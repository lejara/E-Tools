// The Automation window: pick templates and documents, then run template sync and
// Edge Presets over every one of them, three editors at a time.
//
// WHERE THE RUN LIVES. Here, in this window — not in the background script. The
// only thing background ownership would buy is surviving this window being
// closed, and closing it is *already* the cancel gesture: the run's cancel
// semantics are "abandon the page by closing its tab", and nothing is persisted
// until the save at the end of a page, so an abandoned page is an untouched page.
// Paying for a port protocol and MV3 event-page keepalive to protect work that is
// safe to lose would be the wrong trade.
//
// WHAT THIS WINDOW CANNOT DO. It is an extension page, so it has no page bridge
// and no filesystem. Every read about the site goes through a tab that can answer
// (tab-bridge.js), and the run report is produced as a download rather than
// written to disk.
(() => {
  const T = window.__ElementorTemplateFormat;
  const F = window.__EdgePresetFormat;
  const { askElementorTab, focusTab, openTab } = window.__TabBridge;

  const $ = (id) => document.getElementById(id);

  const NO_TAB =
    "No Elementor editor or WordPress admin tab open — open one, then Refresh.";

  // How long to wait for an editor to become drivable. Elementor's editor is a
  // heavy boot — the preview iframe, the panel, the kit — and on a slow site with
  // three of them opening at once it is routinely tens of seconds. Failing early
  // here would report a working site as broken.
  const READY_TIMEOUT = 120000;
  const READY_POLL = 800;

  // Review mode leaves every tab open, so the run's document count IS the number
  // of editors that end up on screen. Sixty Elementor editors will bring the
  // browser to its knees and nobody is going to review sixty pages by hand
  // anyway, so the run is refused rather than started and regretted.
  const REVIEW_MAX_DOCS = 20;

  // Storage keys. workingDomain is deliberately the SAME key the panel uses: it
  // names the site being worked on, and two windows disagreeing about that is the
  // one setting that must never happen.
  const KEYS = {
    workingDomain: "workingDomain",
    settings: "automationSettings",
    armed: "edgePresetArmed",
  };

  // Mirrors OPS.styles.toggles in Tools/template-sync.js — labels only. The group
  // names stay there; this sends key → boolean and the sync resolves the groups,
  // so a key that ever drifts falls back to that toggle's own default rather than
  // silently to "off". `nested` is the pipeline's own toggle.
  const SYNC_TOGGLES = [
    { key: "keepBackground", label: "Keep background image & overlay", default: true },
    { key: "keepAllBackground", label: "Keep all background styles", default: true },
    { key: "keepAnimations", label: "Keep animations", default: true },
    { key: "nested", label: "Match nested containers", default: false },
  ];

  // What "Run" means, as an ORDERED list of phases. The list *is* the order: the
  // window sends it to the agent, which runs the phases it is given and encodes no
  // order of its own, so there is one definition and the two cannot disagree.
  //
  // Sync-then-edge is the default because the sync is the half that pastes the
  // template's own values over the page's. The reverse is offered for the case
  // where the presets are meant to land on a document an earlier run already
  // synced, and it costs two things that `startRun` warns about once per run:
  //   · Edge Presets match instances on the `#id.N` tag ALONE, and the sync is what
  //     writes that tag. Run first, the presets cannot see a hand-built container
  //     the sync was about to adopt.
  //   · Any style-transfer field a preset writes is overwritten by the paste that
  //     follows it. The non-style fields presets exist for are untouched.
  const MODES = {
    both: { label: "Sync → Edge Presets", phases: ["sync", "edge"] },
    "edge-first": { label: "Edge Presets → Sync", phases: ["edge", "sync"] },
    sync: { label: "Template sync only", phases: ["sync"] },
    edge: { label: "Edge Presets only", phases: ["edge"] },
  };

  const TAB_REQUESTS = {
    template: { type: "list-templates" },
    page: { type: "list-posts", options: { include: ["page"] } },
    other: { type: "list-posts", options: { exclude: ["page"] } },
  };

  // ------------------------------------------------------------------ state

  let workingDomain = "";
  let view = "run";
  let docKind = "page";

  const lists = {
    template: { rows: null, error: null, loading: false, via: null, warnings: [] },
    page: { rows: null, error: null, loading: false, via: null, warnings: [] },
    other: { rows: null, error: null, loading: false, via: null, warnings: [] },
  };

  // Selections are Sets of ids and are NEVER touched by the search box. A ticked
  // row hidden by a later search still counts — the count line says how many are
  // hidden, so the number can never look wrong. Same rule as template-insert.js.
  const picked = { templates: new Set(), docs: new Set() };
  const search = { tpl: "", doc: "" };

  let toggles = Object.fromEntries(SYNC_TOGGLES.map((t) => [t.key, t.default]));
  let mode = "both";
  // Everything that needs to know what runs asks in terms of phases, not by
  // comparing `mode` against a string — which is what kept the old `mode === "edge"`
  // tests from having to grow a case each time a mode was added.
  const phasesFor = (m = mode) => MODES[m]?.phases || MODES.both.phases;
  let concurrency = 3;
  // Leave every editor open and unsaved so a human can look before publishing.
  // The safety valve for structural edits, whose removals a normal run makes
  // unrecoverable — the tab is closed the moment the save lands, so the history
  // log goes with it.
  let review = false;

  let presets = [];
  let armedId = null;
  let renaming = null;

  // Run state. `runState` is the window's own state machine and the pill shows it.
  //   idle → running → cancelling → finished | cancelled | error
  let runState = "idle";
  let runNote = "";
  let progress = [];
  let runLog = [];
  let lastReport = null;
  let cancelRequested = false;
  const openTabs = new Set();

  let toolLog = [];

  // ----------------------------------------------------------------- render

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const setState = (state, note) => {
    runState = state;
    if (note !== undefined) runNote = note;
    renderState();
  };

  const PILL = {
    idle: "",
    running: "is-running",
    cancelling: "is-warn",
    finished: "is-ok",
    cancelled: "is-warn",
    error: "is-error",
  };

  const renderState = () => {
    const pill = $("state-pill");
    pill.textContent = runState;
    pill.className = `pill ${PILL[runState] || ""}`;
    $("state-text").textContent = runNote || "";
    const busy = runState === "running" || runState === "cancelling";
    $("start").disabled = busy || !canStart();
    $("cancel").disabled = !busy;
    $("refresh").disabled = busy;
    $("copy-log").disabled = !runLog.length;
    $("download-report").disabled = !lastReport;
  };

  const canStart = () => {
    if (!T.parseWorkingDomain(workingDomain)) return false;
    if (!picked.docs.size) return false;
    // Edge-Presets-only needs at least one preset armed by ticking its template;
    // a sync needs a template in scope for the same reason. Both are gated by the
    // same list, which is the point of the allowlist.
    return picked.templates.size > 0;
  };

  // One row shape for both pickers, because a template and a post differ only in
  // what their second line says. asRow() in UI/panel.js draws the same conclusion.
  const asRow = (kind, item) =>
    kind === "template"
      ? {
          id: String(item.templateId),
          title: item.title || "(untitled)",
          meta: T.metaLine(item),
          badge: item.type || "",
          extra: `${item.author || ""} ${item.type || ""}`,
        }
      : {
          id: String(item.id),
          title: item.title || "(untitled)",
          meta: T.postMetaLine(item),
          badge: item.typeLabel || item.typeSlug || "",
          elementor: item.isElementor,
          extra: `${item.typeSlug || ""} ${item.status || ""} ${
            item.isElementor ? "elementor" : ""
          }`,
        };

  const rowsFor = (kind) => (lists[kind].rows || []).map((r) => asRow(kind, r));

  const filtered = (rows, query) => {
    const terms = T.searchTerms(query);
    return rows.filter((r) => T.matchesTerms(r, terms));
  };

  const renderPicker = ({ kind, listId, countId, which, query }) => {
    const host = $(listId);
    host.textContent = "";
    const state = lists[kind];
    const set = picked[which];

    if (state.loading) {
      host.appendChild(el("div", "empty", "Loading…"));
      $(countId).textContent = "";
      return;
    }
    if (state.error) {
      host.appendChild(el("div", "empty", state.error));
      $(countId).textContent = "";
      return;
    }
    if (state.rows === null) {
      host.appendChild(el("div", "empty", "Not loaded — press Refresh lists"));
      $(countId).textContent = "";
      return;
    }

    const all = rowsFor(kind);
    const shown = filtered(all, query);
    const hiddenPicked = all.filter(
      (r) => set.has(r.id) && !shown.some((s) => s.id === r.id),
    ).length;

    // The count is about the SELECTION, not about the filter, and it says how many
    // ticked rows the search is hiding. Without that a filtered list reads as if
    // the selection shrank.
    const bits = [`${set.size} selected of ${all.length}`];
    if (query) bits.push(`${shown.length} shown`);
    if (hiddenPicked) bits.push(`${hiddenPicked} ticked hidden by search`);
    $(countId).textContent = bits.join(" · ");

    if (!shown.length) {
      host.appendChild(
        el("div", "empty", all.length ? "Nothing matches that search" : "Empty"),
      );
      return;
    }

    for (const row of shown) {
      const label = el("label", "row");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = set.has(row.id);
      box.addEventListener("change", () => {
        if (box.checked) set.add(row.id);
        else set.delete(row.id);
        saveSettings();
        renderPickers();
        renderState();
      });
      const body = el("div", "row-body");
      const title = el("div", "row-title", row.title);
      if (row.badge) {
        const badge = el("span", "badge plain", row.badge);
        title.appendChild(badge);
      }
      if (row.elementor) title.appendChild(el("span", "badge", "Elementor"));
      body.appendChild(title);
      const meta = [row.meta, `#${row.id}`].filter(Boolean).join(" · ");
      if (meta) body.appendChild(el("div", "row-meta", meta));
      label.appendChild(box);
      label.appendChild(body);
      host.appendChild(label);
    }
  };

  const renderPickers = () => {
    renderPicker({
      kind: "template",
      listId: "tpl-list",
      countId: "tpl-count",
      which: "templates",
      query: search.tpl,
    });
    renderPicker({
      kind: docKind,
      listId: "doc-list",
      countId: "doc-count",
      which: "docs",
      query: search.doc,
    });
    for (const btn of $("doc-kinds").querySelectorAll(".kind")) {
      btn.classList.toggle("is-active", btn.dataset.kind === docKind);
      const state = lists[btn.dataset.kind];
      const n = state.rows?.length;
      btn.textContent =
        (btn.dataset.kind === "page"
          ? "Pages"
          : btn.dataset.kind === "template"
            ? "Templates"
            : "Other") + (n === undefined || n === null ? "" : ` (${n})`);
    }
    $("doc-search").placeholder = `Search ${
      docKind === "page" ? "pages" : docKind === "template" ? "templates" : "posts"
    }…`;
  };

  const renderModes = () => {
    const sel = $("run-mode");
    sel.textContent = "";
    for (const [value, m] of Object.entries(MODES)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = m.label;
      sel.appendChild(opt);
    }
    sel.value = mode;
  };

  const renderToggles = () => {
    const host = $("sync-toggles");
    host.textContent = "";
    // Gated on whether a sync phase runs at all, not on which mode is selected —
    // the two orders that include one both want these live.
    const disabled = !phasesFor().includes("sync");
    for (const t of SYNC_TOGGLES) {
      const label = el("label", "toggle");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!toggles[t.key];
      box.disabled = disabled;
      box.addEventListener("change", () => {
        toggles[t.key] = box.checked;
        saveSettings();
      });
      label.appendChild(box);
      label.appendChild(el("span", "", t.label));
      if (disabled) label.style.opacity = "0.45";
      host.appendChild(label);
    }
  };

  const STATE_LABEL = {
    queued: "queued",
    opening: "opening editor",
    waiting: "waiting for editor",
    syncing: "syncing",
    edge: "edge presets",
    saving: "saving",
    done: "done",
    // Distinct from `done` on purpose: nothing has been written to the server,
    // so a run of these is work that still needs a human.
    review: "awaiting review",
    skipped: "skipped",
    failed: "failed",
    cancelled: "cancelled",
  };

  const STATE_PILL = {
    done: "is-ok",
    review: "is-warn",
    failed: "is-error",
    cancelled: "is-warn",
    skipped: "",
    queued: "",
  };

  const renderProgress = () => {
    const host = $("progress");
    host.textContent = "";
    if (!progress.length) {
      host.appendChild(el("div", "empty", "Nothing queued"));
      return;
    }
    for (const p of progress) {
      const row = el("div", "prow");
      const pill = el("span", `pill ${STATE_PILL[p.state] ?? "is-running"}`);
      pill.textContent = STATE_LABEL[p.state] || p.state;
      row.appendChild(pill);
      row.appendChild(el("span", "prow-name", p.title));
      if (p.note) row.appendChild(el("span", "prow-note", p.note));
      host.appendChild(row);
    }
  };

  const renderLogInto = (hostId, entries, emptyText) => {
    const host = $(hostId);
    host.textContent = "";
    if (!entries.length) {
      host.appendChild(el("div", "empty", emptyText));
      return;
    }
    for (const entry of entries) {
      const line = el("div", `logline ${entry.level || ""}`);
      line.appendChild(
        el("span", "when", new Date(entry.time).toLocaleTimeString()),
      );
      line.appendChild(document.createTextNode(entry.message));
      host.appendChild(line);
    }
  };

  const renderLogs = () => {
    renderLogInto("run-log", runLog, "No run yet");
    renderLogInto("tool-log", toolLog, "No activity yet");
  };

  const say = (level, message) => {
    runLog.unshift({ level, message, time: Date.now() });
    if (runLog.length > 500) runLog.length = 500;
    renderLogs();
    renderState();
  };

  // ---------------------------------------------------------------- presets

  const renderArmed = () => {
    const host = $("armed-banner");
    host.textContent = "";
    const preset = presets.find((p) => p.id === armedId) || null;
    const inner = el("div", `armed-inner${preset ? "" : " is-idle"}`);
    if (!preset) {
      inner.appendChild(
        el(
          "span",
          "armed-name",
          "No preset selected — captures are not being offered in the editor.",
        ),
      );
    } else {
      const counts = F.describePreset(preset);
      inner.appendChild(
        el(
          "span",
          "armed-name",
          `Capturing into "${preset.name}" · ${
            preset.templateId
              ? `template ${preset.templateTitle || `#${preset.templateId}`}`
              : "not yet bound to a template"
          } · ${counts.fields} field(s)${counts.edits ? " · 1 structural edit" : ""}`,
        ),
      );
      const off = el("button", "clear", "Stop capturing");
      off.type = "button";
      off.addEventListener("click", () => arm(null));
      inner.appendChild(off);
    }
    host.appendChild(inner);
  };

  // ------------------------------------------------- structural edit editor

  const CMP_LABEL = {
    "==": "is exactly",
    "!=": "is not",
    ">=": "is at least",
    "<=": "is at most",
  };

  const mkSelect = (options, value, onChange) => {
    const s = document.createElement("select");
    s.className = "text-input";
    for (const [v, label] of options) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      s.appendChild(o);
    }
    s.value = value;
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };

  const mkInput = (type, value, placeholder) => {
    const i = document.createElement("input");
    i.className = "text-input";
    i.type = type;
    i.value = value ?? "";
    if (placeholder) i.placeholder = placeholder;
    if (type === "number") i.min = "0";
    return i;
  };

  const patchEdit = async (preset, editId, patch) => {
    const res = F.updateEdit(preset, editId, patch);
    if (!res.ok) {
      say("error", `"${preset.name}": ${res.error}`);
      return;
    }
    await savePresets(
      presets.map((p) => (p.id === preset.id ? res.preset : p)),
    );
  };

  // The inputs for one condition kind. Driven off CONDITION_KINDS' `fields` so a
  // kind added to the schema shows up here rather than silently going unbuildable.
  const conditionInputs = (kind) => {
    const row = el("div", "cond-inputs");
    const fields = {};
    const add = (key, node) => {
      fields[key] = node;
      row.appendChild(node);
    };
    if (kind === "child-count") {
      add(
        "cmp",
        mkSelect(
          [...F.COMPARATORS].map((c) => [c, CMP_LABEL[c] || c]),
          "==",
          () => {},
        ),
      );
      add("value", mkInput("number", "0"));
    } else if (kind === "child-named") {
      add("name", mkInput("text", "", "layer name"));
      add(
        "present",
        mkSelect(
          [
            ["1", "exists"],
            ["", "does not exist"],
          ],
          "1",
          () => {},
        ),
      );
    } else if (kind === "child-of-type") {
      add("signature", mkInput("text", "", "widget:button or container"));
      add(
        "present",
        mkSelect(
          [
            ["1", "exists"],
            ["", "does not exist"],
          ],
          "1",
          () => {},
        ),
      );
    } else {
      add("index", mkInput("number", "0"));
      add("signature", mkInput("text", "", "widget:button or container"));
    }
    return { row, fields };
  };

  const readCondition = (kind, fields) => {
    const v = (k) => fields[k]?.value;
    if (kind === "child-count") {
      return { kind, cmp: v("cmp"), value: Number(v("value")) };
    }
    if (kind === "child-named") {
      return { kind, name: v("name"), present: !!v("present") };
    }
    if (kind === "child-of-type") {
      return { kind, signature: v("signature"), present: !!v("present") };
    }
    return { kind, index: Number(v("index")), signature: v("signature") };
  };

  const renderEdit = (preset, card) => {
    const edit = F.structuralEdit(preset);
    if (!edit) return;

    const box = el("div", "preset-edit");

    const head = el("div", "edit-head");
    head.appendChild(el("span", "chip is-op", edit.op));
    head.appendChild(
      el(
        "span",
        "edit-label",
        `${F.editLabel(edit)} · ${F.editParentKey(edit)} index ${edit.index}`,
      ),
    );
    const kill = el("button", "clear danger", "✕");
    kill.type = "button";
    kill.title = "Remove this structural edit";
    kill.addEventListener("click", () =>
      savePresets(
        presets.map((p) =>
          p.id === preset.id ? F.removeEdit(p, edit.id) : p,
        ),
      ),
    );
    head.appendChild(kill);
    box.appendChild(head);

    // A structural edit fires on EVERY tagged instance of this template on every
    // page in the run — the count differs page to page, so the honest thing to
    // show is the rule rather than a number that would only ever be right once.
    box.appendChild(
      el(
        "div",
        "edit-warn",
        edit.op === "remove"
          ? "Runs on every tagged instance on every page. A remove cannot be undone once the page is saved — tick “Leave tabs open for review” first."
          : "Runs on every tagged instance of this template, on every page in the run.",
      ),
    );

    if (edit.op === "add") {
      const row = el("div", "edit-row");
      row.appendChild(el("span", "field-label", "Insert"));
      const place = edit.place || { mode: "index", index: edit.index };
      row.appendChild(
        mkSelect(
          [
            ["index", "at index"],
            ["append", "at the end"],
            ["before", "before a child named"],
            ["after", "after a child named"],
          ],
          place.mode,
          (mode) =>
            patchEdit(preset, edit.id, {
              place: {
                mode,
                index: place.index ?? edit.index,
                anchorName: place.anchorName || "",
              },
            }),
        ),
      );
      if (place.mode === "index") {
        const n = mkInput("number", String(place.index ?? edit.index));
        n.addEventListener("change", () =>
          patchEdit(preset, edit.id, {
            place: { mode: "index", index: Number(n.value) },
          }),
        );
        row.appendChild(n);
      }
      if (place.mode === "before" || place.mode === "after") {
        const t = mkInput("text", place.anchorName || "", "layer name");
        t.addEventListener("change", () =>
          patchEdit(preset, edit.id, {
            place: { mode: place.mode, anchorName: t.value },
          }),
        );
        row.appendChild(t);
      }
      box.appendChild(row);
    }

    const list = el("div", "cond-list");
    if (!(edit.conditions || []).length) {
      list.appendChild(
        el(
          "div",
          "empty",
          "No conditions — this will apply to every instance, every run.",
        ),
      );
    }
    for (const c of edit.conditions || []) {
      const chip = el("span", "chip");
      chip.appendChild(document.createTextNode(F.conditionLabel(c)));
      // The auto-attached type check is what replaces the leaf type check a field
      // capture gets, so it is shown but not removable — an edit without it would
      // be strictly less safe than what it is modelled on.
      const auto =
        edit.op !== "add" &&
        c.kind === "index-type" &&
        c.index === edit.index &&
        c.signature === F.editSignature(edit);
      if (auto) {
        chip.classList.add("is-auto");
        chip.title = "Automatic — the type check that keeps this edit honest";
      } else {
        const x = el("button", "", "✕");
        x.type = "button";
        x.addEventListener("click", () =>
          patchEdit(preset, edit.id, {
            conditions: edit.conditions.filter((o) => o !== c),
          }),
        );
        chip.appendChild(x);
      }
      list.appendChild(chip);
    }
    const condRow = el("div", "edit-row");
    condRow.appendChild(el("span", "field-label", "Conditions"));
    condRow.appendChild(list);
    box.appendChild(condRow);

    const addRow = el("div", "edit-row cond-add");
    addRow.appendChild(el("span", "field-label", ""));
    let built = conditionInputs(F.CONDITION_KINDS[0].kind);
    let kind = F.CONDITION_KINDS[0].kind;
    const kindSel = mkSelect(
      F.CONDITION_KINDS.map((c) => [c.kind, c.label]),
      kind,
      (next) => {
        kind = next;
        const fresh = conditionInputs(kind);
        built.row.replaceWith(fresh.row);
        built = fresh;
      },
    );
    addRow.appendChild(kindSel);
    addRow.appendChild(built.row);
    const addBtn = el("button", "clear", "Add condition");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      const made = F.normalizeCondition(readCondition(kind, built.fields));
      if (!made) {
        say("error", `"${preset.name}": that condition is incomplete`);
        return;
      }
      patchEdit(preset, edit.id, {
        conditions: [...(edit.conditions || []), made],
      });
    });
    addRow.appendChild(addBtn);
    box.appendChild(addRow);

    card.appendChild(box);
  };

  const renderPresets = () => {
    renderArmed();
    $("preset-count").textContent = presets.length
      ? `${presets.length} preset(s)`
      : "";
    const host = $("preset-list");
    host.textContent = "";
    if (!presets.length) {
      host.appendChild(
        el(
          "div",
          "empty",
          "No edge presets yet — press New preset, then in the template's editor" +
            " right-click a field to capture it, or right-click a layer in the" +
            " navigator to add, rename or remove a node.",
        ),
      );
      return;
    }

    for (const preset of presets) {
      const counts = F.describePreset(preset);
      const card = el("div", `preset${preset.id === armedId ? " is-armed" : ""}`);
      const head = el("div", "preset-head");
      const name = el("div", "preset-name");
      name.appendChild(document.createTextNode(preset.name || "(unnamed)"));
      name.appendChild(
        el(
          "div",
          "preset-sub",
          [
            preset.templateId
              ? `template ${preset.templateTitle || ""} #${preset.templateId}`.replace(
                  "  ",
                  " ",
                )
              : "unbound — capture in a template editor to bind it",
            `${counts.nodes} element(s)`,
            `${counts.fields} field(s)`,
            `${counts.values} key(s)`,
            ...(counts.edits ? ["1 structural edit"] : []),
          ].join(" · "),
        ),
      );
      head.appendChild(name);

      const btn = (text, cls, fn) => {
        const b = el("button", `clear ${cls || ""}`, text);
        b.type = "button";
        b.addEventListener("click", fn);
        head.appendChild(b);
        return b;
      };

      // The label has to say what the CLICK does, not what the state is. It read
      // "Capturing" once, which is a state — and since New preset auto-arms, the
      // first thing a user sees on a fresh preset is that button, so clicking it
      // to "select" the preset silently disarmed it instead. Which one is armed is
      // already carried by the banner and the card border.
      btn(
        preset.id === armedId ? "✓ Stop capturing" : "Select for capture",
        preset.id === armedId ? "primary" : "",
        () => arm(preset.id === armedId ? null : preset.id),
      );
      // Run needs a page editor to act on and a template to look for. An unbound
      // preset has nothing to match, so the button says so rather than reporting
      // zero instances as though that were a result.
      const runBtn = btn("Run on page", "", () => runPresetNow(preset, runBtn));
      if (!preset.templateId) {
        runBtn.disabled = true;
        runBtn.title = "Capture a field in a template's editor first";
      }
      btn("✎", "", () => {
        renaming = renaming === preset.id ? null : preset.id;
        renderPresets();
      });
      btn("Export", "", () => exportPreset(preset));
      btn("✕", "danger", () => removePreset(preset));
      card.appendChild(head);

      if (renaming === preset.id) {
        const row = el("div", "rename-row");
        const input = document.createElement("input");
        input.className = "text-input";
        input.value = preset.name || "";
        const commit = async () => {
          const next = input.value.trim();
          renaming = null;
          if (next && next !== preset.name) {
            await savePresets(
              presets.map((p) => (p.id === preset.id ? { ...p, name: next } : p)),
            );
          } else {
            renderPresets();
          }
        };
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            renaming = null;
            renderPresets();
          }
        });
        const ok = el("button", "clear primary", "✓");
        ok.type = "button";
        ok.addEventListener("click", commit);
        row.appendChild(input);
        row.appendChild(ok);
        card.appendChild(row);
        setTimeout(() => input.focus(), 0);
      }

      if (preset.nodes?.length) {
        const body = el("div", "preset-nodes");
        for (const node of preset.nodes) {
          const nrow = el("div", "node");
          nrow.appendChild(
            el(
              "div",
              "node-path",
              `${node.label ? `"${node.label}" ` : ""}${F.pathLabel(node)}`,
            ),
          );
          const chips = el("div", "node-fields");
          for (const field of node.fields || []) {
            const chip = el("span", "chip");
            chip.appendChild(
              document.createTextNode(
                `${F.fieldLabel(field)} (${F.valueCount(field)})`,
              ),
            );
            const x = el("button", "", "✕");
            x.type = "button";
            x.title = "Remove this field from the preset";
            x.addEventListener("click", () =>
              savePresets(
                presets.map((p) =>
                  p.id === preset.id
                    ? F.removeField(p, F.nodeKey(node), F.fieldKey(field))
                    : p,
                ),
              ),
            );
            chip.appendChild(x);
            chips.appendChild(chip);
          }
          nrow.appendChild(chips);
          body.appendChild(nrow);
        }
        card.appendChild(body);
      }
      renderEdit(preset, card);
      host.appendChild(card);
    }
  };

  // The manual path: apply one preset to whatever page an editor tab has open.
  // Dispatched through `run-action` into the `runners` table in hotkeys.js — the
  // same route the panel's animation-preset buttons take — so applying a preset by
  // hand and applying it in a batch enter the tool at one point.
  //
  // The reply only reports that the run STARTED, which is what run-action promises.
  // Per-instance results, including every skip, land in the tool log this window
  // already renders live.
  const runPresetNow = async (preset, button) => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "…";
    try {
      const { tab, reply } = await askElementorTab({
        __elementorTools: true,
        type: "run-action",
        action: "applyEdgePreset",
        args: { presetIds: [preset.id], titles: titlesById() },
      });
      if (!reply) {
        say("error", "No Elementor editor tab open — open one, then try again.");
      } else if (!reply.ok) {
        say("error", `Could not apply "${preset.name}" — ${reply.error}`);
      } else {
        // Naming the document it went to is load-bearing, not decoration. With
        // several editor tabs open, which one answers is decided by the tab
        // ranking — origin, then *active* — and this window is a popup, so the
        // editor the user is looking at is not necessarily the active tab. Left
        // unnamed, a run that landed in the wrong document is indistinguishable
        // from one that found nothing.
        say(
          "ok",
          `Applying "${preset.name}" in "${tab?.title || "the open editor"}" — ` +
            `per-instance results appear in the tool log below.`,
        );
        // The tool logs from the editor page and this is a separate window, so
        // bring that tab forward rather than leaving the click looking dead.
        await focusTab(tab);
      }
    } catch (err) {
      say("error", `Could not apply "${preset.name}" — ${err?.message || err}`);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  };

  const savePresets = async (next) => {
    presets = next;
    await browser.storage.local.set({ [F.STORAGE_KEY]: next });
    renderPresets();
  };

  const arm = async (id) => {
    armedId = id;
    await browser.storage.local.set({ [KEYS.armed]: id });
    renderPresets();
  };

  const newPreset = async () => {
    const preset = F.makePreset(`Edge preset ${presets.length + 1}`);
    await savePresets([...presets, preset]);
    // Armed immediately: a preset that is not selected offers no capture, so
    // creating one and leaving it inert would read as the button doing nothing.
    await arm(preset.id);
    renaming = preset.id;
    renderPresets();
  };

  const removePreset = async (preset) => {
    const counts = F.describePreset(preset);
    if (
      !window.confirm(
        `Delete "${preset.name}"? It holds ${counts.fields} captured field(s).`,
      )
    ) {
      return;
    }
    if (armedId === preset.id) await arm(null);
    await savePresets(presets.filter((p) => p.id !== preset.id));
  };

  const download = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const exportPreset = (preset) => {
    download(
      F.exportFileName(preset),
      JSON.stringify(F.toPresetFile(preset), null, 2),
      "application/json",
    );
  };

  const importPreset = async (file) => {
    const text = await file.text();
    const parsed = F.parsePresetFile(text);
    if (!parsed.ok) {
      say("error", `Import failed — ${parsed.error}`);
      return;
    }
    for (const problem of parsed.problems || []) {
      say("warn", `Import: ${problem}`);
    }
    // `id` decides replace-or-add, so exporting, hand-editing and importing
    // updates the preset in place rather than accumulating copies.
    const at = presets.findIndex((p) => p.id === parsed.preset.id);
    const next = presets.slice();
    if (at >= 0) next[at] = parsed.preset;
    else next.push(parsed.preset);
    await savePresets(next);
    say(
      "ok",
      `Imported "${parsed.preset.name}" (${at >= 0 ? "replaced" : "added"})`,
    );
  };

  // ------------------------------------------------------------------ lists

  const loadList = async (kind) => {
    const state = lists[kind];
    state.loading = true;
    state.error = null;
    renderPickers();
    const preferOrigin = T.parseWorkingDomain(workingDomain)?.origin || "";
    try {
      const { tab, reply } = await askElementorTab(
        { __elementorTools: true, ...TAB_REQUESTS[kind] },
        { preferOrigin },
      );
      state.via = tab
        ? (tab.url || "").includes("action=elementor")
          ? "editor"
          : "wp-admin"
        : null;
      if (!reply) state.error = NO_TAB;
      else if (!reply.ok) state.error = reply.error;
      else {
        state.rows = kind === "template" ? reply.templates || [] : reply.posts || [];
        state.warnings = reply.warnings || [];
        for (const w of state.warnings) say("warn", `${kind} list: ${w}`);
      }
    } catch (err) {
      state.error = err?.message || String(err);
    } finally {
      state.loading = false;
      renderPickers();
      renderState();
    }
  };

  const refreshAll = async () => {
    // All three, because the Templates list is both the include-picker and one of
    // the target tabs — one fetch serves both.
    await Promise.all([loadList("template"), loadList("page"), loadList("other")]);
    const via = [...new Set(Object.values(lists).map((l) => l.via).filter(Boolean))];
    setState(
      runState === "idle" ? "idle" : runState,
      via.length ? `Lists loaded via ${via.join(" + ")}` : "",
    );
  };

  // -------------------------------------------------------------------- run

  const titlesById = () =>
    Object.fromEntries(
      (lists.template.rows || []).map((t) => [String(t.templateId), t.title || ""]),
    );

  // Every ticked document, in the order the lists present them, with the facts the
  // run needs: which tab request it came from is irrelevant by now, only its id and
  // a name for the report.
  const buildQueue = () => {
    const out = [];
    for (const kind of ["page", "template", "other"]) {
      for (const row of rowsFor(kind)) {
        if (!picked.docs.has(row.id)) continue;
        // A document ticked on two tabs is one job. Template ids and post ids are
        // both WordPress post ids, so the id alone is the identity.
        if (out.some((q) => q.id === row.id)) continue;
        out.push({ id: row.id, title: row.title, kind });
      }
    }
    return out;
  };

  const setProgress = (index, state, note) => {
    const row = progress[index];
    if (!row) return;
    row.state = state;
    if (note !== undefined) row.note = note;
    renderProgress();
  };

  const waitForEditor = async (tabId) => {
    const deadline = Date.now() + READY_TIMEOUT;
    let last = "no answer yet";
    while (Date.now() < deadline) {
      if (cancelRequested) return { ready: false, why: "cancelled" };
      try {
        const reply = await browser.tabs.sendMessage(tabId, {
          __elementorTools: true,
          type: "automation-ready",
        });
        if (reply?.ready) return reply;
        if (reply?.why) last = reply.why;
      } catch (_) {
        // The content script is not in place yet, or the tab is still navigating.
        last = "content script not loaded yet";
      }
      await new Promise((r) => setTimeout(r, READY_POLL));
    }
    return { ready: false, why: `timed out after ${READY_TIMEOUT / 1000}s — ${last}` };
  };

  const runOne = async (job, index) => {
    const url = T.elementorEditUrl(workingDomain, job.id);
    if (!url) {
      setProgress(index, "failed", "could not build an editor URL");
      say("error", `"${job.title}" (#${job.id}) — could not build an editor URL`);
      return { ...job, state: "failed", error: "no editor URL" };
    }

    setProgress(index, "opening");
    let tab = null;
    try {
      // Opened in the background: three editors stealing focus in turn would make
      // the browser unusable for the length of the run.
      tab = await openTab(url, { active: false });
    } catch (err) {
      setProgress(index, "failed", "could not open a tab");
      say("error", `"${job.title}" (#${job.id}) — could not open a tab: ${err}`);
      return { ...job, state: "failed", error: String(err) };
    }
    openTabs.add(tab.id);

    try {
      setProgress(index, "waiting");
      const ready = await waitForEditor(tab.id);
      if (!ready.ready) {
        const cancelled = cancelRequested;
        setProgress(index, cancelled ? "cancelled" : "failed", ready.why);
        say(
          cancelled ? "warn" : "error",
          `"${job.title}" (#${job.id}) — ${ready.why}`,
        );
        return {
          ...job,
          state: cancelled ? "cancelled" : "failed",
          error: ready.why,
        };
      }

      // The agent reports per page, not per phase, so this row shows the phase the
      // page STARTS in — whichever the chosen order puts first.
      const phases = phasesFor();
      setProgress(index, phases[0] === "edge" ? "edge" : "syncing");
      const reply = await browser.tabs.sendMessage(tab.id, {
        __elementorTools: true,
        type: "automation-run",
        args: {
          mode,
          phases,
          templateIds: [...picked.templates],
          toggles,
          titles: titlesById(),
          review,
        },
      });
      if (!reply?.ok) {
        const why = reply?.error || "the editor did not report a result";
        setProgress(index, "failed", why);
        say("error", `"${job.title}" (#${job.id}) — ${why}`);
        return { ...job, state: "failed", error: why };
      }

      const report = reply.report || {};
      const notes = [];
      let level = "ok";

      // Never downgrades an error to a warning. With the phases in a chosen order
      // either of them can be the one that already failed, so neither may assign
      // `level` directly.
      const warn = () => {
        if (level !== "error") level = "warn";
      };

      // Walked in the order the phases actually ran, so the row reads as the
      // sequence of events rather than as a fixed sync-then-edge shape.
      for (const name of report.phases || phases) {
        const phase = report[name];
        if (!phase) continue;
        if (!phase.ok) {
          level = "error";
          notes.push(
            `${name === "sync" ? "sync" : "edge presets"} failed: ${phase.error || "unknown"}`,
          );
        } else if (name === "sync") {
          notes.push(`sync: ${phase.summary || "done"}`);
          // Reported at the page level as well as in the tool log, because a
          // failure count is the one number that decides whether this page needs
          // a human to look at it.
          if (phase.failed) warn();
        } else {
          notes.push(
            `edge: ${phase.applied} field(s)` +
              (phase.skipped ? `, ${phase.skipped} skipped` : ""),
          );
          if (phase.skipped) warn();
          for (const w of phase.warnings || []) say("warn", w);
        }
      }
      if (report.save?.review) {
        notes.push("left open — publish from the editor tab");
      } else if (report.save?.ok) {
        notes.push(
          report.save.saved
            ? `saved (${report.save.status || "?"})`
            : "not saved — nothing changed",
        );
      } else if (report.save?.skipped) {
        // A deliberate skip, not a broken save: an earlier phase hard-failed and
        // the page was left untouched. The phase's own note above already says
        // what went wrong, so this must not read as a second, different failure.
        level = "error";
        notes.push("left untouched — re-run this page");
      } else {
        level = "error";
        notes.push(`SAVE FAILED: ${report.save?.error || "unknown"}`);
      }

      const note = notes.join(" · ");
      const failed = level === "error";
      setProgress(
        index,
        failed ? "failed" : report.save?.review ? "review" : "done",
        note,
      );
      say(level, `"${job.title}" (#${job.id}) — ${note}`);
      return {
        ...job,
        state: failed ? "failed" : report.save?.review ? "review" : "done",
        report,
        note,
      };
    } catch (err) {
      // A cancel closes the tab underneath the pending sendMessage, which lands
      // here. That is the abandon path and it is not a failure: nothing was saved.
      if (cancelRequested) {
        setProgress(index, "cancelled", "abandoned — tab closed, nothing saved");
        return { ...job, state: "cancelled" };
      }
      const why = String(err?.message || err);
      setProgress(index, "failed", why);
      say("error", `"${job.title}" (#${job.id}) — ${why}`);
      return { ...job, state: "failed", error: why };
    } finally {
      // Out of openTabs either way — that set is what a cancel and this window's
      // own beforeunload close, and a review tab holding unsaved work the user is
      // meant to publish must survive both. A tab still mid-run stays in the set,
      // which is right: it has nothing worth preserving yet.
      openTabs.delete(tab.id);
      if (!review || cancelRequested) {
        await browser.tabs.remove(tab.id).catch(() => {});
      }
    }
  };

  // A plain worker pool. `concurrency` editors are in flight; each worker takes
  // the next job when its own finishes, so a slow page does not hold up the others.
  const runPool = async (jobs, n, worker) => {
    let next = 0;
    const results = new Array(jobs.length);
    const workers = Array.from({ length: Math.min(n, jobs.length) }, async () => {
      for (;;) {
        const at = next++;
        if (at >= jobs.length) return;
        if (cancelRequested) {
          results[at] = { ...jobs[at], state: "cancelled" };
          setProgress(at, "cancelled", "not started");
          continue;
        }
        results[at] = await worker(jobs[at], at);
      }
    });
    await Promise.all(workers);
    return results;
  };

  const startRun = async () => {
    const jobs = buildQueue();
    if (!jobs.length) return;

    if (review && jobs.length > REVIEW_MAX_DOCS) {
      setState(
        "error",
        `review mode is limited to ${REVIEW_MAX_DOCS} documents`,
      );
      say(
        "error",
        `Refused: review mode leaves every editor open, and ${jobs.length} of them ` +
          `would be unusable. Narrow the selection to ${REVIEW_MAX_DOCS} or fewer, ` +
          `or untick "Leave tabs open for review".`,
      );
      return;
    }

    cancelRequested = false;
    runLog = [];
    lastReport = null;
    progress = jobs.map((j) => ({ ...j, state: "queued", note: "" }));
    renderProgress();
    setState("running", `0 of ${jobs.length} done`);

    const started = Date.now();
    const phases = phasesFor();
    say(
      "ok",
      `Run started — ${jobs.length} document(s), ${picked.templates.size} template(s) in scope, ` +
        `mode "${MODES[mode]?.label || mode}", ${concurrency} editor(s) at once` +
        (review ? " · REVIEW: nothing will be saved, tabs stay open" : ""),
    );
    // Said once here rather than left to be discovered across a hundred pages.
    // Neither consequence shows up as a failure — an instance the presets could not
    // see is simply not in their count, which reads exactly like a clean run.
    if (phases[0] === "edge" && phases.includes("sync")) {
      say(
        "warn",
        "Edge Presets run BEFORE the sync in this order. Presets match instances on " +
          "the #id tag alone and the sync is what writes that tag, so a container " +
          "this run's sync is about to adopt is still untagged and its presets will " +
          "not reach it. Any style field a preset writes is also overwritten by the " +
          "paste that follows.",
      );
    }

    const results = await runPool(jobs, concurrency, async (job, index) => {
      const out = await runOne(job, index);
      const done = progress.filter((p) =>
        ["done", "review", "failed", "skipped", "cancelled"].includes(p.state),
      ).length;
      setState(runState, `${done} of ${jobs.length} done`);
      return out;
    });

    const counts = results.reduce((acc, r) => {
      const key = r?.state || "failed";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    const seconds = Math.round((Date.now() - started) / 1000);
    const summary =
      `${counts.done || 0} done, ${counts.failed || 0} failed` +
      (counts.review ? `, ${counts.review} awaiting review` : "") +
      (counts.cancelled ? `, ${counts.cancelled} cancelled` : "") +
      ` in ${seconds}s`;

    lastReport = {
      startedAt: new Date(started).toISOString(),
      seconds,
      mode,
      // Spelled out beside the mode, because the mode key alone does not say which
      // half ran first and a report read months later has to.
      phases,
      concurrency,
      workingDomain,
      templateIds: [...picked.templates],
      toggles,
      summary,
      documents: results.map((r) => ({
        id: r?.id,
        title: r?.title,
        kind: r?.kind,
        state: r?.state,
        note: r?.note || null,
        error: r?.error || null,
        report: r?.report || null,
      })),
      log: runLog.slice().reverse(),
    };

    const state = cancelRequested
      ? "cancelled"
      : counts.failed
        ? "error"
        : "finished";
    say(counts.failed ? "error" : "ok", `Run ${state} — ${summary}`);
    setState(state, summary);
  };

  const cancelRun = async () => {
    if (runState !== "running") return;
    cancelRequested = true;
    setState("cancelling", "closing open editors — nothing saved is lost");
    say(
      "warn",
      "Cancel requested — every open editor is being closed. Pages that had not " +
        "reached their save keep their original content, because nothing is " +
        "persisted until then.",
    );
    // Closing the tabs is the abandon. It aborts the agent mid-phase, which is
    // safe: the save is the last thing a page does, so an abandoned page was
    // never written to.
    for (const id of [...openTabs]) {
      openTabs.delete(id);
      await browser.tabs.remove(id).catch(() => {});
    }
  };

  // -------------------------------------------------------------- settings

  const saveSettings = () =>
    browser.storage.local.set({
      [KEYS.settings]: {
        mode,
        concurrency,
        review,
        toggles,
        docKind,
        templates: [...picked.templates],
        docs: [...picked.docs],
      },
    });

  // ------------------------------------------------------------------ wire

  $("working-domain").addEventListener("change", () => {
    workingDomain = $("working-domain").value.trim();
    browser.storage.local.set({ [KEYS.workingDomain]: workingDomain });
    renderState();
  });

  $("views").addEventListener("click", (e) => {
    const tab = e.target.closest(".view-tab");
    if (!tab) return;
    view = tab.dataset.view;
    for (const b of $("views").querySelectorAll(".view-tab")) {
      b.classList.toggle("is-active", b.dataset.view === view);
    }
    $("view-run").classList.toggle("is-hidden", view !== "run");
    $("view-presets").classList.toggle("is-hidden", view !== "presets");
  });

  $("doc-kinds").addEventListener("click", (e) => {
    const btn = e.target.closest(".kind");
    if (!btn) return;
    docKind = btn.dataset.kind;
    saveSettings();
    // A tab that has never loaded fetches on first view; a loaded one renders
    // from what it has. Refresh is the only thing that goes back to the network.
    if (lists[docKind].rows === null && !lists[docKind].loading) loadList(docKind);
    renderPickers();
  });

  $("run-mode").addEventListener("change", () => {
    mode = $("run-mode").value;
    saveSettings();
    renderToggles();
  });

  $("concurrency").addEventListener("change", () => {
    const n = Number($("concurrency").value);
    concurrency = Number.isFinite(n) ? Math.min(8, Math.max(1, Math.round(n))) : 3;
    $("concurrency").value = concurrency;
    saveSettings();
  });

  $("review-mode").addEventListener("change", () => {
    review = $("review-mode").checked;
    saveSettings();
    renderState();
  });

  $("tpl-search").addEventListener("input", () => {
    search.tpl = $("tpl-search").value;
    renderPickers();
  });
  $("doc-search").addEventListener("input", () => {
    search.doc = $("doc-search").value;
    renderPickers();
  });

  document.addEventListener("click", (e) => {
    const all = e.target.closest?.("[data-all]")?.dataset.all;
    const none = e.target.closest?.("[data-none]")?.dataset.none;
    if (!all && !none) return;
    const which = (all || none) === "tpl" ? "templates" : "docs";
    const kind = (all || none) === "tpl" ? "template" : docKind;
    const query = (all || none) === "tpl" ? search.tpl : search.doc;
    if (all) {
      // "Shown", not "All": it ticks what the search is currently showing, which
      // is what the button is next to. It never unticks anything hidden.
      for (const row of filtered(rowsFor(kind), query)) picked[which].add(row.id);
    } else {
      for (const row of filtered(rowsFor(kind), query)) picked[which].delete(row.id);
    }
    saveSettings();
    renderPickers();
    renderState();
  });

  $("refresh").addEventListener("click", refreshAll);
  $("start").addEventListener("click", startRun);
  $("cancel").addEventListener("click", cancelRun);

  $("copy-log").addEventListener("click", () => {
    const text = runLog
      .slice()
      .reverse()
      .map(
        (e) =>
          `[${new Date(e.time).toISOString()}] ${String(e.level).toUpperCase()} ${e.message}`,
      )
      .join("\n");
    navigator.clipboard?.writeText?.(text).catch(() => {});
  });

  $("download-report").addEventListener("click", () => {
    if (!lastReport) return;
    const stamp = lastReport.startedAt.replace(/[:.]/g, "-");
    download(
      `elementor-automation-${stamp}.json`,
      JSON.stringify(lastReport, null, 2),
      "application/json",
    );
  });

  $("preset-new").addEventListener("click", newPreset);
  $("preset-import").addEventListener("click", () => $("preset-file").click());
  $("preset-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await importPreset(file);
  });

  // Closing this window cancels the run, and the tabs it opened have to go with
  // it — otherwise a cancelled run leaves three editors behind. Best effort:
  // `remove` is fired without awaiting, which the background page completes.
  // Review tabs are NOT in openTabs by the time they are worth keeping — runOne
  // removes each one as it finishes — so this closes only editors still mid-run.
  // Closing a review tab here would destroy exactly the unsaved work that mode
  // exists to protect.
  window.addEventListener("beforeunload", () => {
    cancelRequested = true;
    for (const id of openTabs) browser.tabs.remove(id).catch(() => {});
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.logs) {
      toolLog = changes.logs.newValue || [];
      renderLogs();
    }
    if (changes[F.STORAGE_KEY]) {
      presets = changes[F.STORAGE_KEY].newValue || [];
      renderPresets();
    }
    if (changes[KEYS.armed]) {
      armedId = changes[KEYS.armed].newValue || null;
      renderPresets();
    }
    if (changes[KEYS.workingDomain]) {
      workingDomain = changes[KEYS.workingDomain].newValue || "";
      if (document.activeElement !== $("working-domain")) {
        $("working-domain").value = workingDomain;
      }
      renderState();
    }
  });

  const init = async () => {
    const state = await browser.storage.local.get([
      KEYS.workingDomain,
      KEYS.settings,
      KEYS.armed,
      F.STORAGE_KEY,
      "logs",
    ]);
    workingDomain = state[KEYS.workingDomain] || "";
    $("working-domain").value = workingDomain;
    presets = Array.isArray(state[F.STORAGE_KEY]) ? state[F.STORAGE_KEY] : [];
    armedId = state[KEYS.armed] || null;
    toolLog = state.logs || [];

    const saved = state[KEYS.settings] || {};
    // hasOwn, not `in`: `in` walks the prototype chain, so a stored "toString"
    // would validate and then select an option that does not exist.
    if (Object.hasOwn(MODES, saved.mode ?? "")) mode = saved.mode;
    if (Number.isFinite(saved.concurrency)) {
      concurrency = Math.min(8, Math.max(1, Math.round(saved.concurrency)));
    }
    review = !!saved.review;
    if (saved.toggles) {
      toggles = Object.fromEntries(
        SYNC_TOGGLES.map((t) => [
          t.key,
          t.key in saved.toggles ? !!saved.toggles[t.key] : t.default,
        ]),
      );
    }
    if (["page", "template", "other"].includes(saved.docKind)) {
      docKind = saved.docKind;
    }
    for (const id of saved.templates || []) picked.templates.add(String(id));
    for (const id of saved.docs || []) picked.docs.add(String(id));

    $("concurrency").value = concurrency;
    $("review-mode").checked = review;
    renderModes();
    renderToggles();
    renderPresets();
    renderPickers();
    renderProgress();
    renderLogs();
    setState(
      "idle",
      workingDomain
        ? "Press Refresh lists to load this site"
        : "Set a working site to begin",
    );
    if (workingDomain) await refreshAll();
  };

  init();
})();
