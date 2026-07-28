(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const MODAL_ID = "ElementorTools-template-sync-modal";

  let running = false;


  /* ----------------------------------------------------------------- core */

  // Elementor's default label for a never-renamed layer. A root carrying one
  // of these has no identity to match on, so it is skipped rather than guessed at.
  const GENERIC_ROOT_NAMES = new Set(["container"]);

  // Title collisions make the match ambiguous — there is no safe way to guess
  // which template the user meant, so those names are dropped from the map.
  const buildTemplateIndex = (templates) => {
    const byName = new Map();
    const ambiguous = new Set();
    for (const t of templates) {
      const key = ns.normalizeName(t.title);
      if (!key) continue;
      if (byName.has(key)) {
        ambiguous.add(key);
        continue;
      }
      byName.set(key, t);
    }
    for (const key of ambiguous) byName.delete(key);
    return { byName, ambiguous };
  };

  const applyPairs = async (pairs, onProgress) => {
    let done = 0;
    const failures = [];
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i];
      onProgress?.(i + 1, pairs.length);
      const copyRes = await ns.callBridge("copy", { id: pair.sourceId });
      if (!copyRes?.ok) {
        failures.push(`copy ${pair.sourceId}: ${copyRes?.error}`);
        continue;
      }
      const pasteRes = await ns.callBridge("paste-style", {
        ids: [pair.targetId],
      });
      if (!pasteRes?.ok) {
        failures.push(`paste ${pair.targetId}: ${pasteRes?.error}`);
        continue;
      }
      done++;
    }
    return { done, failures };
  };

  // Style one page container from one template root.
  const applyRootToTarget = async (root, target, rowId, modal, tally) => {
    const tgtRes = await ns.callBridge("describe-tree", { id: target.id });
    if (!tgtRes?.ok) {
      tally.failed++;
      modal.setRow(rowId, "error", `could not read page container — ${tgtRes?.error}`);
      return;
    }

    const paired = ns.pairTrees(root, tgtRes.tree, {
      isSkipped: tally.isSkipped,
    });
    if (!paired.ok) {
      tally.failed++;
      modal.setRow(rowId, "error", paired.error);
      for (const m of (paired.missing || []).slice(0, 6)) {
        modal.note(`    missing from page: ${m}`, "warn");
      }
      for (const e of (paired.extra || []).slice(0, 6)) {
        modal.note(`    extra on page: ${e}`, "warn");
      }
      modal.note(
        `    template: ${ns.summarizeTree(root)} (${ns.countNodes(root)} nodes)`,
      );
      modal.note(
        `    page:     ${ns.summarizeTree(tgtRes.tree)} (${ns.countNodes(tgtRes.tree)} nodes)`,
      );
      ns.log("warn", `Template sync: "${target.title}" — ${paired.error}`);
      return;
    }

    const { done, failures } = await applyPairs(paired.pairs, (i, total) =>
      modal.setRow(rowId, "running", `styling ${i}/${total}`),
    );
    const skipped = paired.skipped || [];
    const missing = paired.missing || [];
    const extra = paired.extra || [];
    const drifted = missing.length + extra.length;
    tally.applied++;
    tally.nodes += done;
    tally.skippedNodes += skipped.length;
    tally.driftedNodes += drifted;
    tally.touched.add(target.id);
    modal.setRow(
      rowId,
      failures.length || drifted ? "warn" : "ok",
      `${done}/${paired.pairs.length} node(s) styled` +
        (skipped.length ? `, ${skipped.length} skipped` : "") +
        (drifted ? `, ${drifted} unmatched` : "") +
        (failures.length ? `, ${failures.length} errored` : ""),
    );
    for (const s of skipped) modal.note(`    skipped "${s}"`);
    for (const m of missing) modal.note(`    missing from page: ${m}`, "warn");
    for (const e of extra) modal.note(`    extra on page: ${e}`, "warn");
    for (const f of failures) modal.note(`    ${f}`, "warn");
    ns.log(
      "info",
      `Template sync: "${target.title}" — ${done}/${paired.pairs.length} node(s)`,
    );
  };

  // Swap the page container out for a copy of the template root. No tree
  // pairing: the template's structure wholesale becomes the page's, so
  // nothing has to line up first.
  const replaceRootIntoTarget = async (root, target, rowId, modal, tally) => {
    if (tally.isSkipped(target.title)) {
      tally.skippedNodes++;
      modal.setRow(rowId, "warn", "carries the skip word — left alone");
      return;
    }

    // Replacing an ancestor already deleted this node — its id is stale and
    // the bridge would throw. Only possible when nested matching is on.
    const deadAncestor = [...tally.replaced].find((id) =>
      tally.isDescendantOf(target.id, id),
    );
    if (deadAncestor) {
      tally.skippedNested++;
      modal.setRow(
        rowId,
        "warn",
        "inside a container that was already replaced — skipped",
      );
      return;
    }

    modal.setRow(rowId, "running", "replacing");
    const res = await ns.callBridge("replace-container", {
      sourceId: root.id,
      targetId: target.id,
    });
    if (!res?.ok) {
      tally.failed++;
      modal.setRow(rowId, "error", `replace failed — ${res?.error}`);
      ns.log("warn", `Template replace: "${target.title}" — ${res?.error}`);
      return;
    }

    const nodes = ns.countNodes(root);
    tally.applied++;
    tally.nodes += nodes;
    tally.touched.add(target.id);
    tally.replaced.add(target.id);
    modal.setRow(rowId, "ok", `replaced — ${nodes} node(s)`);
    ns.log("info", `Template replace: "${target.title}" — ${nodes} node(s)`);
  };

  const OPS = {
    styles: {
      title: "Sync Template Styles",
      button: "Sync",
      prompt: (n) =>
        `${n} template(s) match a top container. Untick any you want to leave alone.`,
      logName: "Template sync",
      run: applyRootToTarget,
    },
    replace: {
      title: "Replace With Template",
      button: "Replace",
      prompt: (n) =>
        `${n} template(s) match a top container. Untick any you want to leave ` +
        `alone — replacing deletes the container's current content.`,
      logName: "Template replace",
      run: replaceRootIntoTarget,
    },
  };

  // Insert a template once, treat each of its roots as an independent
  // template keyed on that root's own layer name, then always remove the copy.
  const syncTemplate = async (template, containersByName, modal, tally, op) => {
    modal.setStatus(`Inserting "${template.title}"…`);
    const insertRes = await ns.insertSiteTemplate(template.templateId, {
      source: template.source,
      title: template.title,
      type: template.type,
    });
    if (!insertRes?.ok) {
      tally.failed++;
      modal.note(`✕ "${template.title}" — insert failed: ${insertRes?.error}`, "error");
      ns.log("warn", `${op.logName}: insert "${template.title}" — ${insertRes?.error}`);
      return;
    }

    const insertedIds = insertRes.ids || [];
    try {
      if (!insertedIds.length) {
        tally.failed++;
        modal.note(`✕ "${template.title}" — insert produced no elements`, "error");
        return;
      }

      const srcTrees = await Promise.all(
        insertedIds.map((id) => ns.callBridge("describe-tree", { id })),
      );
      const multi = insertedIds.length > 1;
      if (multi) {
        tally.multiRoot.push({
          title: template.title,
          count: insertedIds.length,
        });
        modal.note(
          `· "${template.title}" has ${insertedIds.length} roots — handling each as its own template`,
        );
      }

      for (let i = 0; i < srcTrees.length; i++) {
        const res = srcTrees[i];
        if (!res?.ok) {
          tally.failed++;
          modal.note(
            `✕ "${template.title}" root ${i + 1} — could not read: ${res?.error}`,
            "error",
          );
          continue;
        }
        const root = res.tree;
        const rootName = root.title || "";
        const label = multi
          ? `"${template.title}" root ${i + 1}${rootName ? ` ("${rootName}")` : ""}`
          : `"${template.title}"`;

        if (!rootName || GENERIC_ROOT_NAMES.has(ns.normalizeName(rootName))) {
          tally.skippedRoots++;
          modal.note(
            `⚠ ${label} — root layer is ${rootName ? `named "${rootName}"` : "unnamed"}, ` +
              `so it matches nothing. Rename it inside the template. Skipped.`,
            "warn",
          );
          ns.log(
            "warn",
            `${op.logName}: "${template.title}" root ${i + 1} has no usable name — skipped`,
          );
          continue;
        }

        let targets = containersByName.get(ns.normalizeName(rootName)) || [];
        // Scanning the whole page needs the extra precision of a type check;
        // at top level the candidate set is tiny and a type clash is more
        // useful reported as a pairing failure than silently dropped.
        if (tally.nested) {
          const want = ns.nodeType(root);
          const before = targets.length;
          targets = targets.filter((c) => ns.nodeType(c) === want);
          const dropped = before - targets.length;
          if (dropped) {
            modal.note(
              `· ${label} — ${dropped} name match(es) skipped, not a "${want}"`,
            );
          }
          // Outermost first, so an ancestor is replaced before its descendants
          // are considered (and then skipped as already gone).
          targets = targets.slice().sort((a, b) => a.depth - b.depth);
        }
        if (!targets.length) {
          modal.note(`· ${label} — no page container named "${rootName}"`);
          continue;
        }

        for (const target of targets) {
          const rowId = `${template.templateId}:${i}:${target.id}`;
          modal.addRow(rowId, `${label} → "${target.title}"`);
          modal.setStatus(`${op.button}: "${target.title}"…`);
          await op.run(root, target, rowId, modal, tally);
        }
      }
    } finally {
      const delRes = await ns.callBridge("delete", { ids: insertedIds });
      if (!delRes?.ok) {
        const msg = `could not remove inserted "${template.title}" (${insertedIds.join(", ")}) — ${delRes?.error}. Delete it manually.`;
        ns.log("error", `${op.logName}: ${msg}`);
        modal.note(`⚠ ${msg}`, "error");
      }
    }
  };

  const runTemplateOperation = async (op) => {
    if (running) {
      ns.log("warn", `${op.logName}: already running`);
      return;
    }
    running = true;

    const modal = ns.openProgressModal(op.title, { id: MODAL_ID });
    let logId = null;
    try {
      modal.setStatus("Fetching site templates…");
      const templatesRes = await ns.listSiteTemplates();
      if (!templatesRes?.ok) {
        ns.log("warn", `${op.logName}: ${templatesRes?.error}`);
        modal.finish(`Could not fetch templates — ${templatesRes?.error}`, "error");
        return;
      }
      const all = templatesRes.templates || [];
      const { byName, ambiguous } = buildTemplateIndex(all);

      modal.setStatus(`Found ${all.length} template(s). Reading page containers…`);
      const pageRes = await ns.callBridge("list-containers");
      if (!pageRes?.ok) {
        ns.log("warn", `${op.logName}: ${pageRes?.error}`);
        modal.finish(`Could not read page — ${pageRes?.error}`, "error");
        return;
      }
      const everything = pageRes.containers || [];
      const topLevel = everything.filter((c) => c.depth === 0);

      // Two indexes: shallow is the default, deep is opt-in from the confirm
      // modal. A root looks up its targets in whichever is active.
      const indexByName = (nodes) => {
        const map = new Map();
        for (const c of nodes) {
          const key = ns.normalizeName(c.title);
          if (!key) continue;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(c);
        }
        return map;
      };
      const topByName = indexByName(topLevel);
      const allByName = indexByName(everything);

      const parentOf = new Map(everything.map((c) => [c.id, c.parentId]));
      const isDescendantOf = (id, ancestorId) => {
        let cur = parentOf.get(id);
        while (cur) {
          if (cur === ancestorId) return true;
          cur = parentOf.get(cur);
        }
        return false;
      };

      for (const key of ambiguous) {
        ns.log("warn", `${op.logName}: "${key}" matches multiple templates — skipped`);
        modal.note(`⚠ "${key}" matches multiple templates — skipped`, "warn");
      }

      // A template is considered when its title matches a page node's name.
      // Root-level names then decide what each root inside it actually styles.
      const buildQueue = ({ nested }) => {
        const pool = nested ? everything : topLevel;
        const queue = [];
        const seen = new Set();
        for (const c of pool) {
          const t = byName.get(ns.normalizeName(c.title));
          if (t && !seen.has(t.templateId)) {
            seen.add(t.templateId);
            queue.push(t);
          }
        }
        return queue;
      };

      if (!buildQueue({ nested: true }).length) {
        modal.note(
          `Top containers: ${topLevel.map((c) => `"${c.title || "(unnamed)"}"`).join(", ") || "none"}`,
        );
        modal.finish(
          `No matches. ${topLevel.length} top container(s), ` +
            `${everything.length} node(s) in total, ${all.length} template(s).`,
          "warn",
        );
        ns.log("info", `${op.logName}: no template matches`);
        return;
      }

      modal.setStatus(op.prompt(buildQueue({ nested: false }).length));
      const choice = await modal.choose({
        buildItems: buildQueue,
        labelOf: (t) => t.title,
        buttonText: op.button,
        toggles: [
          {
            key: "nested",
            label: "Match nested containers",
            hint: "Search the whole page, not just top-level containers. Nested targets must match the template root's name and type.",
            default: false,
          },
        ],
      });
      if (!choice) {
        ns.log("info", `${op.logName}: cancelled`);
        modal.close();
        return;
      }
      const selected = choice.items;
      const nested = !!choice.toggles.nested;
      const queue = buildQueue({ nested });
      const containersByName = nested ? allByName : topByName;
      if (nested) {
        modal.note(`· Matching nested containers (name + type)`);
      }
      if (selected.length < queue.length) {
        modal.note(
          `· ${queue.length - selected.length} template(s) unticked and skipped`,
        );
      }

      const historyRes = await ns.callBridge("history-start", {
        title: op.title,
      });
      logId = historyRes?.ok ? historyRes.logId : null;

      const tally = {
        applied: 0,
        failed: 0,
        nodes: 0,
        skippedRoots: 0,
        skippedNodes: 0,
        driftedNodes: 0,
        skippedNested: 0,
        nested,
        isDescendantOf,
        replaced: new Set(),
        multiRoot: [],
        touched: new Set(),
        isSkipped: await ns.getSkipMatcher(),
      };
      for (const template of selected) {
        await syncTemplate(template, containersByName, modal, tally, op);
      }

      if (tally.multiRoot.length) {
        modal.note(" ");
        for (const m of tally.multiRoot) {
          const msg =
            `"${m.title}" contains ${m.count} root elements — each was treated as ` +
            `a separate template. Re-save it with a single root unless that is intended.`;
          modal.note(`⚠ ${msg}`, "warn");
          ns.log("warn", `${op.logName}: ${msg}`);
        }
      }

      // Denominator is whatever pool the run actually searched, so the count
      // lines up with the toggle the user just set.
      const searched = nested ? everything : topLevel;
      const untouched = searched.filter((c) => !tally.touched.has(c.id)).length;
      const summary =
        `${tally.applied} applied (${tally.nodes} node(s)), ` +
        `${tally.failed} failed, ` +
        (tally.skippedNodes ? `${tally.skippedNodes} node(s) skipped, ` : "") +
        (tally.driftedNodes ? `${tally.driftedNodes} node(s) unmatched, ` : "") +
        (tally.skippedRoots ? `${tally.skippedRoots} root(s) skipped, ` : "") +
        (tally.skippedNested
          ? `${tally.skippedNested} nested target(s) already replaced, `
          : "") +
        `${untouched} ${nested ? "node(s)" : "container(s)"} untouched`;
      ns.log(tally.applied ? "info" : "warn", `${op.logName}: ${summary}`);
      modal.finish(
        summary,
        tally.failed || tally.skippedRoots || tally.multiRoot.length
          ? "warn"
          : "ok",
      );
    } catch (err) {
      ns.log("error", `${op.logName}: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await ns.callBridge("history-end", { logId });
      }
      running = false;
    }
  };

  ns.syncTemplateStyles = () => runTemplateOperation(OPS.styles);
  ns.replaceWithTemplate = () => runTemplateOperation(OPS.replace);
})();
