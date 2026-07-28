(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const MODAL_ID = "ElementorTools-template-decouple-modal";

  let running = false;

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
      const templatesRes = await ns.listSiteTemplates();
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
      const selected = await modal.choose(
        candidates,
        (w) => labels.get(w.id),
        "Decouple",
      );
      if (!selected) {
        ns.log("info", "Template decouple: cancelled");
        modal.close();
        return;
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

      const historyRes = await ns.callBridge("history-start", {
        title: "Decouple templates",
      });
      logId = historyRes?.ok ? historyRes.logId : null;

      const tally = { done: 0, failed: 0, nodes: 0 };

      for (const [templateId, members] of groups) {
        const meta = titleById.get(templateId);
        const name = meta?.title || `#${templateId}`;

        for (const w of members) modal.addRow(w.id, labels.get(w.id));

        modal.setStatus(`Inserting "${name}"…`);
        const ins = await ns.insertSiteTemplate(templateId, {
          source: meta?.source,
          title: meta?.title,
          type: meta?.type,
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
            modal.setRow(
              w.id,
              "ok",
              `decoupled — ${stagedIds.length} root(s), ${nodes} node(s)`,
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
        (fresh.length ? `, ${fresh.length} nested left alone` : "");
      ns.log(tally.done ? "info" : "warn", `Template decouple: ${summary}`);
      modal.finish(summary, tally.failed || fresh.length ? "warn" : "ok");
    } catch (err) {
      ns.log("error", `Template decouple: ${err?.message || err}`);
      modal.finish(`Error — ${err?.message || err}`, "error");
    } finally {
      if (logId !== null && logId !== undefined) {
        await ns.callBridge("history-end", { logId });
      }
      running = false;
    }
  };

  ns.decoupleTemplates = decoupleTemplates;
})();
