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
  const applyPairs = async (pairs, preserve, onProgress, isCancelled) => {
    let done = 0;
    let kept = 0;
    let stopped = false;
    const failures = [];
    for (let i = 0; i < pairs.length; i += STYLE_CHUNK) {
      // A chunk is already the unit of "still alive", so it is also the natural
      // place to notice a cancel. The chunk in flight is never abandoned.
      if (isCancelled?.()) {
        stopped = true;
        break;
      }
      const chunk = pairs.slice(i, i + STYLE_CHUNK);
      onProgress?.(i + 1, pairs.length);
      const res = await ns.callBridge(
        "apply-style-pairs",
        { pairs: chunk, preserve },
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
      kept += res.kept || 0;
      for (const f of res.failures || []) failures.push(f);
    }
    return { done, kept, failures, stopped };
  };

  // Style one page container from one template root. Returns the ids to name
  // afterwards — the target itself, which styling leaves in place.
  const applyRootToTarget = async (root, target, rowId, modal, tally) => {
    const tgtRes = await ns.callBridge("describe-tree", { id: target.id });
    if (!tgtRes?.ok) {
      tally.failed++;
      modal.setRow(rowId, "error", `could not read page container — ${tgtRes?.error}`);
      // Logged as well as shown. An automated run closes this tab the moment the
      // page is done, so a failure that only ever reached the modal is a failure
      // nobody will ever read.
      ns.log(
        "warn",
        `Template sync: "${target.title}" — could not read page container: ${tgtRes?.error}`,
      );
      return null;
    }

    const paired = ns.pairTrees(root, tgtRes.tree, {
      isSkipped: tally.isSkipped,
    });
    if (!paired.ok) {
      tally.failed++;
      modal.setRow(rowId, "error", paired.error);
      ns.log("warn", `Template sync: "${target.title}" — ${paired.error}`);
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

    const { done, kept, failures, stopped } = await applyPairs(
      paired.pairs,
      tally.preserve,
      (i, total) => modal.setRow(rowId, "running", `styling ${i}/${total}`),
      () => modal.cancelled(),
    );
    const skipped = paired.skipped || [];
    const missing = paired.missing || [];
    const extra = paired.extra || [];
    const drifted = missing.length + extra.length;
    tally.applied++;
    tally.nodes += done;
    tally.keptOwn += kept;
    tally.skippedNodes += skipped.length;
    tally.driftedNodes += drifted;
    tally.touched.add(target.id);
    modal.setRow(
      rowId,
      failures.length || drifted || stopped ? "warn" : "ok",
      (stopped ? "cancelled — " : "") +
        `${done}/${paired.pairs.length} node(s) styled` +
        (kept ? `, ${kept} kept own values` : "") +
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
        `${n} container(s) match a template root. Untick any you want to leave alone.`,
      logName: "Template sync",
      run: applyRootToTarget,
      // Only the styling operation pastes anything to hold back. A replace
      // swaps the content wholesale, so the page node's own values go with the
      // rest of it and there is nothing here to offer.
      //
      // `groups` names PRESERVE_GROUPS entries in page-bridge.js, which resolve
      // to control keys against each target's own live control list; `note` is
      // what the run logs when the option is on. Add a fourth option by adding a
      // row here rather than by growing a list at the call site.
      //
      // "background" is a superset of the image and overlay groups, so both
      // being on is not a conflict — preserveKeysFor walks each control once
      // however many groups claim it.
      toggles: [
        {
          key: "keepBackground",
          label: "Keep background image & overlay",
          // Each hint describes only its own toggle. This one used to end "colour
          // and gradient still sync", which stopped being true the moment the
          // broader option below defaulted to on.
          hint: "The image, how it is framed, and the overlay.",
          default: true,
          groups: ["background-image", "background-overlay"],
          note: "Keeping each page node's own background image and overlay",
        },
        {
          key: "keepAllBackground",
          label: "Keep all background styles",
          hint: "Also colour, gradient, video and slideshow.",
          default: true,
          groups: ["background"],
          note: "Keeping each page node's whole background",
        },
        {
          key: "keepAnimations",
          label: "Keep animations",
          hint: "Motion effects, sticky and entrance animation.",
          default: true,
          groups: ["motion-effects"],
          note: "Keeping each page node's own motion effects and animations",
        },
      ],
    },
    replace: {
      title: "Replace With Template",
      button: "Replace",
      prompt: (n) =>
        `${n} container(s) match a template root. Untick any you want to leave ` +
        `alone — replacing deletes the container's current content.`,
      logName: "Template replace",
      run: replaceRootIntoTarget,
    },
  };

  // Which page nodes one template root acts on. Both the confirm checklist and
  // the run itself go through here, and that is the point: the checklist promises
  // a set of containers and the run has to act on exactly that set. Two copies of
  // this rule drifting apart would mean a modal that lies.
  //
  // It reads `title` and the element type off the root, which is all a JSON root
  // from prefetch and a live describe-tree node have in common — so the checklist
  // can be built before anything is inserted.
  const resolveTargets = ({ templateId, root, rootNo, rootCount, index, nested }) => {
    const rootName = root.title || "";
    const usableName =
      !!rootName && !GENERIC_ROOT_NAMES.has(ns.normalizeName(rootName));
    const multi = rootCount > 1;

    // The tag first: it is the exact link, and it is what makes an unnamed root
    // usable at all. A multi-root template looks for its own root index; a
    // single-root one accepts the bare tag and "#id.1" alike, so a template that
    // has since lost roots still finds its blocks.
    const tagKeys = multi
      ? [templateTagKey(templateId, rootNo)]
      : [templateTagKey(templateId), templateTagKey(templateId, 1)];
    let targets = tagKeys.flatMap((k) => index.byTag.get(k) || []);
    const viaTag = targets.length > 0;
    // Nothing tagged: match on the root's name, which is what a hand-built
    // container has.
    if (!targets.length && usableName) {
      targets = index.byName.get(ns.normalizeName(rootName)) || [];
    }

    // Scanning the whole page needs the extra precision of a type check; at top
    // level the candidate set is tiny and a type clash is more useful reported
    // as a pairing failure than silently dropped.
    const want = ns.nodeType(root);
    let dropped = 0;
    if (nested) {
      const before = targets.length;
      targets = targets.filter((c) => ns.nodeType(c) === want);
      dropped = before - targets.length;
      // Outermost first, so an ancestor is replaced before its descendants are
      // considered (and then skipped as already gone).
      targets = targets.slice().sort((a, b) => a.depth - b.depth);
    }

    return {
      targets,
      viaTag,
      dropped,
      want,
      usableName,
      rootName,
      multi,
      tagName: `#${tagKeys.join(" / #")}`,
    };
  };

  // How a root is named in the log and on a checklist row. A kit's roots all
  // share the template's title, so the root index is what tells them apart.
  const rootLabel = (title, rootNo, rootName, multi) =>
    multi
      ? `"${title}" root ${rootNo}${rootName ? ` ("${rootName}")` : ""}`
      : `"${title}"`;

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
      ns.log(
        "error",
        `${op.logName}: "${template.title}" — inserted copy re-used id(s) already on ` +
          `this page (${collisions.join(", ")}); nothing was touched`,
      );
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
        ns.log(
          "error",
          `${op.logName}: "${template.title}" — insert produced no elements`,
        );
        return;
      }

      // Cancelled while the insert was in flight. It had to be awaited — an
      // abandoned insert is an orphan nobody is expecting — but nothing else
      // needs doing, and the finally below still removes the staging copy.
      if (modal.cancelled()) return;

      const srcTrees = await Promise.all(
        insertedIds.map((id) => ns.callBridge("describe-tree", { id })),
      );
      const multi = insertedIds.length > 1;
      // The checklist was built from the template's JSON roots; the run works
      // from the roots the import actually produced. They are the same list in
      // every observed case, and if they ever are not the root indexes have
      // shifted — so "#id.2" now names a different block than the row promised.
      // The allowed set stops an unlisted container being touched, but nothing
      // stops the wrong root reaching a listed one, so say it.
      const planned = tally.plannedRoots.get(String(template.templateId));
      if (planned && planned.length !== insertedIds.length) {
        modal.note(
          `⚠ "${template.title}" — the confirm list was built from ${planned.length} root(s) ` +
            `but the insert produced ${insertedIds.length}. Root numbering may not line up ` +
            `with what was listed; check the result and re-run if it looks wrong.`,
          "warn",
        );
        ns.log(
          "warn",
          `${op.logName}: "${template.title}" planned ${planned.length} roots, inserted ${insertedIds.length}`,
        );
      }
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
        if (modal.cancelled()) break;
        const res = srcTrees[i];
        if (!res?.ok) {
          tally.failed++;
          ns.log(
            "warn",
            `${op.logName}: "${template.title}" root ${i + 1} — could not read: ${res?.error}`,
          );
          modal.note(
            `✕ "${template.title}" root ${i + 1} — could not read: ${res?.error}`,
            "error",
          );
          continue;
        }
        const root = res.tree;
        const rootNo = i + 1;
        const {
          targets,
          viaTag,
          dropped,
          want,
          usableName,
          rootName,
          tagName,
        } = resolveTargets({
          templateId: template.templateId,
          root,
          rootNo,
          rootCount: insertedIds.length,
          index: targetIndex,
          nested: tally.nested,
        });
        const label = rootLabel(template.title, rootNo, rootName, multi);
        if (dropped) {
          modal.note(
            `· ${label} — ${dropped} ${viaTag ? "id tag" : "name"} match(es) skipped, not a "${want}"`,
          );
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
          if (modal.cancelled()) break;
          // The checklist is one row per container, so a container the user
          // unticked is simply not acted on — by any root, from any template.
          // This is also the net for a plan/run disagreement: a target the
          // checklist never offered is not in the set, so the run can only ever
          // do less than it promised, never more.
          if (!tally.allowed.has(target.id)) continue;
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

  // `auto` is the Automation window's entry point. It supplies exactly what the
  // confirm checklist would have collected — which templates are in scope, the
  // nested toggle, the preserve toggles — and makes the run resolve to a summary
  // instead of only drawing one.
  //
  // The confirm is skipped there and nowhere else. CLAUDE.md's rule that it is
  // always shown is a rule about a *hotkey*, where the keypress is the only thing
  // the user said. An automation run has already been specified page by page and
  // template by template in its own GUI, and re-asking inside each of a hundred
  // editor tabs would not make it safer — it would make it impossible.
  const runTemplateOperation = async (op, auto = null) => {
    if (running) {
      ns.log("warn", `${op.logName}: already running`);
      return { ok: false, error: "a template run is already in progress" };
    }
    running = true;

    const modal = ns.openProgressModal(op.title, { id: MODAL_ID });
    let logId = null;
    try {
      // ESC or Cancel from the first moment, because the accidental keypress this
      // exists for is noticed during the fetch below. Nothing is on the page yet,
      // so a cancel here is free.
      modal.allowCancel();
      // Cancelled before anything was written. Said plainly, because "cancelled"
      // and "cancelled but it already changed things" are very different facts.
      const cancelledEarly = () => {
        ns.log("info", `${op.logName}: cancelled`);
        modal.finish("Cancelled — nothing was changed.", "warn");
        return { ok: false, cancelled: true };
      };

      modal.setStatus("Fetching site templates…");
      const templatesRes = await ns.untilCancelled(
        ns.listSiteTemplates({ onWait: waitNote(modal) }),
        modal,
      );
      if (templatesRes === ns.CANCELLED) return cancelledEarly();
      if (!templatesRes?.ok) {
        ns.log("warn", `${op.logName}: ${templatesRes?.error}`);
        modal.finish(`Could not fetch templates — ${templatesRes?.error}`, "error");
        return { ok: false, error: String(templatesRes?.error || "fetch failed") };
      }
      const all = templatesRes.templates || [];
      const { byName, byId, ambiguous } = buildTemplateIndex(all);

      modal.setStatus(`Found ${all.length} template(s). Reading page containers…`);
      const pageRes = await ns.untilCancelled(
        ns.callBridge("list-containers"),
        modal,
      );
      if (pageRes === ns.CANCELLED) return cancelledEarly();
      if (!pageRes?.ok) {
        ns.log("warn", `${op.logName}: ${pageRes?.error}`);
        modal.finish(`Could not read page — ${pageRes?.error}`, "error");
        return { ok: false, error: String(pageRes?.error || "page read failed") };
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

      // Every template that could be involved under *either* toggle state, so
      // the roots below are fetched once and flipping the toggle needs no
      // network. `nested: true` searches the whole page, and its pool contains
      // the top-level one, so this is the superset.
      const candidates = buildQueue({ nested: true });

      if (!candidates.length) {
        modal.note(
          `Top containers: ${topLevel.map((c) => `"${c.title || "(unnamed)"}"`).join(", ") || "none"}`,
        );
        modal.finish(
          `No matches. ${topLevel.length} top container(s), ` +
            `${everything.length} node(s) in total, ${all.length} template(s).`,
          "warn",
        );
        ns.log("info", `${op.logName}: no template matches`);
        // Must return a value, not fall off the end. An automation run reads this
        // result, and `undefined` there is indistinguishable from "the tool is not
        // loaded in this tab" — which is exactly how it was reported once.
        return {
          ok: true,
          applied: 0,
          failed: 0,
          targets: 0,
          summary: `no template matches (${topLevel.length} top container(s), ${all.length} template(s))`,
        };
      }

      // The checklist is one row per page container, and only a template's roots
      // say which containers it reaches — so the content has to be in hand before
      // the confirm, not after it. This is the same prefetch the inserts want
      // anyway, asked one step earlier and for the whole match set rather than
      // just the ticked part: the price of listing targets is fetching templates
      // the user may then untick. Still only matched templates, never the library.
      // Outside the history log on purpose: nothing here changes the document.
      modal.setStatus(
        `Reading ${candidates.length} matched template(s), ${ns.PREFETCH_CONCURRENCY} at a time…`,
      );
      const pre = await ns.untilCancelled(
        ns.prefetchTemplates(candidates, {
          onWait: waitNote(modal),
          withRoots: true,
        }),
        modal,
      );
      if (pre === ns.CANCELLED) return cancelledEarly();
      const rootsById = new Map(
        (pre.roots || []).map((r) => [String(r.templateId), r.roots || []]),
      );
      // Unlike a plain warm, a failure here is not just slower — that template
      // contributes no rows, so it has to be said out loud rather than left to
      // look like "nothing matched".
      for (const f of pre.failed || []) {
        modal.note(
          `⚠ could not read template #${f.templateId} — ${f.error}. It is not listed below.`,
          "warn",
        );
      }

      // Notes about roots that reach nothing. Collected while planning but held
      // back until the confirm resolves: buildPlan re-runs on every toggle flip,
      // and the run itself reports the roots that *do* have targets.
      let planNotes = [];

      // One row per page container, in document order. A container matched by
      // more than one root — or by two different templates, which is legal —
      // is still one row: ticking is a statement about the container.
      const buildPlan = (toggleState) => {
        const nested = !!toggleState.nested;
        const index = nested
          ? { byName: allByName, byTag: allByTag }
          : { byName: topByName, byTag: topByTag };
        const notes = [];
        const byTarget = new Map();

        for (const template of buildQueue({ nested })) {
          const roots = rootsById.get(String(template.templateId));
          if (!roots?.length) continue;
          const multi = roots.length > 1;
          roots.forEach((root, i) => {
            const rootNo = i + 1;
            const { targets, viaTag, usableName, rootName, tagName } =
              resolveTargets({
                templateId: template.templateId,
                root,
                rootNo,
                rootCount: roots.length,
                index,
                nested,
              });
            const label = rootLabel(template.title, rootNo, rootName, multi);
            if (!targets.length) {
              const tagPart = viaTag
                ? `the ${tagName} tag only matched other element types`
                : `nothing is tagged ${tagName}`;
              notes.push({
                templateId: String(template.templateId),
                level: usableName ? "info" : "warn",
                text: usableName
                  ? `· ${label} — ${tagPart}, and no page container named "${rootName}"`
                  : `⚠ ${label} — root layer is ${rootName ? `named "${rootName}"` : "unnamed"} ` +
                    `and ${tagPart} on the page, so it matches nothing. ` +
                    `Name the root inside the template, or insert it once to tag the page. Skipped.`,
              });
              return;
            }
            for (const target of targets) {
              let row = byTarget.get(target.id);
              if (!row) {
                row = { target, acts: [], label: "" };
                byTarget.set(target.id, row);
              }
              row.acts.push({ template, rootNo, multi });
            }
          });
        }

        planNotes = notes;
        const order = new Map(everything.map((c, i) => [c.id, i]));
        const rows = [...byTarget.values()].sort(
          (a, b) => order.get(a.target.id) - order.get(b.target.id),
        );

        // "TW Card" → "Card" reads identically for three sibling cards, and an
        // ambiguous checklist is worse than none because unticking the wrong row
        // is silent. Number the repeats in document order, as template-decouple
        // does for the same reason.
        for (const r of rows) {
          const froms = [
            ...new Set(
              r.acts.map((a) =>
                a.multi
                  ? `"${a.template.title}" root ${a.rootNo}`
                  : `"${a.template.title}"`,
              ),
            ),
          ];
          r.label = `${froms.join(" + ")} → ${r.target.title ? `"${r.target.title}"` : "(unnamed)"}`;
        }
        const total = new Map();
        for (const r of rows) total.set(r.label, (total.get(r.label) || 0) + 1);
        const seen = new Map();
        for (const r of rows) {
          const n = total.get(r.label);
          if (n < 2) continue;
          const k = (seen.get(r.label) || 0) + 1;
          seen.set(r.label, k);
          r.label = `${r.label} (${k} of ${n})`;
        }
        return rows;
      };

      if (!buildPlan({ nested: true }).length) {
        for (const n of planNotes) modal.note(n.text, n.level);
        modal.finish(
          `No container matched a template root. ` +
            `${candidates.length} template(s) matched by title or tag, but none of ` +
            `their roots resolved to a container on this page.`,
          "warn",
        );
        ns.log("info", `${op.logName}: no root matched a container`);
        return {
          ok: true,
          applied: 0,
          failed: 0,
          targets: 0,
          summary: "no root matched a container",
        };
      }

      // The run's template allowlist, and it gates BOTH halves of an automation
      // run: a template outside it is never inserted here, and edge-presets.js
      // filters its presets against the same list. Empty means no allowlist,
      // which is what the interactive path always passes.
      const allow = new Set((auto?.templateIds || []).map(String));

      // One definition of the toggles for both paths. The automation sends a
      // key → boolean map and anything it omits falls back to that row's own
      // `default`, so the group names stay in OPS where they belong and a drifted
      // key degrades to the recommended state rather than silently to "off".
      const toggleRows = [
        {
          key: "nested",
          label: "Match nested containers",
          hint: "Whole page, not just top level. Root name + type must match.",
          default: false,
        },
        ...(op.toggles || []),
      ];

      let chosen;
      let toggleState;
      if (auto) {
        toggleState = {};
        for (const t of toggleRows) {
          toggleState[t.key] =
            auto.toggles && t.key in auto.toggles
              ? !!auto.toggles[t.key]
              : !!t.default;
        }
        const full = buildPlan({ nested: !!toggleState.nested });
        chosen = allow.size
          ? full.filter((r) =>
              r.acts.some((a) => allow.has(String(a.template.templateId))),
            )
          : full;
        modal.setStatus(
          `Automation: ${chosen.length} of ${full.length} container(s) in scope`,
        );
        // Not a failure. Most pages in a site-wide run legitimately hold none of
        // the templates being updated, and saying so plainly is what keeps the
        // automation's log readable.
        if (!chosen.length) {
          const why = "no container matched a template in this run's allowlist";
          ns.log("info", `${op.logName}: ${why}`);
          modal.finish(`Nothing to do — ${why}.`, "warn");
          return { ok: true, applied: 0, failed: 0, targets: 0, summary: why };
        }
      } else {
        modal.setStatus(op.prompt(buildPlan({ nested: false }).length));
        const choice = await modal.choose({
          buildItems: buildPlan,
          labelOf: (r) => r.label,
          buttonText: op.button,
          toggles: toggleRows,
        });
        if (!choice) {
          ns.log("info", `${op.logName}: cancelled`);
          modal.close();
          return { ok: false, cancelled: true };
        }
        chosen = choice.items;
        toggleState = choice.toggles;
      }
      // The chooser took the button row and the Escape key for its own Cancel,
      // so the run has to arm its own again.
      modal.allowCancel();
      const nested = !!toggleState.nested;
      // Every ticked option's groups, in one list. Duplicates between overlapping
      // groups cost nothing page-side, so no attempt is made to fold them.
      const preserve = (op.toggles || []).flatMap((t) =>
        toggleState[t.key] ? t.groups || [] : [],
      );
      const plan = buildPlan({ nested });
      const targetIndex = nested
        ? { byName: allByName, byTag: allByTag }
        : { byName: topByName, byTag: topByTag };

      // The ticked containers, and the templates that reach at least one of
      // them. A template whose every target was unticked is not inserted at all,
      // so unticking still saves the whole round trip it used to.
      const allowed = new Set(chosen.map((r) => r.target.id));
      const wanted = new Set();
      for (const r of chosen) {
        for (const a of r.acts) {
          // One ticked container can be reached by several templates — by id tag
          // from one and by name from another. Under an allowlist only the
          // allowed ones are inserted for it.
          if (allow.size && !allow.has(String(a.template.templateId))) continue;
          wanted.add(a.template.templateId);
        }
      }
      const selected = buildQueue({ nested }).filter((t) =>
        wanted.has(t.templateId),
      );

      // Now the toggle state is final, so the roots that reach nothing can be
      // reported — but only for templates the run will never touch. A template
      // that IS being inserted reports every one of its roots itself, from the
      // live insert, and saying it twice is worse than saying it once.
      const runIds = new Set(selected.map((t) => String(t.templateId)));
      let unlistedRoots = 0;
      for (const n of planNotes) {
        if (runIds.has(n.templateId)) continue;
        modal.note(n.text, n.level);
        if (n.level === "warn") unlistedRoots++;
      }
      if (nested) {
        modal.note(`· Matching nested containers (name + type)`);
      }
      // A preserved value is a value the template asked for and did not get, so
      // each option that is on says so before the run rather than leaving the
      // result looking like a clean sync.
      for (const t of op.toggles || []) {
        if (toggleState[t.key] && t.note) modal.note(`· ${t.note}`);
      }
      if (chosen.length < plan.length) {
        modal.note(
          `· ${plan.length - chosen.length} container(s) unticked and skipped`,
        );
      }

      // Cancelled while reading the notes above. Nothing has been written, so
      // there is no point opening a history log to hold an empty run.
      if (modal.cancelled()) return cancelledEarly();

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
        // Seeded with the roots that never made the checklist, which the run
        // will never mention. The run adds its own, and the two sets cannot
        // overlap: it only counts templates in `selected`, which are exactly
        // the ones excluded above.
        skippedRoots: unlistedRoots,
        allowed,
        plannedRoots: rootsById,
        skippedNodes: 0,
        driftedNodes: 0,
        skippedReplaced: 0,
        keptOwn: 0,
        nested,
        preserve,
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
      let attempted = 0;
      for (const template of selected) {
        if (modal.cancelled()) break;
        attempted++;
        await syncTemplate(template, targetIndex, modal, tally, op);
      }
      // A cancelled run is still one undo step, so say so — the alternative is
      // the user hunting for which half of it landed.
      const stopped = modal.cancelled();
      if (stopped) {
        modal.note(" ");
        modal.note(
          `⚠ cancelled — ${selected.length - attempted} of ${selected.length} ` +
            `template(s) were never started. Ctrl+Z undoes everything this run did.`,
          "warn",
        );
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
      const afterRes = tally.expected.size
        ? await ns.callBridge("list-containers")
        : null;
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
        (tally.keptOwn ? `${tally.keptOwn} node(s) kept own values, ` : "") +
        (tally.skippedNodes ? `${tally.skippedNodes} node(s) skipped, ` : "") +
        (tally.driftedNodes ? `${tally.driftedNodes} node(s) unmatched, ` : "") +
        (tally.skippedRoots ? `${tally.skippedRoots} root(s) skipped, ` : "") +
        (tally.skippedReplaced
          ? `${tally.skippedReplaced} target(s) already replaced, `
          : "") +
        `${untouched} ${nested ? "node(s)" : "container(s)"} untouched`;
      const outcome = stopped ? `Cancelled — ${summary}` : summary;
      ns.log(tally.applied ? "info" : "warn", `${op.logName}: ${outcome}`);
      modal.finish(
        outcome,
        stopped || tally.failed || tally.skippedRoots ? "warn" : "ok",
      );
      return {
        ok: true,
        cancelled: stopped,
        applied: tally.applied,
        failed: tally.failed,
        nodes: tally.nodes,
        targets: chosen.length,
        summary,
      };
    } catch (err) {
      ns.log("error", `${op.logName}: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
      return { ok: false, error: String(err?.message || err) };
    } finally {
      if (logId !== null && logId !== undefined) {
        await ns.callBridge("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  // `auto` is the Automation window's option bag. The hotkey and the panel's Run
  // button both call these with nothing and get the confirm checklist — the
  // keydown path passes the event to its runner, which drops it, so an accidental
  // keypress can never arrive here looking like an automation run.
  ns.syncTemplateStyles = (auto) => runTemplateOperation(OPS.styles, auto);
  ns.replaceWithTemplate = (auto) => runTemplateOperation(OPS.replace, auto);
})();
