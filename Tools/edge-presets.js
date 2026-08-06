// Edge Presets: force-push named fields from a template onto its instances.
//
// A sync pastes the template's *style* controls, so it cannot touch a button's
// label, a link URL, an icon, or any other non-style setting. An Edge Preset is
// the named list of fields to push anyway — the edges a sync cannot reach.
//
// This file owns preset storage and the apply pipeline. The other two halves live
// where they have to: capture is a right-click item in the page-world flyout
// (breakpoint-flyout-page.js, which is where a field row can be clicked at all),
// and the authoring UI is the Automation window. The schema, the path encoding and
// the tag-matching rule are shared by all three through edge-preset-format.js.
//
// Applying makes NO network request. The values are a snapshot taken at capture
// time, the instances are found by their #id.N tag, and the paths are walked
// page-side — so an Edge-Presets-only run over a hundred pages is bounded by the
// editor's own load time and nothing else.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});
  const F = window.__EdgePresetFormat;
  const T = window.__ElementorTemplateFormat;
  if (!F || !T) {
    ns.log?.(
      "error",
      "Edge presets: edge-preset-format.js or template-format.js did not load — check manifest order",
    );
    return;
  }

  const ARMED_KEY = "edgePresetArmed";

  // The page world cannot yield mid-op, so a page with many instances is sent in
  // batches rather than one message: each node costs one Elementor command, and a
  // batch is the unit of "still alive". Same reasoning as STYLE_CHUNK in
  // template-sync.js and NODE_CHUNK in animation-presets.js, and the timeout
  // scales with it the same way.
  const TARGET_CHUNK = 15;

  const loadPresets = async () => {
    const stored = await browser.storage.local.get(F.STORAGE_KEY);
    const list = stored?.[F.STORAGE_KEY];
    return Array.isArray(list) ? list : [];
  };

  const savePresets = (list) =>
    browser.storage.local.set({ [F.STORAGE_KEY]: list });

  // ---------------------------------------------------------------- capture

  // Called from breakpoint-flyout.js, which owns the __bpf channel the page-world
  // menu item talks over. Everything about whether this capture is *allowed* was
  // already checked page-side (right editor, right template, template saved),
  // because all three of those facts live there. What is checked here is the part
  // that lives here: that the preset still exists, and that the merge agrees the
  // capture belongs to it.
  const captureEdgeField = async (payload) => {
    const presetId = payload?.presetId;
    if (!presetId) return { ok: false, error: "no preset id" };

    const list = await loadPresets();
    const at = list.findIndex((p) => p?.id === presetId);
    if (at < 0) return { ok: false, error: "that preset no longer exists" };

    const merged = F.mergeCapture(list[at], {
      templateId: payload.templateId,
      templateTitle: payload.templateTitle,
      root: payload.root,
      path: payload.path,
      elType: payload.elType,
      widgetType: payload.widgetType,
      label: payload.label,
      field: payload.field,
    });
    if (!merged.ok) return { ok: false, error: merged.error };

    const next = list.slice();
    next[at] = merged.preset;
    await savePresets(next);

    const counts = F.describePreset(merged.preset);
    const what = F.fieldLabel(payload.field);
    ns.log(
      "info",
      `Edge preset "${merged.preset.name}": ${merged.replaced ? "re-captured" : "captured"} ` +
        `${what} on ${F.pathLabel(payload)} — now ${counts.fields} field(s) across ` +
        `${counts.nodes} element(s)`,
    );
    return {
      ok: true,
      note: `${merged.replaced ? "Replaced" : "Captured"} — ${counts.fields} field(s) in "${merged.preset.name}"`,
    };
  };

  // ------------------------------------------------------------------ apply

  // Every tagged layer on this page, grouped by the template id its tag names.
  //
  // `skipRootDepth` turns on the one exclusion, and it is the same one
  // findTemplateTags makes for the usage index: inside a template's own document,
  // depth-0 nodes are that template's roots, named "<title> #<id>" by the tools
  // that put them there. Matching them would apply a preset to the very element it
  // was captured from. It is about position, not about which template the tag
  // names — a root tagged for some other template is still a root of this one.
  const indexTaggedNodes = (containers, skipRootDepth) => {
    const byTemplate = new Map();
    for (const c of containers) {
      if (skipRootDepth && c.depth === 0) continue;
      const tag = T.parseTemplateTag(c.title);
      if (!tag?.id) continue;
      if (!byTemplate.has(tag.id)) byTemplate.set(tag.id, []);
      byTemplate.get(tag.id).push({ id: c.id, title: c.title, tag });
    }
    return byTemplate;
  };

  // `titles` lets the caller supply the library's own template titles, because a
  // preset's stored templateTitle is a snapshot from capture time and may be
  // stale or empty. Reporting has to name the template, so the freshest name
  // available wins and the id is the last resort.
  const applyEdgePresets = async ({
    presetIds = null,
    templateIds = null,
    titles = null,
  } = {}) => {
    const all = await loadPresets();
    const wanted = presetIds ? new Set(presetIds) : null;
    const allow = templateIds?.length
      ? new Set(templateIds.map(String))
      : null;

    const chosen = all.filter((p) => {
      if (!p?.id) return false;
      if (wanted && !wanted.has(p.id)) return false;
      // An unbound preset names no template, so there is no set of instances for
      // it to reach. Reported below on a manual run, where the user is looking at
      // the preset they just made — but dropped under an allowlist, because an
      // automation run would otherwise repeat the same warning on all hundred
      // pages, and the allowlist could never have matched it anyway.
      if (!p.templateId) return !allow;
      if (allow && !allow.has(String(p.templateId))) return false;
      return true;
    });

    if (!chosen.length) {
      return { ok: true, presets: [], applied: 0, skipped: 0, warnings: [] };
    }

    const docRes = await ns.callBridge("describe-document", {}, { waitLimit: 1 });
    const pageName =
      (docRes?.ok && (docRes.title || (docRes.id ? `#${docRes.id}` : ""))) ||
      "this page";
    const isTemplateDoc = !!(docRes?.ok && docRes.isTemplate);

    const pageRes = await ns.callBridge("list-containers");
    if (!pageRes?.ok) {
      const error = `could not read the page — ${pageRes?.error}`;
      ns.log("error", `Edge presets · page "${pageName}": ${error}`);
      return { ok: false, error, presets: [], applied: 0, skipped: 0, warnings: [] };
    }
    const byTemplate = indexTaggedNodes(
      pageRes.containers || [],
      isTemplateDoc,
    );

    const nameOf = (preset) =>
      (titles && titles[String(preset.templateId)]) ||
      preset.templateTitle ||
      (preset.templateId ? `#${preset.templateId}` : "(unbound)");

    const historyRes = await ns.callBridge(
      "history-start",
      { title: "Apply edge presets" },
      { waitLimit: 1 },
    );
    const logId = historyRes?.ok ? historyRes.logId : null;

    const report = [];
    let totalApplied = 0;
    let totalSkipped = 0;
    const warnings = [];

    // Reported at every level it can go wrong at, and always with the same three
    // facts — preset, page, template — because a line missing any one of them is
    // unactionable in a hundred-page run's log.
    const warn = (message) => {
      warnings.push(message);
      ns.log("warn", message);
    };

    try {
      for (const preset of chosen) {
        const templateName = nameOf(preset);
        const where = `Edge preset "${preset.name}" · page "${pageName}" · template "${templateName}"`;

        if (!preset.templateId) {
          warn(`${where}: never captured from a template — nothing to apply`);
          report.push({ id: preset.id, name: preset.name, instances: 0, applied: 0, skipped: 0 });
          continue;
        }

        const candidates = byTemplate.get(String(preset.templateId)) || [];
        // Build one target per (instance root, node) pairing. A node is matched
        // against the instance's own tag, so root 2's fields never land on root 1
        // of the same kit.
        const targets = [];
        for (const node of preset.nodes || []) {
          const expect = F.nodeSignature(node);
          const key = F.nodeKey(node);
          for (const c of candidates) {
            if (!F.tagMatchesNode(c.tag, preset, node)) continue;
            let target = targets.find((t) => t.rootId === c.id);
            if (!target) {
              target = { rootId: c.id, rootTitle: c.title, nodes: [] };
              targets.push(target);
            }
            target.nodes.push({
              key,
              path: node.path,
              expect,
              label: node.label,
              pathLabel: F.pathLabel(node),
              fields: node.fields,
            });
          }
        }

        if (!targets.length) {
          // Zero is an answer. A page that holds none of this template's blocks
          // is the ordinary case in a site-wide run, so it is an info line; a
          // preset that reaches nothing *anywhere* is what the run summary shows.
          ns.log("info", `${where}: no tagged instance on this page`);
          report.push({ id: preset.id, name: preset.name, instances: 0, applied: 0, skipped: 0 });
          continue;
        }

        let applied = 0;
        let skipped = 0;
        let failure = null;
        for (let at = 0; at < targets.length; at += TARGET_CHUNK) {
          const slice = targets.slice(at, at + TARGET_CHUNK);
          const res = await ns.callBridge(
            "apply-edge-preset",
            {
              targets: slice.map((t) => ({
                rootId: t.rootId,
                nodes: t.nodes.map((n) => ({
                  key: n.key,
                  path: n.path,
                  expect: n.expect,
                  fields: n.fields,
                })),
              })),
            },
            // A mutation, so it is waited on and never re-sent. The span covers
            // one Elementor command per node in the batch.
            { timeout: 4000 + slice.length * 800, waitLimit: 3 },
          );
          if (!res?.ok) {
            failure = res?.error || "the bridge refused the write";
            break;
          }
          for (const target of res.results || []) {
            const source = slice.find((t) => t.rootId === target.rootId);
            for (const node of target.nodes || []) {
              const meta = source?.nodes.find((n) => n.key === node.key);
              const at2 = meta?.pathLabel || node.key;
              if (!node.ok) {
                skipped += 1;
                warn(
                  `${where}: "${target.rootTitle || target.rootId}" ${at2} — ${node.why} — skipped`,
                );
                continue;
              }
              applied += (node.applied || []).length;
              for (const s of node.skipped || []) {
                skipped += 1;
                warn(
                  `${where}: "${node.title || node.id}" ${at2} · ${s.key} — ${s.why}`,
                );
              }
            }
          }
        }

        if (failure) {
          warn(`${where}: failed after ${applied} field(s) — ${failure}`);
        } else {
          ns.log(
            "info",
            `${where}: ${applied} field(s) written across ${targets.length} instance(s)` +
              (skipped ? ` · ${skipped} skipped` : ""),
          );
        }
        totalApplied += applied;
        totalSkipped += skipped;
        report.push({
          id: preset.id,
          name: preset.name,
          template: templateName,
          instances: targets.length,
          applied,
          skipped,
          error: failure,
        });
      }
    } finally {
      if (logId !== null && logId !== undefined) {
        // waitLimit 1, as everywhere: history-end degrades to a no-op, and a
        // re-arming wait holds the undo group open long enough for a later edit
        // to join this run's step.
        await ns.callBridge("history-end", { logId }, { waitLimit: 1 });
      }
    }

    return {
      ok: true,
      page: pageName,
      presets: report,
      applied: totalApplied,
      skipped: totalSkipped,
      warnings,
    };
  };

  // The armed preset is read by breakpoint-flyout.js for the menu item, and set
  // by the Automation window. It lives here as a named constant so the two ends
  // agree on the key.
  ns.EDGE_ARMED_KEY = ARMED_KEY;
  ns.captureEdgeField = captureEdgeField;
  ns.applyEdgePresets = applyEdgePresets;
})();
