const EMPTY_TEXT = "No layer selected";
// Mirrors DEFAULT_SKIP_WORD in Tools/core_utils.js — the panel does not load
// content scripts, so the default is stated in both places. Keep them in sync.
const DEFAULT_SKIP_WORD = "skip";
const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const clearBtn = document.getElementById("clear");
const logsEl = document.getElementById("logs");
const clearLogsBtn = document.getElementById("clear-logs");
const replaceChildrenEl = document.getElementById("opt-replace-children");
const overlayEl = document.getElementById("opt-overlay");
const overlayFroggyEl = document.getElementById("opt-overlay-froggy");
const skipWordEl = document.getElementById("opt-skip-word");
const workingDomainEl = document.getElementById("opt-working-domain");
const templatesEl = document.getElementById("templates");
const templateSearchEl = document.getElementById("template-search");
const templateStatusEl = document.getElementById("template-status");
const refreshTemplatesBtn = document.getElementById("refresh-templates");
const hotkeysEl = document.getElementById("hotkeys");
const resetAllHotkeysBtn = document.getElementById("reset-all-hotkeys");
const hotkeyErrorEl = document.getElementById("hotkey-error");

const { ACTIONS, formatBinding, bindingKey, mergeWithDefaults } =
  window.__ElementorHotkeyDefaults;

const { metaLine, searchTerms, matchesTerms, elementorEditUrl } =
  window.__ElementorTemplateFormat;

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

overlayFroggyEl.addEventListener("change", () => {
  browser.storage.local.set({ overlayFroggy: overlayFroggyEl.checked });
});

skipWordEl.addEventListener("change", () => {
  browser.storage.local.set({ skipWord: skipWordEl.value.trim() });
});

workingDomainEl.addEventListener("change", () => {
  browser.storage.local.set({ workingDomain: workingDomainEl.value.trim() });
});

// null until a load has been attempted, so "not loaded" and "empty library"
// stay distinguishable.
let templates = null;
let templateError = null;
let templatesLoading = false;
let workingDomain = "";

// The panel window has no page bridge — only an Elementor editor tab can reach
// the authenticated template endpoint. Ask the first tab that answers.
// Returns { tab, reply } — the responding tab matters for run-action, which
// has to bring the editor forward so the tool's own modal is visible.
const askElementorTab = async (message) => {
  const tabs = await browser.tabs.query({});
  // tab.url is only populated where the extension holds host permission for
  // that tab; fall back to broadcasting rather than assuming it is there.
  const editors = tabs.filter((t) => (t.url || "").includes("action=elementor"));
  // Active tabs first — with two editors open, a side-effectful run should land
  // in the one the user is actually looking at, not whichever answers first.
  const candidates = (editors.length ? editors : tabs)
    .slice()
    .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0));
  for (const tab of candidates) {
    try {
      const reply = await browser.tabs.sendMessage(tab.id, message);
      if (reply) return { tab, reply };
    } catch (_) {
      // No content script listening in that tab — expected for most of them.
    }
  }
  return { tab: null, reply: null };
};

const focusTab = async (tab) => {
  if (!tab) return;
  try {
    await browser.tabs.update(tab.id, { active: true });
    if (tab.windowId !== undefined) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
  } catch (_) {
    // The tab can be gone by now; the run itself already happened.
  }
};

const openInNewTab = async (url) => {
  // The panel lives in a popup window, which cannot hold tabs — put the tab in
  // a normal browser window instead of letting it default to this one.
  const wins = await browser.windows.getAll({});
  const normal = wins.filter((w) => w.type === "normal");
  const target = normal.find((w) => w.focused) || normal[0];
  if (target) {
    await browser.tabs.create({ url, windowId: target.id, active: true });
    await browser.windows.update(target.id, { focused: true });
    return;
  }
  await browser.windows.create({ url });
};

const renderTemplateStatus = () => {
  templateStatusEl.classList.toggle("error", !!templateError && !templatesLoading);
  if (templatesLoading) {
    templateStatusEl.textContent = "Fetching site templates…";
    return;
  }
  if (templateError) {
    templateStatusEl.textContent = templateError;
    return;
  }
  if (!templates) {
    templateStatusEl.textContent = "";
    return;
  }
  const shown = templatesEl.querySelectorAll(".template").length;
  const bits = [`${shown} of ${templates.length} shown`];
  if (!workingDomain) bits.push("set a Working Domain to enable Edit");
  templateStatusEl.textContent = bits.join(" · ");
};

const setTemplatesMessage = (text) => {
  templatesEl.replaceChildren(
    Object.assign(document.createElement("div"), {
      className: "empty",
      textContent: text,
    }),
  );
};

