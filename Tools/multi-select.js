(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const SELECTED_CLASS = "ElementorTools-selected";
  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";
  const NAV_SCOPE =
    "#elementor-navigator, .elementor-navigator, .elementor-navigator__elements";

  const style = document.createElement("style");
  style.textContent = `
    .${SELECTED_CLASS} > .elementor-navigator__item {
      background: rgba(56, 128, 255, 0.35) !important;
      outline: 1px solid rgba(56, 128, 255, 0.75);
      outline-offset: -1px;
    }
  `;
  (document.head || document.documentElement).appendChild(style);

  const selectedIds = new Set();
  const listeners = new Set();

  const emit = () => {
    const snapshot = new Set(selectedIds);
    for (const cb of listeners) {
      try {
        cb(snapshot);
      } catch (_) {}
    }
  };

  const applyTint = () => {
    const rows = document.querySelectorAll(NAV_ELEMENT);
    for (const el of rows) {
      const id = el.getAttribute("data-id");
      const shouldHave = selectedIds.has(id);
      const hasIt = el.classList.contains(SELECTED_CLASS);
      if (shouldHave && !hasIt) el.classList.add(SELECTED_CLASS);
      else if (!shouldHave && hasIt) el.classList.remove(SELECTED_CLASS);
    }
  };

  let rafPending = false;
  const scheduleRetint = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      applyTint();
    });
  };

  const setSelected = (id, on) => {
    if (on) selectedIds.add(id);
    else selectedIds.delete(id);
    emit();
    applyTint();
  };

  const clearAll = () => {
    if (!selectedIds.size) return;
    selectedIds.clear();
    emit();
    applyTint();
  };

  document.addEventListener(
    "click",
    (e) => {
      if (!e.shiftKey) return;
      const inNav = e.target.closest?.(NAV_SCOPE);
      if (!inNav) return;

      const row = e.target.closest(NAV_ELEMENT);
      e.preventDefault();
      e.stopPropagation();

      if (!row) {
        if (selectedIds.size) {
          clearAll();
          ns.log?.("info", "Multi-select: cleared");
        }
        return;
      }

      const id = row.getAttribute("data-id");
      if (!id) return;

      if (selectedIds.has(id)) {
        setSelected(id, false);
        ns.log?.("info", `Multi-select: -${id} (${selectedIds.size})`);
      } else {
        setSelected(id, true);
        ns.log?.("info", `Multi-select: +${id} (${selectedIds.size})`);
      }
    },
    true,
  );

  const observer = new MutationObserver(scheduleRetint);
  observer.observe(document.body, { childList: true, subtree: true });

  ns.multiSelect = {
    getIds: () => [...selectedIds],
    has: (id) => selectedIds.has(id),
    clear: clearAll,
    onChange: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
})();
