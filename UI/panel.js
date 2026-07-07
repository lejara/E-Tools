const EMPTY_TEXT = "No layer selected";
const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const clearBtn = document.getElementById("clear");
const logsEl = document.getElementById("logs");
const clearLogsBtn = document.getElementById("clear-logs");
const replaceChildrenEl = document.getElementById("opt-replace-children");
const overlayEl = document.getElementById("opt-overlay");

const renderLayer = (layer) => {
  if (!layer) {
    titleEl.textContent = EMPTY_TEXT;
    titleEl.classList.add("empty");
    metaEl.textContent = "";
    clearBtn.disabled = true;
    return;
  }
  titleEl.textContent = layer.title || "(untitled)";
  titleEl.classList.remove("empty");
  metaEl.textContent = `id: ${layer.id || "?"} · cid: ${layer.modelCid || "?"}`;
  clearBtn.disabled = false;
};

const formatTime = (ts) => {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

const renderLogs = (logs) => {
  if (!logs || !logs.length) {
    logsEl.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "empty",
        textContent: "No activity yet",
      }),
    );
    clearLogsBtn.disabled = true;
    return;
  }
  const nodes = logs.map((entry) => {
    const row = document.createElement("div");
    row.className = `log ${entry.level || "info"}`;
    const time = document.createElement("span");
    time.className = "time";
    time.textContent = formatTime(entry.time);
    const msg = document.createElement("span");
    msg.className = "msg";
    msg.textContent = entry.message;
    row.append(time, msg);
    return row;
  });
  logsEl.replaceChildren(...nodes);
  clearLogsBtn.disabled = false;
};

clearBtn.addEventListener("click", () => {
  browser.storage.local.remove("selectedLayer");
});

clearLogsBtn.addEventListener("click", () => {
  browser.storage.local.remove("logs");
});

replaceChildrenEl.addEventListener("change", () => {
  browser.storage.local.set({ replaceChildrenStyles: replaceChildrenEl.checked });
});

overlayEl.addEventListener("change", () => {
  browser.storage.local.set({ overlayEnabled: overlayEl.checked });
});

browser.storage.local
  .get(["selectedLayer", "logs", "replaceChildrenStyles", "overlayEnabled"])
  .then((state) => {
    renderLayer(state.selectedLayer || null);
    renderLogs(state.logs || []);
    replaceChildrenEl.checked = !!state.replaceChildrenStyles;
    overlayEl.checked = !!state.overlayEnabled;
  });

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.selectedLayer) {
    renderLayer(changes.selectedLayer.newValue || null);
  }
  if (changes.logs) {
    renderLogs(changes.logs.newValue || []);
  }
  if (changes.replaceChildrenStyles) {
    replaceChildrenEl.checked = !!changes.replaceChildrenStyles.newValue;
  }
  if (changes.overlayEnabled) {
    overlayEl.checked = !!changes.overlayEnabled.newValue;
  }
});
