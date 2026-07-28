(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const MODAL_ID = "ElementorTools-template-sync-modal";

  let running = false;

  const {
    templateTagKey,
    withTemplateTag,
    parseTemplateTag,
    stripTemplateTag,
  } = window.__ElementorTemplateFormat;

  /* ----------------------------------------------------------------- core */

  // A slow op is not a dead one — the bridge keeps waiting (and an insert that
  // outran its deadline has still inserted), so say so in the log rather than
  // leaving the modal frozen on its last phase.
  const waitNote = (modal) => (info) =>
    modal.note(
      `· still waiting on ${info.op} — ${Math.round(info.waited / 1000)}s so far, not giving up`,
      "warn",
    );

  // Elementor's default label for a never-renamed layer. A root carrying one
  // of these has no identity to match on, so it is skipped rather than guessed at.
  const GENERIC_ROOT_NAMES = new Set(["container"]);

  // Title collisions make the match ambiguous — there is no safe way to guess
  // which template the user meant, so those names are dropped from the map.
  // byId never collides: it is keyed on the template's own id, which is what
  // the id tag on a page layer resolves against.
  const buildTemplateIndex = (templates) => {
    const byName = new Map();
    const byId = new Map();
    const ambiguous = new Set();
    for (const t of templates) {
      byId.set(String(t.templateId), t);
      const key = ns.normalizeName(t.title);
      if (!key) continue;
      if (byName.has(key)) {
        ambiguous.add(key);
        continue;
      }
      byName.set(key, t);
    }
    for (const key of ambiguous) byName.delete(key);
    return { byName, byId, ambiguous };
  };

  // Stamp the block's identity onto the page after the operation: the name that
  // matched (or the template's title) plus the template id tag. Replace pastes
  // the template's own root name over the page's, which would otherwise lose
  // the link outright; styling keeps the target but not necessarily a name that
  // says where the styles came from.
  const nameTargets = async (ids, title, modal) => {
    if (!ids?.length || !title) return;
    const res = await ns.callBridge("rename", { ids, title });
    if (!res?.ok) {
      modal.note(`    could not name "${title}" — ${res?.error}`, "warn");
      ns.log("warn", `Template sync: naming "${title}" — ${res?.error}`);
    }
  };

  // How many pairs go page-side per bridge call. One call for the whole block
  // would be fastest, but the page world cannot yield mid-op: a thousand pairs
  // in one message freezes the tab with no progress and no way to tell whether
  // it is still working. A chunk is the unit of "still alive".
  const STYLE_CHUNK = 40;

  // Two Elementor commands per pair, and the point of batching is that they no
  // longer each get their own deadline — so the budget scales with the chunk.
  const styleChunkTimeout = (n) => 5000 + n * 400;

  // The copy → paste-style loop runs page-side now (see apply-style-pairs). A
  // pair used to cost two postMessage round trips, and a sync over a large page
  // is thousands of pairs, so the messaging was most of the run rather than the
  // styling. Failures still come back per pair and still don't stop the block.
  const applyPairs = async (pairs, onProgress) => {
    let done = 0;
    const failures = [];
    for (let i = 0; i < pairs.length; i += STYLE_CHUNK) {
      const chunk = pairs.slice(i, i + STYLE_CHUNK);
      onProgress?.(i + 1, pairs.length);
      const res = await ns.callBridge(
        "apply-style-pairs",
        { pairs: chunk },
        {
          timeout: styleChunkTimeout(chunk.length),
          // A mutation, so it is never re-sent; re-arming only decides how long
          // to keep waiting. Three spans is generous for one chunk, and unlike
          // an insert there is no orphan left behind if the wait is called off.
          waitLimit: 3,
        },
      );
      if (!res?.ok) {
        failures.push(
          `styling ${chunk.length} node(s) from ${chunk[0]?.sourceId}: ${res?.error}`,
        );
        continue;
      }
      done += res.done || 0;
      for (const f of res.failures || []) failures.push(f);
    }
    return { done, failures };
  };

  // Style one page container from one template root. Returns the ids to name
  // afterwards — the target itself, which styling leaves in place.
  const applyRootToTarget = async (root, target, rowId, modal, tally) => {
    const tgtRes = await ns.callBridge("describe-tree", { id: target.id });
    if (!tgtRes?.ok) {
      tally.failed++;
      modal.setRow(rowId, "error", `could not read page container — ${tgtRes?.error}`);
      return null;
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
      return null;
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
    return [target.id];
  };

  // Swap the page container out for a copy of the template root. No tree
  // pairing: the template's structure wholesale becomes the page's, so
  // nothing has to line up first.
  const replaceRootIntoTarget = async (root, target, rowId, modal, tally) => {
    if (tally.isSkipped(target.title)) {
      tally.skippedNodes++;
      modal.setRow(rowId, "warn", "carries the skip word — left alone");
      return null;
    }

    // Already replaced, so this id is stale and the bridge would throw. Either
    // this exact node (two templates can match one container — by name from one
    // and by id tag from another) or an ancestor, whose replace deleted it.
    const self = tally.replaced.has(target.id);
    const deadAncestor =
      !self && tally.firstAncestorIn(target.id, tally.replaced);
    if (self || deadAncestor) {
      tally.skippedReplaced++;
      modal.setRow(
        rowId,
        "warn",
        self
          ? "already replaced by another template — skipped"
          : "inside a container that was already replaced — skipped",
      );
      return null;
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
      return null;
    }

    const nodes = ns.countNodes(root);
    tally.applied++;
    tally.nodes += nodes;
    tally.touched.add(target.id);
    tally.replaced.add(target.id);
    modal.setRow(rowId, "ok", `replaced — ${nodes} node(s)`);
    ns.log("info", `Template replace: "${target.title}" — ${nodes} node(s)`);
    // The target is gone; what gets named is whatever the paste created.
    return res.ids || (res.id ? [res.id] : []);
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
  const syncTemplate = async (template, targetIndex, modal, tally, op) => {
    modal.setStatus(`Inserting "${template.title}"…`);
    const insertRes = await ns.insertSiteTemplate(template.templateId, {
      source: template.source,
      title: template.title,
      type: template.type,
      onWait: waitNote(modal),
    });
    if (!insertRes?.ok) {
      tally.failed++;
      modal.note(`✕ "${template.title}" — insert failed: ${insertRes?.error}`, "error");
      ns.log("warn", `${op.logName}: insert "${template.title}" — ${insertRes?.error}`);
      return;
    }

    const insertedIds = insertRes.ids || [];
    // The copy must be genuinely new. If one of its ids was already on the page,
    // two elements now answer to it, and deleting the copy by id in the finally
    // could delete the page's element instead — which is precisely how a sync
    // once destroyed a container it was only meant to read styles from. Bail out
    // before the try, so nothing is styled and nothing is deleted; an orphaned
    // copy is a nuisance, deleting the original is not recoverable.
    const collisions = insertedIds.filter((id) => tally.pageIds.has(id));
    if (collisions.length) {
      tally.failed++;
      modal.note(
        `✕ "${template.title}" — the inserted copy re-used id(s) already on this page ` +
          `(${collisions.join(", ")}), so nothing was touched. Remove the copy at the end ` +
          `of the page by hand, and report this — inserts are supposed to get fresh ids.`,
        "error",
      );
      ns.log(
        "error",
        `${op.logName}: insert id collision — ${collisions.join(", ")}`,
      );
      return;
    }

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
          templateId: template.templateId,
          count: insertedIds.length,
        });
        modal.note(
          `· "${template.title}" has ${insertedIds.length} roots — each is handled as ` +
            `its own template, tagged #${template.templateId}.1…${insertedIds.length}`,
        );
        // A layer tagged with the bare id predates the template having several
        // roots, so nothing says which root it holds. Guessing would style — or
        // destroy — the wrong block, so it is reported instead of matched.
        const strays =
          targetIndex.byTag.get(templateTagKey(template.templateId)) || [];
        if (strays.length) {
          modal.note(
            `⚠ ${strays.length} layer(s) tagged #${template.templateId} with no root index: ` +
              strays.map((c) => `"${c.title}"`).join(", ") +
              `. "${template.title}" has ${insertedIds.length} roots, so which one they hold ` +
              `is unknown — add ".1"…".${insertedIds.length}" to the tag, or re-insert the template.`,
            "warn",
          );
        }
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
        const usableName =
          !!rootName && !GENERIC_ROOT_NAMES.has(ns.normalizeName(rootName));

        // The tag first: it is the exact link, and it is what makes an unnamed
        // root usable at all. A multi-root template looks for its own root
        // index; a single-root one accepts the bare tag and "#id.1" alike, so a
        // template that has since lost roots still finds its blocks.
        const rootNo = i + 1;
        const tagKeys = multi
          ? [templateTagKey(template.templateId, rootNo)]
          : [
              templateTagKey(template.templateId),
              templateTagKey(template.templateId, 1),
            ];
        const tagName = `#${tagKeys.join(" / #")}`;
        let targets = tagKeys.flatMap((k) => targetIndex.byTag.get(k) || []);
        const viaTag = targets.length > 0;
        // Nothing tagged: match on the root's name, which is what a hand-built
        // container has.
        if (!targets.length && usableName) {
          targets = targetIndex.byName.get(ns.normalizeName(rootName)) || [];
        }
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
              `· ${label} — ${dropped} ${viaTag ? "id tag" : "name"} match(es) skipped, not a "${want}"`,
            );
          }
          // Outermost first, so an ancestor is replaced before its descendants
          // are considered (and then skipped as already gone).
          targets = targets.slice().sort((a, b) => a.depth - b.depth);
        }
        if (!targets.length) {
          // viaTag with no targets left means the tag did match, but the nested
          // type check dropped every one of them.
          const tagPart = viaTag
            ? `the ${tagName} tag only matched other element types`
            : `nothing is tagged ${tagName}`;
          if (!usableName) {
            tally.skippedRoots++;
            modal.note(
              `⚠ ${label} — root layer is ${rootName ? `named "${rootName}"` : "unnamed"} ` +
                `and ${tagPart} on the page, so it matches nothing. ` +
                `Name the root inside the template, or insert it once to tag the page. Skipped.`,
              "warn",
            );
            ns.log(
              "warn",
              `${op.logName}: "${template.title}" root ${rootNo} matched nothing — skipped`,
            );
          } else {
            modal.note(
              `· ${label} — ${tagPart}, and no page container named "${rootName}"`,
            );
          }
          continue;
        }
        if (viaTag) {
          modal.note(`· ${label} — matched by tag ${tagName}`);
        }

        // What the block is called once the operation is done: always the
        // template's title from the library, plus the tag. Roots of a kit end up
        // sharing a name, which is fine — the root index in the tag is the
        // identity, and it is what the next run matches on first. The root's own
        // name still decides *matching* above, for containers that were built by
        // hand and never tagged.
        const identity = withTemplateTag(
          template.title,
          template.templateId,
          multi ? rootNo : null,
        );

        for (const target of targets) {
          const rowId = `${template.templateId}:${i}:${target.id}`;
          modal.addRow(rowId, `${label} → "${target.title}"`);
          modal.setStatus(`${op.button}: "${target.title}"…`);
          const nameIds = await op.run(root, target, rowId, modal, tally);
          // Whatever the operation hands back is the block as it now stands, so
          // it is also exactly what must still exist when the run is over.
          for (const id of nameIds || []) tally.expected.add(id);
          await nameTargets(nameIds, identity, modal);
        }
      }
    } finally {
      // Logged on success too: a container vanishing at the end of a run is the
      // staging copy being cleaned up, and the log should say so plainly rather
      // than leaving that looking like data loss.
      const delRes = await ns.callBridge("delete", { ids: insertedIds });
      if (delRes?.ok) {
        modal.note(
          `· removed the inserted copy of "${template.title}" (${insertedIds.join(", ")})`,
        );
      }
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
      const templatesRes = await ns.listSiteTemplates({
        onWait: waitNote(modal),
      });
      if (!templatesRes?.ok) {
        ns.log("warn", `${op.logName}: ${templatesRes?.error}`);
        modal.finish(`Could not fetch templates — ${templatesRes?.error}`, "error");
        return;
      }
      const all = templatesRes.templates || [];
      const { byName, byId, ambiguous } = buildTemplateIndex(all);

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
      // The id tag is stripped before keying, so tagging a layer never breaks
      // the name match that found it in the first place.
      const indexByName = (nodes) => {
        const map = new Map();
        for (const c of nodes) {
          const key = ns.normalizeName(stripTemplateTag(c.title));
          if (!key) continue;
          if (!map.has(key)) map.set(key, []);
          map.get(key).push(c);
        }
        return map;
      };
      // The same nodes keyed on their whole tag — "4821" or "4821.2" — so a
      // lookup names one template *and* one of its roots. This is the pass that
      // runs first; a name only has to answer for untagged layers.
      const indexByTag = (nodes) => {
        const map = new Map();
        for (const c of nodes) {
          const tag = parseTemplateTag(c.title);
          if (!tag?.key) continue;
          if (!map.has(tag.key)) map.set(tag.key, []);
          map.get(tag.key).push(c);
        }
        return map;
      };
      const topByName = indexByName(topLevel);
      const allByName = indexByName(everything);
      const topByTag = indexByTag(topLevel);
      const allByTag = indexByTag(everything);

      const parentOf = new Map(everything.map((c) => [c.id, c.parentId]));
      // Walk the node's own ancestors and ask the set, rather than asking "is
      // this a descendant of X?" once per already-replaced container. Same
      // answer, one pass up the tree instead of one pass per member of a set
      // that grows as the run goes on.
      const firstAncestorIn = (id, set) => {
        let cur = parentOf.get(id);
        while (cur) {
          if (set.has(cur)) return cur;
          cur = parentOf.get(cur);
        }
        return null;
      };

      for (const key of ambiguous) {
        ns.log("warn", `${op.logName}: "${key}" matches multiple templates — skipped`);
        modal.note(`⚠ "${key}" matches multiple templates — skipped`, "warn");
      }

      // A template is considered when a page node carries its id tag, or
      // failing that when its title matches a page node's name. Id first: the
      // tag is exact, so a layer whose name was edited by hand still resolves
      // to the template it came from, and a name only has to answer for layers
      // that were never tagged.
      // Root-level names then decide what each root inside it actually styles.
      const buildQueue = ({ nested }) => {
        const pool = nested ? everything : topLevel;
        const queue = [];
        const seen = new Set();
        for (const c of pool) {
          const t =
            byId.get(parseTemplateTag(c.title)?.id) ||
            byName.get(ns.normalizeName(stripTemplateTag(c.title)));
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
      const targetIndex = nested
        ? { byName: allByName, byTag: allByTag }
        : { byName: topByName, byTag: topByTag };
      if (nested) {
        modal.note(`· Matching nested containers (name + type)`);
      }
      if (selected.length < queue.length) {
        modal.note(
          `· ${queue.length - selected.length} template(s) unticked and skipped`,
        );
      }

      // Load every chosen template's content before touching the document, a few
      // requests at a time. The inserts below still run one at a time — this only
      // takes the network wait out of the serial loop. Outside the history log on
      // purpose: nothing here changes the document.
      if (selected.length > 1) {
        modal.setStatus(
          `Loading ${selected.length} template(s), ${ns.PREFETCH_CONCURRENCY} at a time…`,
        );
        const pre = await ns.prefetchTemplates(selected, {
          onWait: waitNote(modal),
        });
        for (const f of pre.failed || []) {
          modal.note(
            `· could not preload #${f.templateId} — ${f.error}. Its insert will try again.`,
            "warn",
          );
        }
      }

      // waitLimit 1 on both ends of the history log. Both already degrade to a
      // no-op rather than failing the caller, so re-arming buys nothing — and on
      // history-end it actively hurts: it runs in the finally, after finish()
      // has told the user the run is over, so a re-arming wait would hold the
      // undo group open for half a minute. Any edit made in that window would
      // join this run's undo step, and the hotkey stays locked the whole time.
      const historyRes = await ns.callBridge(
        "history-start",
        { title: op.title },
        { waitLimit: 1 },
      );
      logId = historyRes?.ok ? historyRes.logId : null;

      const tally = {
        applied: 0,
        failed: 0,
        nodes: 0,
        skippedRoots: 0,
        skippedNodes: 0,
        driftedNodes: 0,
        skippedReplaced: 0,
        nested,
        firstAncestorIn,
        replaced: new Set(),
        multiRoot: [],
        touched: new Set(),
        expected: new Set(),
        // Snapshot of what was on the page before any insert, for the collision
        // guard in syncTemplate.
        pageIds: new Set(everything.map((c) => c.id)),
        isSkipped: await ns.getSkipMatcher(),
      };
      for (const template of selected) {
        await syncTemplate(template, targetIndex, modal, tally, op);
      }

      // Multi-root templates are supported, not a problem to be warned about:
      // the root index in the tag is what keeps them apart. Restated at the end
      // only so a long log still says which templates were kits.
      if (tally.multiRoot.length) {
        modal.note(" ");
        for (const m of tally.multiRoot) {
          const msg =
            `"${m.title}" has ${m.count} roots — each handled separately, ` +
            `tagged #${m.templateId}.1…${m.count}.`;
          modal.note(`· ${msg}`);
          ns.log("info", `${op.logName}: ${msg}`);
        }
      }

      // Every block the run left behind must still be in the document. If one
      // is not, the run destroyed something it was only meant to style or swap —
      // say so loudly with the ids, rather than leaving the user to notice a
      // container missing and have to work out which.
      const afterRes = await ns.callBridge("list-containers");
      if (afterRes?.ok) {
        const present = new Set((afterRes.containers || []).map((c) => c.id));
        const lost = [...tally.expected].filter((id) => !present.has(id));
        if (lost.length) {
          modal.note(" ");
          modal.note(
            `⚠ ${lost.length} element(s) the run acted on are gone from the document: ` +
              `${lost.join(", ")}. Ctrl+Z restores them. This is a bug — send Copy details.`,
            "error",
          );
          ns.log("error", `${op.logName}: lost element(s) ${lost.join(", ")}`);
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
        (tally.skippedReplaced
          ? `${tally.skippedReplaced} target(s) already replaced, `
          : "") +
        `${untouched} ${nested ? "node(s)" : "container(s)"} untouched`;
      ns.log(tally.applied ? "info" : "warn", `${op.logName}: ${summary}`);
      modal.finish(
        summary,
        tally.failed || tally.skippedRoots ? "warn" : "ok",
      );
    } catch (err) {
      ns.log("error", `${op.logName}: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await ns.callBridge("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  ns.syncTemplateStyles = () => runTemplateOperation(OPS.styles);
  ns.replaceWithTemplate = () => runTemplateOperation(OPS.replace);
})();
