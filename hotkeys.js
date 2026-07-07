(() => {
  if (!location.search.includes("action=elementor")) return;

  const bindings = [
    {
      match: (e) =>
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.shiftKey &&
        e.code === "Digit1",
      run: () => window.__ElementorTools?.findLayerRoot?.(),
    },
    {
      match: (e) =>
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.shiftKey &&
        e.code === "Digit2",
      run: () => {
        window.__ElementorTools?.replaceStyles?.();
        return true;
      },
    },
    {
      match: (e) =>
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.shiftKey &&
        e.code === "Digit3",
      run: () => {
        window.__ElementorTools?.replaceLayer?.();
        return true;
      },
    },
    {
      match: (e) =>
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        e.shiftKey &&
        e.code === "Digit4",
      run: async () => {
        const { selectedLayer } =
          await browser.storage.local.get("selectedLayer");
        if (!selectedLayer?.id) {
          window.__ElementorTools?.log?.("warn", "No stored layer to reselect");
          return true;
        }
        window.__ElementorTools?.selectLayerById?.(selectedLayer.id);
        return true;
      },
    },
  ];

  const handler = (e) => {
    for (const b of bindings) {
      if (!b.match(e)) continue;
      const result = b.run();
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
