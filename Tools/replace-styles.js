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
      if (getTitle(el) === name) out.push({ id, title: getTitle(el) });
    }
    return out;
  };

  const replaceStyles = async () => {
    const source = findCurrentlySelected();
    if (!source) {
      ns.log?.("warn", "Replace styles: no layer selected in editor");
      return;
    }
    const sourceId = source.getAttribute("data-id");
    const sourceName = getTitle(source);
    if (!sourceName) {
      ns.log?.("warn", "Replace styles: source has no name");
      return;
    }

    const rootEl = await findRootElement();
    if (!rootEl) {
      ns.log?.("warn", "Replace styles: no root layer stored (Ctrl+Shift+1)");
      return;
    }

    const matches = findMatches(rootEl, sourceId, sourceName);
    if (!matches.length) {
      ns.log?.("warn", `Replace styles: no matches for "${sourceName}"`);
      return;
    }

    ns.log?.(
      "info",
      `Replace styles: ${matches.length} match(es) for "${sourceName}" — awaiting confirm`,
    );

    const preview = matches
      .slice(0, 8)
      .map((m) => `• ${m.title} (${m.id})`)
      .join("\n");
    const more = matches.length > 8 ? `\n… and ${matches.length - 8} more` : "";
    const ok = window.confirm(
      `REPLACE STYLES\n  ${matches.length} layer(s) named "${sourceName}"?\n\n${preview}${more}`,
    );
    if (!ok) {
      ns.log?.("info", "Replace styles: cancelled");
      return;
    }

    const copyRes = await ns.callBridge?.("copy", { id: sourceId });
    if (!copyRes || !copyRes.ok) {
      ns.log?.(
        "warn",
        `Replace styles: copy failed: ${copyRes?.error || "no bridge"}`,
      );
      return;
    }

    let done = 0;
    for (const m of matches) {
      const res = await ns.callBridge?.("paste-style", { id: m.id });
      if (!res || !res.ok) {
        ns.log?.(
          "warn",
          `Replace styles: paste-style failed on ${m.id}: ${res?.error || "unknown"}`,
        );
        continue;
      }
      done++;
      await wait(30);
    }

    ns.log?.(
      "info",
      `Replace styles: applied to ${done}/${matches.length} layer(s)`,
    );
  };

  ns.replaceStyles = replaceStyles;
})();
