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
