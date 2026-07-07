(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";
  const TITLE_SELECTOR = ".elementor-navigator__element__title__text";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const getTitle = (el) =>
    el.querySelector(TITLE_SELECTOR)?.textContent?.trim() || "";

  const findCurrentlySelected = () => {
    const editing = document.querySelector(
      ".elementor-navigator__item.elementor-editing",
    );
    return editing ? editing.closest(NAV_ELEMENT) : null;
  };

  const findRootElement = async () => {
    const { selectedLayer } = await browser.storage.local.get("selectedLayer");
    if (!selectedLayer?.id) return null;
    return document.querySelector(
      `${NAV_ELEMENT}[data-id="${CSS.escape(selectedLayer.id)}"]`,
    );
  };

  const findMatches = (rootEl, sourceId, name) => {
    const out = [];
    const all = rootEl.querySelectorAll(NAV_ELEMENT);
    for (const el of all) {
      const id = el.getAttribute("data-id");
      if (!id || id === sourceId) continue;
      if (getTitle(el) !== name) continue;

      const childrenContainer = el.parentElement;
      const parentEl = childrenContainer?.parentElement;
      const parentId = parentEl?.getAttribute?.("data-id") || null;
      const siblings = childrenContainer
        ? [...childrenContainer.children].filter((c) =>
            c.hasAttribute("data-id"),
          )
        : [];
      const index = siblings.indexOf(el);
      out.push({ id, title: getTitle(el), parentId, index });
    }
    return out;
  };

  const replaceLayer = async () => {
    const source = findCurrentlySelected();
    if (!source) {
      ns.log?.("warn", "Replace layer: no layer selected in editor");
      return;
    }
    const sourceId = source.getAttribute("data-id");
    const sourceName = getTitle(source);
    if (!sourceName) {
      ns.log?.("warn", "Replace layer: source has no name");
      return;
    }

    const rootEl = await findRootElement();
    if (!rootEl) {
      ns.log?.("warn", "Replace layer: no root layer stored (Ctrl+Shift+1)");
      return;
    }

    const matches = findMatches(rootEl, sourceId, sourceName);
    if (!matches.length) {
      ns.log?.("warn", `Replace layer: no matches for "${sourceName}"`);
      return;
    }

    const usable = matches.filter((m) => m.parentId && m.index >= 0);
    if (usable.length < matches.length) {
      ns.log?.(
        "warn",
        `Replace layer: skipping ${matches.length - usable.length} match(es) with no resolvable parent`,
      );
    }
    if (!usable.length) return;

    ns.log?.(
      "info",
      `Replace layer: ${usable.length} match(es) for "${sourceName}" — awaiting confirm`,
    );

    const preview = usable
      .slice(0, 8)
      .map((m) => `• ${m.title} (${m.id}) @${m.index}`)
      .join("\n");
    const more = usable.length > 8 ? `\n… and ${usable.length - 8} more` : "";
    const ok = window.confirm(
      `REPLACE ${usable.length} LAYERS: \n named "${sourceName}"?\n\n${preview}${more}`,
    );
    if (!ok) {
      ns.log?.("info", "Replace layer: cancelled");
      return;
    }

    const copyRes = await ns.callBridge?.("copy", { id: sourceId });
    if (!copyRes || !copyRes.ok) {
      ns.log?.(
        "warn",
        `Replace layer: copy failed: ${copyRes?.error || "no bridge"}`,
      );
      return;
    }

    ns.log?.(
      "info",
      `Replace layer: started — ${usable.length} target(s) for "${sourceName}"`,
    );

    let done = 0;
    for (const m of usable) {
      const pasteRes = await ns.callBridge?.("paste", { targetId: m.parentId });
      if (!pasteRes || !pasteRes.ok || !pasteRes.id) {
        ns.log?.(
          "warn",
          `Replace layer: paste failed under ${m.parentId}: ${pasteRes?.error || "no id returned"}`,
        );
        continue;
      }
      const newId = pasteRes.id;

      const moveRes = await ns.callBridge?.("move", {
        id: newId,
        targetId: m.parentId,
        at: m.index,
      });
      if (!moveRes || !moveRes.ok) {
        ns.log?.(
          "warn",
          `Replace layer: move failed for ${newId}: ${moveRes?.error || "unknown"}`,
        );
        continue;
      }

      const delRes = await ns.callBridge?.("delete", { id: m.id });
      if (!delRes || !delRes.ok) {
        ns.log?.(
          "warn",
          `Replace layer: delete failed for ${m.id}: ${delRes?.error || "unknown"}`,
        );
        continue;
      }

      done++;
      await wait(30);
    }

    ns.log?.(
      "info",
      `Replace layer: ended — replaced ${done}/${usable.length} layer(s)`,
    );

    ns.selectLayerById?.(sourceId);
  };

  ns.replaceLayer = replaceLayer;
})();
