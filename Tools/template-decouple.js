(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const MODAL_ID = "ElementorTools-template-decouple-modal";

  let running = false;

  const { withTemplateTag } = window.__ElementorTemplateFormat;

  // A slow op is not a dead one — the bridge keeps waiting past its deadline
  // (an insert that outran it has still inserted), so record the wait instead
  // of leaving the modal on a stale phase.
  const waitNote = (modal) => (info) =>
    modal.note(
      `· still waiting on ${info.op} — ${Math.round(info.waited / 1000)}s so far, not giving up`,
      "warn",
    );

  // Unlike template-sync, nothing here matches on names: the Template widget
  // stores the template's id in settings.template_id, so the link is exact.
  // Titles are only ever used for labels.
  const widgetLabel = (w, titleById) => {
    const meta = w.templateId ? titleById.get(w.templateId) : null;
    const name =
      meta?.title ||
      (w.templateId ? `#${w.templateId}` : "(no template set)");
    const where = w.parentTitle ? `inside "${w.parentTitle}"` : `at ${w.path}`;
    return `${name} — ${where}`;
  };

  // Labels collide readily — three containers all named "Card", each holding
  // the same template, read identically. Number the repeats in document order
  // so the checklist rows can actually be told apart.
  const buildLabels = (widgets, titleById) => {
    const totals = new Map();
    for (const w of widgets) {
      const base = widgetLabel(w, titleById);
      totals.set(base, (totals.get(base) || 0) + 1);
    }
    const seen = new Map();
    const labels = new Map();
    for (const w of widgets) {
      const base = widgetLabel(w, titleById);
      const total = totals.get(base);
      if (total === 1) {
        labels.set(w.id, base);
        continue;
      }
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      labels.set(w.id, `${base} (${n} of ${total})`);
    }
    return labels;
  };

  // Push the widget's Advanced tab onto whatever replaced it, and return the
  // fragment the caller appends to its row. The key mapping (_padding→padding
  // and the rest) is the bridge's job — it needs the target's live control
  // schema, which only the page world can read.
  //
  // Never fatal: the content is already in place and the widget is already
  // gone, so a failure here is a degraded decouple, not a broken one.
  const carryOverAdvanced = async (modal, advanced, newIds, multi, tally) => {
    const entries = advanced || [];
    if (!entries.length || !newIds.length) return "";

    // A multi-root template lands several siblings where one widget stood.
    // Repeating spacing across them is a judgement call the modal warns about,
    // but repeating a CSS ID is not — the same _element_id on three elements is
    // three duplicate DOM ids, which is invalid whatever the intent was.
    const payload = multi
      ? entries.filter((e) => e.key !== "_element_id")
      : entries;
    if (!payload.length) return "";

    // A mutation, so it is waited on rather than re-sent; unlike an insert a
    // called-off wait leaves nothing orphaned behind.
    const res = await ns.callBridge(
      "apply-advanced-settings",
      { items: newIds.map((id) => ({ id, settings: payload })) },
      { waitLimit: 3 },
    );
    if (!res?.ok) {
      ns.log("warn", `Template decouple: advanced settings — ${res?.error}`);
      return ` · advanced failed (${res?.error})`;
    }

    // Every root gets the same payload, so report the distinct keys rather than
    // counting the same setting once per sibling.
    const applied = new Set();
    const dropped = new Map();
    for (const r of res.results || []) {
      for (const k of r.applied || []) applied.add(k);
      for (const d of r.dropped || []) dropped.set(d.key, d.why);
    }
    tally.advanced += applied.size;

    if (dropped.size) {
      for (const [key, why] of dropped) {
        modal.note(`    ⚠ Advanced "${key}" not transferred — ${why}`, "warn");
      }
    }
    if (multi && applied.size) {
      modal.note(
        `    ⚠ the template has ${newIds.length} roots, so the widget's Advanced ` +
          `settings were copied onto each of them — spacing is worth a look`,
        "warn",
      );
    }

    if (!applied.size) return ` · advanced: nothing transferable`;
    return (
      ` · advanced: ${applied.size} setting(s)` +
      (dropped.size ? `, ${dropped.size} dropped` : "")
    );
  };

  const decoupleTemplates = async () => {
    if (running) {
      ns.log("warn", "Template decouple: already running");
      return;
    }
    running = true;

    const modal = ns.openProgressModal("Decouple Templates", { id: MODAL_ID });
    let logId = null;
    try {
      modal.setStatus("Scanning the page for template widgets…");
      const scan = await ns.callBridge("list-template-widgets");
      if (!scan?.ok) {
        ns.log("warn", `Template decouple: ${scan?.error}`);
        modal.finish(`Could not read the page — ${scan?.error}`, "error");
        return;
      }
      const widgets = scan.widgets || [];
      if (!widgets.length) {
        ns.log("info", "Template decouple: no template widgets on this page");
        modal.finish("No template widgets on this page.", "warn");
        return;
      }

      // Titles are labels only — the insert works from the id alone, so a
      // failure here degrades the wording rather than stopping the run.
      modal.setStatus(
        `Found ${widgets.length} template widget(s). Fetching template titles…`,
      );
      const titleById = new Map();
      const templatesRes = await ns.listSiteTemplates({
        onWait: waitNote(modal),
      });
      if (templatesRes?.ok) {
        for (const t of templatesRes.templates || []) {
          titleById.set(String(t.templateId), t);
        }
      } else {
        modal.note(
          `⚠ could not fetch template titles — ${templatesRes?.error}. Showing ids instead.`,
          "warn",
        );
      }

      const isSkipped = await ns.getSkipMatcher();

      const candidates = [];
      for (const w of widgets) {
        if (!w.templateId) {
          modal.note(
            `⚠ widget at ${w.path} points at no template — left alone`,
            "warn",
          );
          continue;
        }
        if (isSkipped(w.title)) {
          modal.note(`· "${w.title}" carries the skip word — left linked`);
          continue;
        }
        candidates.push(w);
      }

      if (!candidates.length) {
        ns.log("warn", "Template decouple: every widget was skipped");
        modal.finish(
          `Nothing to decouple — all ${widgets.length} widget(s) were skipped.`,
          "warn",
        );
        return;
      }

      const labels = buildLabels(candidates, titleById);

      modal.setStatus(
        `${candidates.length} template widget(s) found. Untick any you want to ` +
          `leave linked — decoupling swaps the widget for a copy of the ` +
          `template's content, which then stops tracking the template.`,
      );
      const chosen = await modal.choose({
        buildItems: () => candidates,
        labelOf: (w) => labels.get(w.id),
        buttonText: "Decouple",
        toggles: [
          {
            key: "advanced",
            label: "Carry over each widget's Advanced tab",
            default: true,
            hint: "padding, margin, z-index, CSS classes, motion effects — none of which live in the template's content",
          },
        ],
      });
      if (!chosen) {
        ns.log("info", "Template decouple: cancelled");
        modal.close();
        return;
      }
      const selected = chosen.items;
      const carryAdvanced = !!chosen.toggles.advanced;
      if (!carryAdvanced) {
        modal.note("· Advanced tab left behind — content only");
      }
      if (selected.length < candidates.length) {
        modal.note(
          `· ${candidates.length - selected.length} widget(s) unticked and left linked`,
        );
      }

      // Group by template so a template shared by several widgets is fetched
      // and staged once — the staged copy survives each replace.
      const groups = new Map();
      for (const w of selected) {
        if (!groups.has(w.templateId)) groups.set(w.templateId, []);
        groups.get(w.templateId).push(w);
      }

      // Anything carrying an id we have not already seen, once the run is over,
      // arrived inside decoupled content.
      const knownIds = new Set(widgets.map((w) => w.id));

      // One fetch per distinct template either way; doing them a few at a time
      // up front keeps the staging inserts below from each waiting on their own
      // round trip. Nothing here changes the document, so it sits outside the
      // history log.
      if (groups.size > 1) {
        modal.setStatus(
          `Loading ${groups.size} template(s), ${ns.PREFETCH_CONCURRENCY} at a time…`,
        );
        const pre = await ns.prefetchTemplates(
          [...groups.keys()].map((id) => ({
            templateId: id,
            source: titleById.get(id)?.source,
          })),
          { onWait: waitNote(modal) },
        );
        for (const f of pre.failed || []) {
          const meta = titleById.get(f.templateId);
          modal.note(
            `· could not preload "${meta?.title || `#${f.templateId}`}" — ${f.error}. ` +
              `Its insert will try again.`,
            "warn",
          );
        }
      }

      // waitLimit 1: both history ops degrade to a no-op already, and history-end
      // runs in a finally after the summary is on screen — a re-arming wait there
      // holds the undo group open long enough for a user edit to join this run's
      // undo step, with the hotkey locked meanwhile.
      const historyRes = await ns.callBridge(
        "history-start",
        { title: "Decouple templates" },
        { waitLimit: 1 },
      );
      logId = historyRes?.ok ? historyRes.logId : null;

      const tally = { done: 0, failed: 0, nodes: 0, advanced: 0 };

      for (const [templateId, members] of groups) {
        const meta = titleById.get(templateId);
        const name = meta?.title || `#${templateId}`;

        for (const w of members) modal.addRow(w.id, labels.get(w.id));

        modal.setStatus(`Inserting "${name}"…`);
        const ins = await ns.insertSiteTemplate(templateId, {
          source: meta?.source,
          title: meta?.title,
          type: meta?.type,
          onWait: waitNote(modal),
        });
        if (!ins?.ok) {
          tally.failed += members.length;
          for (const w of members) {
            modal.setRow(w.id, "error", `insert failed — ${ins?.error}`);
          }
          ns.log("warn", `Template decouple: insert "${name}" — ${ins?.error}`);
          continue;
        }

        const stagedIds = ins.ids || [];
        try {
          if (!stagedIds.length) {
            tally.failed += members.length;
            for (const w of members) {
              modal.setRow(w.id, "error", "insert produced no elements");
            }
            continue;
          }

          let nodes = 0;
          for (const id of stagedIds) {
            const t = await ns.callBridge("describe-tree", { id });
            if (t?.ok) nodes += ns.countNodes(t.tree);
          }

          for (const w of members) {
            modal.setStatus(`Decoupling "${name}"…`);
            modal.setRow(w.id, "running", "replacing");
            // The index is resolved page-side against the widget's own id, so
            // earlier replaces shifting its siblings cannot misplace it.
            const res = await ns.callBridge("replace-container", {
              sourceIds: stagedIds,
              targetId: w.id,
            });
            if (!res?.ok) {
              tally.failed++;
              modal.setRow(w.id, "error", `failed — ${res?.error}`);
              ns.log("warn", `Template decouple: "${name}" — ${res?.error}`);
              continue;
            }
            tally.done++;
            tally.nodes += nodes;

            // Decoupling is what destroys settings.template_id, so the tag on
            // the layer name becomes the only remaining trace of where this
            // content came from — and it is what lets template-sync still find
            // and re-style the block afterwards. The name is the template's title
            // from the library; the widget's own layer name only stands in when
            // the library fetch failed and there is no title to use.
            // A multi-root template lands several siblings here, so each carries
            // its root index and they stay individually addressable.
            const newIds = res.ids || (res.id ? [res.id] : []);
            const multi = newIds.length > 1;

            // The template's content says nothing about the box the widget sat
            // in — its padding, CSS classes, motion effects and the rest live on
            // the widget, and the replace above just deleted it. Captured at
            // scan time for exactly that reason; written here, inside the same
            // undo step.
            const advNote = await carryOverAdvanced(
              modal,
              carryAdvanced ? w.advanced : null,
              newIds,
              multi,
              tally,
            );

            const items = newIds
              .map((id, k) => ({
                id,
                title: withTemplateTag(
                  meta?.title || w.title,
                  templateId,
                  multi ? k + 1 : null,
                ),
              }))
              .filter((it) => it.title);
            let namedNote = "";
            if (items.length) {
              const ren = await ns.callBridge("rename", { items });
              const names = [...new Set(items.map((it) => it.title))]
                .map((n) => `"${n}"`)
                .join(", ");
              namedNote = ren?.ok ? ` · named ${names}` : " · rename failed";
              if (!ren?.ok) {
                ns.log(
                  "warn",
                  `Template decouple: naming ${names} — ${ren?.error}`,
                );
              }
            }
            modal.setRow(
              w.id,
              "ok",
              `decoupled — ${stagedIds.length} root(s), ${nodes} node(s)${advNote}${namedNote}`,
            );
          }
        } finally {
          if (stagedIds.length) {
            const del = await ns.callBridge("delete", { ids: stagedIds });
            if (!del?.ok) {
              const msg =
                `could not remove the staged copy of "${name}" ` +
                `(${stagedIds.join(", ")}) — ${del?.error}. Delete it manually.`;
              ns.log("error", `Template decouple: ${msg}`);
              modal.note(`⚠ ${msg}`, "error");
            }
          }
        }
      }

      // Content pulled in from a template can itself hold template widgets.
      // Deliberately not recursed — a second keypress is safer than a walk
      // that could chase a template referencing itself.
      const after = await ns.callBridge("list-template-widgets");
      const fresh = after?.ok
        ? (after.widgets || []).filter((w) => !knownIds.has(w.id))
        : [];
      if (fresh.length) {
        modal.note(" ");
        modal.note(
          `⚠ ${fresh.length} template widget(s) came in with the decoupled ` +
            `content. They were left alone — run the hotkey again to decouple them.`,
          "warn",
        );
        for (const w of fresh.slice(0, 10)) {
          const meta = w.templateId ? titleById.get(w.templateId) : null;
          modal.note(
            `    ${meta?.title || `#${w.templateId}`} at ${w.path}`,
            "warn",
          );
        }
        ns.log(
          "warn",
          `Template decouple: ${fresh.length} nested template widget(s) left alone`,
        );
      }

      const summary =
        `${tally.done} decoupled (${tally.nodes} node(s)), ${tally.failed} failed` +
        (tally.advanced ? `, ${tally.advanced} advanced setting(s) carried over` : "") +
        (fresh.length ? `, ${fresh.length} nested left alone` : "");
      ns.log(tally.done ? "info" : "warn", `Template decouple: ${summary}`);
      modal.finish(summary, tally.failed || fresh.length ? "warn" : "ok");
    } catch (err) {
      ns.log("error", `Template decouple: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await ns.callBridge("history-end", { logId }, { waitLimit: 1 });
      }
      running = false;
    }
  };

  ns.decoupleTemplates = decoupleTemplates;
})();
