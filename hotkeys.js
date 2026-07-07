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

  document.addEventListener("keydown", handler, true);
})();
