// Component system — key bindings.
//
// Its own listener rather than an entry in hotkeys.js, so the component system
// stays self-contained: deleting this folder removes the feature completely.
//
// Ctrl+Shift+1..9 are taken by the existing tools, so the numeric family
// continues at 0 for the action that gets used constantly, and the panel toggle
// sits on a different modifier.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorComponents = window.__ElementorComponents || {});

  const BINDINGS = [
    {
      match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.code === "Digit0",
      label: "Ctrl+Shift+0",
      description: "Sync components in this document",
      run: () => ns.syncComponents?.(),
    },
    {
      match: (e) => e.ctrlKey && e.altKey && !e.shiftKey && e.code === "KeyC",
      label: "Ctrl+Alt+C",
      description: "Toggle the Components panel",
      run: () => ns.ui?.toggle?.(),
    },
  ];

  // Elementor's panel is full of text inputs and its preview is an iframe of
  // editable content. A hotkey that fires mid-typing is worse than no hotkey.
  const isTyping = (target) => {
    if (!target) return false;
    const tag = String(target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return true;
    return !!target.isContentEditable;
  };

  const handle = (event) => {
    if (isTyping(event.target)) return;
    for (const binding of BINDINGS) {
      if (!binding.match(event)) continue;
      event.preventDefault();
      event.stopPropagation();
      try {
        binding.run();
      } catch (err) {
        ns.log?.("error", `${binding.label}: ${err?.message || err}`);
      }
      return;
    }
  };

  // Capture phase, because Elementor binds its own shortcuts on the document
  // and a bubbling listener would sometimes never see the event.
  document.addEventListener("keydown", handle, true);

  ns.BINDINGS = BINDINGS.map((b) => ({
    label: b.label,
    description: b.description,
  }));
})();
