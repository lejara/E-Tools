// The editor half of the Automation tool. One message runs one page, start to
// finish: the phases the window asked for, in the order it asked for them, then
// the save. The save is always last — see below.
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
  // The blind path: the saved document config was unreadable, so there is no
  // ground truth at all and "empty" can only be established by time.
  //
  // This used to be the ONLY path — SETTLE_EMPTY applied to every empty-looking
  // page, which meant 3 polls at 800ms decided it. 2.4 seconds is nowhere near a
  // large page's boot, so a still-building editor passed for an empty one and the
  // whole page was skipped, silently, because "no matches" is a legitimate answer.
  // That is now the rare degraded case, so it can afford to be properly patient.
  const SETTLE_EMPTY_BLIND = 12;

  // How many polls the rendered element count may sit still, SHORT of what the
  // saved document says, before it is accepted anyway. The 1:1 correspondence
  // between saved elements and walked containers holds on this build, but a
  // future Elementor that renders one fewer node must not turn every run into a
  // 120s timeout — a count that has stopped growing has finished building,
  // whatever the arithmetic says. Reported rather than swallowed.
  const UNDERCOUNT_GRACE = 8;

  // Module-level, because a settling check is the one thing here that needs memory
  // between polls. The window calls readiness() repeatedly; these carry across.
  let lastTop = -1;
  let lastTotal = -1;
  let stableHits = 0;
  let totalStableHits = 0;
  let firstPollAt = 0;

  // Whether Firefox is throttling this tab, answered once and reused.
  //
  // A background tab gets its timers clamped to >=1s and its requestAnimationFrame
  // suspended outright — and Elementor builds the preview through rAF, so a hidden
  // tab can look exactly like a slow site: the readiness probe just never passes.
  // Those two are worth being able to tell apart from a run's report rather than
  // by guessing, so a frame probe rides along on every reply.
  //
  // The cost is self-selecting: an unthrottled tab answers in ~16ms, and only a
  // suspended one pays the full window — which is precisely the tab worth waiting
  // to learn about.
  let framesMs;
  const frameProbe = (ms = 1200) =>
    new Promise((resolve) => {
      const t0 = Date.now();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, ms);
      requestAnimationFrame(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(Date.now() - t0);
      });
    });

  const environment = async () => {
    if (framesMs === undefined) framesMs = await frameProbe();
    return {
      hidden: document.hidden,
      visibilityState: document.visibilityState,
      // null means no frame arrived at all, which is the signature of a tab
      // Firefox has suspended rather than a site that is merely slow.
      frameMs: framesMs,
    };
  };

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
    if (!firstPollAt) firstPollAt = Date.now();
    const env = await environment();
    const not = (why) => ({ ready: false, why, env });

    const ping = await ns.callBridge("ping", {}, { waitLimit: 1, timeout: 2000 });
    if (!ping?.ok || !ping.ready) {
      return not("Elementor has not booted yet");
    }
    const doc = await ns.callBridge("describe-document", {}, { waitLimit: 1 });
    if (!doc?.ok) {
      return not(`no document yet — ${doc?.error || "unknown"}`);
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
      return not(`preview iframe is ${frameState || "not there yet"}`);
    }

    const page = await ns.callBridge("list-containers", {}, { waitLimit: 1 });
    if (!page?.ok) {
      return not(`preview not built — ${page?.error || "unknown"}`);
    }
    // `list-containers` answering ok is NOT enough, and this is the trap that cost
    // a real run: the preview container exists well before its children are built,
    // so an early walk returns an EMPTY list with ok: true. The sync then sees no
    // top containers, concludes the page holds no templates, and the page is
    // skipped — on a page with five of them.
    const all = page.containers || [];
    const rendered = all.filter((c) => c.depth === 0).length;
    const saved = page.saved || { top: null, total: null, via: null };

    // GATE 1, and the one that actually settles this: the saved document config,
    // read off the server response before a single view is built. Compared on the
    // TOTAL element count rather than the top level, because a page whose top
    // containers exist while their descendants are still rendering is exactly what
    // breaks nested matching — the top-level check cannot see that at all.
    //
    // `total: 0` is a legitimately empty document and passes; `via: null` means
    // the config was unreadable and the blind settle below carries it instead.
    let undercount = null;
    if (typeof saved.total === "number" && all.length < saved.total) {
      if (all.length === lastTotal) totalStableHits += 1;
      else {
        lastTotal = all.length;
        totalStableHits = 0;
      }
      stableHits = 0;
      lastTop = rendered;
      if (totalStableHits < UNDERCOUNT_GRACE) {
        return not(`preview still building (${all.length}/${saved.total} elements)`);
      }
      // Stopped growing well short of the saved count. Accepted rather than left
      // to time out, and carried into the reply so the run says so — see
      // UNDERCOUNT_GRACE.
      undercount = { rendered: all.length, saved: saved.total };
    } else {
      lastTotal = all.length;
      totalStableHits = 0;
    }

    // GATE 2 — the live model, kept as an independent second signal. It is precise
    // once populated; it simply cannot be trusted to say "empty", because
    // `elementor.elements` fills in WITH the preview rather than before it, which
    // is what made the old empty check a coin flip.
    const expected = page.topLevelExpected;
    if (typeof expected === "number" && expected > 0 && rendered !== expected) {
      stableHits = 0;
      lastTop = rendered;
      return not(`preview still building (${rendered}/${expected} top-level containers)`);
    }

    if (rendered === lastTop) stableHits += 1;
    else {
      lastTop = rendered;
      stableHits = 0;
    }
    // A rendered page needs one confirming sample. An empty one needs more, and
    // how many depends on whether anything authoritative said it is empty: with
    // the saved config readable this is a formality, without it, it is the only
    // evidence there is.
    const needed =
      rendered > 0
        ? SETTLE_NONEMPTY
        : saved.via
          ? SETTLE_EMPTY
          : SETTLE_EMPTY_BLIND;
    if (stableHits < needed) {
      return not(
        rendered === 0
          ? `no top-level containers yet — confirming the document really is empty (${stableHits}/${needed}${saved.via ? "" : ", saved count unreadable"})`
          : `preview settling (${rendered} top-level, ${stableHits}/${needed})`,
      );
    }

    return {
      ready: true,
      env,
      elapsedMs: Date.now() - firstPollAt,
      doc: {
        id: doc.id,
        title: doc.title || "",
        status: doc.status || null,
        isTemplate: !!doc.isTemplate,
      },
      containers: all.length,
      topLevel: rendered,
      saved,
      undercount,
    };
  };

  // The two phases a page can run, and nothing about the order they run in — the
  // window owns that and sends it, so the sequence has exactly one definition (see
  // MODES in automation.js) rather than a copy here to drift from it.
  //
  // `missing` is what a phase reports when its tool is not loaded in this tab. It
  // has to be its own message per phase: an automation run cannot tell `undefined`
  // from "no matches", and a wrong diagnosis once sent an investigation in the
  // wrong direction for a whole run.
  const PHASES = {
    sync: {
      missing: "template sync is not available in this tab",
      // Awaited in full. The allowlist and the toggles stand in for the confirm
      // checklist the interactive path shows — see runTemplateOperation's `auto`.
      run: ({ templateIds, toggles }) =>
        ns.syncTemplateStyles?.({ templateIds, toggles }),
    },
    edge: {
      missing: "edge presets are not available in this tab",
      run: ({ presetIds, templateIds, titles }) =>
        ns.applyEdgePresets?.({ presetIds, templateIds, titles }),
    },
  };

  const runPage = async (args = {}) => {
    const { mode = "both", review = false } = args;
    // Unknown names are dropped and a repeat is taken once. There is deliberately
    // NO fallback order: guessing one for a page whose phase list arrived empty
    // would mean running — and writing — something the window never asked for, so
    // an empty list is reported instead. Same direction as an unrecognised Edge
    // Preset condition, which never passes.
    const phases = (Array.isArray(args.phases) ? args.phases : []).filter(
      (p, i, all) => Object.hasOwn(PHASES, p) && all.indexOf(p) === i,
    );
    // Thrown rather than reported as a phase or save result: nothing was attempted,
    // so this is a bad request and belongs on the listener's error channel, where
    // the window shows it as the failure it is instead of as a broken save.
    if (!phases.length) {
      throw new Error("nothing to run — no recognised phases were requested");
    }

    const report = { mode, phases, review, sync: null, edge: null, save: null };

    for (const name of phases) {
      const phase = PHASES[name];
      report[name] = (await phase.run(args)) || { ok: false, error: phase.missing };
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
    // Walked in run order, so with both phases broken the one reported is the one
    // that failed first.
    const hardFailure = phases.map((p) => report[p]).find((r) => r && !r.ok) || null;
    if (hardFailure) {
      report.save = {
        ok: false,
        saved: false,
        skipped: true,
        error: "not saved — a phase failed, so the page was left untouched",
      };
      return report;
    }

    // Review mode: the edits stay in the editor and the window leaves the tab
    // open so a human can look at them and publish. Nothing here is persisted,
    // which is the whole point — a structural edit that removes content is the
    // one thing in this tool that an automated run cannot undo afterwards,
    // because the tab is normally closed the moment the save lands.
    //
    // The cost is real and was chosen: a browser crash loses the entire run.
    if (review) {
      report.save = {
        ok: true,
        saved: false,
        review: true,
        why: "left open for review — publish from the editor tab",
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
