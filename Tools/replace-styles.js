(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorTools = window.__ElementorTools || {});

  const NAV_ELEMENT = ".elementor-navigator__element[data-id]";
  const TITLE_SELECTOR = ".elementor-navigator__element__title__text";
  const CHILDREN_CONTAINER = ".elementor-navigator__elements";

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  const getTitle = (el) =>
    el.querySelector(TITLE_SELECTOR)?.textContent?.trim() || "";

  const getIconClass = (el) => {
    const icon = el.querySelector(
      ".elementor-navigator__element__element-type i",
    );
    if (!icon) return "";
    return [...icon.classList].find((c) => c.startsWith("eicon-")) || "";
  };

  const getDirectChildren = (el) => {
    const container = [...el.children].find((c) =>
      c.classList?.contains(CHILDREN_CONTAINER.slice(1)),
    );
    if (!container) return [];
    return [...container.children].filter((c) => c.matches(NAV_ELEMENT));
  };

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

  const describeSubtree = (el) => ({
    id: el.getAttribute("data-id"),
    name: getTitle(el),
    type: getIconClass(el),
    children: getDirectChildren(el).map(describeSubtree),
  });

  // Walk source and target trees in lockstep. If structurally identical
  // (same name + icon type, same child count and order at every level),
  // return the positional pairs [{sourceId, targetId}, ...]. Otherwise null.
  const pairSubtrees = (src, tgt) => {
    if (src.name !== tgt.name) return null;
    if (src.type !== tgt.type) return null;
    if (src.children.length !== tgt.children.length) return null;
    const pairs = [{ sourceId: src.id, targetId: tgt.id }];
    for (let i = 0; i < src.children.length; i++) {
      const sub = pairSubtrees(src.children[i], tgt.children[i]);
      if (!sub) return null;
      pairs.push(...sub);
    }
    return pairs;
  };

  const runSimpleReplace = async (source, sourceId, sourceName, rootEl) => {
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

  const runDeepReplace = async (source, sourceId, sourceName, rootEl) => {
    const sourceType = getIconClass(source);
    const sourceTree = describeSubtree(source);

    const passed = [];
    const failedStructure = [];
    for (const el of rootEl.querySelectorAll(NAV_ELEMENT)) {
      const id = el.getAttribute("data-id");
      if (!id || id === sourceId) continue;
      if (getTitle(el) !== sourceName) continue;
      if (getIconClass(el) !== sourceType) continue;
      const pairs = pairSubtrees(sourceTree, describeSubtree(el));
      if (pairs) passed.push({ id, pairs });
      else failedStructure.push({ id, title: getTitle(el) });
    }

    for (const f of failedStructure) {
      ns.log?.(
        "warn",
        `Replace styles: structure mismatch on "${f.title}" (${f.id}) — skipped`,
      );
    }

    if (!passed.length) {
      ns.log?.(
        "warn",
        `Replace styles: no structural matches for "${sourceName}"`,
      );
      return;
    }

    const totalNodes = passed.reduce((n, m) => n + m.pairs.length, 0);
    const preview = passed
      .slice(0, 8)
      .map((m) => `• ${sourceName} (${m.id}) — ${m.pairs.length} node(s)`)
      .join("\n");
    const more = passed.length > 8 ? `\n… and ${passed.length - 8} more` : "";
    const ok = window.confirm(
      `REPLACE STYLES + CHILDREN\n  ${passed.length} layer(s) named "${sourceName}", ${totalNodes} node(s) total?\n\n${preview}${more}`,
    );
    if (!ok) {
      ns.log?.("info", "Replace styles: cancelled");
      return;
    }

    let done = 0;
    for (const m of passed) {
      for (const p of m.pairs) {
        const copyRes = await ns.callBridge?.("copy", { id: p.sourceId });
        if (!copyRes || !copyRes.ok) {
          ns.log?.(
            "warn",
            `Replace styles: copy failed for ${p.sourceId}: ${copyRes?.error || "no bridge"}`,
          );
          continue;
        }
        const pasteRes = await ns.callBridge?.("paste-style", {
          id: p.targetId,
        });
        if (!pasteRes || !pasteRes.ok) {
          ns.log?.(
            "warn",
            `Replace styles: paste-style failed on ${p.targetId}: ${pasteRes?.error || "unknown"}`,
          );
          continue;
        }
        done++;
        await wait(30);
      }
    }

    ns.log?.(
      "info",
      `Replace styles: applied to ${done}/${totalNodes} node(s) across ${passed.length} match(es)`,
    );
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

    const { replaceChildrenStyles } = await browser.storage.local.get(
      "replaceChildrenStyles",
    );
    if (replaceChildrenStyles) {
      await runDeepReplace(source, sourceId, sourceName, rootEl);
    } else {
      await runSimpleReplace(source, sourceId, sourceName, rootEl);
    }
  };

  ns.replaceStyles = replaceStyles;
})();