const renderTemplates = () => {
  // A failed refresh keeps whatever was already listed — the error goes in the
  // status line rather than throwing away a good list.
  if (!templates) {
    setTemplatesMessage(
      templateError
        ? "Could not load templates"
        : templatesLoading
          ? "Loading…"
          : "Not loaded",
    );
    renderTemplateStatus();
    return;
  }
  if (!templates.length) {
    setTemplatesMessage("No site templates in this library");
    renderTemplateStatus();
    return;
  }

  const terms = searchTerms(templateSearchEl.value);
  const rows = templates
    .filter((t) => matchesTerms(t, terms))
    .map((t) => {
      const row = document.createElement("div");
      row.className = "template";

      const text = document.createElement("div");
      text.className = "text";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = t.title || "(untitled)";
      text.append(name);
      const sub = metaLine(t);
      if (sub) {
        const subEl = document.createElement("span");
        subEl.className = "sub";
        subEl.textContent = sub;
        text.append(subEl);
      }

      const type = document.createElement("span");
      type.className = "type";
      type.textContent = t.type || "";

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "edit";
      edit.textContent = "Edit";
      const url = elementorEditUrl(workingDomain, t.templateId);
      edit.disabled = !url;
      edit.title = url || "Set a Working Domain to build the Edit link";
      edit.addEventListener("click", () => {
        if (url) openInNewTab(url);
      });

      row.append(text, type, edit);
      return row;
    });

  if (!rows.length) {
    setTemplatesMessage("Nothing matches that search");
    renderTemplateStatus();
    return;
  }
  templatesEl.replaceChildren(...rows);
  renderTemplateStatus();
};

const loadTemplates = async () => {
  if (templatesLoading) return;
  templatesLoading = true;
  templateError = null;
  refreshTemplatesBtn.disabled = true;
  renderTemplates();
  try {
    const { reply } = await askElementorTab({
      __elementorTools: true,
      type: "list-templates",
    });
    if (!reply) {
      templateError = "No Elementor editor tab open — open one, then Refresh.";
    } else if (!reply.ok) {
      templateError = `Could not fetch templates — ${reply.error}`;
    } else {
      templates = (reply.templates || [])
        .slice()
        .sort((a, b) =>
          String(a.title || "").localeCompare(String(b.title || "")),
        );
    }
  } catch (err) {
    templateError = `Could not fetch templates — ${err?.message || err}`;
  } finally {
    templatesLoading = false;
    refreshTemplatesBtn.disabled = false;
    renderTemplates();
  }
};

templateSearchEl.addEventListener("input", renderTemplates);
templateSearchEl.addEventListener("search", renderTemplates);
refreshTemplatesBtn.addEventListener("click", loadTemplates);

const showHotkeyError = (msg, level = "error") => {
  hotkeyErrorEl.textContent = msg;
  hotkeyErrorEl.classList.toggle("ok", !!msg && level === "ok");
  clearTimeout(hotkeyErrorTimer);
  if (msg) {
    hotkeyErrorTimer = setTimeout(() => {
      hotkeyErrorEl.textContent = "";
      hotkeyErrorEl.classList.remove("ok");
    }, 3500);
  }
};

// Fires the action in the editor tab, then brings that tab forward: every tool
// draws its own modal in the page, and the panel is a separate popup window, so
// leaving focus here would hide the thing the user just asked for.
const runHotkeyAction = async (action, btn) => {
  showHotkeyError("");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    const { tab, reply } = await askElementorTab({
      __elementorTools: true,
      type: "run-action",
      action: action.id,
    });
    if (!reply) {
      showHotkeyError("No Elementor editor tab open — open one, then try again.");
    } else if (!reply.ok) {
      showHotkeyError(`Could not run "${action.label}" — ${reply.error}`);
    } else {
      showHotkeyError(`Ran "${action.label}"`, "ok");
      await focusTab(tab);
    }
  } catch (err) {
    showHotkeyError(`Could not run "${action.label}" — ${err?.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run";
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

    const run = document.createElement("button");
    run.type = "button";
    run.className = "hotkey-run";
    run.textContent = "Run";
    run.title = `Run "${a.label}" in the Elementor editor tab`;
    run.addEventListener("click", (e) => {
      e.stopPropagation();
      runHotkeyAction(a, run);
    });

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "hotkey-reset";
    reset.textContent = "↺";
    reset.title = "Reset to default";
    reset.addEventListener("click", (e) => {
      e.stopPropagation();
      resetOneHotkey(a.id);
    });

    row.append(capture, desc, run, reset);
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
    "overlayFroggy",
    "skipWord",
    "workingDomain",
    "hotkeyBindings",
  ])
  .then((state) => {
    renderLayer(state.selectedLayer || null);
    renderLogs(state.logs || []);
    replaceChildrenEl.checked = !!state.replaceChildrenStyles;
    overlayEl.checked = !!state.overlayEnabled;
    overlayFroggyEl.checked = !!state.overlayFroggy;
    skipWordEl.value =
      state.skipWord === undefined ? DEFAULT_SKIP_WORD : state.skipWord;
    workingDomain = state.workingDomain || "";
    workingDomainEl.value = workingDomain;
    hotkeyBindings = mergeWithDefaults(state.hotkeyBindings || null);
    renderHotkeys();
    loadTemplates();
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
  if (changes.overlayFroggy) {
    overlayFroggyEl.checked = !!changes.overlayFroggy.newValue;
  }
  if (changes.skipWord && document.activeElement !== skipWordEl) {
    skipWordEl.value =
      changes.skipWord.newValue === undefined
        ? DEFAULT_SKIP_WORD
        : changes.skipWord.newValue;
  }
  if (changes.workingDomain) {
    workingDomain = changes.workingDomain.newValue || "";
    if (document.activeElement !== workingDomainEl) {
      workingDomainEl.value = workingDomain;
    }
    // The Edit links are built from it, so they have to be rebuilt with it.
    renderTemplates();
  }
  if (changes.hotkeyBindings) {
    hotkeyBindings = mergeWithDefaults(changes.hotkeyBindings.newValue || null);
    if (!recordingActionId) renderHotkeys();
  }
});
