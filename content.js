(() => {
  if (!location.search.includes("action=elementor")) return;

  const WIDTHS = { mobile: 390, tablet: 786 };

  let wrapper = null;
  let selfWrite = false;
  let overrideActive = false;
  let observer = null;
  let bootstrap = null;

  const findWrapper = () => {
    const byId = document.querySelector(
      "#elementor-preview-responsive-wrapper",
    );
    if (byId) return byId;
    const byClass = document.querySelector(
      ".elementor-preview-responsive-wrapper",
    );
    if (byClass) return byClass;
    const iframe = document.querySelector("#elementor-preview-iframe");
    let el = iframe && iframe.parentElement;
    while (el && !/width\s*:/.test(el.getAttribute("style") || ""))
      el = el.parentElement;
    return el;
  };

  const currentDevice = () => {
    const active = document.querySelector(
      '[data-testid^="switch-device-to-"][aria-selected="true"]',
    );
    return active
      ? active.getAttribute("data-testid").replace("switch-device-to-", "")
      : null;
  };

  const clearOverride = () => {
    if (!overrideActive || !wrapper) return;
    selfWrite = true;
    wrapper.style.removeProperty("width");
    overrideActive = false;
    requestAnimationFrame(() => {
      selfWrite = false;
    });
  };

  const applyOverride = () => {
    if (!wrapper || !document.contains(wrapper)) wrapper = findWrapper();
    if (!wrapper) return;
    const device = currentDevice();
    const target = WIDTHS[device];
    if (target == null) {
      clearOverride();
      return;
    }
    selfWrite = true;
    wrapper.style.setProperty("width", target + "px", "important");
    overrideActive = true;
    requestAnimationFrame(() => {
      selfWrite = false;
    });
  };

  const onClick = (e) => {
    if (e.target.closest('[data-testid^="switch-device-to-"]')) {
      requestAnimationFrame(applyOverride);
    }
  };
  document.addEventListener("click", onClick, true);

  const cleanup = () => {
    if (bootstrap) {
      clearInterval(bootstrap);
      bootstrap = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    document.removeEventListener("click", onClick, true);
    clearOverride();
  };
  window.addEventListener("pagehide", cleanup, { once: true });

  const start = Date.now();
  bootstrap = setInterval(() => {
    wrapper = findWrapper();
    if (wrapper) {
      clearInterval(bootstrap);
      bootstrap = null;
      observer = new MutationObserver(() => {
        if (!selfWrite) applyOverride();
      });
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: [
          "style",
          "aria-selected",
          "data-elementor-device-mode",
        ],
      });
      applyOverride();
    } else if (Date.now() - start > 30000) {
      clearInterval(bootstrap);
      bootstrap = null;
    }
  }, 300);
})();
