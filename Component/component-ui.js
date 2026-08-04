// Component system — the in-editor panel.
//
// Phase 1 is deliberately a flat list: every component in the open document,
// each with its state icon, plus the three actions. Phase 2 turns the list into
// a tree; the row rendering and the state resolution are already shaped for
// that, so the tree is a change of layout rather than a rewrite.
//
// Drawn in the content script's own overlay rather than inside Elementor's
// panel. Elementor re-renders its panel on every selection change, so anything
// injected there has to be re-injected by a MutationObserver — worth it for a
// per-field decoration, not worth it for a window the user opens and closes.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = (window.__ElementorComponents = window.__ElementorComponents || {});
  const fmt = window.__ElementorComponentFormat;
  if (!fmt) return;

  const PANEL_ID = "ElementorComponents-panel";

  const TONE = {
    ok: "#6ac47a",
    warn: "#e0b060",
    error: "#e07070",
    info: "#7a9cff",
    muted: "#888",
  };

  let el = null;
  let listEl = null;
  let statusEl = null;
  let busy = false;

  const styleButton = (b, primary) => {
    b.type = "button";
    b.style.cssText = `
      padding:6px 11px; border-radius:4px; font-size:12px; cursor:pointer;
      border:1px solid ${primary ? "#3880ff" : "#555"};
      background:${primary ? "#3880ff" : "transparent"};
      color:#fff; white-space:nowrap;
    `;
    return b;
  };

  const setBusy = (on) => {
    busy = on;
    if (!el) return;
    for (const b of el.querySelectorAll("button[data-action]")) {
      b.disabled = on;
      b.style.opacity = on ? "0.5" : "1";
    }
  };

  const setStatus = (text, tone = "muted") => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.style.color = TONE[tone] || TONE.muted;
  };

  /* -------------------------------------------------------------------- rows */

  const renderRow = (row) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = `
      display:flex; align-items:flex-start; gap:8px; padding:6px 8px;
      border-bottom:1px solid #333;
    `;
    // Depth is what makes a nested instance readable as nested. Phase 2 turns
    // this indent into real tree lines.
    wrap.style.paddingLeft = `${8 + row.depth * 12}px`;

    const icon = document.createElement("span");
    icon.textContent = row.icon.glyph;
    icon.title = row.reason ? `${row.icon.label} — ${row.reason}` : row.icon.label;
    icon.style.cssText = `
      flex:0 0 auto; font-size:13px; line-height:1.4;
      color:${TONE[row.icon.tone] || TONE.muted};
    `;

    const body = document.createElement("div");
    body.style.cssText = "flex:1 1 auto; min-width:0;";

    const name = document.createElement("div");
    name.textContent = row.payload?.name || "(unnamed)";
    name.style.cssText =
      "color:#eee; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;";

    const meta = document.createElement("div");
    const bits = [row.payload?.role === "base" ? "base" : "instance"];
    if (row.payload?.parent?.templateId) {
      bits.push(`← #${row.payload.parent.templateId}`);
    }
    if (row.overrides) bits.push(`${row.overrides} override(s)`);
    if (!row.validation?.ok) {
      bits.push(`invalid: ${row.validation.errors.join("; ")}`);
    }
    meta.textContent = bits.join(" · ");
    meta.style.cssText = "color:#777; font-size:11px; margin-top:1px;";

    body.append(name, meta);

    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex; gap:4px; flex:0 0 auto;";

    const smallButton = (label, title, onClick) => {
      const b = styleButton(document.createElement("button"), false);
      b.textContent = label;
      b.title = title;
      b.style.padding = "3px 7px";
      b.style.fontSize = "11px";
      b.addEventListener("click", onClick);
      return b;
    };

    // Renaming is an inline input that stays open until it is committed or
    // cancelled — Enter/✓ saves, Escape discards. Clicking away deliberately
    // leaves it alone, for the reason animation-presets documents: committing
    // on blur either discards the edit silently or swallows the click that
    // caused it, because the commit re-renders the row out from under it.
    const startRename = () => {
      if (name.dataset.editing === "1") return;
      name.dataset.editing = "1";
      const current = row.payload?.name || "";
      name.replaceChildren();

      const input = document.createElement("input");
      input.type = "text";
      input.value = current;
      input.style.cssText = `
        width:100%; box-sizing:border-box; padding:2px 5px;
        background:#1e1e1e; color:#eee; font-size:12px;
        border:1px solid #3880ff; border-radius:3px;
      `;
      const stop = () => {
        name.dataset.editing = "0";
        name.textContent = row.payload?.name || "(unnamed)";
      };
      const commit = async () => {
        const next = input.value.trim();
        if (!next || next === current) return stop();
        input.disabled = true;
        const res = await ns.renameComponent({ widgetId: row.widgetId, name: next });
        if (!res?.ok) {
          setStatus(`Rename failed — ${res?.error}`, "error");
          stop();
          return;
        }
        await refresh();
      };
      input.addEventListener("keydown", (e) => {
        // The editor binds its own shortcuts on the document; without this a
        // keystroke here reaches them too.
        e.stopPropagation();
        if (e.key === "Enter") commit();
        else if (e.key === "Escape") stop();
      });
      name.appendChild(input);
      input.focus();
      input.select();
    };

    // Selecting the component's root is the fastest way to answer "which block
    // is this row?" — reuse the navigator selection the rest of the toolset uses.
    buttons.append(
      smallButton("✎", "Rename this component", startRename),
      smallButton("Select", "Select this component's root container", () => {
        window.__ElementorTools?.selectLayerById?.(row.rootId);
      }),
    );

    wrap.append(icon, body, buttons);
    return wrap;
  };

  const renderBrokenRow = (b) => {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "display:flex; gap:8px; padding:6px 8px; border-bottom:1px solid #333;";
    const icon = document.createElement("span");
    icon.textContent = fmt.ICONS.broken.glyph;
    icon.style.color = TONE.error;
    const body = document.createElement("div");
    body.style.cssText = "flex:1 1 auto; min-width:0;";
    const name = document.createElement("div");
    name.textContent = `Unreadable component data in "${b.rootTitle || b.rootId}"`;
    name.style.cssText = "color:#eee; font-size:12px;";
    const meta = document.createElement("div");
    meta.textContent = `${b.reason} · widget ${b.widgetId}`;
    meta.style.cssText = "color:#777; font-size:11px;";
    body.append(name, meta);
    wrap.append(icon, body);
    return wrap;
  };

  /* ------------------------------------------------------------------ refresh */

  const refresh = async () => {
    if (!listEl) return;
    setStatus("Checking components…");
    const state = await ns.documentState();
    if (!state?.ok) {
      setStatus(`Could not read components — ${state?.error}`, "error");
      return;
    }

    listEl.replaceChildren();
    const rows = state.rows || [];
    const broken = state.broken || [];

    if (!rows.length && !broken.length) {
      const empty = document.createElement("div");
      empty.textContent = "No components in this document.";
      empty.style.cssText = "color:#888; font-style:italic; padding:10px 8px; font-size:12px;";
      listEl.appendChild(empty);
    }
    for (const row of rows) listEl.appendChild(renderRow(row));
    for (const b of broken) listEl.appendChild(renderBrokenRow(b));

    const stale = rows.filter((r) => r.stale && r.state !== "broken").length;
    const brokenCount =
      rows.filter((r) => r.state === "broken" || !r.validation?.ok).length + broken.length;

    if (state.stampError) {
      setStatus(`Could not read parent timestamps — ${state.stampError}`, "warn");
    } else if (brokenCount) {
      setStatus(
        `${rows.length} component(s), ${brokenCount} broken` +
          (stale ? `, ${stale} out of date` : ""),
        "error",
      );
    } else if (stale) {
      setStatus(`${rows.length} component(s), ${stale} out of date`, "warn");
    } else {
      setStatus(`${rows.length} component(s), all in sync`, "ok");
    }
  };

  /* -------------------------------------------------------------------- panel */

  const close = () => {
    el?.remove();
    el = null;
    listEl = null;
    statusEl = null;
  };

  const open = async () => {
    if (el) {
      await refresh();
      return;
    }

    el = document.createElement("div");
    el.id = PANEL_ID;
    el.style.cssText = `
      position:fixed; top:60px; right:20px; width:340px; max-height:70vh;
      z-index:2147483000; background:#2a2a2a; color:#fff;
      border:1px solid #3a3a3a; border-radius:8px;
      box-shadow:0 12px 40px rgba(0,0,0,0.5);
      display:flex; flex-direction:column;
      font-family:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    const header = document.createElement("div");
    header.style.cssText = `
      display:flex; align-items:center; gap:8px; padding:10px 12px;
      border-bottom:1px solid #3a3a3a; cursor:move;
    `;
    const title = document.createElement("div");
    title.textContent = "Components";
    title.style.cssText = "font-size:13px; font-weight:600; flex:1 1 auto;";
    const closeBtn = styleButton(document.createElement("button"), false);
    closeBtn.textContent = "✕";
    closeBtn.style.padding = "2px 8px";
    closeBtn.addEventListener("click", close);
    header.append(title, closeBtn);

    // Dragged by its header, like the existing overlay HUD. The editor fills the
    // screen and a fixed panel will sit on top of whatever you need to see.
    let drag = null;
    header.addEventListener("mousedown", (e) => {
      if (e.target === closeBtn) return;
      const rect = el.getBoundingClientRect();
      drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      el.style.left = `${e.clientX - drag.dx}px`;
      el.style.top = `${e.clientY - drag.dy}px`;
      el.style.right = "auto";
    });
    window.addEventListener("mouseup", () => {
      drag = null;
    });

    const actions = document.createElement("div");
    actions.style.cssText =
      "display:flex; gap:6px; padding:10px 12px; border-bottom:1px solid #3a3a3a; flex-wrap:wrap;";

    const mkAction = (label, name, handler, primary, title) => {
      const b = styleButton(document.createElement("button"), primary);
      b.textContent = label;
      // A plain marker so setBusy can find every action button; the handler is
      // held in the closure, not stringified onto the element.
      b.dataset.action = name;
      if (title) b.title = title;
      b.addEventListener("click", async () => {
        if (busy) return;
        setBusy(true);
        try {
          await handler();
        } finally {
          setBusy(false);
          await refresh();
        }
      });
      return b;
    };

    actions.append(
      mkAction("Sync", "sync", () => ns.syncComponents(), true, "Pull parent changes into this document's instances"),
      mkAction("New Component", "new", () => ns.newComponent(), false, "Turn this template's root container into a component base"),
      mkAction("Insert…", "insert", () => ns.insertComponents(), false, "Pick components from the library and insert them here"),
      mkAction("Link…", "link", () => ns.linkComponent(), false, "Select a container first, then link it to an existing component — nothing on the page changes"),
      mkAction("Reset to Base…", "reset", () => ns.resetInstances(), false, "Discard an instance's overrides and added nodes so it matches its base again"),
      mkAction("Detach…", "detach", () => ns.detachComponents(), false, "Strip component data and leave ordinary containers behind"),
      mkAction("Refresh", "refresh", async () => ns.invalidateTemplates(), false, "Re-read parent templates"),
    );

    statusEl = document.createElement("div");
    statusEl.style.cssText = "padding:8px 12px; font-size:11px; color:#888;";

    listEl = document.createElement("div");
    listEl.style.cssText = "overflow-y:auto; flex:1 1 auto; min-height:60px;";

    el.append(header, actions, statusEl, listEl);
    document.body.appendChild(el);

    await refresh();
  };

  const toggle = async () => {
    if (el) close();
    else await open();
  };

  ns.ui = { open, close, toggle, refresh };

  // The panel window has no page bridge, so it asks this tab to open the UI.
  // Returning undefined for anything else leaves the other content scripts'
  // listeners free to answer their own messages.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorComponents !== true) return undefined;
    if (msg.type === "ping") return Promise.resolve({ ok: true });
    if (msg.type === "open-ui") {
      return open().then(
        () => ({ ok: true }),
        (err) => ({ ok: false, error: String(err?.message || err) }),
      );
    }
    // Which document this tab has open. The command centre uses it to decide
    // which of its rows it is allowed to rename: a rename is a model write, and
    // writing into a document that is not open would be reverted by that
    // document's own next save — the clobbering CLAUDE.md documents.
    if (msg.type === "doc-info") {
      return ns
        .callBridge("doc-info", {}, { waitLimit: 1 })
        .then((info) => info || { ok: false, error: "no answer from the page bridge" });
    }
    if (msg.type === "rename") {
      return ns
        .renameComponent({ widgetId: msg.widgetId, name: msg.name })
        .then((res) => {
          if (res?.ok) refresh();
          return res;
        });
    }
    if (msg.type === "run") {
      const fn = {
        sync: () => ns.syncComponents(),
        new: () => ns.newComponent(),
        insert: () => ns.insertComponents(),
        link: () => ns.linkComponent(),
        reset: () => ns.resetInstances(),
        detach: () => ns.detachComponents(),
      }[msg.action];
      if (!fn) return Promise.resolve({ ok: false, error: `Unknown action: ${msg.action}` });
      // Reports that the run STARTED, not that it finished — a sync draws its
      // own modal and can take a while, and holding the message open would time
      // the panel out for no gain. Same contract as run-action in hotkeys.js.
      fn();
      return Promise.resolve({ ok: true, started: msg.action });
    }
    return undefined;
  });
})();
