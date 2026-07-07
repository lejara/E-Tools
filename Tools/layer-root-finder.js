(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";

  const findSelected = () => {
    const editing = document.querySelector(
      ".elementor-navigator__item.elementor-editing",
    );
    return editing ? editing.closest(NAV_ELEMENT) : null;
  };

  const log = (level, message) => ns.log?.(level, message);

  const findLayerRoot = () => {
    const el = findSelected();
    if (!el) {
      log("warn", "No selected layer found");
      return null;
    }

    const id = el.getAttribute("data-id");
    if (!id) {
      log("warn", "Selected element has no data-id");
      return null;
    }

    const layer = {
      id,
      modelCid: el.getAttribute("data-model-cid"),
      title:
        el
          .querySelector(".elementor-navigator__element__title__text")
          ?.textContent?.trim() || null,
      element: el,
    };
    ns.selectedLayer = layer;
    document.dispatchEvent(
      new CustomEvent("elementor-tools:layer-selected", { detail: layer }),
    );
    browser.storage?.local
      ?.set({
        selectedLayer: {
          id: layer.id,
          modelCid: layer.modelCid,
          title: layer.title,
        },
      })
      ?.catch?.(() => {});
    log("info", `Selected ${layer.title || "(untitled)"} · ${layer.id}`);
    return layer;
  };

  ns.findLayerRoot = findLayerRoot;
})();
