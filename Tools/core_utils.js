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

  const NS = "elementor-tools";
  const BRIDGE_URL = browser.runtime.getURL("Tools/page-bridge.js");
  const BRIDGE_TIMEOUT = 3000;

  let bridgeInjected = false;
  let bridgeReady = false;
  let bridgeReadyResolvers = [];
  let nextRequestId = 0;
  const pending = new Map();

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== NS) return;
    if (data.__ready) {
      bridgeReady = true;
      bridgeReadyResolvers.forEach((r) => r());
      bridgeReadyResolvers = [];
      return;
    }
    if (data.__response && pending.has(data.requestId)) {
      const { resolve, timer } = pending.get(data.requestId);
      pending.delete(data.requestId);
      clearTimeout(timer);
      resolve(data);
    }
  });

  const injectBridge = () => {
    if (bridgeInjected) return;
    bridgeInjected = true;
    const script = document.createElement("script");
    script.src = BRIDGE_URL;
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  };

  const waitForBridge = () =>
    new Promise((resolve) => {
      if (bridgeReady) return resolve();
      bridgeReadyResolvers.push(resolve);
      setTimeout(resolve, BRIDGE_TIMEOUT);
    });

  const callBridge = async (op, payload) => {
    injectBridge();
    await waitForBridge();
    if (!bridgeReady) {
      return { ok: false, error: "Bridge failed to load" };
    }
    const requestId = ++nextRequestId;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        resolve({ ok: false, error: `Timeout on op: ${op}` });
      }, BRIDGE_TIMEOUT);
      pending.set(requestId, { resolve, timer });
      window.postMessage(
        { __ns: NS, requestId, op, payload: payload || {} },
        "*",
      );
    });
  };

  ns.log = log;
  ns.selectLayerById = selectLayerById;
  ns.callBridge = callBridge;
})();
