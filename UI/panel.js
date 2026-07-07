const EMPTY_TEXT = "No layer selected";
const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const clearBtn = document.getElementById("clear");
const logsEl = document.getElementById("logs");
const clearLogsBtn = document.getElementById("clear-logs");
const replaceChildrenEl = document.getElementById("opt-replace-children");
const overlayEl = document.getElementById("opt-overlay");
const workingDomainEl = document.getElementById("opt-working-domain");
const hotkeysEl = document.getElementById("hotkeys");
const resetAllHotkeysBtn = document.getElementById("reset-all-hotkeys");
const hotkeyErrorEl = document.getElementById("hotkey-error");

const { ACTIONS, formatBinding, bindingKey, mergeWithDefaults } =
  window.__ElementorHotkeyDefaults;

let hotkeyBindings = mergeWithDefaults(null);
let recordingActionId = null;
let hotkeyErrorTimer = 0;

const MODIFIER_CODES = new Set([
  "ControlLeft",
  "ControlRight",
  "ShiftLeft",
  "ShiftRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "OSLeft",
  "OSRight",
]);

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

workingDomainEl.addEventListener("change", () => {
  browser.storage.local.set({ workingDomain: workingDomainEl.value.trim() });
});

const showHotkeyError = (msg) => {
  hotkeyErrorEl.textContent = msg;
  clearTimeout(hotkeyErrorTimer);
  if (msg) {
    hotkeyErrorTimer = setTimeout(() => {
      hotkeyErrorEl.textContent = "";
    }, 3500);
  }
};

const renderHotkeys = () => {
  hotkeysEl.replaceChildren();
  for (const a of ACTIONS) {
    const row = document.createElement("div");
    row.className = "hotkey";

    const capture = document.createElement("button");
    capture.type = "button";
    capture.className = "hotkey-capture";
    if (recordingActionId === a.id) {
      capture.classList.add("recording");
      capture.textContent = "Press keys…";
    } else {
      capture.textContent = formatBinding(hotkeyBindings[a.id]);
    }
    capture.addEventListener("click", () => startRecording(a.id));

    const desc = document.createElement("span");
    desc.className = "desc";
    desc.textContent = a.label;

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "hotkey-reset";
    reset.textContent = "↺";
    reset.title = "Reset to default";
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      resetOneHotkey(a.id);
    });

    row.append(capture, desc, reset);
    hotkeysEl.append(row);
  }
};

const startRecording = (id) => {
  showHotkeyError("");
  recordingActionId = id;
  renderHotkeys();
};

const stopRecording = () => {
  recordingActionId = null;
  renderHotkeys();
};

const conflictLabel = (candidate, exceptId) => {
  const key = bindingKey(candidate);
  if (!key) return null;
  for (const a of ACTIONS) {
    if (a.id === exceptId) continue;
    if (bindingKey(hotkeyBindings[a.id]) === key) return a.label;
  }
  return null;
};

const saveHotkeys = () => {
  browser.storage.local.set({ hotkeyBindings });
};

const resetOneHotkey = (id) => {
  const action = ACTIONS.find((a) => a.id === id);
  const conflict = conflictLabel(action.default, id);
  if (conflict) {
    showHotkeyError(`Default conflicts with "${conflict}"`);
    return;
  }
  hotkeyBindings[id] = action.default;
  saveHotkeys();
  showHotkeyError("");
  renderHotkeys();
};

resetAllHotkeysBtn.addEventListener("click", () => {
  hotkeyBindings = mergeWithDefaults(null);
  recordingActionId = null;
  saveHotkeys();
  showHotkeyError("");
  renderHotkeys();
});

document.addEventListener(
  "keydown",
  (e) => {
    if (!recordingActionId) return;
    if (
      e.code === "Escape" &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      stopRecording();
      return;
    }
    if (MODIFIER_CODES.has(e.code)) return;
    e.preventDefault();
    e.stopPropagation();

    const candidate = {
      ctrl: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey,
      code: e.code,
    };

    if (!candidate.ctrl && !candidate.shift && !candidate.alt) {
      showHotkeyError("Hotkey must include Ctrl, Shift, or Alt");
      stopRecording();
      return;
    }

    const conflict = conflictLabel(candidate, recordingActionId);
    if (conflict) {
      showHotkeyError(`Already bound to "${conflict}"`);
      stopRecording();
      return;
    }

    hotkeyBindings[recordingActionId] = candidate;
    saveHotkeys();
    stopRecording();
  },
  true,
);

browser.storage.local
  .get([
    "selectedLayer",
    "logs",
    "replaceChildrenStyles",
    "overlayEnabled",
    "workingDomain",
    "hotkeyBindings",
  ])
  .then((state) => {
    renderLayer(state.selectedLayer || null);
    renderLogs(state.logs || []);
    replaceChildrenEl.checked = !!state.replaceChildrenStyles;
    overlayEl.checked = !!state.overlayEnabled;
    workingDomainEl.value = state.workingDomain || "";
    hotkeyBindings = mergeWithDefaults(state.hotkeyBindings || null);
    renderHotkeys();
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
  if (changes.workingDomain && document.activeElement !== workingDomainEl) {
    workingDomainEl.value = changes.workingDomain.newValue || "";
  }
  if (changes.hotkeyBindings) {
    hotkeyBindings = mergeWithDefaults(changes.hotkeyBindings.newValue || null);
    if (!recordingActionId) renderHotkeys();
  }
});
