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

  const callBridge = async (op, payload, { timeout } = {}) => {
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
      }, timeout || BRIDGE_TIMEOUT);
      pending.set(requestId, { resolve, timer });
      window.postMessage(
        { __ns: NS, requestId, op, payload: payload || {} },
        "*",
      );
    });
  };

  // The first insert of a given template fetches its content over the network,
  // which routinely outlives the 3s default. A timeout here is worse than slow:
  // the insert still lands, leaving an orphaned copy in the document.
  const TEMPLATE_TIMEOUT = 15000;

  // intoId / afterId are optional placement: append inside that container, or
  // land directly after that element. Neither one means the end of the page.
  const insertSiteTemplate = async (
    templateId,
    {
      source = "local",
      title,
      type,
      withPageSettings = false,
      intoId,
      afterId,
    } = {},
  ) => {
    if (!templateId) {
      log("warn", "insertSiteTemplate called without templateId");
      return { ok: false, error: "templateId is required" };
    }
    const result = await callBridge(
      "insert-template",
      { templateId, source, title, type, withPageSettings, intoId, afterId },
      { timeout: TEMPLATE_TIMEOUT },
    );
    log(
      result.ok ? "info" : "warn",
      result.ok
        ? `Inserted template ${templateId}`
        : `Failed to insert template ${templateId}: ${result.error}`,
    );
    return result;
  };

  const listSiteTemplates = async ({ source = "local" } = {}) => {
    const result = await callBridge(
      "list-templates",
      { source },
      { timeout: TEMPLATE_TIMEOUT },
    );
    log(
      result.ok ? "info" : "warn",
      result.ok
        ? `Fetched ${result.templates?.length ?? 0} templates (source=${source})`
        : `Failed to fetch templates: ${result.error}`,
    );
    return result;
  };

  // Layer names and template titles are both hand-typed. Compare them
  // forgivingly. Shared with the panel — see template-format.js.
  const { normalizeName } = window.__ElementorTemplateFormat;

  const nodeType = (n) =>
    `${n.elType || "?"}${n.widgetType ? `:${n.widgetType}` : ""}`;

  const countNodes = (n) =>
    1 + (n.children || []).reduce((sum, c) => sum + countNodes(c), 0);

  // Compact one-line shape, e.g. container[heading, container[text, button]].
  // Depth-capped so a deep tree stays readable in a log line.
  const summarizeTree = (n, depth = 2) => {
    const kids = n.children || [];
    if (!kids.length) return nodeType(n);
    if (depth <= 0) return `${nodeType(n)}[…${kids.length}]`;
    return `${nodeType(n)}[${kids.map((c) => summarizeTree(c, depth - 1)).join(", ")}]`;
  };

  const childList = (kids) =>
    kids.length ? kids.map(nodeType).join(", ") : "nothing";

  const nodeLabel = (n) =>
    n.title ? `"${n.title}" (${nodeType(n)})` : nodeType(n);

  // Longest common subsequence over two child lists, returning aligned index
  // pairs. Lists are small (a level of an Elementor tree), so plain O(n*m) DP.
  const lcsAlign = (a, b, keyOf) => {
    const n = a.length;
    const m = b.length;
    if (!n || !m) return [];
    const keysA = a.map(keyOf);
    const keysB = b.map(keyOf);
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          keysA[i] === keysB[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (keysA[i] === keysB[j]) {
        out.push([i, j]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
    return out;
  };

  // Align one level of children. Pass 1 matches on type+name (high
  // confidence); pass 2 fills the leftover gaps on type alone, so a renamed
  // layer still aligns while an inserted or deleted one becomes a gap.
  const alignChildren = (srcKids, tgtKids) => {
    const strictKey = (n) => `${nodeType(n)}\0${normalizeName(n.title)}`;
    const looseKey = (n) => nodeType(n);

    const matched = [];
    let si = 0;
    let ti = 0;
    const fillGap = (sEnd, tEnd) => {
      const sGap = srcKids.slice(si, sEnd);
      const tGap = tgtKids.slice(ti, tEnd);
      if (!sGap.length || !tGap.length) return;
      for (const [a, b] of lcsAlign(sGap, tGap, looseKey)) {
        matched.push([si + a, ti + b]);
      }
    };

    for (const [s, t] of lcsAlign(srcKids, tgtKids, strictKey)) {
      fillGap(s, t);
      matched.push([s, t]);
      si = s + 1;
      ti = t + 1;
    }
    fillGap(srcKids.length, tgtKids.length);

    matched.sort((x, y) => x[0] - y[0]);
    const srcSeen = new Set(matched.map((p) => p[0]));
    const tgtSeen = new Set(matched.map((p) => p[1]));
    return {
      matched,
      srcOnly: srcKids.map((_, i) => i).filter((i) => !srcSeen.has(i)),
      tgtOnly: tgtKids.map((_, i) => i).filter((i) => !tgtSeen.has(i)),
    };
  };

  // Below this share of nodes aligning, the two trees are not the same block
  // and styling the overlap would do more harm than refusing.
  const MIN_MATCH_RATIO = 0.5;

  // A layer whose name contains the skip word is left alone. Default "skip";
  // clearing the panel field to empty turns the feature off entirely.
  const DEFAULT_SKIP_WORD = "skip";

  const skipMatcherFor = (word) => {
    const needle = normalizeName(word);
    if (!needle) return () => false;
    return (name) => normalizeName(name).includes(needle);
  };

  const getSkipMatcher = async () => {
    try {
      const { skipWord } = await browser.storage.local.get("skipWord");
      return skipMatcherFor(
        skipWord === undefined ? DEFAULT_SKIP_WORD : skipWord,
      );
    } catch (_) {
      return skipMatcherFor(DEFAULT_SKIP_WORD);
    }
  };

  // Walk two model trees (from the describe-tree bridge op) in lockstep.
  // Names are deliberately ignored — only element type and child order/count
  // have to line up. Returns positional pairs, or the first divergence with
  // enough context to see what actually differs.
  //
  // opts.isSkipped(name) marks a node as untouchable: it yields no pair, its
  // subtree is not walked, and — deliberately — its structure is not compared.
  // Marking a branch "skip" means the branch is allowed to have diverged.
  const pairTrees = (src, tgt, opts = {}) => {
    const isSkipped = opts.isSkipped || (() => false);
    const skipped = [];
    const missing = []; // in the template, absent from the page
    const extra = []; //   on the page, absent from the template
    const pairs = [];

    // The roots have to be the same kind of thing; nothing below that is
    // interpretable if they are not.
    const srcType = nodeType(src);
    const tgtType = nodeType(tgt);
    if (srcType !== tgtType) {
      return {
        ok: false,
        error: `root: template is "${srcType}" but page is "${tgtType}"`,
      };
    }

    // Whole skipped subtrees come out of the ratio on each side. Counting
    // their descendants would let the skip word itself push a container under
    // the threshold, which is the opposite of what marking a branch means.
    let srcSkip = 0;
    let tgtSkip = 0;

    const walk = (s, t, path) => {
      if (isSkipped(s.title) || isSkipped(t.title)) {
        skipped.push(t.title || s.title || path);
        srcSkip += countNodes(s);
        tgtSkip += countNodes(t);
        return;
      }
      pairs.push({ sourceId: s.id, targetId: t.id });

      const srcKids = s.children || [];
      const tgtKids = t.children || [];
      const { matched, srcOnly, tgtOnly } = alignChildren(srcKids, tgtKids);

      for (const i of srcOnly) {
        if (isSkipped(srcKids[i].title)) {
          srcSkip += countNodes(srcKids[i]);
          continue;
        }
        missing.push(`${path} > ${nodeLabel(srcKids[i])}`);
      }
      for (const j of tgtOnly) {
        if (isSkipped(tgtKids[j].title)) {
          tgtSkip += countNodes(tgtKids[j]);
          continue;
        }
        extra.push(`${path} > ${nodeLabel(tgtKids[j])}`);
      }
      for (const [i, j] of matched) {
        walk(srcKids[i], tgtKids[j], `${path} > [${i}]`);
      }
    };

    walk(src, tgt, "root");

    // Ratio is against the larger tree so that a template matching only a
    // small corner of a big page container still reads as a poor match.
    const total = Math.max(
      countNodes(src) - srcSkip,
      countNodes(tgt) - tgtSkip,
      1,
    );
    const ratio = pairs.length / total;
    if (ratio < MIN_MATCH_RATIO) {
      return {
        ok: false,
        ratio,
        missing,
        extra,
        error:
          `only ${pairs.length}/${total} nodes aligned (${Math.round(ratio * 100)}%) — ` +
          `too different to be the same block ` +
          `(${missing.length} missing from page, ${extra.length} extra on page)`,
      };
    }

    return { ok: true, pairs, skipped, missing, extra, ratio };
  };

  // The panel window has no page bridge of its own — only the editor tab can
  // reach Elementor's authenticated REST endpoints. This is the panel's way in.
  // The file-level action=elementor guard above means only editor tabs answer,
  // so the panel can broadcast and take the first responder.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    if (msg.type === "ping") return Promise.resolve({ ok: true });
    if (msg.type === "list-templates") {
      return listSiteTemplates(msg.options || {});
    }
    return undefined;
  });

  /* --------------------------------------------------------- progress modal */

  const STATE_COLORS = {
    pending: "#888",
    running: "#7a9cff",
    ok: "#6ac47a",
    warn: "#e0b060",
    error: "#e07070",
  };

  // Shared progress/checklist modal. Every long-running tool drives the same
  // shape: a status line, a scrolling log of per-target rows, an optional
  // checklist confirm, and a summary that stays up with Copy details. Opened
  // before the first await, never after — see CLAUDE.md.
  const openProgressModal = (
    titleText,
    { id = "ElementorTools-progress-modal" } = {},
  ) => {
    document.getElementById(id)?.remove();

    const wrap = document.createElement("div");
    wrap.id = id;
    wrap.style.cssText = `
      position: fixed; inset: 0; z-index: 2147483647;
      background: rgba(0,0,0,0.45);
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const card = document.createElement("div");
    card.style.cssText = `
      background: #2a2a2a; color: #fff; border-radius: 8px;
      padding: 20px 22px; width: 560px; max-width: 92vw;
      box-shadow: 0 12px 40px rgba(0,0,0,0.5);
      display: flex; flex-direction: column; gap: 12px;
    `;
    wrap.appendChild(card);

    const title = document.createElement("div");
    title.textContent = titleText;
    title.style.cssText = "font-size:15px;font-weight:600;";
    card.appendChild(title);

    const status = document.createElement("div");
    status.style.cssText = "font-size:13px;color:#cfcfcf;";
    card.appendChild(status);

    const list = document.createElement("div");
    list.style.cssText = `
      max-height: 320px; overflow-y: auto;
      background: #1a1a1a; border: 1px solid #3a3a3a; border-radius: 4px;
      padding: 6px 8px; font-size: 12px; line-height: 1.5;
      font-family: ui-monospace, monospace; display: none;
    `;
    card.appendChild(list);

    const btnRow = document.createElement("div");
    btnRow.style.cssText =
      "display:flex;justify-content:flex-end;gap:8px;align-items:center;";
    card.appendChild(btnRow);

    const makeBtn = (text, primary) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = text;
      b.style.cssText = `
        padding:7px 14px; border-radius:4px; font-size:13px; cursor:pointer;
        border: 1px solid ${primary ? "#3880ff" : "#555"};
        background: ${primary ? "#3880ff" : "transparent"};
        color: #fff;
      `;
      return b;
    };

    document.body.appendChild(wrap);

    const rows = new Map();
    let onEscape = null;
    const keyHandler = (e) => {
      if (e.key === "Escape" && onEscape) {
        e.preventDefault();
        e.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener("keydown", keyHandler, true);

    const api = {
      setStatus(text) {
        status.textContent = text;
      },
      addRow(rowId, label) {
        const row = document.createElement("div");
        row.style.cssText = "padding:2px 0;word-break:break-word;";
        const name = document.createElement("span");
        name.textContent = label;
        name.style.cssText = "color:#eee;";
        const detail = document.createElement("span");
        detail.style.cssText = `color:${STATE_COLORS.pending};`;
        detail.textContent = " — waiting";
        row.append(name, detail);
        list.appendChild(row);
        list.style.display = "block";
        rows.set(rowId, detail);
        row.scrollIntoView({ block: "nearest" });
      },
      setRow(rowId, state, text) {
        const detail = rows.get(rowId);
        if (!detail) return;
        detail.style.color = STATE_COLORS[state] || STATE_COLORS.pending;
        detail.textContent = ` — ${text}`;
        detail.parentElement?.scrollIntoView({ block: "nearest" });
      },
      note(text, state = "pending") {
        const row = document.createElement("div");
        row.textContent = text;
        row.style.cssText = `padding:2px 0;word-break:break-word;white-space:pre-wrap;color:${
          STATE_COLORS[state] || STATE_COLORS.pending
        };`;
        list.appendChild(row);
        list.style.display = "block";
        row.scrollIntoView({ block: "nearest" });
      },
      // Checklist confirm. Everything starts ticked, so the default is the
      // whole match set and unticking is the deliberate act.
      //
      // Two shapes:
      //   choose(items, labelOf, buttonText)              -> items[] | null
      //   choose({ buildItems, labelOf, buttonText, toggles }) -> {items, toggles} | null
      // The object form takes a buildItems(toggleState) callback because a
      // toggle can change which items even qualify, so flipping one has to
      // rebuild the list rather than just filter it.
      choose(itemsOrConfig, labelOfArg, buttonTextArg) {
        const legacy = Array.isArray(itemsOrConfig);
        const {
          buildItems,
          labelOf,
          buttonText,
          toggles = [],
        } = legacy
          ? {
              buildItems: () => itemsOrConfig,
              labelOf: labelOfArg,
              buttonText: buttonTextArg,
            }
          : itemsOrConfig;

        return new Promise((resolve) => {
          const toggleState = {};
          for (const t of toggles) toggleState[t.key] = !!t.default;

          // Tracked as "unticked" rather than "chosen" so an item that
          // survives a rebuild keeps its state, and new ones arrive ticked.
          const unticked = new Set();
          const ownRows = [];
          const boxes = new Map();
          let items = [];
          list.style.display = "block";

          const addOwn = (el) => {
            list.appendChild(el);
            ownRows.push(el);
            return el;
          };

          const checkRow = (labelText, checked, onChange, hint) => {
            const row = document.createElement("label");
            row.style.cssText = `
              display:flex; align-items:flex-start; gap:8px; padding:3px 2px;
              cursor:pointer; word-break:break-word; border-radius:3px;
            `;
            row.addEventListener("mouseenter", () => {
              row.style.background = "#242424";
            });
            row.addEventListener("mouseleave", () => {
              row.style.background = "";
            });
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = checked;
            box.style.cssText =
              "accent-color:#3880ff;cursor:pointer;flex:0 0 auto;margin-top:2px;";
            box.addEventListener("change", () => onChange(box.checked));
            const text = document.createElement("span");
            text.style.cssText =
              "flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:1px;";
            const main = document.createElement("span");
            main.textContent = labelText;
            main.style.color = "#eee";
            text.appendChild(main);
            if (hint) {
              const h = document.createElement("span");
              h.textContent = hint;
              h.style.cssText = "color:#777;font-size:11px;";
              text.appendChild(h);
            }
            row.append(box, text);
            return row;
          };

          const tiny = (b) => {
            b.style.padding = "5px 9px";
            b.style.fontSize = "11px";
            return b;
          };
          const allBtn = tiny(makeBtn("All", false));
          const noneBtn = tiny(makeBtn("None", false));
          const leftGroup = document.createElement("span");
          leftGroup.style.cssText = "margin-right:auto;display:flex;gap:6px;";
          leftGroup.append(allBtn, noneBtn);
          const cancel = makeBtn("Cancel", false);
          const go = makeBtn(buttonText, true);
          btnRow.replaceChildren(leftGroup, cancel, go);

          const chosenItems = () => items.filter((i) => !unticked.has(i));

          const renderButtons = () => {
            const n = chosenItems().length;
            go.disabled = !n;
            go.style.opacity = n ? "1" : "0.5";
            go.textContent = `${buttonText} ${n}`;
          };

          const rebuild = () => {
            for (const el of ownRows.splice(0)) el.remove();
            boxes.clear();

            for (const t of toggles) {
              addOwn(
                checkRow(
                  t.label,
                  toggleState[t.key],
                  (on) => {
                    toggleState[t.key] = on;
                    rebuild();
                  },
                  t.hint,
                ),
              );
            }
            if (toggles.length) {
              const rule = document.createElement("div");
              rule.style.cssText = "border-top:1px solid #333;margin:5px 0 3px;";
              addOwn(rule);
            }

            items = buildItems(toggleState) || [];
            if (!items.length) {
              const empty = document.createElement("div");
              empty.textContent = "Nothing matches.";
              empty.style.cssText =
                "color:#888;font-style:italic;padding:3px 2px;";
              addOwn(empty);
            }
            for (const item of items) {
              const row = checkRow(labelOf(item), !unticked.has(item), (on) => {
                if (on) unticked.delete(item);
                else unticked.add(item);
                renderButtons();
              });
              boxes.set(item, row.querySelector("input"));
              addOwn(row);
            }
            renderButtons();
          };

          const setAll = (on) => {
            for (const [item, box] of boxes) {
              box.checked = on;
              if (on) unticked.delete(item);
              else unticked.add(item);
            }
            renderButtons();
          };

          // Drop only this chooser's rows, so notes logged before the confirm
          // (ambiguous titles, for one) survive into the progress view.
          const done = (cancelled) => {
            btnRow.replaceChildren();
            for (const el of ownRows.splice(0)) el.remove();
            onEscape = null;
            if (cancelled) return resolve(null);
            resolve(
              legacy
                ? chosenItems()
                : { items: chosenItems(), toggles: { ...toggleState } },
            );
          };

          allBtn.addEventListener("click", () => setAll(true));
          noneBtn.addEventListener("click", () => setAll(false));
          cancel.addEventListener("click", () => done(true));
          go.addEventListener("click", () => done(false));
          onEscape = () => done(true);

          rebuild();
          go.focus();
        });
      },
      finish(summary, state = "ok") {
        status.textContent = summary;
        status.style.color = STATE_COLORS[state] || "#cfcfcf";
        const copy = makeBtn("Copy details", false);
        copy.addEventListener("click", () => {
          navigator.clipboard
            ?.writeText(list.innerText)
            .then(() => (copy.textContent = "Copied"))
            .catch(() => (copy.textContent = "Copy failed"));
        });
        const close = makeBtn("Close", true);
        close.addEventListener("click", api.close);
        btnRow.replaceChildren(copy, close);
        onEscape = api.close;
        close.focus();
        wrap.addEventListener("click", (e) => {
          if (e.target === wrap) api.close();
        });
      },
      close() {
        document.removeEventListener("keydown", keyHandler, true);
        wrap.remove();
      },
    };

    return api;
  };

  ns.log = log;
  ns.selectLayerById = selectLayerById;
  ns.openProgressModal = openProgressModal;
  ns.MODAL_STATE_COLORS = STATE_COLORS;
  ns.callBridge = callBridge;
  ns.insertSiteTemplate = insertSiteTemplate;
  ns.listSiteTemplates = listSiteTemplates;
  ns.normalizeName = normalizeName;
  ns.pairTrees = pairTrees;
  ns.summarizeTree = summarizeTree;
  ns.countNodes = countNodes;
  ns.nodeType = nodeType;
  ns.getSkipMatcher = getSkipMatcher;
  ns.DEFAULT_SKIP_WORD = DEFAULT_SKIP_WORD;
})();
