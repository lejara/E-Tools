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

  // The structural half of capture, driven by the navigator's right-click menu
  // rather than the panel flyout — a layer's position and its name are not field
  // rows, so there was nowhere in the panel for this to live.
  //
  // The page world sends the captured subtree RAW. Stripping `_element_id` out of
  // it happens in normalizeEdit, on this side, because that is where
  // __EdgePresetFormat is readable — which is what keeps the rule in one place
  // instead of a second copy in the page-world script.
  const captureEdgeStructural = async (payload) => {
    const presetId = payload?.presetId;
    if (!presetId) return { ok: false, error: "no preset id" };

    const list = await loadPresets();
    const at = list.findIndex((p) => p?.id === presetId);
    if (at < 0) return { ok: false, error: "that preset no longer exists" };

    const merged = F.mergeStructural(list[at], {
      templateId: payload.templateId,
      templateTitle: payload.templateTitle,
      edit: payload.edit,
    });
    if (!merged.ok) return { ok: false, error: merged.error };

    const next = list.slice();
    next[at] = merged.preset;
    await savePresets(next);

    const label = F.editLabel(merged.edit);
    ns.log(
      "info",
      `Edge preset "${merged.preset.name}": captured ${label}` +
        ` at ${F.editParentKey(merged.edit)} index ${merged.edit.index}`,
    );
    return { ok: true, note: `Captured — ${label}` };
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

  // What a structural edit actually did, for the log line. Each op reports a
  // different fact, and "applied" alone would not say whether an add landed at
  // the position the author asked for or what a remove destroyed — which is the
  // one thing nobody can check afterwards.
  const describeApplied = (edit, out) => {
    if (edit.op === "rename") {
      return out.unchanged
        ? `already named "${out.title}"`
        : `renamed "${out.was || "(unnamed)"}" → "${out.title}"`;
    }
    if (edit.op === "remove") return `removed "${out.removed}"`;
    return `added at index ${out.at}`;
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
      return {
        ok: true,
        presets: [],
        applied: 0,
        gated: 0,
        skipped: 0,
        warnings: [],
      };
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
      return {
        ok: false,
        error,
        presets: [],
        applied: 0,
        gated: 0,
        skipped: 0,
        warnings: [],
      };
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
    const byPreset = new Map();
    let totalApplied = 0;
    let totalSkipped = 0;
    let totalGated = 0;
    const warnings = [];

    // Every structural edit on the page, collected during the field pass and run
    // once it is finished. THE ORDER IS THE POINT: a field capture is addressed by
    // a child-index path from its instance root, and adding or removing a node
    // shifts every index after it. Field writes therefore resolve against a tree
    // nothing has touched, and the structural edits go last.
    //
    // Collected across ALL presets rather than applied per preset, for the same
    // reason: preset A's add would invalidate preset B's field paths.
    const structuralJobs = [];

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

        // The preset's one structural edit, queued against every instance whose
        // tag names the root it was captured under. Queued now and applied after
        // every field write in the whole run — see structuralJobs above.
        const edit = F.structuralEdit(preset);
        if (edit) {
          for (const c of candidates) {
            if (!F.tagMatchesNode(c.tag, preset, edit)) continue;
            structuralJobs.push({
              presetId: preset.id,
              where,
              edit,
              rootId: c.id,
              rootTitle: c.title,
              key: `${preset.id}:${edit.id}:${c.id}`,
            });
          }
        }

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

        // A preset carrying only a structural edit has no field targets and is
        // still a preset with work to do, so the queue is consulted too.
        if (!targets.length && !structuralJobs.some((j) => j.presetId === preset.id)) {
          // Zero is an answer. A page that holds none of this template's blocks
          // is the ordinary case in a site-wide run, so it is an info line; a
          // preset that reaches nothing *anywhere* is what the run summary shows.
          ns.log("info", `${where}: no tagged instance on this page`);
          const entry = {
            id: preset.id,
            name: preset.name,
            template: templateName,
            instances: 0,
            applied: 0,
            gated: 0,
            skipped: 0,
          };
          byPreset.set(preset.id, entry);
          report.push(entry);
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
        } else if (targets.length) {
          ns.log(
            "info",
            `${where}: ${applied} field(s) written across ${targets.length} instance(s)` +
              (skipped ? ` · ${skipped} skipped` : ""),
          );
        }
        totalApplied += applied;
        totalSkipped += skipped;
        const entry = {
          id: preset.id,
          name: preset.name,
          template: templateName,
          instances: targets.length,
          applied,
          gated: 0,
          skipped,
          error: failure,
        };
        byPreset.set(preset.id, entry);
        report.push(entry);
      }

      // ------------------------------------------------- structural edits
      //
      // Sent in ONE call, deliberately not chunked. The bridge refuses two edits
      // that resolve to the same container, and it can only see that within a
      // single call — chunking would let a collision slip through by landing the
      // two halves in different messages. The count is bounded by (presets with
      // an edit) × (instances on this page), which is small in practice.
      if (structuralJobs.length) {
        const res = await ns.callBridge(
          "apply-edge-structural",
          {
            edits: structuralJobs.map((j) => ({
              key: j.key,
              rootId: j.rootId,
              path: j.edit.path,
              index: j.edit.index,
              op: j.edit.op,
              place: j.edit.place || null,
              node: j.edit.node || null,
              title: j.edit.title || "",
              conditions: j.edit.conditions || [],
              expectParent: j.edit.parentWidgetType
                ? `widget:${j.edit.parentWidgetType}`
                : String(j.edit.parentElType || "container"),
            })),
          },
          // A mutation: waited on, never re-sent. One Elementor command per edit,
          // and an add carries a whole subtree, so the span is generous.
          {
            timeout: 6000 + structuralJobs.length * 1200,
            waitLimit: 3,
          },
        );

        if (!res?.ok) {
          const why = res?.error || "the bridge refused the write";
          for (const job of structuralJobs) {
            const entry = byPreset.get(job.presetId);
            if (entry) entry.skipped += 1;
            totalSkipped += 1;
          }
          warn(
            `Edge presets · page "${pageName}": structural edits failed — ${why}`,
          );
        } else {
          for (const out of res.results || []) {
            const job = structuralJobs.find((j) => j.key === out.key);
            if (!job) continue;
            const entry = byPreset.get(job.presetId);
            const at = `"${job.rootTitle || job.rootId}" ${F.editLabel(job.edit)}`;
            if (out.outcome === "applied") {
              totalApplied += 1;
              if (entry) entry.applied += 1;
              ns.log(
                "info",
                `${job.where}: ${at} — ${describeApplied(job.edit, out)}`,
              );
            } else if (out.outcome === "gated") {
              // A gate is a designed no-op, NOT a failure. Reported at info so a
              // preset doing exactly what it was told does not fill a
              // hundred-page run's log with warnings.
              totalGated += 1;
              if (entry) entry.gated += 1;
              ns.log(
                "info",
                `${job.where}: ${at} — gated: ${F.conditionLabel(out.condition)}` +
                  ` (${out.childCount} child(ren))`,
              );
            } else {
              totalSkipped += 1;
              if (entry) entry.skipped += 1;
              warn(`${job.where}: ${at} — ${out.why} — skipped`);
            }
          }
        }
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
      // Three outcomes, not two. A gate that fired is the preset working as
      // authored; folding it into `skipped` would make a correct run read as a
      // broken one across a hundred pages.
      gated: totalGated,
      skipped: totalSkipped,
      warnings,
    };
  };

  // The armed preset is read by breakpoint-flyout.js for the menu item, and set
  // by the Automation window. It lives here as a named constant so the two ends
  // agree on the key.
  ns.EDGE_ARMED_KEY = ARMED_KEY;
  ns.captureEdgeField = captureEdgeField;
  ns.captureEdgeStructural = captureEdgeStructural;
  ns.applyEdgePresets = applyEdgePresets;
})();
