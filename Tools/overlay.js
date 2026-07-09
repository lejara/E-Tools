(() => {
  const OVERLAY_ID = "elementor-tools-overlay";
  const STYLE_ID = "elementor-tools-overlay-style";
  const IS_EDITOR = location.search.includes("action=elementor");

  let overlay = null;
  let titleEl = null;
  let logsEl = null;
  let clearLogsBtn = null;
  let editBtn = null;
  let froggyEl = null;

  const state = {
    enabled: false,
    froggy: false,
    selectedLayer: null,
    logs: [],
    position: null,
    workingDomain: "",
    wpPostId: readWpPostId(),
  };

  function readWpPostId() {
    const body = document.body;
    if (!body) return null;
    const m = body.className.match(/(?:^|\s)(?:page-id|postid)-(\d+)(?:\s|$)/);
    return m ? m[1] : null;
  }

  const parseWorkingDomain = (raw) => {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    try {
      const withProto = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
      const u = new URL(withProto);
      return { hostname: u.hostname, origin: u.origin };
    } catch {
      return null;
    }
  };

  const domainMatches = () => {
    const parsed = parseWorkingDomain(state.workingDomain);
    return !!parsed && parsed.hostname === location.hostname;
  };

  const shouldShow = () =>
    state.enabled && (IS_EDITOR || domainMatches());

  const ensureStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${OVERLAY_ID} {
        position: fixed;
        z-index: 2147483000;
        width: 280px;
        background: #1e1e1e;
        color: #eee;
        border: 1px solid #333;
        border-radius: 6px;
        box-shadow: 0 4px 14px rgba(0,0,0,0.35);
        font: 11px/1.4 system-ui, sans-serif;
        user-select: none;
      }
      #${OVERLAY_ID} .et-ov-header {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 8px;
        border-bottom: 1px solid #2a2a2a;
        cursor: move;
      }
      #${OVERLAY_ID} .et-ov-label {
        font-size: 10px;
        color: #888;
        text-transform: uppercase;
        letter-spacing: 0.4px;
        flex: 0 0 auto;
      }
      #${OVERLAY_ID} .et-ov-title {
        flex: 1 1 auto;
        font-size: 12px;
        font-weight: 600;
        color: #eee;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${OVERLAY_ID} .et-ov-title.empty {
        color: #666;
        font-weight: 400;
        font-style: italic;
      }
      #${OVERLAY_ID} .et-ov-clear {
        flex: 0 0 auto;
        font: inherit;
        font-size: 10px;
        background: #2a2a2a;
        color: #ccc;
        border: 1px solid #3a3a3a;
        border-radius: 3px;
        padding: 2px 6px;
        cursor: pointer;
      }
      #${OVERLAY_ID} .et-ov-clear:hover:not(:disabled) { background: #333; }
      #${OVERLAY_ID} .et-ov-clear:disabled { opacity: 0.4; cursor: default; }
      #${OVERLAY_ID} .et-ov-logs {
        max-height: 56px;
        overflow-y: auto;
        padding: 4px 8px;
        font-family: ui-monospace, monospace;
      }
      #${OVERLAY_ID} .et-ov-empty {
        color: #555;
        font-style: italic;
        padding: 2px 0;
      }
      #${OVERLAY_ID} .et-ov-log {
        display: flex;
        gap: 6px;
        padding: 0;
        line-height: 16px;
        white-space: nowrap;
        overflow: hidden;
      }
      #${OVERLAY_ID} .et-ov-log .t { color: #666; flex: 0 0 auto; }
      #${OVERLAY_ID} .et-ov-log .m {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${OVERLAY_ID} .et-ov-log.info .m { color: #d0d0d0; }
      #${OVERLAY_ID} .et-ov-log.warn .m { color: #e0b060; }
      #${OVERLAY_ID} .et-ov-log.error .m { color: #e07070; }
      #${OVERLAY_ID} .et-ov-actions {
        padding: 6px 8px;
        border-bottom: 1px solid #2a2a2a;
      }
      #${OVERLAY_ID} .et-ov-edit {
        width: 100%;
        font: inherit;
        font-size: 11px;
        background: #2b3a66;
        color: #eaeaea;
        border: 1px solid #3a4d80;
        border-radius: 3px;
        padding: 5px 8px;
        cursor: pointer;
      }
      #${OVERLAY_ID} .et-ov-edit:hover { background: #34467a; }
      #${OVERLAY_ID} .et-ov-froggy {
        display: block;
        height: 64px;
        width: auto;
        max-width: 100%;
        margin: 6px auto;
        object-fit: contain;
        pointer-events: none;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  };

  const applyPosition = () => {
    if (!overlay) return;
    const p = state.position;
    if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
      overlay.style.left = p.left + "px";
      overlay.style.top = p.top + "px";
      overlay.style.right = "";
      overlay.style.bottom = "";
    } else {
      overlay.style.left = "";
      overlay.style.top = "";
      overlay.style.right = "16px";
      overlay.style.bottom = "16px";
    }
  };

  const formatTime = (ts) => {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  const renderTitle = () => {
    if (!titleEl) return;
    const layer = state.selectedLayer;
    if (!layer) {
      titleEl.textContent = "No root";
      titleEl.classList.add("empty");
      titleEl.removeAttribute("title");
      return;
    }
    titleEl.textContent = layer.title || "(untitled)";
    titleEl.classList.remove("empty");
    titleEl.title = `id: ${layer.id || "?"} · cid: ${layer.modelCid || "?"}`;
  };

  const renderEditButton = () => {
    if (!overlay) return;
    const parsed = parseWorkingDomain(state.workingDomain);
    const canEdit = !!(parsed && state.wpPostId);

    if (!canEdit) {
      if (editBtn) {
        const row = editBtn.parentElement;
        editBtn.remove();
        editBtn = null;
        if (row) row.remove();
      }
      return;
    }

    if (!editBtn) {
      const row = document.createElement("div");
      row.className = "et-ov-actions";
      editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "et-ov-edit";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const p = parseWorkingDomain(state.workingDomain);
        if (!p || !state.wpPostId) return;
        const url = `${p.origin}/wp-admin/post.php?post=${state.wpPostId}&action=elementor`;
        window.open(url, "_blank", "noopener");
      });
      editBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      row.appendChild(editBtn);
      // insert between header and logs
      overlay.insertBefore(row, logsEl);
    }
    editBtn.textContent = `Edit in Elementor (#${state.wpPostId})`;
  };

  const renderFroggy = () => {
    if (!overlay) return;
    if (state.froggy) {
      if (!froggyEl) {
        froggyEl = document.createElement("img");
        froggyEl.className = "et-ov-froggy";
        froggyEl.alt = "";
        froggyEl.src = browser.runtime.getURL("assets/Froggy.gif");
        overlay.appendChild(froggyEl);
      }
    } else if (froggyEl) {
      froggyEl.remove();
      froggyEl = null;
    }
  };

  const renderLogs = () => {
    if (!logsEl) return;
    const logs = state.logs || [];
    if (!logs.length) {
      logsEl.replaceChildren(
        Object.assign(document.createElement("div"), {
          className: "et-ov-empty",
          textContent: "No activity yet",
        }),
      );
      if (clearLogsBtn) clearLogsBtn.disabled = true;
      return;
    }
    const nodes = logs.map((entry) => {
      const row = document.createElement("div");
      row.className = `et-ov-log ${entry.level || "info"}`;
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = formatTime(entry.time);
      const m = document.createElement("span");
      m.className = "m";
      m.textContent = entry.message;
      m.title = entry.message;
      row.append(t, m);
      return row;
    });
    logsEl.replaceChildren(...nodes);
    if (clearLogsBtn) clearLogsBtn.disabled = false;
  };

  const startDrag = (e) => {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest(".et-ov-clear")) return;
    e.preventDefault();
    const rect = overlay.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const onMove = (ev) => {
      const left = Math.max(
        0,
        Math.min(window.innerWidth - rect.width, ev.clientX - offX),
      );
      const top = Math.max(
        0,
        Math.min(window.innerHeight - rect.height, ev.clientY - offY),
      );
      overlay.style.left = left + "px";
      overlay.style.top = top + "px";
      overlay.style.right = "";
      overlay.style.bottom = "";
      state.position = { left, top };
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (state.position) {
        browser.storage.local
          .set({ overlayPosition: state.position })
          .catch(() => {});
      }
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const createOverlay = () => {
    if (overlay || !document.body) return;
    ensureStyle();
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;

    const header = document.createElement("div");
    header.className = "et-ov-header";
    const label = Object.assign(document.createElement("span"), {
      className: "et-ov-label",
      textContent: "Root",
    });
    titleEl = Object.assign(document.createElement("span"), {
      className: "et-ov-title empty",
      textContent: "No root",
    });
    clearLogsBtn = Object.assign(document.createElement("button"), {
      className: "et-ov-clear",
      textContent: "Clear",
      type: "button",
      disabled: true,
    });
    clearLogsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      browser.storage.local.remove("logs").catch(() => {});
    });
    clearLogsBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    header.append(label, titleEl, clearLogsBtn);
    header.addEventListener("mousedown", startDrag);

    logsEl = document.createElement("div");
    logsEl.className = "et-ov-logs";

    overlay.append(header, logsEl);
    document.body.appendChild(overlay);

    applyPosition();
    renderTitle();
    renderEditButton();
    renderLogs();
    renderFroggy();
  };

  const destroyOverlay = () => {
    if (!overlay) return;
    overlay.remove();
    overlay = null;
    titleEl = null;
    logsEl = null;
    clearLogsBtn = null;
    editBtn = null;
    froggyEl = null;
  };

  const sync = () => {
    if (shouldShow()) {
      createOverlay();
      applyPosition();
      renderTitle();
      renderEditButton();
      renderLogs();
      renderFroggy();
    } else {
      destroyOverlay();
    }
  };

  browser.storage.local
    .get([
      "overlayEnabled",
      "overlayFroggy",
      "selectedLayer",
      "logs",
      "overlayPosition",
      "workingDomain",
    ])
    .then((s) => {
      state.enabled = !!s.overlayEnabled;
      state.froggy = !!s.overlayFroggy;
      state.selectedLayer = s.selectedLayer || null;
      state.logs = s.logs || [];
      state.position = s.overlayPosition || null;
      state.workingDomain = s.workingDomain || "";
      if (!state.wpPostId) state.wpPostId = readWpPostId();
      sync();
    })
    .catch(() => {});

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let resync = false;
    if (changes.overlayEnabled) {
      state.enabled = !!changes.overlayEnabled.newValue;
      resync = true;
    }
    if (changes.overlayFroggy) {
      state.froggy = !!changes.overlayFroggy.newValue;
      if (overlay) renderFroggy();
    }
    if (changes.workingDomain) {
      state.workingDomain = changes.workingDomain.newValue || "";
      resync = true;
    }
    if (changes.selectedLayer) {
      state.selectedLayer = changes.selectedLayer.newValue || null;
      if (overlay) renderTitle();
    }
    if (changes.logs) {
      state.logs = changes.logs.newValue || [];
      if (overlay) renderLogs();
    }
    if (changes.overlayPosition) {
      state.position = changes.overlayPosition.newValue || null;
      if (overlay) applyPosition();
    }
    if (resync) sync();
  });
})();
