(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const LOG_LIMIT = 50;
  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";

  const log = async (level, message) => {
    const entry = { level, message, time: Date.now() };
    try {
      const { logs = [] } = await browser.storage.local.get("logs");
      const next = [entry, ...logs].slice(0, LOG_LIMIT);
      await browser.storage.local.set({ logs: next });
    } catch (_) {}
  };

  const collectCollapsedAncestors = (target) => {
    const collapsed = [];
    let node = target.parentElement;
    while (node) {
      if (
        node.classList &&
        node.classList.contains("elementor-navigator__elements") &&
        getComputedStyle(node).display === "none"
      ) {
        collapsed.push(node);
      }
      node = node.parentElement;
    }
    return collapsed.reverse();
  };

  const expandContainer = (container) => {
    const owner = container.parentElement;
    const toggle = owner?.querySelector(
      ":scope > .elementor-navigator__item .elementor-navigator__element__list-toggle",
    );
    toggle?.click();
  };

  const selectLayerById = (id) => {
    if (!id) {
      log("warn", "selectLayerById called without id");
      return false;
    }
    const target = document.querySelector(
      `${NAV_ELEMENT}[data-id="${CSS.escape(id)}"]`,
    );
    if (!target) {
      log("warn", `Layer not found in navigator: ${id}`);
      return false;
    }

    for (const container of collectCollapsedAncestors(target)) {
      expandContainer(container);
    }

    const item = target.querySelector(":scope > .elementor-navigator__item");
    if (!item) {
      log("warn", `Layer row not clickable: ${id}`);
      return false;
    }
    item.click();
    item.scrollIntoView({ block: "center" });
    log("info", `Reselected ${id}`);
    return true;
  };

  ns.log = log;
  ns.selectLayerById = selectLayerById;
})();
