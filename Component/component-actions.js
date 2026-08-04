// Component system — the three operations a user actually runs.
//
//   newComponent()    turn the open template's root into a component base
//   createInstance()  drop a copy of a component into this document, linked
//   syncComponents()  pull parent changes into this document's instances
//
// Every one of them touches the network, so every one opens its modal BEFORE
// the first await — the rule CLAUDE.md states and the reason template-sync
// looks the way it does.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorComponents = window.__ElementorComponents || {});
  const fmt = window.__ElementorComponentFormat;
  const tools = window.__ElementorTools;
  if (!fmt || !tools) return;

  const MODAL_ID = "ElementorComponents-modal";

  // One operation at a time. Two syncs over one document would interleave
  // structural edits against indices the other is changing.
  let running = false;

  // How many nodes go page-side per settings call. The page world cannot yield
  // mid-op, so a whole large component in one message freezes the tab with no
  // sign of progress. Same reasoning as STYLE_CHUNK in template-sync.js.
  const NODE_CHUNK = 20;
  const chunkTimeout = (n) => 5000 + n * 400;

  const waitNote = (modal) => (info) =>
    modal.note(
      `· still waiting on ${info.op} — ${Math.round(info.waited / 1000)}s so far, not giving up`,
      "warn",
    );

  const call = (op, payload, opts) => ns.callBridge(op, payload, opts);

  /* ------------------------------------------------------------ new component */

  // A base is authored in a template editor: the template's root container
  // becomes the component, and its content becomes the definition.
  const newComponent = async () => {
    if (running) return;
    running = true;
    const modal = tools.openProgressModal("New Component", { id: MODAL_ID });
    try {
      modal.setStatus("Reading document…");
      const info = await call("doc-info");
      if (!info?.ok) {
        modal.finish(`Could not read the document — ${info?.error}`, "error");
        return;
      }
      if (!info.isTemplateEditor) {
        modal.finish(
          "A component base has to be created in an Elementor template, not on a page. " +
            "Save this block as a template first, then open it and try again.",
          "error",
        );
        return;
      }
      // The single-root rule. A template with several roots has no one
      // container that is "the component", and guessing would silently make a
      // component out of whichever happened to be first.
      if (info.rootCount !== 1) {
        modal.finish(
          `This template has ${info.rootCount} root containers. A component needs exactly one — ` +
            `wrap the content in a single container and try again.`,
          "error",
        );
        return;
      }

      const scanRes = await call("scan");
      if (!scanRes?.ok) {
        modal.finish(`Could not scan the document — ${scanRes?.error}`, "error");
        return;
      }
      const rootLevel = (scanRes.components || []).filter((c) => c.depth === 0);
      if (rootLevel.length) {
        const existing = rootLevel[0].payload;
        modal.finish(
          `This template is already a component ("${existing?.name}", ${existing?.role}).`,
          "warn",
        );
        return;
      }

      const rootId = info.rootId;
      if (!rootId) {
        modal.finish(
          "Could not identify the root container to attach component data to.",
          "error",
        );
        return;
      }

      // Named after the TEMPLATE, not after the root container's layer name.
      // Those are different things and the layer name is usually the one the
      // user never set — a fresh container reports "" or "Container", which is
      // what made every new component read as untitled.
      //
      // Seeded once and then independent: renaming the component afterwards
      // changes only comp-data, and the template post keeps its own title. The
      // two are allowed to drift, which is why this is a fallback chain rather
      // than a live mirror.
      const payload = fmt.emptyBase({
        name:
          info.postTitle ||
          info.roots?.[0]?.title ||
          `Component ${info.postId}`,
        templateId: info.postId,
      });

      modal.setStatus("Creating the component data widget…");

      const created = await call("create-comp-widget", { intoId: rootId, payload });
      if (!created?.ok) {
        modal.finish(`Could not create the data widget — ${created?.error}`, "error");
        return;
      }

      ns.log("info", `Component created: "${payload.name}" (${payload.id})`);
      modal.note(`· data widget ${created.widgetId} added to ${rootId}`);
      modal.note(`· component id ${payload.id}`);
      modal.finish(
        `Component created. Publish this template so instances can resolve against it.`,
        "ok",
      );
      ns.navigator?.refresh?.();
    } catch (err) {
      ns.log("error", `New component: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      running = false;
    }
  };

  /* --------------------------------------------------------- create instance */

  // Strip the parent's own data widget out of the JSON before it is copied: the
  // instance writes its own, and copying the parent's would give two components
  // the same identity.
  const withoutCompWidget = (node) => {
    const clone = JSON.parse(JSON.stringify(node));
    const strip = (n) => {
      if (!Array.isArray(n.elements)) return;
      n.elements = n.elements.filter(
        (k) =>
          !(k?.widgetType === "html" && (k?.settings?._title || "") === fmt.COMP_WIDGET_TITLE),
      );
      n.elements.forEach(strip);
    };
    strip(clone);
    return clone;
  };

  // Everything that has to be true before a component can be inserted, with no
  // writes. Split out because the single insert and the batch picker have to
  // agree about it exactly — a check that ran on one path and not the other is
  // how a self-referencing insert would get through.
  const prepareInsert = async (templateId, currentPostId) => {
    let tpl;
    try {
      tpl = await ns.fetchTemplate(templateId);
    } catch (err) {
      return { ok: false, error: `could not fetch the template — ${err?.message || err}` };
    }

    const found = ns.findComponentRoot(tpl.elements);
    if (!found?.payload) {
      return {
        ok: false,
        error: `"${tpl.title}" is not a component — it has no ${fmt.COMP_WIDGET_TITLE} widget.`,
      };
    }

    // A component cannot contain itself. collectChain refuses the loop anyway,
    // but the direct case deserves a message that names what went wrong.
    if (currentPostId && String(currentPostId) === String(templateId)) {
      return { ok: false, error: "that component cannot be inserted into itself" };
    }

    const { chain, cycle } = await ns.collectChain(templateId);
    if (cycle) {
      return {
        ok: false,
        error: `the component chain loops back on template ${cycle} — refusing to insert`,
      };
    }
    return { ok: true, tpl, found, chain };
  };

  // The writes. Assumes prepareInsert already passed and a history log is open.
  const materialiseInstance = async ({ templateId, tpl, found, chain, intoId }) => {
    const body = withoutCompWidget(found.rootNode);
    const inserted = await call(
      "insert-nodes",
      { intoId, nodes: [body] },
      { timeout: 15000 },
    );
    if (!inserted?.ok || !inserted.ids?.length) {
      return { ok: false, error: inserted?.error || "no elements created" };
    }

    const newRootId = inserted.ids[0];
    // insert-nodes returns the old -> new id map, and that map IS the
    // instance's parentNodeId -> instanceNodeId map. Nothing has to be
    // reconstructed by name or position later, which is the whole reason
    // instances are created through this path rather than by hand.
    const map = { ...(inserted.idMap || {}) };

    const payload = fmt.emptyInstance({
      name: found.payload.name || tpl.title,
      parentTemplateId: String(templateId),
      parentComponentId: found.payload.id,
    });
    payload.map = map;
    payload.syncedAgainst = chain;

    const widget = await call("create-comp-widget", { intoId: newRootId, payload });
    if (!widget?.ok) {
      return {
        ok: false,
        rootId: newRootId,
        unlinked: true,
        error:
          `the content was inserted but its component data widget failed — ` +
          `${widget?.error}. This block is an unlinked copy; delete it and try again.`,
      };
    }
    return { ok: true, rootId: newRootId, payload, mapped: Object.keys(map).length };
  };

  const createInstance = async ({ templateId, intoId = null } = {}) => {
    if (running) return;
    if (!templateId) return;
    running = true;
    const modal = tools.openProgressModal("Insert Component", { id: MODAL_ID });
    let logId = null;
    try {
      modal.setStatus(`Fetching component template ${templateId}…`);
      const info = await call("doc-info");
      const prepared = await prepareInsert(templateId, info?.ok ? info.postId : null);
      if (!prepared.ok) {
        modal.finish(prepared.error, "error");
        return;
      }

      modal.setStatus("Inserting…");
      const hist = await call("history-start", { title: "Insert component" }, { waitLimit: 1 });
      logId = hist?.ok ? hist.logId : null;

      const made = await materialiseInstance({ templateId, intoId, ...prepared });
      if (!made.ok) {
        if (made.unlinked) {
          modal.note(`⚠ ${made.error}`, "error");
          modal.finish("Inserted, but not linked.", "warn");
        } else {
          modal.finish(`Insert failed — ${made.error}`, "error");
        }
        return;
      }

      ns.log(
        "info",
        `Component instance created from template ${templateId} (${made.mapped} nodes mapped)`,
      );
      modal.note(`· root ${made.rootId}, ${made.mapped} node(s) mapped`);
      modal.finish(`Inserted "${made.payload.name}".`, "ok");

      // The new instance has no resolved values cached yet, so a save before
      // this lands would leave its overrides untouched — correct, but it also
      // means no overrides would be recorded. Warm it now.
      await ns.warmResolved({ quiet: true });
      ns.navigator?.refresh?.();
    } catch (err) {
      ns.log("error", `Insert component: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await call("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  /* --------------------------------------------------------- insert, by name

     Pick components from a list rather than typing a template id. The list is
     built by scanning the template library for data widgets, because "which
     templates are components" is not something Elementor's own library
     endpoint can answer — it knows titles and types, not payloads.

     Scoped to elementor_library on purpose: only a template can ever be a
     parent, so a whole-site scan would spend minutes finding rows this picker
     is not allowed to offer. */

  const insertComponents = async ({ intoId = null } = {}) => {
    if (running) return;
    running = true;
    const modal = tools.openProgressModal("Insert Component", { id: MODAL_ID });
    let logId = null;
    try {
      // Modal first, then the await — the network round trip below is exactly
      // the wait CLAUDE.md's rule exists for.
      modal.setStatus("Scanning the template library for components…");
      const index = window.__ElementorComponentIndex;
      if (!index) {
        modal.finish(
          "Component/component-index.js did not load — check content_scripts order in manifest.json.",
          "error",
        );
        return;
      }
      const listed = await index.listComponentTemplates();
      if (!listed?.ok) {
        modal.finish(`Could not list components — ${listed?.error}`, "error");
        return;
      }
      for (const w of listed.warnings || []) modal.note(`⚠ ${w}`, "warn");

      const info = await call("doc-info");
      const here = info?.ok ? String(info.postId) : null;
      // A template cannot be inserted into itself, so it is removed from the
      // list rather than offered and then refused.
      const available = (listed.templates || []).filter(
        (t) => !here || String(t.templateId) !== here,
      );
      if (!available.length) {
        modal.finish(
          "No component templates on this site yet. Open a template, then use New Component.",
          "warn",
        );
        return;
      }

      const choice = await modal.choose({
        buildItems: () => available,
        labelOf: (t) => {
          const bits = [t.role];
          if (t.status && t.status !== "publish") bits.push(t.status);
          if (t.overrideCount) bits.push(`${t.overrideCount} override(s)`);
          return `"${t.name}" — ${bits.join(", ")} · template ${t.templateId}`;
        },
        buttonText: "Insert",
        toggles: [],
      });
      if (!choice) {
        modal.close();
        return;
      }
      const selected = choice.items;
      if (!selected.length) {
        modal.finish("Nothing selected.", "warn");
        return;
      }

      // Whole batch is one undo step, like every other batch in this toolset.
      const hist = await call(
        "history-start",
        { title: "Insert components" },
        { waitLimit: 1 },
      );
      logId = hist?.ok ? hist.logId : null;

      for (const t of selected) modal.addRow(String(t.templateId), `"${t.name}"`);

      let inserted = 0;
      let failed = 0;
      for (const t of selected) {
        const rowId = String(t.templateId);
        modal.setRow(rowId, "running", "preparing");
        const prepared = await prepareInsert(t.templateId, here);
        if (!prepared.ok) {
          failed++;
          modal.setRow(rowId, "error", prepared.error);
          continue;
        }
        modal.setRow(rowId, "running", "inserting");
        const made = await materialiseInstance({
          templateId: t.templateId,
          intoId,
          ...prepared,
        });
        if (!made.ok) {
          failed++;
          modal.setRow(rowId, made.unlinked ? "warn" : "error", made.error);
          continue;
        }
        inserted++;
        modal.setRow(rowId, "ok", `root ${made.rootId}, ${made.mapped} node(s) mapped`);
      }

      await ns.warmResolved({ quiet: true });
      ns.navigator?.refresh?.();

      const summary = `${inserted} inserted` + (failed ? `, ${failed} failed` : "");
      ns.log(failed ? "warn" : "info", `Insert components: ${summary}`);
      modal.finish(summary, failed ? "warn" : "ok");
    } catch (err) {
      ns.log("error", `Insert components: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await call("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  /* ------------------------------------------------------------------- sync */

  // Drop nodes from a JSON subtree before it is inserted. Used for descendants
  // that already exist in the instance and are going to be moved into the new
  // node instead of duplicated inside it.
  const pruneJson = (json, dropIds) => {
    const clone = JSON.parse(JSON.stringify(json));
    const strip = (node) => {
      if (!Array.isArray(node.elements)) return;
      node.elements = node.elements.filter((k) => !dropIds.has(k.id));
      node.elements.forEach(strip);
    };
    strip(clone);
    return clone;
  };

  // What one instance needs done, worked out with no writes at all. Planning
  // before applying is what lets every conflict across every instance be
  // collected into ONE prompt instead of interrupting the run per node.
  const planInstance = async (component, resolvedParent) => {
    const payload = component.payload;
    const plan = {
      component,
      payload,
      resolvedParent,
      settings: [],   // { id, settings, reset }
      inserts: [],    // { json, intoInstanceId, afterInstanceId, parentNodeId }
      moves: [],      // { baseNodeId, intoBaseNodeId, afterBaseNodeId }
      deletes: [],    // { parentNodeId, instanceNodeId }
      conflicts: [],  // { parentNodeId, instanceNodeId, overrideCount }
      notes: [],
    };

    const map = payload.map || {};
    const overrides = payload.overrides || {};
    const removedByInstance = new Set(payload.structure?.removed || []);

    // What the instance currently holds, so a key the parent no longer sets can
    // be reset rather than left behind.
    const liveRes = await call("read-subtree-settings", { id: component.rootId });
    const live = new Map();
    if (liveRes?.ok) {
      for (const node of liveRes.nodes || []) live.set(node.id, node);
    }
    // Which instance elements exist right now. applyPlan needs this to refuse to
    // overwrite a mapping that still points at a live element.
    plan.liveIds = new Set(live.keys());

    const parentNodes = new Map();
    const walkParent = (node, parentOf, prevSibling) => {
      parentNodes.set(node.id, { node, parentOf, prevSibling });
      let prev = null;
      for (const kid of node.children || []) {
        walkParent(kid, node.id, prev);
        prev = kid.id;
      }
    };
    walkParent(resolvedParent.tree, null, null);

    // --- nodes the parent has -------------------------------------------------
    for (const [parentNodeId, entry] of parentNodes) {
      const instanceNodeId = map[parentNodeId];
      const parentValues = resolvedParent.values[parentNodeId] || {};

      // The instance does not have this node, deliberately. Rule: the instance
      // wins — a parent field change has nowhere to land, and re-adding the
      // node would undo the decision.
      //
      // Tested BEFORE the mapping, not after it. Two different things land in
      // structure.removed: a node the instance deleted (which was mapped, and
      // whose element is now gone) and a node "Link to Component" declared the
      // instance never had (which was never mapped at all). Requiring
      // instanceNodeId here only caught the first, so every link-time removal
      // fell through to the insert branch below and the next sync rebuilt the
      // container into the base.
      if (removedByInstance.has(parentNodeId)) continue;
      if (instanceNodeId && !live.has(instanceNodeId)) continue;

      // New in the parent — insert it.
      if (!instanceNodeId) {
        // Its own parent is not in this instance either, so it will arrive as
        // part of that ancestor's insert rather than needing one of its own.
        if (entry.parentOf && !map[entry.parentOf]) continue;
        const intoInstanceId = entry.parentOf ? map[entry.parentOf] : component.rootId;

        // Descendants of this new node that ALREADY exist in the instance must
        // be MOVED into it, never re-created. This is the "parent wrapped an
        // existing node in a new container" case: recreating the node leaves the
        // original behind as an orphan and gives the instance two of them, and
        // the id map then points at the copy instead of the node the user has
        // been editing.
        //
        // Only the topmost such node is collected — its own subtree travels with
        // it, so descending past it would move a node twice.
        const relocate = [];
        const collect = (node, isRoot) => {
          if (!isRoot) {
            const mappedTo = map[node.id];
            if (mappedTo && live.has(mappedTo)) {
              relocate.push(node.id);
              return;
            }
          }
          for (const kid of node.children || []) collect(kid, false);
        };
        collect(entry.node, true);

        for (const baseNodeId of relocate) {
          const moved = parentNodes.get(baseNodeId);
          const siblings = moved?.parentOf
            ? parentNodes.get(moved.parentOf)?.node.children || []
            : [];
          const index = siblings.findIndex((s) => s.id === baseNodeId);
          plan.moves.push({
            baseNodeId,
            intoBaseNodeId: moved?.parentOf || null,
            // Anchored to the previous sibling in the parent, which the bridge
            // resolves against the instance's live children at apply time.
            afterBaseNodeId: index > 0 ? siblings[index - 1].id : null,
          });
        }

        plan.inserts.push({
          parentNodeId,
          json: pruneJson(entry.node.json, new Set(relocate)),
          intoInstanceId,
          afterInstanceId: entry.prevSibling ? map[entry.prevSibling] || null : null,
          relocated: relocate.length,
        });
        continue;
      }

      // Present on both sides — merge field by field.
      const nodeOverrides = overrides[parentNodeId] || {};
      const liveNode = live.get(instanceNodeId);

      // The parent moved this node between two containers that both already
      // exist here. Same family as the wrap case, and just as invisible without
      // an explicit check: nothing about the node's own settings changed, so a
      // field-only merge reports "in sync" while the instance keeps the old
      // layout. Only relocate when the expected parent is resolvable — if it is
      // not mapped yet it is arriving in this same run, and that insert places
      // the node itself.
      const expectedInstanceParent = entry.parentOf
        ? map[entry.parentOf]
        : component.rootId;
      if (
        expectedInstanceParent &&
        liveNode?.parentId &&
        liveNode.parentId !== expectedInstanceParent
      ) {
        const siblings = entry.parentOf
          ? parentNodes.get(entry.parentOf)?.node.children || []
          : [];
        const index = siblings.findIndex((s) => s.id === parentNodeId);
        plan.moves.push({
          baseNodeId: parentNodeId,
          intoBaseNodeId: entry.parentOf || null,
          afterBaseNodeId: index > 0 ? siblings[index - 1].id : null,
        });
      }
      const toWrite = {};
      const toReset = [];

      for (const [key, value] of Object.entries(parentValues)) {
        if (fmt.NEVER_INHERIT.has(key)) continue;
        // An overridden field keeps the instance's value. That is the point of
        // the whole system.
        if (key in nodeOverrides) continue;
        if (!fmt.valuesEqual(liveNode?.settings?.[key], value)) {
          toWrite[key] = value;
        }
      }
      // A key the instance still carries that the parent no longer sets, and
      // that is not overridden, has to go back to default — otherwise removing
      // a value in the parent would never propagate.
      for (const key of Object.keys(liveNode?.settings || {})) {
        if (fmt.NEVER_INHERIT.has(key)) continue;
        if (key in nodeOverrides) continue;
        if (key in parentValues) continue;
        toReset.push(key);
      }

      if (Object.keys(toWrite).length || toReset.length) {
        plan.settings.push({
          id: instanceNodeId,
          settings: toWrite,
          reset: toReset,
        });
      }
    }

    // --- nodes the parent no longer has --------------------------------------
    for (const [parentNodeId, instanceNodeId] of Object.entries(map)) {
      if (parentNodes.has(parentNodeId)) continue;
      if (!live.has(instanceNodeId)) continue; // already gone from the instance

      const overrideCount = Object.keys(overrides[parentNodeId] || {}).length;
      if (overrideCount) {
        // The parent deleted a node this instance has customised. Discarding
        // that silently is the one thing most likely to destroy work, so it is
        // collected and asked about rather than decided here.
        plan.conflicts.push({
          parentNodeId,
          instanceNodeId,
          overrideCount,
          label: live.get(instanceNodeId)?.title || instanceNodeId,
        });
      } else {
        plan.deletes.push({ parentNodeId, instanceNodeId });
      }
    }

    return plan;
  };

  const applyPlan = async (plan, modal, rowId, resolveConflict) => {
    const stats = {
      written: 0,
      inserted: 0,
      moved: 0,
      deleted: 0,
      kept: 0,
      failures: [],
    };
    const map = { ...(plan.payload.map || {}) };

    // Deletes first, so a later insert cannot be placed relative to something
    // that is about to disappear.
    const deletions = plan.deletes.map((d) => d.instanceNodeId);
    for (const conflict of plan.conflicts) {
      if (resolveConflict(conflict)) {
        deletions.push(conflict.instanceNodeId);
        plan.deletes.push(conflict);
      } else {
        stats.kept++;
      }
    }
    if (deletions.length) {
      modal.setRow(rowId, "running", `removing ${deletions.length} node(s)`);
      const res = await call("delete-nodes", { ids: deletions });
      if (res?.ok) {
        stats.deleted = (res.deleted || []).length;
        for (const d of plan.deletes) delete map[d.parentNodeId];
      } else {
        stats.failures.push(`delete: ${res?.error}`);
      }
    }

    // Inserts before moves: a moved node's new home is often a container this
    // insert just created, so its instance id does not exist until now. One at a
    // time, because a whole new subtree's ids are needed by whatever follows it.
    for (const ins of plan.inserts) {
      modal.setRow(rowId, "running", `adding ${ins.parentNodeId}`);
      const res = await call(
        "insert-nodes",
        {
          intoId: ins.intoInstanceId,
          afterId: ins.afterInstanceId,
          nodes: [ins.json],
        },
        { timeout: 15000 },
      );
      if (!res?.ok || !res.ids?.length) {
        stats.failures.push(
          `insert ${ins.parentNodeId}: ${res?.error || "nothing created"}`,
        );
        continue;
      }
      stats.inserted += res.ids.length;
      for (const [baseId, newId] of Object.entries(res.idMap || {})) {
        // Never overwrite a mapping that still points at a live element. Doing
        // so is what orphaned the original heading and left the map describing
        // a duplicate — the node the user had been editing dropped out of the
        // map entirely and would come back as instance-added junk.
        if (map[baseId] && plan.liveIds.has(map[baseId])) continue;
        map[baseId] = newId;
      }
    }

    // Relocate existing nodes into their new parents.
    if (plan.moves.length) {
      const moves = [];
      for (const mv of plan.moves) {
        const id = map[mv.baseNodeId];
        const intoId = mv.intoBaseNodeId
          ? map[mv.intoBaseNodeId]
          : plan.component.rootId;
        if (!id || !intoId) {
          stats.failures.push(
            `move ${mv.baseNodeId}: could not resolve ` +
              `${!id ? "the node" : "its new parent"} in this instance`,
          );
          continue;
        }
        moves.push({
          id,
          intoId,
          afterId: mv.afterBaseNodeId ? map[mv.afterBaseNodeId] || null : null,
        });
      }
      if (moves.length) {
        modal.setRow(rowId, "running", `moving ${moves.length} node(s)`);
        const res = await call("move-nodes", { moves });
        if (res?.ok) {
          stats.moved = (res.moved || []).length;
          for (const f of res.failed || []) {
            stats.failures.push(`move ${f.id}: ${f.error}`);
          }
        } else {
          stats.failures.push(`move: ${res?.error}`);
        }
      }
    }

    // Settings, chunked.
    for (let i = 0; i < plan.settings.length; i += NODE_CHUNK) {
      const chunk = plan.settings.slice(i, i + NODE_CHUNK);
      modal.setRow(
        rowId,
        "running",
        `updating ${i + 1}-${Math.min(i + NODE_CHUNK, plan.settings.length)} of ${plan.settings.length}`,
      );
      const res = await call(
        "apply-node-settings",
        { items: chunk },
        { timeout: chunkTimeout(chunk.length), waitLimit: 3 },
      );
      if (!res?.ok) {
        stats.failures.push(`settings chunk at ${i}: ${res?.error}`);
        continue;
      }
      for (const r of res.results || []) {
        if (r.error) stats.failures.push(`${r.id}: ${r.error}`);
        else stats.written += (r.applied || []).length + (r.reset || 0);
        for (const d of r.dropped || []) {
          plan.notes.push(`    ${r.id}: dropped ${d.key} — ${d.why}`);
        }
      }
    }

    return { stats, map };
  };

  const syncComponents = async () => {
    if (running) {
      ns.log("warn", "Component sync: already running");
      return;
    }
    running = true;

    const modal = tools.openProgressModal("Sync Components", { id: MODAL_ID });
    let logId = null;
    try {
      modal.setStatus("Scanning this document for components…");
      // A sync must see the parents as they are now, not as an earlier action
      // in this tab cached them.
      ns.invalidateTemplates();

      const scanRes = await call("scan");
      if (!scanRes?.ok) {
        modal.finish(`Could not scan the document — ${scanRes?.error}`, "error");
        return;
      }
      for (const b of scanRes.broken || []) {
        modal.note(
          `⚠ data widget ${b.widgetId} in "${b.rootTitle || b.rootId}" did not decode — skipped`,
          "warn",
        );
      }

      const instances = (scanRes.components || []).filter(
        (c) => c.payload?.role === "instance",
      );
      if (!instances.length) {
        modal.finish("No component instances in this document.", "warn");
        return;
      }

      // Group by component so the checklist is per component, with a row per
      // instance — the same shape template-sync uses for templates and targets.
      const byComponent = new Map();
      for (const c of instances) {
        const key = String(c.payload.parent?.templateId || "?");
        if (!byComponent.has(key)) {
          byComponent.set(key, {
            parentTemplateId: key,
            name: c.payload.name,
            items: [],
          });
        }
        byComponent.get(key).items.push(c);
      }

      modal.setStatus(`Checking ${byComponent.size} component(s) for updates…`);
      const state = await ns.documentState();
      const stateByWidget = new Map(
        (state.rows || []).map((r) => [r.widgetId, r]),
      );
      if (state.stampError) {
        modal.note(
          `⚠ could not read parent timestamps (${state.stampError}) — showing everything as syncable`,
          "warn",
        );
      }

      const groups = [...byComponent.values()];
      const choice = await modal.choose({
        buildItems: () => groups,
        labelOf: (g) => {
          const states = g.items.map(
            (i) => stateByWidget.get(i.widgetId)?.state || "unknown",
          );
          const stale = states.filter((s) => s === "stale" || s === "unknown").length;
          const broken = states.filter((s) => s === "broken").length;
          const bits = [`${g.items.length} instance(s)`];
          if (stale) bits.push(`${stale} out of date`);
          if (broken) bits.push(`${broken} broken`);
          return `"${g.name}" — ${bits.join(", ")}`;
        },
        buttonText: "Sync",
        toggles: [],
      });
      if (!choice) {
        modal.close();
        return;
      }
      const selected = choice.items;
      if (!selected.length) {
        modal.finish("Nothing selected.", "warn");
        return;
      }

      // ---- plan every instance before writing anything ----------------------
      modal.setStatus("Working out what changed…");
      const plans = [];
      const skipped = [];
      for (const group of selected) {
        let resolvedParent = null;
        for (const component of group.items) {
          if (!resolvedParent) {
            resolvedParent = await ns.resolveParentFor(component.payload);
            if (!resolvedParent.ok) {
              modal.note(
                `✕ "${group.name}" — ${resolvedParent.error}`,
                "error",
              );
              skipped.push(group.name);
              break;
            }
            if (resolvedParent.chainIncomplete) {
              modal.note(
                `⚠ "${group.name}" — chain incomplete above template ` +
                  `${resolvedParent.chainIncomplete.missing}; staleness may under-report`,
                "warn",
              );
            }
          }
          const plan = await planInstance(component, resolvedParent);
          plans.push(plan);
        }
      }

      if (!plans.length) {
        modal.finish("Nothing could be resolved.", "error");
        return;
      }

      // ---- one batched conflict prompt -------------------------------------
      const allConflicts = plans.flatMap((p) =>
        p.conflicts.map((c) => ({ ...c, plan: p })),
      );
      let baseWins = new Set();
      if (allConflicts.length) {
        modal.setStatus(
          `${allConflicts.length} node(s) were deleted in the parent but have overrides here.`,
        );
        modal.note(
          "Tick the ones where the parent should win (the node is removed and its " +
            "overrides are lost). Unticked nodes are kept as they are.",
        );
        const picked = await modal.choose({
          buildItems: () => allConflicts,
          labelOf: (c) =>
            `"${c.plan.payload.name}" → "${c.label}" (${c.overrideCount} override(s))`,
          buttonText: "Apply",
          toggles: [],
        });
        if (!picked) {
          modal.close();
          return;
        }
        baseWins = new Set(picked.items);
      }
      const resolveConflict = (conflict) =>
        [...baseWins].some(
          (c) => c.instanceNodeId === conflict.instanceNodeId,
        );

      // ---- apply -----------------------------------------------------------
      const hist = await call("history-start", { title: "Sync components" }, { waitLimit: 1 });
      logId = hist?.ok ? hist.logId : null;

      const tally = {
        synced: 0,
        failed: 0,
        written: 0,
        inserted: 0,
        moved: 0,
        deleted: 0,
        kept: 0,
      };
      for (const plan of plans) {
        const rowId = plan.payload.instanceId;
        modal.addRow(rowId, `"${plan.payload.name}" (${plan.component.rootId})`);

        const nothing =
          !plan.settings.length &&
          !plan.inserts.length &&
          !plan.moves.length &&
          !plan.deletes.length &&
          !plan.conflicts.length;
        if (nothing) {
          // Still refresh the stamps: the parent may have been re-saved with no
          // real change, and leaving the stamp behind keeps the icon warning
          // about a difference that does not exist.
          await refreshStamps(plan);
          tally.synced++;
          modal.setRow(rowId, "ok", "already up to date");
          continue;
        }

        const { stats, map } = await applyPlan(plan, modal, rowId, resolveConflict);
        const next = {
          ...plan.payload,
          map,
          syncedAgainst: plan.resolvedParent.chain,
        };
        const write = await call("write-comp-data", {
          widgetId: plan.component.widgetId,
          payload: next,
        });
        if (!write?.ok) {
          stats.failures.push(`comp-data: ${write?.error}`);
        }

        tally.written += stats.written;
        tally.inserted += stats.inserted;
        tally.moved += stats.moved;
        tally.deleted += stats.deleted;
        tally.kept += stats.kept;
        if (stats.failures.length) {
          tally.failed++;
          modal.setRow(
            rowId,
            "warn",
            `${stats.written} field(s), +${stats.inserted} ~${stats.moved} -${stats.deleted}, ` +
              `${stats.failures.length} error(s)`,
          );
          for (const f of stats.failures) modal.note(`    ${f}`, "warn");
        } else {
          tally.synced++;
          modal.setRow(
            rowId,
            "ok",
            `${stats.written} field(s)` +
              (stats.inserted ? `, +${stats.inserted} node(s)` : "") +
              (stats.moved ? `, ${stats.moved} moved` : "") +
              (stats.deleted ? `, -${stats.deleted} node(s)` : "") +
              (stats.kept ? `, ${stats.kept} kept` : ""),
          );
        }
        for (const n of plan.notes) modal.note(n, "warn");
      }

      // The instances just changed shape, so anything the save hook diffs
      // against is now wrong until it is re-resolved.
      await ns.warmResolved({ quiet: true });
      ns.navigator?.refresh?.();

      const summary =
        `${tally.synced} synced, ${tally.failed} with errors — ` +
        `${tally.written} field(s), +${tally.inserted} node(s), ` +
        `${tally.moved} moved, -${tally.deleted} node(s)` +
        (tally.kept ? `, ${tally.kept} kept over parent deletes` : "") +
        (skipped.length ? `, ${skipped.length} component(s) skipped` : "");
      ns.log(tally.failed ? "warn" : "info", `Component sync: ${summary}`);
      modal.finish(summary, tally.failed ? "warn" : "ok");
    } catch (err) {
      ns.log("error", `Component sync: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await call("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  // A no-op sync still has to record that it looked, or the icon keeps warning.
  const refreshStamps = async (plan) => {
    const next = { ...plan.payload, syncedAgainst: plan.resolvedParent.chain };
    await call("write-comp-data", {
      widgetId: plan.component.widgetId,
      payload: next,
    });
  };

  /* -------------------------------------------------------------------- link

     Turn a container you already have into an instance of an existing
     component, without changing a single thing you can see.

     Insert and link differ in exactly one place: where the node map comes
     from. An insert CREATES the elements from the parent's JSON, so the map
     falls out of the create call for free. A link finds a container that was
     built independently, so the correspondence has to be worked out — and that
     is precisely what ns.pairTrees does for template-sync (LCS on type + name,
     then type alone). Its pairs are {sourceId, targetId}, which IS the map.

     Everything after the map is shared with the rest of the system: comp-data
     is written, the resolved cache is warmed, and refresh-comp-data derives the
     overrides through the same save-hook path a normal edit goes through. No
     override logic is duplicated here. */

  // Every node id in a parent tree, so the ones that never paired can be
  // declared removed.
  const parentNodeIds = (tree) => {
    const ids = new Set();
    const walk = (n) => {
      if (n?.id) ids.add(n.id);
      for (const kid of n?.children || []) walk(kid);
    };
    walk(tree);
    return ids;
  };

  const subtreeIds = (tree) => parentNodeIds(tree);

  // Which container the user means. Shift-click wins when it is unambiguous,
  // because it is an explicit act; otherwise fall back to whatever the editor
  // has selected. Several shift-clicked layers is refused rather than guessed
  // — "the first one" is not something the user asked for here, unlike the
  // animation-preset stagger where the order is the whole input.
  const resolveTarget = async () => {
    const picked = window.__ElementorTools?.multiSelect?.getIds?.() || [];
    if (picked.length > 1) {
      return {
        ok: false,
        error: `${picked.length} layers are shift-selected. Link works on one container — clear the selection and pick a single layer.`,
      };
    }
    if (picked.length === 1) return { ok: true, id: picked[0], via: "shift-click" };

    const sel = await tools.callBridge("describe-selection", {}, { waitLimit: 1 });
    if (!sel?.ok || !sel.id) {
      return {
        ok: false,
        error: "Nothing is selected. Click the container you want to link, then try again.",
      };
    }
    return { ok: true, id: sel.id, via: sel.via || "selection" };
  };

  const linkComponent = async () => {
    if (running) return;
    running = true;
    const modal = tools.openProgressModal("Link to Component", { id: MODAL_ID });
    let logId = null;
    try {
      modal.setStatus("Reading the selection…");
      const target = await resolveTarget();
      if (!target.ok) {
        modal.finish(target.error, "error");
        return;
      }

      const described = await call("describe-subtree", { id: target.id });
      if (!described?.ok) {
        modal.finish(`Could not read the selected layer — ${described?.error}`, "error");
        return;
      }
      const targetTree = described.tree;

      // A widget cannot be a component root: a component's identity is a data
      // widget sitting inside it, and a widget holds no children.
      if (targetTree.elType !== "container") {
        modal.finish(
          `The selected layer is a ${targetTree.widgetType || targetTree.elType}, not a container. ` +
            `A component root has to be a container.`,
          "error",
        );
        return;
      }

      // Overlapping ownership, in both directions.
      const scanRes = await call("scan");
      if (!scanRes?.ok) {
        modal.finish(`Could not scan the document — ${scanRes?.error}`, "error");
        return;
      }
      const inside = subtreeIds(targetTree);
      const all = [...(scanRes.components || []), ...(scanRes.broken || [])];

      const itself = all.find((c) => c.rootId === target.id);
      if (itself) {
        modal.finish(
          `"${targetTree.title || target.id}" is already a component ` +
            `("${itself.payload?.name || "unreadable"}"). Detach it first if you want to re-link it.`,
          "error",
        );
        return;
      }

      // Refused, not warned. Two instances whose maps overlap would both try to
      // manage the same elements on every sync, and nothing downstream can tell
      // which one should win.
      const nested = all.filter((c) => c.rootId !== target.id && inside.has(c.rootId));
      if (nested.length) {
        modal.finish(
          `This container holds ${nested.length} component(s) — ` +
            `${nested.map((c) => `"${c.payload?.name || c.rootId}"`).join(", ")}. ` +
            `Linking it would give two instances ownership of the same elements. ` +
            `Detach the inner one(s), or link a container that does not contain them.`,
          "error",
        );
        return;
      }

      // The inverse case is a warning rather than a refusal: the user may well
      // know that the enclosing instance does not manage this branch.
      const enclosing = all.filter(
        (c) => c.rootId !== target.id && !inside.has(c.rootId),
      );
      for (const outer of enclosing) {
        const outerTree = await call("describe-subtree", { id: outer.rootId });
        if (outerTree?.ok && subtreeIds(outerTree.tree).has(target.id)) {
          modal.note(
            `⚠ this container sits inside the component "${outer.payload?.name || outer.rootId}". ` +
              `If that instance's map covers these nodes, both will try to manage them.`,
            "warn",
          );
        }
      }

      // ---- pick the component -------------------------------------------
      modal.setStatus("Scanning the template library for components…");
      const index = window.__ElementorComponentIndex;
      if (!index) {
        modal.finish(
          "Component/component-index.js did not load — check content_scripts order in manifest.json.",
          "error",
        );
        return;
      }
      const listed = await index.listComponentTemplates();
      if (!listed?.ok) {
        modal.finish(`Could not list components — ${listed?.error}`, "error");
        return;
      }
      for (const w of listed.warnings || []) modal.note(`⚠ ${w}`, "warn");

      const info = await call("doc-info");
      const here = info?.ok ? String(info.postId) : null;
      // A component cannot be the parent of something inside itself.
      const available = (listed.templates || []).filter(
        (t) => !here || String(t.templateId) !== here,
      );
      if (!available.length) {
        modal.finish(
          "No component templates on this site yet. Open a template, then use New Component.",
          "warn",
        );
        return;
      }

      modal.setStatus(
        `Linking "${targetTree.title || target.id}" — pick the component it should follow.`,
      );
      const choice = await modal.choose({
        buildItems: () => available,
        labelOf: (t) => {
          const bits = [t.role];
          if (t.status && t.status !== "publish") bits.push(t.status);
          return `"${t.name}" — ${bits.join(", ")} · template ${t.templateId}`;
        },
        buttonText: "Link",
        toggles: [],
      });
      if (!choice) {
        modal.close();
        return;
      }
      // One parent, so anything past the first tick is ambiguous rather than
      // additive. The checklist is reused for its search and layout; the rule
      // is stated here.
      if (choice.items.length !== 1) {
        modal.finish(
          `Pick exactly one component to link to — ${choice.items.length} were ticked.`,
          "warn",
        );
        return;
      }
      const chosen = choice.items[0];

      // ---- resolve and pair ----------------------------------------------
      modal.setStatus(`Resolving "${chosen.name}"…`);
      const resolved = await ns.resolveParentFor({
        parent: { templateId: String(chosen.templateId) },
      });
      if (!resolved.ok) {
        modal.finish(`Could not resolve the component — ${resolved.error}`, "error");
        return;
      }
      if (resolved.chainIncomplete) {
        modal.note(
          `⚠ chain incomplete above template ${resolved.chainIncomplete.missing}; ` +
            `staleness may under-report`,
          "warn",
        );
      }

      const isSkipped = await tools.getSkipMatcher();
      let paired = tools.pairTrees(resolved.tree, targetTree, { isSkipped });

      if (!paired.ok && paired.ratio === undefined) {
        // Root type mismatch. Nothing below it is interpretable, so this is the
        // one hard refusal — same rule template-sync applies.
        modal.note(`    component: ${tools.summarizeTree(resolved.tree, 2)}`, "warn");
        modal.note(`    selection: ${tools.summarizeTree(targetTree, 2)}`, "warn");
        modal.finish(`Cannot link — ${paired.error}`, "error");
        return;
      }

      if (!paired.ok) {
        // Below the match threshold. Unlike a bulk sync this is one deliberate
        // act on one chosen container, so the divergence is shown and the
        // decision handed over rather than taken.
        modal.setStatus("This is a poor match.");
        modal.note(`⚠ ${paired.error}`, "warn");
        modal.note(
          `    component: ${tools.summarizeTree(resolved.tree, 2)} ` +
            `(${tools.countNodes(resolved.tree)} nodes)`,
          "warn",
        );
        modal.note(
          `    selection: ${tools.summarizeTree(targetTree, 2)} ` +
            `(${tools.countNodes(targetTree)} nodes)`,
          "warn",
        );
        for (const m of paired.missing.slice(0, 8)) {
          modal.note(`    only in the component: ${m}`, "warn");
        }
        for (const e of paired.extra.slice(0, 8)) {
          modal.note(`    only in the selection: ${e}`, "warn");
        }
        const confirm = await modal.choose({
          buildItems: () => [
            {
              label:
                `Link anyway — ${paired.pairs.length} node(s) will follow the component, ` +
                `the rest stay independent`,
            },
          ],
          labelOf: (i) => i.label,
          buttonText: "Link anyway",
          toggles: [],
        });
        if (!confirm || !confirm.items.length) {
          modal.finish("Not linked.", "warn");
          return;
        }
      }

      const pairs = paired.pairs || [];
      if (!pairs.length) {
        modal.finish("Nothing aligned — there is no correspondence to record.", "error");
        return;
      }

      // pairs are { sourceId, targetId } — parent node -> this document's node.
      // That is exactly the shape an instance's map is stored in.
      const map = {};
      for (const p of pairs) map[p.sourceId] = p.targetId;

      // A parent node that never paired is declared REMOVED, not left unmapped.
      // Unmapped means "new in the parent" to planInstance, which would insert
      // it on the next sync and rebuild the container into the base. Declaring
      // it removed is what makes linking a snapshot: what you see now is what
      // you keep.
      const removed = [...parentNodeIds(resolved.tree)].filter((id) => !(id in map));

      // ---- write -----------------------------------------------------------
      const hist = await call(
        "history-start",
        { title: "Link to component" },
        { waitLimit: 1 },
      );
      logId = hist?.ok ? hist.logId : null;

      const payload = fmt.emptyInstance({
        name: chosen.name || targetTree.title || "Linked component",
        parentTemplateId: String(chosen.templateId),
        parentComponentId: chosen.componentId,
      });
      payload.map = map;
      payload.structure = { removed, added: [] };
      payload.syncedAgainst = resolved.chain;

      modal.setStatus("Writing component data…");
      const widget = await call("create-comp-widget", {
        intoId: target.id,
        payload,
      });
      if (!widget?.ok) {
        modal.finish(`Could not create the data widget — ${widget?.error}`, "error");
        return;
      }

      // Overrides are DERIVED, never computed here — warming the resolved cache
      // and running the ordinary refresh is the same path a save takes, so a
      // link cannot disagree with what the next save would have written.
      modal.setStatus("Working out the overrides…");
      await ns.warmResolved({ quiet: true });
      const refreshed = await call("refresh-comp-data", { why: "link" }, { timeout: 15000 });

      const mine = (refreshed?.report?.updated || []).find(
        (u) => u.instanceId === payload.instanceId,
      );
      const skipped = (refreshed?.report?.skipped || []).find(
        (s) => s.instanceId === payload.instanceId,
      );

      modal.note(`· ${pairs.length} node(s) mapped to the component`);
      if (removed.length) {
        modal.note(
          `· ${removed.length} component node(s) this container does not have — ` +
            `recorded as removed, so a sync will not add them`,
        );
      }
      if (paired.extra?.length) {
        modal.note(
          `· ${paired.extra.length} node(s) here that the component does not have — ` +
            `kept as this instance's own`,
        );
      }
      if (mine) {
        modal.note(`· ${mine.overrides} override(s) derived`);
      } else if (skipped) {
        modal.note(
          `⚠ overrides were not derived — ${skipped.reason}. They will be on the next save.`,
          "warn",
        );
      }

      ns.log(
        "info",
        `Linked "${targetTree.title || target.id}" to component "${chosen.name}" ` +
          `(template ${chosen.templateId}, ${pairs.length} nodes mapped, ${removed.length} declared removed)`,
      );
      modal.finish(
        `Linked to "${chosen.name}". Nothing on the page changed — every difference ` +
          `is recorded as an override.`,
        "ok",
      );
      ns.navigator?.refresh?.();
    } catch (err) {
      ns.log("error", `Link component: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await call("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  /* ------------------------------------------------------------------ rename */

  // The component name is comp-data and nothing else, so a rename is one model
  // write — no history entry, no re-render, and it rides along with the next
  // save exactly like a derived override set does.
  //
  // No modal: this touches no network, which is the whole test CLAUDE.md sets
  // for whether a modal is owed. It reports to the log like the passive
  // features do, and the caller re-renders its own row.
  const renameComponent = async ({ widgetId, name }) => {
    const clean = String(name ?? "").trim();
    if (!widgetId || !clean) return { ok: false, error: "a name is required" };

    const scanRes = await call("scan");
    if (!scanRes?.ok) return { ok: false, error: scanRes.error };
    const found = (scanRes.components || []).find((c) => c.widgetId === widgetId);
    if (!found) {
      return { ok: false, error: "that component is no longer in this document" };
    }
    if (found.payload.name === clean) return { ok: true, changed: false };

    const previous = found.payload.name;
    const write = await call("write-comp-data", {
      widgetId,
      payload: { ...found.payload, name: clean },
    });
    if (!write?.ok) return { ok: false, error: write?.error };

    ns.log("info", `Component renamed: "${previous}" → "${clean}"`);
    return { ok: true, changed: true, name: clean };
  };

  /* ------------------------------------------------------------------- reset

     Throw away everything that makes an instance differ from its base: the
     overrides, the nodes it added, and its declaration that it does not have
     certain base nodes. Afterwards it is a faithful copy again — still linked,
     still an instance, just with nothing of its own.

     This is the destructive counterpart to sync. Sync deliberately PRESERVES
     overrides; reset exists because there is otherwise no way to give one back. */

  // Nodes under an instance root that the map does not cover — the ones this
  // instance added. A nested component's subtree is excluded whole: those nodes
  // belong to another component, and deleting them would destroy a thing the
  // user did not select.
  const addedNodesOf = (component, liveNodes, otherRootIds) => {
    const mapped = new Set(Object.values(component.payload.map || {}));
    const kids = new Map();
    for (const node of liveNodes) {
      if (!kids.has(node.parentId)) kids.set(node.parentId, []);
      kids.get(node.parentId).push(node);
    }
    const added = [];
    const skippedNested = [];
    const walk = (id) => {
      for (const node of kids.get(id) || []) {
        if (otherRootIds.has(node.id)) {
          skippedNested.push(node);
          continue; // its whole subtree belongs to that component
        }
        if (!mapped.has(node.id)) {
          added.push(node);
          // Do not descend: the subtree goes with it, and listing descendants
          // separately would hand the same elements to delete twice.
          continue;
        }
        walk(node.id);
      }
    };
    walk(null);
    return { added, skippedNested };
  };

  const resetInstances = async () => {
    if (running) return;
    running = true;
    const modal = tools.openProgressModal("Reset to Base", { id: MODAL_ID });
    let logId = null;
    try {
      modal.setStatus("Scanning this document for instances…");
      // A reset has to land on the parent as it stands now, not as an earlier
      // action in this tab cached it.
      ns.invalidateTemplates();

      const scanRes = await call("scan");
      if (!scanRes?.ok) {
        modal.finish(`Could not scan the document — ${scanRes?.error}`, "error");
        return;
      }
      const all = [...(scanRes.components || []), ...(scanRes.broken || [])];
      const instances = (scanRes.components || []).filter(
        (c) => c.payload?.role === "instance",
      );
      if (!instances.length) {
        modal.finish("No component instances in this document.", "warn");
        return;
      }

      const items = instances.map((c) => ({
        component: c,
        name: c.payload.name || "(unnamed)",
        overrides: fmt.countOverrides(c.payload),
        removed: (c.payload.structure?.removed || []).length,
        added: (c.payload.structure?.added || []).length,
      }));

      const choice = await modal.choose({
        buildItems: () => items,
        labelOf: (i) => {
          const bits = [];
          bits.push(i.overrides ? `${i.overrides} override(s)` : "no overrides");
          if (i.added) bits.push(`${i.added} added node(s)`);
          if (i.removed) bits.push(`${i.removed} node(s) it does not have`);
          const where = i.component.rootTitle || i.component.rootId;
          return `"${i.name}" — ${bits.join(", ")} · in ${where}`;
        },
        buttonText: "Continue",
        toggles: [],
      });
      if (!choice) {
        modal.close();
        return;
      }
      const selected = choice.items;
      if (!selected.length) {
        modal.finish("Nothing selected.", "warn");
        return;
      }

      // A second, explicit confirmation. The checklist above chooses WHICH;
      // this one confirms WHAT IS LOST, with the totals spelled out. Detach
      // does not need this step because it destroys no content — a reset
      // deletes elements and discards work, so it is worth the extra click.
      const totalOverrides = selected.reduce((n, i) => n + i.overrides, 0);
      const totalAdded = selected.reduce((n, i) => n + i.added, 0);
      modal.setStatus("This cannot be undone from the panel — check before you go on.");
      modal.note(
        `About to reset ${selected.length} instance(s): ` +
          `${totalOverrides} override(s) discarded` +
          (totalAdded ? `, ${totalAdded} added node(s) deleted` : "") +
          `, and any base node this instance was missing put back.`,
        "warn",
      );
      modal.note(
        `It stays an instance of the same component — it just keeps nothing of its own.`,
      );
      const confirmed = await modal.choose({
        buildItems: () => [{ label: `Yes, reset ${selected.length} instance(s) to base` }],
        labelOf: (i) => i.label,
        buttonText: "Reset",
        toggles: [],
      });
      if (!confirmed || !confirmed.items.length) {
        modal.finish("Nothing reset.", "warn");
        return;
      }

      const hist = await call(
        "history-start",
        { title: "Reset components to base" },
        { waitLimit: 1 },
      );
      logId = hist?.ok ? hist.logId : null;

      const tally = { reset: 0, failed: 0, deleted: 0, written: 0, inserted: 0 };
      for (const item of selected) {
        const component = item.component;
        const rowId = component.payload.instanceId;
        modal.addRow(rowId, `"${item.name}" (${component.rootId})`);

        const resolvedParent = await ns.resolveParentFor(component.payload);
        if (!resolvedParent.ok) {
          tally.failed++;
          modal.setRow(rowId, "error", resolvedParent.error);
          continue;
        }

        // --- delete what this instance added -----------------------------
        const otherRootIds = new Set(
          all.filter((c) => c.rootId !== component.rootId).map((c) => c.rootId),
        );
        const live = await call("read-subtree-settings", { id: component.rootId });
        if (!live?.ok) {
          tally.failed++;
          modal.setRow(rowId, "error", `could not read the instance — ${live?.error}`);
          continue;
        }
        const { added, skippedNested } = addedNodesOf(
          component,
          live.nodes || [],
          otherRootIds,
        );
        for (const nested of skippedNested) {
          modal.note(
            `    kept "${nested.title || nested.id}" — it is another component's root`,
            "warn",
          );
        }
        if (added.length) {
          modal.setRow(rowId, "running", `deleting ${added.length} added node(s)`);
          const del = await call("delete-nodes", { ids: added.map((n) => n.id) });
          if (del?.ok) tally.deleted += (del.deleted || []).length;
          else modal.note(`    delete failed — ${del?.error}`, "warn");
        }

        // --- plan against a payload with nothing of its own ---------------
        // Cleared BEFORE planning, which is the whole trick: planInstance
        // honours overrides and structure.removed, so handing it an empty pair
        // makes it write every parent value and re-insert every base node the
        // instance had declared it did not have.
        const cleaned = {
          ...component.payload,
          overrides: {},
          structure: { removed: [], added: [] },
        };
        const plan = await planInstance({ ...component, payload: cleaned }, resolvedParent);

        modal.setRow(rowId, "running", "applying base values");
        // No conflicts can exist with an empty override set, so the resolver is
        // never consulted; base-wins is the honest answer if that ever changes.
        const { stats, map } = await applyPlan(plan, modal, rowId, () => true);

        const write = await call("write-comp-data", {
          widgetId: component.widgetId,
          payload: { ...cleaned, map, syncedAgainst: resolvedParent.chain },
        });
        if (!write?.ok) stats.failures.push(`comp-data: ${write?.error}`);

        tally.written += stats.written;
        tally.inserted += stats.inserted;
        if (stats.failures.length) {
          tally.failed++;
          modal.setRow(
            rowId,
            "warn",
            `reset with ${stats.failures.length} error(s)`,
          );
          for (const f of stats.failures) modal.note(`    ${f}`, "warn");
        } else {
          tally.reset++;
          modal.setRow(
            rowId,
            "ok",
            `reset — ${stats.written} field(s)` +
              (stats.inserted ? `, +${stats.inserted} node(s)` : "") +
              (added.length ? `, -${added.length} added node(s)` : ""),
          );
        }
        for (const n of plan.notes) modal.note(n, "warn");
      }

      // The instances just changed shape and hold no overrides, so anything the
      // save hook diffs against is now wrong until it is re-resolved.
      await ns.warmResolved({ quiet: true });
      ns.navigator?.refresh?.();

      const summary =
        `${tally.reset} reset, ${tally.failed} with errors — ` +
        `${tally.written} field(s), +${tally.inserted} node(s), ` +
        `-${tally.deleted} added node(s)`;
      ns.log(tally.failed ? "warn" : "info", `Reset to base: ${summary}`);
      modal.finish(summary, tally.failed ? "warn" : "ok");
    } catch (err) {
      ns.log("error", `Reset to base: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await call("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  /* ------------------------------------------------------------------ detach */

  // Delete a component's data widget and the container becomes an ordinary
  // block again. Nothing else is touched: the content is already real elements,
  // so there is nothing to unpick — which is what makes this the exact inverse
  // of newComponent, and much simpler than template-decouple.js, whose whole
  // job is swapping a widget for content that did not previously exist.
  //
  // Modelled on template-decouple's checklist all the same, because the failure
  // mode is the same one: several rows that read identically, where unticking
  // the wrong one is silent.
  const detachComponents = async () => {
    if (running) return;
    running = true;
    const modal = tools.openProgressModal("Detach Components", { id: MODAL_ID });
    let logId = null;
    try {
      modal.setStatus("Scanning this document for components…");
      const scanRes = await call("scan");
      if (!scanRes?.ok) {
        modal.finish(`Could not scan the document — ${scanRes?.error}`, "error");
        return;
      }

      // A broken component is exactly the thing someone most wants to detach,
      // so it is offered alongside the readable ones rather than skipped.
      const items = [
        ...(scanRes.components || []).map((c) => ({
          widgetId: c.widgetId,
          rootId: c.rootId,
          rootTitle: c.rootTitle,
          name: c.payload?.name || "(unnamed)",
          role: c.payload?.role === "base" ? "base" : "instance",
          componentId: c.payload?.id || null,
          templateId: c.payload?.parent?.templateId || null,
        })),
        ...(scanRes.broken || []).map((b) => ({
          widgetId: b.widgetId,
          rootId: b.rootId,
          rootTitle: b.rootTitle,
          name: "(unreadable component data)",
          role: "broken",
          componentId: null,
          templateId: null,
        })),
      ];
      if (!items.length) {
        modal.finish("No components in this document.", "warn");
        return;
      }

      // Detaching a base orphans every instance of it across the site — they
      // resolve against this template and will report "holds no component data
      // widget" forever after. The site index already knows how many there are,
      // so the warning can be specific instead of theoretical. Cache-only: this
      // must not go to the network, and a cold cache simply says less.
      const orphanCounts = await countInstancesOf(items);

      // Labels collide readily — three containers all named "Card" holding the
      // same component read identically. Numbered in document order for the
      // reason template-decouple.js documents: an ambiguous checklist is worse
      // than none, because unticking the wrong row is silent.
      const seen = new Map();
      for (const item of items) {
        const key = `${item.name} ${item.rootTitle}`;
        seen.set(key, (seen.get(key) || 0) + 1);
      }
      const ordinals = new Map();
      for (const item of items) {
        const key = `${item.name} ${item.rootTitle}`;
        const total = seen.get(key);
        if (total > 1) {
          const n = (ordinals.get(key) || 0) + 1;
          ordinals.set(key, n);
          item.ordinal = ` (${n} of ${total})`;
        } else {
          item.ordinal = "";
        }
      }

      const choice = await modal.choose({
        buildItems: () => items,
        labelOf: (i) => {
          const bits = [i.role];
          const orphans = orphanCounts.get(i.componentId);
          if (i.role === "base" && orphans) {
            bits.push(`⚠ ${orphans} instance(s) elsewhere would break`);
          }
          const where = i.rootTitle ? `"${i.rootTitle}"` : i.rootId;
          return `"${i.name}"${i.ordinal} — ${bits.join(", ")} · in ${where}`;
        },
        buttonText: "Detach",
        toggles: [],
      });
      if (!choice) {
        modal.close();
        return;
      }
      const selected = choice.items;
      if (!selected.length) {
        modal.finish("Nothing selected.", "warn");
        return;
      }

      const hist = await call(
        "history-start",
        { title: "Detach components" },
        { waitLimit: 1 },
      );
      logId = hist?.ok ? hist.logId : null;

      modal.setStatus(`Detaching ${selected.length} component(s)…`);
      for (const item of selected) {
        modal.addRow(item.widgetId, `"${item.name}" (${item.rootId})`);
      }

      const res = await call("delete-comp-widgets", {
        widgetIds: selected.map((i) => i.widgetId),
      });
      if (!res?.ok) {
        for (const item of selected) {
          modal.setRow(item.widgetId, "error", res?.error || "failed");
        }
        modal.finish(`Detach failed — ${res?.error}`, "error");
        return;
      }

      const gone = new Set(res.deleted || []);
      const absent = new Set(res.missing || []);
      const refused = new Map((res.refused || []).map((r) => [r.id, r.why]));
      let detached = 0;
      for (const item of selected) {
        if (gone.has(item.widgetId)) {
          detached++;
          modal.setRow(item.widgetId, "ok", "detached — now an ordinary container");
        } else if (absent.has(item.widgetId)) {
          modal.setRow(item.widgetId, "warn", "already gone from this document");
        } else {
          modal.setRow(
            item.widgetId,
            "warn",
            refused.get(item.widgetId) || "not detached",
          );
        }
      }

      const brokeBases = selected.filter(
        (i) => gone.has(i.widgetId) && i.role === "base" && orphanCounts.get(i.componentId),
      );
      for (const b of brokeBases) {
        modal.note(
          `⚠ "${b.name}" was a base — ${orphanCounts.get(b.componentId)} instance(s) ` +
            `elsewhere on this site now have no parent. Re-run the site scan in the ` +
            `Components panel to see them.`,
          "warn",
        );
      }

      // Anything the save hook was holding resolved values for is no longer a
      // component, so leaving the cache warm would have it deriving overrides
      // for instances that no longer exist.
      await ns.warmResolved({ quiet: true });
      ns.navigator?.refresh?.();

      const summary =
        `${detached} detached` +
        (detached < selected.length ? `, ${selected.length - detached} skipped` : "");
      ns.log("info", `Detach components: ${summary}`);
      modal.finish(summary, detached ? "ok" : "warn");
    } catch (err) {
      ns.log("error", `Detach components: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await call("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  // How many instances across the site point at each base being detached.
  // Read from the cached site index only — detach is a local, offline action
  // and must not turn into a multi-minute scan because the user opened a
  // checklist. A cold cache means the warning is simply absent.
  const countInstancesOf = async (items) => {
    const counts = new Map();
    const bases = items.filter((i) => i.role === "base" && i.componentId);
    if (!bases.length) return counts;
    try {
      const { componentIndex } = await browser.storage.local.get("componentIndex");
      const docs = componentIndex?.docs;
      if (!docs) return counts;
      const info = await call("doc-info");
      const here = info?.ok ? String(info.postId) : null;
      for (const doc of Object.values(docs)) {
        for (const comp of doc.components || []) {
          if (comp.role !== "instance") continue;
          // An instance in THIS document is about to be looked at by the user
          // anyway, and may itself be on the detach list. Only elsewhere counts.
          if (here && String(doc.id) === here) continue;
          if (!comp.parentComponentId) continue;
          for (const base of bases) {
            if (comp.parentComponentId === base.componentId) {
              counts.set(base.componentId, (counts.get(base.componentId) || 0) + 1);
            }
          }
        }
      }
    } catch (_) {}
    return counts;
  };

  ns.newComponent = newComponent;
  ns.createInstance = createInstance;
  ns.insertComponents = insertComponents;
  ns.linkComponent = linkComponent;
  ns.syncComponents = syncComponents;
  ns.renameComponent = renameComponent;
  ns.resetInstances = resetInstances;
  ns.detachComponents = detachComponents;
  ns.isRunning = () => running;
})();
