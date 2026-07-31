(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const SELECTED_CLASS = "ElementorTools-selected";
  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";
  const NAV_ITEM = ".elementor-navigator__item";
  const NAV_SCOPE =
    "#elementor-navigator, .elementor-navigator, .elementor-navigator__elements";
  const ORDER_ATTR = "data-et-order";

  const style = document.createElement("style");
  style.textContent = `
    .${SELECTED_CLASS} > .elementor-navigator__item {
      background: rgba(56, 128, 255, 0.35) !important;
      outline: 1px solid rgba(56, 128, 255, 0.75);
      outline-offset: -1px;
    }
    /* The selection-order badge, for tools that care which layer came first —
       template-sync does not, animation presets' Delay Accumulation does.
       It is a pseudo-element reading a data attribute rather than an injected
       node, and that is load-bearing: the retint below is driven by a childList
       MutationObserver, so a real element would be observed and re-inserted on
       every pass. Attribute writes are not observed.
       The navigator row is already position:relative with overflow:hidden and
       its ::after is unused, so this claims space Elementor is not using. */
    .${SELECTED_CLASS} > .elementor-navigator__item[${ORDER_ATTR}]::after {
      content: attr(${ORDER_ATTR});
      position: absolute;
      left: 3px;
      bottom: 1px;
      z-index: 1;
      min-width: 11px;
      padding: 0 2px;
      border-radius: 2px;
      background: rgba(56, 128, 255, 0.95);
      color: #fff;
      font:
        600 9px/12px ui-monospace,
        monospace;
      text-align: center;
      pointer-events: none;
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

  // Rank comes straight out of the Set — JS iterates insertion order, so this is
  // shift-click order, which is the order getIds() hands to a tool. Deselecting
  // renumbers whatever is left, and re-selecting a row puts it at the end rather
  // than back where it was.
  const applyTint = () => {
    const order = new Map(
      [...selectedIds].map((id, i) => [id, String(i + 1)]),
    );
    const rows = document.querySelectorAll(NAV_ELEMENT);
    for (const el of rows) {
      const id = el.getAttribute("data-id");
      const rank = order.get(id);
      const shouldHave = rank !== undefined;
      const hasIt = el.classList.contains(SELECTED_CLASS);
      if (shouldHave && !hasIt) el.classList.add(SELECTED_CLASS);
      else if (!shouldHave && hasIt) el.classList.remove(SELECTED_CLASS);

      const item = el.querySelector(`:scope > ${NAV_ITEM}`);
      if (!item) continue;
      if (rank === undefined) item.removeAttribute(ORDER_ATTR);
      else if (item.getAttribute(ORDER_ATTR) !== rank) {
        item.setAttribute(ORDER_ATTR, rank);
      }
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
