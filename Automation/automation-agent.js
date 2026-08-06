// The editor half of the Automation tool. One message runs one page, start to
// finish: sync, then edge presets, then save.
//
// It is a content script, so it lives inside the editor tab the Automation window
// opened and can simply await each phase. The alternative — the window driving
// four separate messages per page — would have to guess at the boundaries between
// them and would leave a page half-processed whenever a reply went missing.
//
// It does NOT own cancellation. The window cancels by closing the tab, which
// kills this script mid-run, and that is safe by construction: nothing here has
// been persisted until `save-document` at the end, so an abandoned page is an
// untouched page. That is the whole reason the phases are ordered with the save
// last.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  // A save is a network round trip to WordPress on a site that may be slow, and
  // it is the one op here where a lost answer loses work: the window closes the
  // tab straight after, so a save that never landed is silent data loss. Hence a
  // generous span and a high waitLimit — the rule from CLAUDE.md that waitLimit
  // is high where a lost answer orphans something. It is a mutation, so it is
  // waited on and never re-sent.
  const SAVE_TIMEOUT = 20000;
  const SAVE_WAIT_LIMIT = 5;

  // How many consecutive polls must agree on the top-level count before the
  // document is called ready. A page with content needs one confirming sample; a
  // page that looks EMPTY has to look empty for longer, because "empty" is also
  // what a preview that has not started building looks like.
  const SETTLE_NONEMPTY = 1;
  const SETTLE_EMPTY = 3;

  // Module-level, because a settling check is the one thing here that needs memory
  // between polls. The window calls readiness() repeatedly; these carry across.
  let lastTop = -1;
  let stableHits = 0;

  // "The editor is ready" is not one fact, and getting it wrong is expensive: a
  // run that starts too early reads an EMPTY document, concludes the page holds no
  // templates, and skips it — silently, because "no matches" is a legitimate
  // answer. That happened on a real run, on a page with five top-level containers.
  //
  //   ping              → $e and elementor exist at all
  //   describe-document → a document is open (and which one)
  //   preview iframe    → the preview page itself has finished loading
  //   list-containers   → the preview container is built, so the sync can read it
  //   settling          → the count agrees with itself, and with the model
  //
  // The settling check is the load-bearing one and the model comparison is not
  // enough on its own: `elementor.elements` fills in WITH the preview rather than
  // before it, so early on the rendered count and the model count are both 0 and
  // agree — which is exactly how an unbuilt page passed for a built empty one.
  const readiness = async () => {
    const ping = await ns.callBridge("ping", {}, { waitLimit: 1, timeout: 2000 });
    if (!ping?.ok || !ping.ready) {
      return { ready: false, why: "Elementor has not booted yet" };
    }
    const doc = await ns.callBridge("describe-document", {}, { waitLimit: 1 });
    if (!doc?.ok) {
      return { ready: false, why: `no document yet — ${doc?.error || "unknown"}` };
    }
    // The preview is a same-origin iframe, so its own load state is readable and
    // is a real signal rather than an inference. It is created dynamically, so it
    // does not hold up the top document's load event — which is why the top
    // document being "complete" proves nothing here.
    const frame = document.querySelector("#elementor-preview-iframe");
    const frameState = (() => {
      try {
        return frame?.contentDocument?.readyState || null;
      } catch (_) {
        return null;
      }
    })();
    if (frameState !== "complete") {
      return { ready: false, why: `preview iframe is ${frameState || "not there yet"}` };
    }

    const page = await ns.callBridge("list-containers", {}, { waitLimit: 1 });
    if (!page?.ok) {
      return { ready: false, why: `preview not built — ${page?.error || "unknown"}` };
    }
    // `list-containers` answering ok is NOT enough, and this is the trap that cost
    // a real run: the preview container exists well before its children are built,
    // so an early walk returns an EMPTY list with ok: true. The sync then sees no
    // top containers, concludes the page holds no templates, and the page is
    // skipped — on a page with five of them.
    //
    // So the rendered depth-0 count has to match what the document model says.
    // `topLevelExpected: 0` is a legitimately empty page and is accepted; `null`
    // means the model was unreadable, where not checking beats never being ready.
    const rendered = (page.containers || []).filter((c) => c.depth === 0).length;
    const expected = page.topLevelExpected;
    if (typeof expected === "number" && expected > 0 && rendered !== expected) {
      stableHits = 0;
      lastTop = rendered;
      return {
        ready: false,
        why: `preview still building (${rendered}/${expected} top-level containers)`,
      };
    }

    if (rendered === lastTop) stableHits += 1;
    else {
      lastTop = rendered;
      stableHits = 0;
    }
    const needed = rendered === 0 ? SETTLE_EMPTY : SETTLE_NONEMPTY;
    if (stableHits < needed) {
      return {
        ready: false,
        why:
          rendered === 0
            ? `no top-level containers yet — confirming the document really is empty (${stableHits}/${needed})`
            : `preview settling (${rendered} top-level, ${stableHits}/${needed})`,
      };
    }

    return {
      ready: true,
      doc: {
        id: doc.id,
        title: doc.title || "",
        status: doc.status || null,
        isTemplate: !!doc.isTemplate,
      },
      containers: (page.containers || []).length,
      topLevel: rendered,
    };
  };

  const runPage = async ({
    mode = "both",
    templateIds = null,
    toggles = null,
    presetIds = null,
    titles = null,
  } = {}) => {
    const report = { mode, sync: null, edge: null, save: null };

    if (mode === "sync" || mode === "both") {
      // Awaited in full. The allowlist and the toggles stand in for the confirm
      // checklist the interactive path shows — see runTemplateOperation's `auto`.
      report.sync = (await ns.syncTemplateStyles?.({ templateIds, toggles })) || {
        ok: false,
        error: "template sync is not available in this tab",
      };
    }

    // Runs after the sync, always. The sync pastes the template's own values, so
    // an edge preset applied first would simply be overwritten.
    if (mode === "edge" || mode === "both") {
      report.edge = (await ns.applyEdgePresets?.({
        presetIds,
        templateIds,
        titles,
      })) || { ok: false, error: "edge presets are not available in this tab" };
    }

    // A phase that failed OUTRIGHT — not one that merely counted failures — leaves
    // the page unsaved on purpose. `ok: false` means the run stopped somewhere it
    // did not expect to, so what the model holds is unknown; not saving leaves the
    // document exactly as it was on the server, which is both the safe outcome and
    // a re-runnable one. Persisting an unknown state is neither.
    //
    // This is the same reasoning as the cancel path, where abandoning a tab is safe
    // precisely because nothing has been written yet. It does not conflict with
    // "always save what was edited": a page that is not saved was never edited.
    //
    // A sync reporting `failed: 3` is a different thing and IS saved — carrying on
    // past individual failures is what the sync is designed to do, and throwing the
    // rest of its work away would make one bad container cost the whole page.
    const hardFailure =
      (report.sync && !report.sync.ok && report.sync) ||
      (report.edge && !report.edge.ok && report.edge) ||
      null;
    if (hardFailure) {
      report.save = {
        ok: false,
        saved: false,
        skipped: true,
        error: "not saved — a phase failed, so the page was left untouched",
      };
      return report;
    }

    // Otherwise unconditional, because `save-document` is the thing that decides:
    // it skips a document Elementor reports as unchanged, so a page nothing matched
    // keeps its modified date and writes no revision. Publish-vs-draft is decided
    // by the post's own status, so a draft stays a draft.
    const save = await ns.callBridge(
      "save-document",
      {},
      { timeout: SAVE_TIMEOUT, waitLimit: SAVE_WAIT_LIMIT },
    );
    report.save = save?.ok
      ? {
          ok: true,
          saved: !!save.saved,
          why: save.why || null,
          status: save.status || null,
          // A save that reports the document still changed did not take. Surfaced
          // rather than trusted: the tab is closed immediately after this, so this
          // is the last moment anything can notice.
          stillChanged: save.stillChanged ?? null,
        }
      : { ok: false, error: save?.error || "save failed" };

    if (report.save.ok && report.save.saved && report.save.stillChanged) {
      report.save.ok = false;
      report.save.error = "saved, but Elementor still reports unsaved changes";
    }
    return report;
  };

  // Distinct message types rather than riding `run-action`, for two reasons that
  // both matter: run-action deliberately replies as soon as a run has *started*,
  // and its runners drop their arguments, so neither the allowlist nor the report
  // could travel on it. Anything else returns undefined so the page's other
  // listeners stay free to answer.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    if (msg.type === "automation-ready") {
      return readiness().catch((err) => ({
        ready: false,
        why: String(err?.message || err),
      }));
    }
    if (msg.type === "automation-run") {
      return runPage(msg.args || {})
        .then((report) => ({ ok: true, report }))
        .catch((err) => ({ ok: false, error: String(err?.message || err) }));
    }
    return undefined;
  });
})();
