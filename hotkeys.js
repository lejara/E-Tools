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
