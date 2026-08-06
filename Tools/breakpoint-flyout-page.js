// Page-world half of the breakpoint flyout.
//
// Every other tool in this extension lives in the content script and reaches
// the page through `callBridge`. This one cannot: it instantiates Elementor's
// own Backbone control views and drives them per keystroke, so a postMessage
// round trip per interaction would be the wrong seam entirely. It is injected
// by Tools/breakpoint-flyout.js, the same way core_utils.js injects
// page-bridge.js.
//
// Two features, deliberately scoped differently:
//
//   * Left-click a responsive field's label or its empty row area -> a flyout
//     showing that field at every active breakpoint at once. Edits are staged;
//     nothing reaches the document until Apply.
//   * Right-click ANY field -> copy/paste that field's value. Responsive
//     fields copy the whole breakpoint set as one payload.
(() => {
  if (!location.search.includes("action=elementor")) return;
  if (window.__ElementorToolsBreakpointFlyout) return;
  window.__ElementorToolsBreakpointFlyout = true;

  const ROW_CLASS = "ElementorTools-bpf-row"; // responsive: opens the flyout
  const ANY_CLASS = "ElementorTools-bpf-any"; // any control: right-click menu
  const FLYOUT_CLASS = "ElementorTools-bpf";
  const MENU_CLASS = "ElementorTools-bpf-menu";
  const SWITCHERS = ".elementor-control-responsive-switchers";
  const HISTORY_TITLE = "Edit breakpoints";
  const PAYLOAD_KIND = "elementor-tools/control-values";

  // A left-click opens the flyout unless it landed on something that does its
  // own job. Every control type nests its actual inputs under one of these
  // wrappers — inputs in `input-wrapper`, the unit picker in `e-units-wrapper`,
  // Elementor's device switcher in its own div — so this is a positive rule
  // about structure rather than a blocklist of control types that would need
  // extending every time Elementor adds one. The bare tags are a backstop for
  // anything rendering a control outside those wrappers.
  const PASSTHROUGH = [
    ".elementor-control-input-wrapper",
    ".e-units-wrapper",
    SWITCHERS,
    "input",
    "textarea",
    "select",
    "button",
    "a",
    "[contenteditable]",
  ].join(",");

  // Right-click is allowed almost everywhere on a row, because copying a value
  // is useful wherever you are pointing. Text entry is the exception: the
  // native menu there carries spellcheck and text copy/paste, which is more
  // valuable than ours.
  const NATIVE_MENU = "input, textarea, [contenteditable]";

  const style = document.createElement("style");
  style.textContent = `
    /* No icon: the row itself is the affordance. Only the label and the row's
       own whitespace get the pointer, which is exactly the region that opens
       the flyout — so the cursor never promises a click the inputs will eat. */
    .${ROW_CLASS} > .elementor-control-content,
    .${ROW_CLASS} .elementor-control-title {
      cursor: pointer;
    }
    .${ROW_CLASS} .elementor-control-title:hover { color: #5aa1ff; }
    .${ROW_CLASS}[data-bpf-open="1"] .elementor-control-title {
      color: #5aa1ff;
      font-weight: 600;
    }

    .${FLYOUT_CLASS}, .${MENU_CLASS} {
      position: fixed;
      z-index: 100000;
      background: #26292c;
      color: #d5d8dc;
      border: 1px solid #3f444b;
      border-radius: 4px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
      font-family: Roboto, Arial, sans-serif;
      font-size: 12px;
    }

    .${FLYOUT_CLASS} {
      width: 300px;
      max-height: 70vh;
      display: flex;
      flex-direction: column;
    }
    .${FLYOUT_CLASS}__head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-bottom: 1px solid #3f444b;
      font-weight: 600;
    }
    .${FLYOUT_CLASS}__close {
      border: 0;
      background: none;
      color: inherit;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
      opacity: 0.7;
    }
    .${FLYOUT_CLASS}__close:hover { opacity: 1; }
    .${FLYOUT_CLASS}__body { overflow-y: auto; padding: 4px 0 8px; }
    .${FLYOUT_CLASS}__device {
      padding: 8px 10px 2px;
      font-size: 10px;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      opacity: 0.65;
    }
    /* A breakpoint still sitting on the control's default has no value of its
       own yet. It is fully editable — this only says "nothing set here", so
       the set breakpoints are readable at a glance. */
    .${FLYOUT_CLASS}__device--unset { opacity: 0.3; font-style: italic; }
    /* Every breakpoint is on screen at once here, so whatever hides a
       non-active device in the panel has to lose — and it takes an !important
       display on the row itself.
       Stripping "elementor-hidden-control" is NOT enough, which is the whole
       trap: measured on 4.2.1 a tablet row renders its full markup (~5k of
       real slider HTML) and still computes "display: none" with that class
       gone. It is not an inline style either — there is none, and clearing it
       changes nothing. The rule lives in the one editor stylesheet script
       cannot read, so it cannot be matched or overridden by specificity;
       !important on our own rows is the answer. Symptom if this regresses:
       the flyout shows only Desktop, every other device label with empty
       space beneath it. */
    .${FLYOUT_CLASS}__body > .elementor-control {
      display: block !important;
    }
    /* Each cloned view renders Elementor's own device switcher. It would switch
       the *panel*, not this row, which is exactly the confusion this exists to
       remove. */
    .${FLYOUT_CLASS} ${SWITCHERS} { display: none !important; }
    .${FLYOUT_CLASS} .elementor-control { padding: 0 10px 8px; background: none; }
    .${FLYOUT_CLASS} .elementor-control-separator-default { border: 0; }
    .${FLYOUT_CLASS}__foot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid #3f444b;
    }
    .${FLYOUT_CLASS}__count { margin-inline-end: auto; opacity: 0.65; }
    .${FLYOUT_CLASS}__btn {
      padding: 5px 12px;
      border: 1px solid #4b5058;
      border-radius: 3px;
      background: #33373c;
      color: #d5d8dc;
      cursor: pointer;
      font-size: 12px;
    }
    .${FLYOUT_CLASS}__btn:hover { background: #3c4046; }
    .${FLYOUT_CLASS}__btn--primary {
      border-color: #5aa1ff;
      background: #2f6fd0;
      color: #fff;
    }
    .${FLYOUT_CLASS}__btn--primary:disabled { opacity: 0.45; cursor: default; }
    .${FLYOUT_CLASS}__err { padding: 6px 10px; color: #ff8a80; }

    .${MENU_CLASS} { min-width: 168px; padding: 4px 0; }
    .${MENU_CLASS}__label {
      padding: 4px 10px 6px;
      opacity: 0.55;
      font-size: 10px;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 240px;
    }
    .${MENU_CLASS}__item {
      display: block;
      width: 100%;
      padding: 6px 10px;
      border: 0;
      background: none;
      color: inherit;
      text-align: start;
      cursor: pointer;
      font-size: 12px;
    }
    .${MENU_CLASS}__item:hover { background: #33373c; }
    .${MENU_CLASS}__note { padding: 4px 10px; opacity: 0.7; }
    .${MENU_CLASS}__note--err { color: #ff8a80; opacity: 1; }
  `;
  (document.head || document.documentElement).appendChild(style);

  // ---------------------------------------------------------------- schema

  // Control values are plain JSON (objects for sliders and dimensions, scalars
  // elsewhere), so this is enough to sever the reference to the live model.
  const copyValue = (value) => {
    if (value === undefined || value === null) return value;
    if (typeof value !== "object") return value;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return value;
    }
  };

  // Elementor generates one control per breakpoint from a single responsive
  // definition and chains the copies through a top-level `parent` — NOT
  // `responsive.parent`, which does not exist. Getting that wrong is silent:
  // every variant looks like a base (620 of 620 on a container) and every
  // family comes back one key long.
  //
  // Measured on Elementor 4.2.1: a container has 904 controls, 620 of them
  // responsive, partitioning exactly into 124 bases of 5 devices each. That
  // arithmetic is the check that this walk is right.
  const resolveBase = (controls, name) => {
    let cursor = name;
    let guard = 0;
    while (controls[cursor]?.parent && guard++ < 16) {
      cursor = controls[cursor].parent;
    }
    return cursor;
  };

  const buildFamily = (controls, baseName) => {
    const childOf = new Map();
    for (const key of Object.keys(controls)) {
      const parent = controls[key]?.parent;
      if (parent) childOf.set(parent, key);
    }
    const keys = [baseName];
    const seen = new Set(keys);
    let cursor = baseName;
    while (childOf.has(cursor)) {
      const next = childOf.get(cursor);
      if (seen.has(next)) break;
      seen.add(next);
      keys.push(next);
      cursor = next;
    }
    return keys;
  };

  // Widest first, which is the order Elementor's own switcher uses. Never
  // hardcode this list: a site can run both "extra" breakpoints, making five
  // devices, and that is not the default shape.
  const deviceRank = () => {
    try {
      const list = elementor.breakpoints.getActiveBreakpointsList({
        withDesktop: true,
      });
      return new Map([...list].reverse().map((d, i) => [d, i]));
    } catch (_) {
      return new Map([["desktop", 0]]);
    }
  };

  const deviceLabel = (device) => {
    if (device === "desktop") return "Desktop";
    if (device === "base") return "Value";
    return (
      elementor?.config?.responsive?.activeBreakpoints?.[device]?.label ||
      device
    );
  };

  // Elementor seeds *every* control into the settings model, so a breakpoint
  // that was never touched is not absent — it is present holding the control's
  // default. "No value yet" therefore means "equal to the default", and that
  // is what the faded device label reports.
  //
  // The comparison canonicalises key order rather than stringifying directly.
  // On 4.2.1 that is precaution, not a fix: all 620 responsive controls on a
  // container agree either way. It is here because `canon()` in
  // animation-preset-fields.js exists for exactly this reason on a neighbouring
  // set of controls, so Elementor demonstrably does reorder keys somewhere —
  // and the failure is silent, an untouched default reading as "set".
  // Key *sets* legitimately differ (a value can carry `size` where the default
  // does not); that is a real difference and correctly reads as set.
  const canon = (value) => {
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
        return out;
      }
      return v;
    };
    try {
      return JSON.stringify(walk(value));
    } catch (_) {
      return String(value);
    }
  };

  const isUnset = (controls, key, value) => {
    const def = controls[key]?.default;
    if (value === undefined || value === null || value === "") return true;
    return canon(value) === canon(def);
  };

  // Everything downstream — flyout, copy, paste — works off this one shape, so
  // a non-responsive control is simply a family of one whose single device is
  // "base". That is what lets right-click copy/paste cover every field in the
  // editor without a second code path.
  const controlInfo = (view) => {
    const name = view?.model?.get?.("name");
    const container = view?.options?.container;
    const controls = container?.settings?.controls;
    if (!name || !controls || !controls[name]) return null;

    const base = resolveBase(controls, name);
    if (!controls[base]) return null;
    const keys = buildFamily(controls, base);
    const responsive = keys.length > 1;
    const rank = deviceRank();

    const entries = keys
      .map((key) => ({
        key,
        device:
          key === base
            ? responsive
              ? "desktop"
              : "base"
            : key.slice(base.length + 1),
      }))
      .filter(({ device }) => !responsive || rank.has(device))
      .sort((a, b) => (rank.get(a.device) ?? 0) - (rank.get(b.device) ?? 0));
    // Deliberately NOT filtered by `condition`. Every active breakpoint must be
    // editable whether or not it holds a value, and measured on 4.2.1 the
    // condition is all-or-nothing per family anyway (10 of 17 visible
    // responsive fields drop all 5 variants, none drop a subset) — so filtering
    // could only ever remove a breakpoint the user asked to be able to set. A
    // family whose condition fails entirely is hidden in the panel and cannot
    // be clicked in the first place.

    return {
      scope: "field",
      name,
      base,
      container,
      controls,
      entries,
      responsive,
      type: controls[base].type,
      label:
        controls[base].label ||
        view.el
          ?.querySelector(".elementor-control-title")
          ?.textContent?.trim() ||
        base,
    };
  };

  // A section header ("Layout", "Background", …) is itself a control of type
  // `section`, and every control it owns points back at it by name. That name
  // is the section's identity for paste, deliberately rather than its label:
  // a container's Layout is `section_layout_container` and a widget's is
  // `section_layout`, so matching on name refuses a cross-element paste that
  // matching on the word "Layout" would happily accept.
  const sectionInfo = (view) => {
    const name = view?.model?.get?.("name");
    const container = view?.options?.container;
    const controls = container?.settings?.controls;
    if (!name || !controls || controls[name]?.type !== "section") return null;

    const keys = Object.keys(controls).filter(
      (key) =>
        controls[key] &&
        controls[key].type !== "section" &&
        controls[key].section === name,
    );
    if (!keys.length) return null;

    return {
      scope: "section",
      section: name,
      container,
      controls,
      keys,
      label: controls[name].label || name,
    };
  };

  const infoForView = (view) => sectionInfo(view) || controlInfo(view);

  const getPanelPage = () => {
    try {
      const page = elementor.getPanelView().getCurrentPageView();
      return page?.children?.each ? page : null;
    } catch (_) {
      return null;
    }
  };

  const viewForRow = (row) => {
    const page = getPanelPage();
    if (!page) return null;
    let match = null;
    page.children.each((view) => {
      if (!match && view.el === row) match = view;
    });
    return match;
  };

  // ------------------------------------------------------------- transport

  let nextRequestId = 0;
  const askContentScript = (op, payload) =>
    new Promise((resolve) => {
      const requestId = ++nextRequestId;
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ ok: false, error: "Extension did not respond" });
      }, 3000);
      const onMessage = (event) => {
        if (event.source !== window) return;
        const d = event.data;
        if (
          !d ||
          d.__bpf !== true ||
          !d.__response ||
          d.requestId !== requestId
        ) {
          return;
        }
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(d);
      };
      window.addEventListener("message", onMessage);
      window.postMessage({ __bpf: true, requestId, op, payload }, "*");
    });

  // ---------------------------------------------------------------- unlink

  // Mirrors LINKED_TYPES in page-bridge.js. Both are page-world scripts with no
  // shared scope — the same boundary that keeps the template-tag regex out of the
  // bridge. Change one, change both.
  const LINKED_TYPES = new Set(["dimensions", "gaps"]);

  // The panel's "Unlink Fields On New Elements" flag, pushed in from the content
  // script: browser.storage is unreachable from the page world, so it arrives
  // over the same __bpf channel the clipboard uses.
  //
  // Defaults to OFF here rather than mirroring the panel's ON. A lost push then
  // degrades to this file's previous behaviour, which is a missing feature; the
  // other way round it would flip a flag the user had deliberately switched off.
  let unlinkNewEnabled = false;

  // Edge Preset capture state, pushed in over the same channel for the same
  // reason: which preset is armed lives in browser.storage, and which document
  // this editor has open is decided by the bridge's `describe-document` — one
  // implementation of that heuristic, reached over a channel, rather than a
  // second copy of it in this file.
  //
  // `{ id, name, templateId }` for the preset the Automation window has selected,
  // and `{ isTemplate, id, title }` for this document. Both null until pushed,
  // which correctly means "no capture offered".
  let edgeArmed = null;
  let edgeDoc = null;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || d.__bpf !== true || d.__config !== true) return;
    // Applied only where present, so the unlink flag and the edge state can be
    // pushed independently without either clobbering the other's value.
    if ("unlinkNew" in d) unlinkNewEnabled = !!d.unlinkNew;
    if ("edgeArmed" in d) edgeArmed = d.edgeArmed || null;
    if ("edgeDoc" in d) edgeDoc = d.edgeDoc || null;
  });

  // Honoured at commit, never at seed. Seeding isLinked into `working` looks like
  // the obvious place and is wrong: `isUnset` compares the staged value against
  // the control default, so a forced flag makes every row differ from its default
  // and `isOwnValue` then reports the whole family as set — the fade goes away and
  // the cascade preview stops working. Committing leaves all of that untouched.
  //
  // Only the flag moves; the values are whatever the user typed. So a row edited
  // with the link button still on keeps its four equal sides and simply arrives
  // unlinked.
  const withUnlinked = (container, settings) => {
    if (!unlinkNewEnabled) return settings;
    const controls = container?.settings?.controls || {};
    const out = {};
    for (const [key, value] of Object.entries(settings)) {
      out[key] =
        LINKED_TYPES.has(controls[key]?.type) &&
        value &&
        typeof value === "object"
          ? { ...value, isLinked: false }
          : value;
    }
    return out;
  };

  // ---------------------------------------------------------------- commit

  // The one place anything reaches the document. Wrapped in a history log, the
  // same way page-bridge.js groups a sync: a bare $e.run does NOT get its own
  // entry — measured on 4.2.1 it coalesces into whatever item is already open,
  // leaving the edit unundoable on its own. With the log it is exactly one
  // entry, titled. A null logId degrades to no grouping rather than failing.
  // A settings write updates the model and the preview, but NOT the input
  // already rendered in the panel: Elementor assumes the panel itself made any
  // change, so the on-screen control never re-reads. The edit then only appears
  // after selecting away and back, which re-renders the panel.
  //
  // Measured on 4.2.1, and the shape of it is counter-intuitive: writing
  // min_height across three breakpoints left the *visible* desktop input empty
  // while the hidden tablet and mobile rows updated themselves. So it is
  // specifically the row on screen that goes stale — which is exactly the one
  // being looked at, and why this reads as "nothing happened".
  //
  // The repair is to tell the affected views to re-read. Deliberately NOT
  // `options: { external: true }`, which is the other way to get this: external
  // re-renders the element, and re-rendering a live populated container is
  // exactly what made one disappear from the preview (see `rename` in
  // page-bridge.js). This touches the panel only.
  const refreshPanelControls = (keys) => {
    const page = getPanelPage();
    if (!page) return;
    const wanted = new Set(keys);
    page.children.each((view) => {
      const name = view.model?.get?.("name");
      if (!name || !wanted.has(name)) return;
      try {
        view.applySavedValue?.();
      } catch (_) {}
    });
  };

  const commitSettings = (container, settings, title) => {
    let logId = null;
    try {
      logId = $e.internal("document/history/start-log", {
        type: "change",
        title: title || HISTORY_TITLE,
      });
    } catch (_) {}
    try {
      // Every route to the document goes through here — Apply, paste-field and
      // paste-section — so this is also the one place the unlink option is
      // honoured, and the three cannot drift apart.
      const payload = withUnlinked(container, settings);
      $e.run("document/elements/settings", { container, settings: payload });
      refreshPanelControls(Object.keys(payload));
      return true;
    } catch (e) {
      window.console?.warn?.("[ElementorTools] breakpoint commit failed", e);
      return false;
    } finally {
      if (logId !== null && logId !== undefined) {
        try {
          $e.internal("document/history/end-log", { id: logId });
        } catch (_) {}
      }
    }
  };

  // ---------------------------------------------------------------- flyout

  let open = null;

  const closeFlyout = ({ commit } = { commit: false }) => {
    if (!open) return;
    const current = open;
    open = null;

    if (commit && current.dirty.size) {
      // Only keys the user actually touched. `working` holds a copy of every
      // key that was merely *read*, so committing all of it would rewrite
      // untouched breakpoints for no reason.
      const settings = {};
      for (const key of current.dirty) settings[key] = current.working[key];
      commitSettings(current.container, settings, HISTORY_TITLE);
    }

    for (const entry of current.entries) {
      try {
        entry.view?.destroy?.();
      } catch (_) {}
    }
    current.root.remove();
    current.row?.removeAttribute("data-bpf-open");
    document.removeEventListener("mousedown", current.onOutside, true);
    document.removeEventListener("keydown", current.onKey, true);
  };

  const place = (el, rect) => {
    const width = el.offsetWidth || 300;
    const height = el.offsetHeight || 320;
    let left = rect.right + 8;
    if (left + width > window.innerWidth - 8) {
      left = Math.max(8, rect.left - width - 8);
    }
    let top = rect.top - 8;
    if (top + height > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - height - 8);
    }
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  };

  const openFlyout = (baseView, row) => {
    const info = controlInfo(baseView);
    if (!info || !info.responsive) return null;

    closeFlyout({ commit: false });

    const { container, controls } = info;
    const settings = container.settings;

    // `working` is the staging buffer: one deep copy per key the flyout has
    // touched, seeded lazily on first read. `dirty` is which of those the user
    // actually changed. See the overrides below for why a copy is mandatory.
    const working = Object.create(null);
    const dirty = new Set();
    const entries = [];

    const root = document.createElement("div");
    root.className = FLYOUT_CLASS;

    const head = document.createElement("div");
    head.className = `${FLYOUT_CLASS}__head`;
    const heading = document.createElement("span");
    heading.textContent = info.label;
    const closeBtn = document.createElement("button");
    closeBtn.className = `${FLYOUT_CLASS}__close`;
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.title = "Discard and close";
    head.append(heading, closeBtn);

    const body = document.createElement("div");
    body.className = `${FLYOUT_CLASS}__body`;

    const foot = document.createElement("div");
    foot.className = `${FLYOUT_CLASS}__foot`;
    const count = document.createElement("span");
    count.className = `${FLYOUT_CLASS}__count`;
    const cancel = document.createElement("button");
    cancel.className = `${FLYOUT_CLASS}__btn`;
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const applyBtn = document.createElement("button");
    applyBtn.className = `${FLYOUT_CLASS}__btn ${FLYOUT_CLASS}__btn--primary`;
    applyBtn.type = "button";
    applyBtn.textContent = "Apply";
    applyBtn.disabled = true;
    foot.append(count, cancel, applyBtn);

    root.append(head, body, foot);
    document.body.appendChild(root);

    const rawValue = (key) =>
      key in working ? working[key] : settings.get(key);

    // A row whose value is a cascade preview rather than its own. Tracked
    // explicitly because the preview is a real value in `working` — without
    // this flag an inherited 340 is indistinguishable from a set 340, and the
    // row would un-fade and start being treated as its own value.
    const inheriting = new Set();

    const isOwnValue = (key) =>
      !inheriting.has(key) && !isUnset(controls, key, rawValue(key));

    // Elementor's responsive cascade: a breakpoint with no value of its own
    // renders with the nearest *wider* one that has a value. `entries` is
    // sorted widest-first, so that is a walk backwards from this row.
    const displayValue = (index) => {
      const self = entries[index];
      if (self && isOwnValue(self.key)) return rawValue(self.key);
      for (let i = index - 1; i >= 0; i--) {
        if (isOwnValue(entries[i].key)) return rawValue(entries[i].key);
      }
      return controls[self ? self.key : info.base]?.default;
    };

    // Editing a wider breakpoint has to move every narrower row that is still
    // inheriting, or the flyout shows a cascade that the document would not
    // produce. Guarded against re-entry: applySavedValue re-renders a control,
    // and a control that answers by writing back would loop.
    let cascading = false;
    const refreshCascade = () => {
      if (cascading) return;
      cascading = true;
      try {
        entries.forEach((entry, index) => {
          if (isOwnValue(entry.key)) return;
          const next = copyValue(displayValue(index));
          if (
            entry.key in working &&
            canon(working[entry.key]) === canon(next)
          ) {
            return;
          }
          working[entry.key] = next;
          inheriting.add(entry.key);
          try {
            entry.view?.applySavedValue?.();
          } catch (_) {}
        });
      } finally {
        cascading = false;
      }
    };

    // Faded means "no value of its own" — which is exactly `!isOwnValue`, not
    // "looks like the default". An inheriting row usually shows a non-default
    // number and must still read as unset.
    const refreshFade = () => {
      for (const entry of entries) {
        if (!entry.label) continue;
        entry.label.classList.toggle(
          `${FLYOUT_CLASS}__device--unset`,
          !isOwnValue(entry.key),
        );
      }
    };

    const refreshCount = () => {
      const n = dirty.size;
      count.textContent = n ? `${n} change${n === 1 ? "" : "s"}` : "No changes";
      applyBtn.disabled = n === 0;
      refreshCascade();
      refreshFade();
    };

    const ControlModel = baseView.model.constructor;

    info.entries.forEach(({ key, device }, index) => {
      const label = document.createElement("div");
      label.className = `${FLYOUT_CLASS}__device`;
      label.textContent = deviceLabel(device);
      body.appendChild(label);

      let view = null;
      try {
        const model = new ControlModel(Object.assign({}, controls[key]));
        const View = elementor.getControlView(controls[key].type);
        view = new View({
          model,
          container,
          elementSettingsModel: baseView.options.elementSettingsModel,
          elementEditSettings: baseView.options.elementEditSettings,
          element: baseView.options.element,
        });

        // These two per-instance overrides are the whole staging mechanism.
        // Elementor's own view code is untouched.
        //
        // The copy in getControlValue is not a nicety, it is the entire reason
        // staging works. Compound controls (dimensions is the clear case) do
        // not write through `setSettingsModel` or even `settings.set` — they
        // take the object `getControlValue` returns and mutate it in place.
        // Hand back the live object out of the model and those keystrokes edit
        // the document directly: no set() call, no $e command, no history
        // entry, and nothing for Cancel to undo. Verified on 4.2.1 — a
        // dimensions control moved a container's border width with `set`
        // stubbed out entirely and the history stack untouched.
        //
        // The copy must be *stable*, not fresh per call: a control that mutates
        // then re-reads has to see its own edit.
        //
        // Seeding also resolves the cascade: a breakpoint with no value of its
        // own is shown holding the nearest wider one's value, the same as the
        // document renders it. `inheriting` remembers that the number on screen
        // is a preview, so it still reads as unset and is never committed.
        view.getControlValue = (sub) => {
          if (!(key in working)) {
            const own = settings.get(key);
            if (isUnset(controls, key, own)) {
              working[key] = copyValue(displayValue(index));
              inheriting.add(key);
            } else {
              working[key] = copyValue(own);
            }
          }
          const value = working[key];
          return sub ? value?.[sub] : value;
        };
        view.setSettingsModel = (value) => {
          working[key] = value;
          // Touching an inheriting row is what gives it a value of its own.
          inheriting.delete(key);
          dirty.add(key);
          refreshCount();
        };

        // Appended before render so controls that measure themselves during
        // init (sliders, dimension groups) do it while in the document.
        body.appendChild(view.el);
        view.render();
        view.el.classList.remove("elementor-hidden-control");
        entries.push({ key, device, view, label });
      } catch (_) {
        try {
          view?.destroy?.();
        } catch (_) {}
        const err = document.createElement("div");
        err.className = `${FLYOUT_CLASS}__err`;
        err.textContent = `${deviceLabel(device)}: could not render (${key})`;
        body.appendChild(err);
      }
    });

    refreshCount();

    const onOutside = (e) => {
      if (root.contains(e.target) || row.contains(e.target)) return;
      if (e.target.closest?.(`.${MENU_CLASS}`)) return;
      closeFlyout({ commit: false });
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeFlyout({ commit: false });
      }
    };

    closeBtn.addEventListener("click", () => closeFlyout({ commit: false }));
    cancel.addEventListener("click", () => closeFlyout({ commit: false }));
    applyBtn.addEventListener("click", () => closeFlyout({ commit: true }));
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);

    row.setAttribute("data-bpf-open", "1");

    open = {
      root,
      entries,
      working,
      dirty,
      container,
      row,
      info,
      anchor: baseView.el,
      onOutside,
      onKey,
    };
    place(root, row.getBoundingClientRect());
    return open;
  };

  // ----------------------------------------------------------- copy/paste

  // Read staged values when the flyout is open on this very field, so copying
  // after editing copies what is on screen rather than what is still saved.
  const readValues = (info, row) => {
    const staged = open && open.row === row ? open.working : null;
    const values = {};
    for (const { key, device } of info.entries) {
      values[device] =
        staged && key in staged
          ? copyValue(staged[key])
          : copyValue(info.container.settings.get(key));
    }
    return values;
  };

  // A section is copied whole — every key it owns, defaults included — because
  // paste is defined as making the target one-to-one with the source. Copying
  // only the keys that happen to be set would leave the target's own extras
  // behind and the two would not match. Same reasoning as animation presets,
  // where Apply means the tab now equals the preset.
  const sectionValues = (info) => {
    const values = {};
    for (const key of info.keys) {
      values[key] = copyValue(info.container.settings.get(key));
    }
    return values;
  };

  const doCopy = async (info, row) => {
    const payload =
      info.scope === "section"
        ? {
            kind: PAYLOAD_KIND,
            v: 1,
            scope: "section",
            section: info.section,
            label: info.label,
            values: sectionValues(info),
          }
        : {
            kind: PAYLOAD_KIND,
            v: 1,
            scope: "field",
            control: info.base,
            label: info.label,
            type: info.type,
            responsive: info.responsive,
            values: readValues(info, row),
          };
    const json = JSON.stringify(payload, null, 2);
    // Best effort, and genuinely optional: storage is what paste reads. This
    // only exists so the payload can be inspected, saved or hand-edited.
    try {
      await navigator.clipboard?.writeText?.(json);
    } catch (_) {}
    const res = await askContentScript("copy", payload);
    if (!res.ok) return { ok: false, error: res.error || "Copy failed" };
    const n = Object.keys(payload.values).length;
    if (info.scope === "section") {
      return { ok: true, note: `Copied section (${n} fields)` };
    }
    return {
      ok: true,
      note: info.responsive ? `Copied ${n} breakpoints` : "Copied value",
    };
  };

  const doPaste = async (info, row) => {
    const res = await askContentScript("paste");
    if (!res.ok) return { ok: false, error: res.error || "Paste failed" };
    const payload = res.data;
    if (!payload || payload.kind !== PAYLOAD_KIND) {
      return { ok: false, error: "Nothing copied yet" };
    }
    const payloadScope = payload.scope || "field";
    if (payloadScope !== info.scope) {
      return {
        ok: false,
        error: `That is a ${payloadScope} copy`,
      };
    }

    if (info.scope === "section") {
      // Only the same section, by name. A section's keys are meaningful only
      // within it, so there is no cross-section mapping to attempt the way
      // there is between two fields of one type.
      if (payload.section !== info.section) {
        return {
          ok: false,
          error: `Different section: ${payload.label} → ${info.label}`,
        };
      }
      const settings = {};
      for (const [key, value] of Object.entries(payload.values)) {
        // The target decides what exists. A source from a build with extra
        // controls must not write keys this element has no control for.
        if (info.controls[key]) settings[key] = copyValue(value);
      }
      const total = Object.keys(settings).length;
      if (!total) return { ok: false, error: "Nothing to paste" };
      if (open) closeFlyout({ commit: false });
      if (!commitSettings(info.container, settings, "Paste section")) {
        return { ok: false, error: "Could not write the section" };
      }
      return { ok: true, note: `Pasted ${total} fields` };
    }

    // Same-name fields of different types exist all over Elementor, and the
    // value shapes are not interchangeable — a slider object written into a
    // select is silently meaningless. Refusing is the only honest answer.
    if (payload.type !== info.type) {
      return {
        ok: false,
        error: `Type mismatch: ${payload.type} → ${info.type}`,
      };
    }

    // Map by DEVICE, never by key: the whole point is pasting between two
    // different fields, whose key names differ. "base" and "desktop" are
    // interchangeable so a non-responsive field and a responsive one can trade
    // values in either direction.
    const pick = (device) => {
      if (device in payload.values) return payload.values[device];
      if (device === "desktop" && "base" in payload.values) {
        return payload.values.base;
      }
      if (device === "base" && "desktop" in payload.values) {
        return payload.values.desktop;
      }
      return undefined;
    };

    // Paste commits straight away — no staging, no Apply. Responsive and
    // non-responsive are the same operation once the family is a list of
    // (key, device): build the settings object, write it in one command.
    const settings = {};
    for (const { key, device } of info.entries) {
      const value = pick(device);
      if (value !== undefined) settings[key] = copyValue(value);
    }
    const count = Object.keys(settings).length;
    if (!count) return { ok: false, error: "No matching breakpoints" };

    // A flyout open on this very field is holding a staging buffer that is now
    // stale, and its Apply would clobber the paste. Discard it first.
    if (open && open.row === row) closeFlyout({ commit: false });

    if (!commitSettings(info.container, settings, "Paste breakpoints")) {
      return { ok: false, error: "Could not write the value" };
    }
    return {
      ok: true,
      note: info.responsive ? `Pasted ${count} breakpoints` : "Pasted",
    };
  };

  // ---------------------------------------------------------- edge capture

  // Where this element sits, as the address an Edge Preset stores: which of the
  // template's roots it is under (1-based, matching the tag and how every tool
  // here labels roots) and the child-index path from that root down to it.
  //
  // Walks upward rather than searching down, because the element is the one the
  // user right-clicked. It stops at the document container, whose direct children
  // ARE the template's roots — which is the whole reason capture is restricted to
  // a template's own editor: there is no tag to consult and none is needed.
  //
  // Parents are compared by id, never by identity: `children` hands back fresh
  // wrappers, the same reason indexInParent in page-bridge.js falls back to an id
  // match.
  const edgeAddress = (container) => {
    const root = window.elementor?.getPreviewContainer?.();
    if (!root?.id) return { error: "cannot read the document root" };

    const indexIn = (child, parent) => {
      const kids = parent?.children;
      const list = Array.isArray(kids)
        ? kids
        : kids && typeof kids.length === "number"
          ? Array.from(kids)
          : [];
      return list.findIndex((c) => c && c.id === child.id);
    };

    const path = [];
    let cursor = container;
    let guard = 0;
    while (cursor?.parent && cursor.parent.id !== root.id && guard++ < 64) {
      const at = indexIn(cursor, cursor.parent);
      if (at < 0) return { error: "lost track of the element's position" };
      path.unshift(at);
      cursor = cursor.parent;
    }
    if (!cursor?.parent || cursor.parent.id !== root.id) {
      return { error: "this element is not inside one of the template's roots" };
    }
    const rootAt = indexIn(cursor, root);
    if (rootAt < 0) return { error: "cannot place the template root" };

    return {
      root: rootAt + 1,
      path,
      elType: container.model?.get?.("elType") || null,
      widgetType: container.model?.get?.("widgetType") || null,
      label: container.settings?.get?.("_title") || "",
    };
  };

  // Keyed by control KEY rather than by device — see edge-preset-format.js for
  // why the preset format departs from the clipboard payload there. Staged values
  // win while the flyout is open on this row, so capturing after editing captures
  // what is on screen, exactly as copy does.
  const edgeFieldValues = (info, row) => {
    const staged = open && open.row === row ? open.working : null;
    const values = {};
    for (const { key } of info.entries) {
      values[key] =
        staged && key in staged
          ? copyValue(staged[key])
          : copyValue(info.container.settings.get(key));
    }
    return values;
  };

  const doCapture = async (info, row) => {
    if (!edgeArmed) return { ok: false, error: "No edge preset selected" };
    if (!edgeDoc?.isTemplate) {
      return { ok: false, error: "Open the template's own editor to capture" };
    }
    if (
      edgeArmed.templateId &&
      String(edgeArmed.templateId) !== String(edgeDoc.id)
    ) {
      return {
        ok: false,
        error: `"${edgeArmed.name}" is bound to template #${edgeArmed.templateId}`,
      };
    }
    // Asked here and now rather than pushed in with the config: it changes on
    // every keystroke. A snapshot taken from an unsaved template is a preset that
    // silently disagrees with the template it names — and under a snapshot format
    // there is nothing downstream that could ever notice.
    if (window.elementor?.saver?.isEditorChanged?.() !== false) {
      return {
        ok: false,
        error: "Unsaved changes — update the template first",
      };
    }

    const address = edgeAddress(info.container);
    if (address.error) return { ok: false, error: address.error };

    const field =
      info.scope === "section"
        ? {
            scope: "section",
            section: info.section,
            label: info.label,
            values: sectionValues(info),
          }
        : {
            scope: "field",
            control: info.base,
            label: info.label,
            type: info.type,
            responsive: info.responsive,
            values: edgeFieldValues(info, row),
          };

    const res = await askContentScript("edge-capture", {
      presetId: edgeArmed.id,
      templateId: edgeDoc.id,
      templateTitle: edgeDoc.title || "",
      ...address,
      field,
    });
    if (!res.ok) return { ok: false, error: res.error || "Capture failed" };
    return { ok: true, note: res.note };
  };

  // ------------------------------------------------------------------ menu

  let menu = null;

  const closeMenu = () => {
    if (!menu) return;
    menu.root.remove();
    document.removeEventListener("mousedown", menu.onOutside, true);
    document.removeEventListener("keydown", menu.onKey, true);
    menu = null;
  };

  const showMenu = (x, y, info, row) => {
    closeMenu();

    const root = document.createElement("div");
    root.className = MENU_CLASS;

    const label = document.createElement("div");
    label.className = `${MENU_CLASS}__label`;
    label.textContent =
      info.scope === "section"
        ? `${info.label} · section, ${info.keys.length} fields`
        : info.responsive
          ? `${info.label} · ${info.entries.length} breakpoints`
          : info.label;
    root.appendChild(label);

    const note = document.createElement("div");
    note.className = `${MENU_CLASS}__note`;

    const item = (text, run) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `${MENU_CLASS}__item`;
      btn.textContent = text;
      btn.addEventListener("click", async () => {
        const result = await run();
        if (result?.ok) {
          closeMenu();
          return;
        }
        note.textContent = result?.error || "Failed";
        note.classList.add(`${MENU_CLASS}__note--err`);
        if (!note.isConnected) root.appendChild(note);
      });
      root.appendChild(btn);
    };

    const copyText =
      info.scope === "section"
        ? "Copy whole section"
        : info.responsive
          ? "Copy all breakpoints"
          : "Copy value";
    const pasteText =
      info.scope === "section"
        ? "Paste whole section"
        : info.responsive
          ? "Paste breakpoints"
          : "Paste value";

    item(copyText, () => doCopy(info, row));
    item(pasteText, () => doPaste(info, row));

    // Offered whenever a preset is armed. Every other condition — right editor,
    // right template, template saved — is reported on click rather than by
    // hiding the item, so a refusal explains itself instead of leaving the user
    // wondering where Capture went.
    if (edgeArmed) {
      item(`Capture into "${edgeArmed.name}"`, () => doCapture(info, row));
    }

    document.body.appendChild(root);
    place(root, new DOMRect(x, y, 0, 0));

    const onOutside = (e) => {
      if (!root.contains(e.target)) closeMenu();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeMenu();
      }
    };
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
    menu = { root, onOutside, onKey };
  };

  // ------------------------------------------------------------------ rows

  // Rows are only *marked*, never given a button or their own listener. The
  // classes are what the cursor styling keys on and what the delegated
  // handlers hit-test, so a panel re-render costs one class write per row
  // instead of rebuilding listeners.
  const markRows = () => {
    const page = getPanelPage();
    if (!page) return;

    page.children.each((view) => {
      const el = view.el;
      if (!el || el.classList.contains(ANY_CLASS)) return;
      const name = view.model?.get?.("name");
      const controls = view.options?.container?.settings?.controls;
      if (!name || !controls || !controls[name]) return;

      // A section header gets the right-click menu (copy/paste the whole
      // section) but never ROW_CLASS: it has no value of its own to expand,
      // and left-click belongs to Elementor for collapse/expand.
      if (controls[name].type === "section") {
        el.classList.add(ANY_CLASS);
        return;
      }

      el.classList.add(ANY_CLASS);
      const base = resolveBase(controls, name);
      if (buildFamily(controls, base).length > 1) el.classList.add(ROW_CLASS);
    });
  };

  // One delegated listener each rather than one per row, so there is nothing
  // to re-attach when Elementor re-renders. Bubble phase, not capture: a
  // control that stops propagation handled the click itself, and this must not
  // pre-empt it.
  document.addEventListener("click", (e) => {
    const row = e.target.closest?.(`.${ROW_CLASS}`);
    if (!row || e.target.closest(PASSTHROUGH)) return;
    const view = viewForRow(row);
    if (!view) return;
    e.preventDefault();
    e.stopPropagation();
    closeMenu();
    if (open && open.row === row) closeFlyout({ commit: false });
    else openFlyout(view, row);
  });

  document.addEventListener("contextmenu", (e) => {
    const row = e.target.closest?.(`.${ANY_CLASS}`);
    if (!row || e.target.closest(NATIVE_MENU)) return;
    const view = viewForRow(row);
    if (!view) return;
    const info = infoForView(view);
    if (!info) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, info, row);
  });

  let rafPending = false;
  const schedule = () => {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      // An open flyout is anchored to a row that a panel re-render replaces.
      // Nothing is staged into the document, so dropping it is a clean discard.
      if (open && !document.contains(open.anchor)) {
        closeFlyout({ commit: false });
      }
      if (menu && !document.contains(menu.root)) closeMenu();
      markRows();
    });
  };

  const start = () => {
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
    schedule();
  };

  if (window.elementor?.on) {
    if (elementor.panel) start();
    else elementor.on("panel:init", start);
    // panel:init does not fire if the panel was already up when we loaded.
    setTimeout(start, 1500);
  } else {
    const wait = setInterval(() => {
      if (window.elementor?.getPanelView) {
        clearInterval(wait);
        start();
      }
    }, 300);
    setTimeout(() => clearInterval(wait), 30000);
  }
})();
