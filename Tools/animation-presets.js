// Apply a saved Motion Effects preset to whatever is selected. The panel owns
// the UI — presets are authored as JSON files there and stored in
// browser.storage.local; this side only resolves the targets and writes.
//
// "Apply" means the Motion Effects tab now *equals* the preset: every one of the
// section's 61 settings is reset to its Elementor default and then the preset's
// own values are written over the top. A field the preset does not mention goes
// back to default rather than keeping whatever the previous preset left there,
// which is what makes applying two presets in a row predictable.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});
  const F = window.__AnimationPresetFields;
  if (!F) {
    ns.log?.(
      "error",
      "Animation presets: animation-preset-fields.js did not load — check manifest order",
    );
    return;
  }

  const STORAGE_KEY = "animationPresets";

  // The page world cannot yield mid-op, so a large shift-click selection is sent
  // in batches rather than one message: each element costs two Elementor
  // commands, and a batch is the unit of "still alive". Same reasoning as
  // STYLE_CHUNK in template-sync.js, and the timeout scales with it.
  const NODE_CHUNK = 20;

  const loadPresets = async () => {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const list = stored?.[STORAGE_KEY];
    return Array.isArray(list) ? list : [];
  };

  // Shift-click always wins. It is an explicit act, and its *order* is the whole
  // input to Delay Accumulation; the navigator selection is only whatever
  // happened to be clicked last and is always a single element.
  const resolveTargets = async () => {
    const ids = ns.multiSelect?.getIds?.() || [];
    if (ids.length) return { ids, via: "shift-click order" };

    const res = await ns.callBridge("describe-selection", {}, { waitLimit: 1 });
    if (!res?.ok) {
      return { ids: [], error: `could not read the selection — ${res?.error}` };
    }
    if (!res.selected?.id) {
      return {
        ids: [],
        error:
          "nothing selected — shift+click layers in the navigator, or select one",
      };
    }
    return { ids: [res.selected.id], via: `selection (${res.selected.via})` };
  };

  // The panel's New button: a preset is *captured* off an element the user has
  // already styled in Elementor's own UI, which is why there is no blank
  // template to author by hand. A selection is required — with nothing selected
  // there is nothing to copy, so this reports rather than inventing defaults.
  //
  // Several layers shift-clicked reads from the first, the one wearing badge #1.
  // Picking one of many needs to be predictable and visible, and that badge is
  // both.
  const captureFromSelection = async () => {
    const ids = ns.multiSelect?.getIds?.() || [];
    let id = ids[0] || null;
    let via = ids.length
      ? `shift-click #1${ids.length > 1 ? ` of ${ids.length}` : ""}`
      : "";

    if (!id) {
      const res = await ns.callBridge(
        "describe-selection",
        {},
        { waitLimit: 1 },
      );
      if (!res?.ok) {
        return {
          ok: false,
          error: `could not read the selection — ${res?.error}`,
        };
      }
      if (!res.selected?.id) {
        return {
          ok: false,
          error:
            "No layer selected — select one in the editor, or shift+click it in the navigator.",
        };
      }
      id = res.selected.id;
      via = `selection (${res.selected.via})`;
    }

    const read = await ns.callBridge(
      "read-preset-settings",
      { id, keys: F.ALL_KEYS },
      { waitLimit: 3 },
    );
    if (!read?.ok) {
      return {
        ok: false,
        error: `could not read Motion Effects — ${read?.error}`,
      };
    }

    ns.log(
      "info",
      `Animation preset captured from "${read.title || id}" (${via})` +
        (read.missing?.length
          ? ` · ${read.missing.length} field(s) absent on that element`
          : ""),
    );
    return {
      ok: true,
      layer: { id, title: read.title || "", elType: read.elType },
      via,
      values: read.values || [],
      missing: read.missing || [],
    };
  };

  const applyAnimationPreset = async ({
    presetId,
    delayAccumulation = 0,
  } = {}) => {
    if (!presetId) {
      ns.log("error", "Animation presets: no preset id given");
      return { ok: false, error: "no preset id" };
    }

    const preset = (await loadPresets()).find((p) => p?.id === presetId);
    if (!preset) {
      ns.log("error", `Animation presets: no preset with id ${presetId}`);
      return { ok: false, error: "preset not found" };
    }
    const label = preset.name || preset.id;

    const { ids, via, error } = await resolveTargets();
    if (!ids.length) {
      ns.log("warn", `Animation preset "${label}": ${error}`);
      return { ok: false, error };
    }

    const writes = F.presetWrites(preset);
    const resetKeys = F.ALL_KEYS;

    // The stagger only exists for a multi-layer shift-click selection: one layer
    // gets the preset's own delay untouched, which is what the preset says.
    const step = Number(delayAccumulation) || 0;
    const staggered = ids.length > 1 && step > 0;
    const baseDelay = staggered ? F.presetDelay(preset) : 0;
    const delayFor = (i) => baseDelay + step * i;

    const settingsFor = (i) => {
      if (!staggered) return writes;
      // The preset's own animation_delay is the base, so its entry is replaced
      // rather than appended to — otherwise two values for one key would ride
      // along and the last one written would silently win.
      const rest = writes.filter((w) => w.key !== F.DELAY_KEY);
      return [...rest, { key: F.DELAY_KEY, type: "number", value: delayFor(i) }];
    };

    const delayNote = staggered
      ? ` · delay ${ids
          .slice(0, 6)
          .map((_, i) => delayFor(i))
          .join("/")}${ids.length > 6 ? `/…` : ""}ms`
      : "";
    ns.log(
      "info",
      `Animation preset "${label}" → ${ids.length} layer${
        ids.length === 1 ? "" : "s"
      } (${via}) · ${writes.length} field${
        writes.length === 1 ? "" : "s"
      } set${delayNote}`,
    );

    const historyRes = await ns.callBridge(
      "history-start",
      { title: `Apply animation preset: ${label}` },
      { waitLimit: 1 },
    );
    const logId = historyRes?.ok ? historyRes.logId : null;

    const results = [];
    let failure = null;
    try {
      for (let start = 0; start < ids.length; start += NODE_CHUNK) {
        const slice = ids.slice(start, start + NODE_CHUNK);
        const items = slice.map((id, n) => ({
          id,
          reset: resetKeys,
          settings: settingsFor(start + n),
        }));
        const res = await ns.callBridge(
          "apply-preset-settings",
          { items },
          // A mutation, so it is waited on and never re-sent. The span covers two
          // Elementor commands per element in the batch.
          { timeout: 4000 + slice.length * 600, waitLimit: 3 },
        );
        if (!res?.ok) {
          failure = res?.error || "bridge refused the write";
          break;
        }
        results.push(...(res.results || []));
      }
    } finally {
      if (logId !== null && logId !== undefined) {
        // waitLimit 1, as everywhere: history-end degrades to a no-op, and a
        // re-arming wait here holds the undo group open long enough for the
        // user's next edit to join this run's undo step.
        await ns.callBridge("history-end", { logId }, { waitLimit: 1 });
      }
    }

    // Every skip is reported. A field that could not be written is a value the
    // user put in the preset and did not get, which is exactly the case where
    // silence reads as success.
    let skipped = 0;
    for (const r of results) {
      if (!r.skipped?.length) continue;
      skipped += r.skipped.length;
      const which = r.skipped
        .map((s) => `${s.key} (${s.why})`)
        .join(", ");
      ns.log(
        "warn",
        `Animation preset "${label}": "${r.title || r.id}" skipped ${
          r.skipped.length
        } field${r.skipped.length === 1 ? "" : "s"} — ${which}`,
      );
    }

    if (failure) {
      ns.log(
        "error",
        `Animation preset "${label}" failed after ${results.length} of ${ids.length} layers — ${failure}`,
      );
      return { ok: false, error: failure, applied: results.length };
    }

    ns.log(
      "info",
      `Animation preset "${label}" applied to ${results.length} layer${
        results.length === 1 ? "" : "s"
      }${skipped ? ` · ${skipped} field(s) skipped` : ""}`,
    );
    return { ok: true, applied: results.length, skipped };
  };

  // Capture gets its own message type rather than riding run-action: the panel
  // needs the values *back*, and run-action deliberately replies as soon as a
  // run has started. Anything else returns undefined so the other listeners on
  // this page stay free to answer it.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    if (msg.type !== "capture-preset") return undefined;
    return captureFromSelection().catch((err) => ({
      ok: false,
      error: err?.message || String(err),
    }));
  });

  ns.applyAnimationPreset = applyAnimationPreset;
  ns.captureAnimationPreset = captureFromSelection;
})();
