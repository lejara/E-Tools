(() => {
  if (!location.search.includes("action=elementor")) return;

  const { ACTIONS, matches, mergeWithDefaults } =
    window.__ElementorHotkeyDefaults;

  const runners = {
    findLayerRoot: () => window.__ElementorTools?.findLayerRoot?.(),
    replaceStyles: () => {
      window.__ElementorTools?.replaceStyles?.();
      return true;
    },
    replaceLayer: () => {
      window.__ElementorTools?.replaceLayer?.();
      return true;
    },
    batchRename: () => {
      window.__ElementorTools?.batchRename?.();
      return true;
    },
    syncTemplateStyles: () => {
      window.__ElementorTools?.syncTemplateStyles?.();
      return true;
    },
    replaceWithTemplate: () => {
      window.__ElementorTools?.replaceWithTemplate?.();
      return true;
    },
    insertTemplates: () => {
      window.__ElementorTools?.insertTemplates?.();
      return true;
    },
    decoupleTemplates: () => {
      window.__ElementorTools?.decoupleTemplates?.();
      return true;
    },
    // Not in ACTIONS — it has no binding, because which preset to apply cannot
    // be expressed as a keystroke. It lives here anyway so the panel's preset
    // buttons dispatch through the same table as everything else.
    applyAnimationPreset: (args) => {
      window.__ElementorTools?.applyAnimationPreset?.(args || {});
      return true;
    },
    reselectRoot: async () => {
      const { selectedLayer } =
        await browser.storage.local.get("selectedLayer");
      if (!selectedLayer?.id) {
        window.__ElementorTools?.log?.("warn", "No stored layer to reselect");
        return true;
      }
      window.__ElementorTools?.selectLayerById?.(selectedLayer.id);
      return true;
    },
  };

  // The panel's per-hotkey Run buttons land here. They go through the same
  // `runners` table as the keydown handler on purpose — a button and its key
  // cannot drift apart if there is only one entry point per action.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    if (msg.type !== "run-action") return undefined;
    const runner = runners[msg.action];
    if (!runner) {
      return Promise.resolve({
        ok: false,
        error: `unknown action "${msg.action}"`,
      });
    }
    try {
      // Tools own their own UI, so the reply only reports that the run
      // started — awaiting the whole operation would hold the panel's
      // sendMessage open for the length of a template sync.
      //
      // msg.args carries whatever the caller needs the action parameterised by
      // (which animation preset, and its delay accumulation). The keydown path
      // passes the event instead, which every bound action ignores.
      Promise.resolve(runner(msg.args)).catch((err) => {
        window.__ElementorTools?.log?.(
          "error",
          `${msg.action} failed — ${err?.message || err}`,
        );
      });
    } catch (err) {
      return Promise.resolve({ ok: false, error: err?.message || String(err) });
    }
    return Promise.resolve({ ok: true });
  });

  let bindings = mergeWithDefaults(null);

  browser.storage.local.get("hotkeyBindings").then(({ hotkeyBindings }) => {
    bindings = mergeWithDefaults(hotkeyBindings || null);
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.hotkeyBindings) return;
    bindings = mergeWithDefaults(changes.hotkeyBindings.newValue || null);
  });

  const handler = (e) => {
    for (const a of ACTIONS) {
      if (!matches(bindings[a.id], e)) continue;
      const result = runners[a.id](e);
      if (result !== undefined) e.preventDefault();
      return;
    }
  };

  const attached = new WeakSet();
  const attach = (doc) => {
    if (!doc || attached.has(doc)) return;
    attached.add(doc);
    doc.addEventListener("keydown", handler, true);
  };

  attach(document);

  document.addEventListener(
    "load",
    (e) => {
      const t = e.target;
      if (t && t.id === "elementor-preview-iframe" && t.contentDocument) {
        attach(t.contentDocument);
      }
    },
    true,
  );

  const initialIframe = document.querySelector("#elementor-preview-iframe");
  if (initialIframe?.contentDocument) attach(initialIframe.contentDocument);
})();
