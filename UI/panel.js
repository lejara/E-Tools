const EMPTY_TEXT = "No layer selected";
// Mirrors DEFAULT_SKIP_WORD in Tools/core_utils.js — the panel does not load
// content scripts, so the default is stated in both places. Keep them in sync.
const DEFAULT_SKIP_WORD = "skip";
// Mirrors DEFAULT_PURE_CONTAINER_RESET in Tools/pure-container-reset.js, for the
// same reason as the skip word above. On by default: zeroing a fresh container's
// box is the whole point of the option, and a stored `undefined` means the user
// has never touched it rather than having turned it off.
const DEFAULT_PURE_CONTAINER_RESET = true;
// Mirrors DEFAULT_UNLINK_NEW_ELEMENTS in Tools/pure-container-reset.js. On by
// default for the same reason: the option exists because the linked default is
// the wrong one to start from, so shipping it off would be shipping it unused.
const DEFAULT_UNLINK_NEW_ELEMENTS = true;
const titleEl = document.getElementById("title");
const metaEl = document.getElementById("meta");
const clearBtn = document.getElementById("clear");
const logsEl = document.getElementById("logs");
const clearLogsBtn = document.getElementById("clear-logs");
const replaceChildrenEl = document.getElementById("opt-replace-children");
const overlayEl = document.getElementById("opt-overlay");
const overlayFroggyEl = document.getElementById("opt-overlay-froggy");
const pureContainerResetEl = document.getElementById(
  "opt-pure-container-reset",
);
const unlinkNewEl = document.getElementById("opt-unlink-new");
const skipWordEl = document.getElementById("opt-skip-word");
const workingDomainEl = document.getElementById("opt-working-domain");
const contentEl = document.getElementById("content");
const contentSearchEl = document.getElementById("content-search");
const contentStatusEl = document.getElementById("content-status");
const contentTabsEl = document.getElementById("content-tabs");
const refreshContentBtn = document.getElementById("refresh-content");
const scanUsageBtn = document.getElementById("scan-usage");
const presetsEl = document.getElementById("presets");
const presetStatusEl = document.getElementById("preset-status");
const presetNewBtn = document.getElementById("preset-new");
const presetImportBtn = document.getElementById("preset-import");
const presetFileEl = document.getElementById("preset-file");
const presetDelayEl = document.getElementById("preset-delay");
const hotkeysEl = document.getElementById("hotkeys");
const resetAllHotkeysBtn = document.getElementById("reset-all-hotkeys");
const hotkeyErrorEl = document.getElementById("hotkey-error");

const { ACTIONS, formatBinding, bindingKey, mergeWithDefaults } =
  window.__ElementorHotkeyDefaults;

const {
  metaLine,
  postMetaLine,
  statusLabel,
  searchTerms,
  matchesTerms,
  elementorEditUrl,
  contentViewUrl,
  parseWorkingDomain,
  wpAdminEditUrl,
  USAGE_INDEX_VERSION,
  buildUsageIndex,
} = window.__ElementorTemplateFormat;

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
  browser.storage.local.set({
    replaceChildrenStyles: replaceChildrenEl.checked,
  });
});

overlayEl.addEventListener("change", () => {
  browser.storage.local.set({ overlayEnabled: overlayEl.checked });
});

overlayFroggyEl.addEventListener("change", () => {
  browser.storage.local.set({ overlayFroggy: overlayFroggyEl.checked });
});

pureContainerResetEl.addEventListener("change", () => {
  browser.storage.local.set({
    pureContainerReset: pureContainerResetEl.checked,
  });
});

unlinkNewEl.addEventListener("change", () => {
  browser.storage.local.set({ unlinkNewElements: unlinkNewEl.checked });
});

skipWordEl.addEventListener("change", () => {
  browser.storage.local.set({ skipWord: skipWordEl.value.trim() });
});

workingDomainEl.addEventListener("change", () => {
  browser.storage.local.set({ workingDomain: workingDomainEl.value.trim() });
});

let workingDomain = "";

// One tab at a time, and each tab owns its own request, rows, error and
// warnings. That separation is the whole speed story: Refresh re-fetches the
// tab you are looking at and nothing else, and a tab you have never opened
// costs nothing at all.
//
// `rows: null` means "never loaded", which is a different thing from an empty
// array — the list says "Not loaded" for the first and "nothing here" for the
// second.
const ALL_KINDS = ["template", "page", "other"];
// Two vocabularies on purpose: TAB_LABELS reads as a noun inside a sentence
// ("Fetching pages…", "Search posts…"), TAB_TITLES matches the tab caption
// exactly, which is what the Refresh button has to echo.
const TAB_LABELS = { template: "templates", page: "pages", other: "posts" };
const TAB_TITLES = { template: "Templates", page: "Pages", other: "Other" };
const tabState = Object.fromEntries(
  ALL_KINDS.map((kind) => [
    kind,
    { rows: null, error: null, warnings: [], loading: false, via: null },
  ]),
);
let activeTab = "template";

// Each tab is one message. Pages and Other split the post types between them
// rather than both pulling the lot — fetching every CPT to render the Pages tab
// was the bulk of what made a refresh slow.
const TAB_REQUESTS = {
  template: { type: "list-templates" },
  page: { type: "list-posts", options: { include: ["page"] } },
  other: { type: "list-posts", options: { exclude: ["page"] } },
};

// The panel window has no page bridge — it cannot reach the authenticated
// template endpoint itself, so it asks a tab that can. Returns { tab, reply } —
// the responding tab matters for run-action, which has to bring the editor
// forward so the tool's own modal is visible.
//
// Two kinds of tab answer. An editor tab answers everything (core_utils.js and
// hotkeys.js); a plain wp-admin tab answers list-templates
// (Tools/admin-templates.js) and list-posts (Tools/wp-pages.js, which also runs
// in the editor) but stays silent on run-action, so an editor-only message
// simply falls through to the next candidate.
const askElementorTab = async (message, { preferOrigin = "" } = {}) => {
  const tabs = await browser.tabs.query({});
  const urlOf = (t) => t.url || "";
  // tab.url is only populated where the extension holds host permission for
  // that tab; fall back to broadcasting rather than assuming it is there.
  const editors = tabs.filter((t) => urlOf(t).includes("action=elementor"));
  const admins = tabs.filter(
    (t) => !editors.includes(t) && urlOf(t).includes("/wp-admin/"),
  );
  // One ranking across both kinds of tab, not editors-as-a-block followed by
  // admins-as-a-block. Grouping first meant a background editor on any site
  // outranked the wp-admin tab in front of the user, so list-templates went
  // down the editor's page-bridge path while list-posts — which wp-pages.js
  // answers in either tab — went to the admin one. Same panel, two sources,
  // and only one of them failing.
  //
  //   origin  the Working Domain names the site being asked about, so another
  //           client's tab must never answer for it
  //   active  the tab in front of the user, which is the one they mean
  //   editor  a tiebreak only: it can service every message, including
  //           run-action, which an admin tab declines
  //
  // Ranking editor below active costs one declined message before run-action
  // finds its tab, and buys the panel agreeing with what is on screen.
  const matchesOrigin = (t) =>
    !!preferOrigin && urlOf(t).startsWith(`${preferOrigin}/`);
  const score = (t) =>
    (matchesOrigin(t) ? 4 : 0) +
    (t.active ? 2 : 0) +
    (editors.includes(t) ? 1 : 0);
  const known = [...editors, ...admins];
  const candidates = (known.length ? known : tabs.slice()).sort(
    (a, b) => score(b) - score(a),
  );
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

// ---- Template usage index ---------------------------------------------------
// "Where is this template used?", answered by the template tag: every layer the
// tools create carries "#<templateId>" in its name, so the question is which
// documents hold a layer tagged for a given template. Tools/template-index.js
// does the walking; template-format.js owns the tag rule and the grouping; this
// holds the cache and the dropdown.
//
// It has its OWN scan button rather than riding Refresh Templates, because the
// two cost wildly different things. Refresh is one call to Elementor's library
// endpoint; a usage scan has to read every document's `_elementor_data`, since a
// layer name is not something any listing endpoint returns. Folding that into
// Refresh would make the list that is already fast feel broken.
const USAGE_CACHE_KEY = "templateUsageIndex";
// How many documents' content are asked for per message. The content script
// batches internally too; this outer chunk exists only so the status line can
// move — one message covering 400 documents would sit silent for minutes and
// read as a hang. Same reasoning as the component command centre.
const USAGE_READ_CHUNK = 30;
// The key the orphan block's open/closed state is stored under. It is not a
// template id, and a real one can never collide with it.
const ORPHAN_KEY = "__orphans";

let usageCache = null; // { version, origin, scannedAt, templateIds, docs: { id: doc } }
let usageIndex = null; // buildUsageIndex output, or null until a scan has landed
let usageScanning = false;
let usageScanStatus = "";
let usageError = null;
// Which rows are expanded. Kept across re-renders and tab switches — collapsing
// everything because the search box was typed into would be its own annoyance.
const usageOpen = new Set();

const rebuildUsageIndex = () => {
  usageIndex = usageCache
    ? buildUsageIndex(Object.values(usageCache.docs || {}), {
        templateIds: usageCache.templateIds || [],
      })
    : null;
};

const usageRowsFor = (item) =>
  usageIndex ? usageIndex.byTemplate[String(item.id)] || [] : null;

// A cache from another site describes nothing about this one, and a cache from
// an older build describes it in a shape this code does not read. Both are
// discarded rather than repaired — re-earning one costs a single Scan.
const usableUsageCache = (cache, origin) =>
  cache &&
  cache.version === USAGE_INDEX_VERSION &&
  (!origin || cache.origin === origin)
    ? cache
    : null;

const scanUsage = async () => {
  if (usageScanning) return;
  usageScanning = true;
  usageError = null;
  usageScanStatus = "Asking a WordPress tab for the document list…";
  scanUsageBtn.disabled = true;
  scanUsageBtn.textContent = "Scanning…";
  renderContent();

  const preferOrigin = parseWorkingDomain(workingDomain)?.origin || "";
  try {
    const { tab, reply } = await askElementorTab(
      { __elementorTools: true, type: "usage-list-docs" },
      { preferOrigin },
    );
    if (!reply) throw new Error(NO_TAB);
    if (!reply.ok) throw new Error(reply.error);

    const docs = reply.docs || [];
    const origin = reply.origin || "";
    const reusable = usableUsageCache(usageCache, origin)?.docs || {};

    // Two stamps per document, and the split is load-bearing:
    //
    //   modifiedGmt  what the document says right now
    //   indexedGmt   what it said the last time its content was successfully READ
    //
    // One field cannot do both. Stamping the fresh value against a document
    // whose read FAILED would make the next scan consider it up to date and
    // never retry it — its usages would silently vanish and stay gone, which is
    // the worst failure this cache could have.
    const next = {};
    const stale = [];
    for (const doc of docs) {
      const prev = reusable[doc.id];
      if (prev && prev.indexedGmt && prev.indexedGmt === doc.modifiedGmt) {
        // Unchanged content, but take the freshly-listed metadata: a retitled or
        // republished document has the same layers and a different label.
        next[doc.id] = {
          ...doc,
          usages: prev.usages || [],
          indexedGmt: prev.indexedGmt,
        };
      } else {
        next[doc.id] = { ...doc, usages: [], indexedGmt: null };
        stale.push(doc);
      }
    }

    const kept = docs.length - stale.length;
    const warnings = [...(reply.warnings || [])];

    for (let i = 0; i < stale.length; i += USAGE_READ_CHUNK) {
      const slice = stale.slice(i, i + USAGE_READ_CHUNK);
      usageScanStatus =
        `Reading document ${i + 1}–${Math.min(i + USAGE_READ_CHUNK, stale.length)} ` +
        `of ${stale.length}${kept ? ` (${kept} unchanged)` : ""}…`;
      renderContent();

      const res = await browser.tabs
        .sendMessage(tab.id, {
          __elementorTools: true,
          type: "usage-read-docs",
          options: {
            targets: slice.map((d) => ({
              id: d.id,
              restBase: d.restBase,
              isTemplate: d.isTemplate,
            })),
          },
        })
        .catch((err) => ({ ok: false, error: String(err?.message || err) }));

      if (!res?.ok) {
        // Keep whatever landed rather than throwing the run away — a half-built
        // index still answers most questions, and the status line says it is
        // partial.
        warnings.push(`batch at ${i + 1}: ${res?.error}`);
        continue;
      }
      warnings.push(...(res.warnings || []));
      for (const [id, found] of Object.entries(res.results || {})) {
        if (!next[id]) continue;
        if (found.error) {
          warnings.push(`document ${id}: ${found.error}`);
          continue;
        }
        // indexedGmt is stamped ONLY here, on the success path. Anything that did
        // not reach this line stays unindexed and is retried next scan.
        next[id] = {
          ...next[id],
          usages: found.usages || [],
          indexedGmt: next[id].modifiedGmt,
        };
      }
    }

    usageCache = {
      version: USAGE_INDEX_VERSION,
      origin,
      scannedAt: Date.now(),
      templateIds: reply.templateIds || [],
      docs: next,
      warnings,
    };
    rebuildUsageIndex();
    await browser.storage.local.set({ [USAGE_CACHE_KEY]: usageCache });
  } catch (err) {
    usageError = err?.message || String(err);
  } finally {
    usageScanning = false;
    usageScanStatus = "";
    scanUsageBtn.disabled = false;
    scanUsageBtn.textContent = "Scan Usage";
    renderContent();
  }
};

// A template and a post arrive in two different shapes from two endpoints.
// This is the one place either becomes a row, so everything downstream —
// search, sort, the two buttons — sees a single kind of thing.
const asRow = (raw, kind) =>
  kind === "template"
    ? {
        kind,
        id: raw.templateId,
        title: raw.title,
        type: raw.type || "",
        sub: metaLine(raw),
        // A library template is Elementor by definition, so the badge would be
        // noise on every row of this tab.
        elementor: true,
        badge: false,
        // elementor_library is not a viewable *post type*, but the library
        // endpoint still hands back each template's own permalink
        // ("/?elementor_library=<slug>"), which renders. So View works here —
        // it just cannot be built from the id the way a post's preview is.
        viewable: !!raw.url,
        status: raw.status || "",
        link: raw.url || "",
        extra: raw.author || "",
      }
    : {
        kind,
        id: raw.id,
        title: raw.title,
        type: raw.typeLabel || raw.typeSlug || "",
        sub: postMetaLine(raw),
        elementor: raw.elementor,
        badge: raw.elementor === true,
        docType: raw.docType,
        viewable: raw.viewable,
        status: raw.status,
        link: raw.link,
        // Searchable but not shown: the raw type slug, the status, and the word
        // "elementor" so the badge can be searched for like any other text.
        extra: [
          raw.typeSlug,
          raw.status,
          raw.elementor ? "elementor" : "",
          raw.docType,
        ]
          .filter(Boolean)
          .join(" "),
      };

const activeItems = () => {
  const { rows } = tabState[activeTab];
  if (!rows) return null;
  return rows
    .map((raw) => asRow(raw, activeTab))
    .sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
};

// What the usage index has to say about itself, for the Templates tab's status
// line. Never called for the other tabs: usage is a template-shaped question.
const usageStatusBits = () => {
  if (usageError) return [`usage scan failed — ${usageError}`];
  if (!usageIndex) return ["Scan Usage to find where each template is used"];
  const bits = [
    `${usageIndex.total} tagged layer(s) in ${usageIndex.docCount} document(s)`,
  ];
  // An orphan is a tag naming a template that no longer exists, so it belongs in
  // the status line whether or not the block below it is expanded.
  if (usageIndex.orphans.length) {
    bits.push(`${usageIndex.orphans.length} pointing at a missing template`);
  }
  const stamp = usageCache?.scannedAt;
  if (stamp) bits.push(`scanned ${formatTime(stamp)}`);
  if (usageCache?.warnings?.length) {
    bits.push(`${usageCache.warnings.length} scan warning(s)`);
  }
  return bits;
};

const renderContentStatus = (shown, total) => {
  const state = tabState[activeTab];
  // A scan in progress owns the line outright: it is the thing that is moving,
  // and the row count underneath it has not changed.
  if (usageScanning && activeTab === "template") {
    contentStatusEl.classList.remove("error");
    contentStatusEl.textContent = usageScanStatus;
    return;
  }
  contentStatusEl.classList.toggle("error", !!state.error && !state.loading);
  if (state.loading) {
    contentStatusEl.textContent = `Fetching ${TAB_LABELS[activeTab]}…`;
    return;
  }
  if (!state.rows) {
    contentStatusEl.textContent = state.error || "";
    return;
  }
  // A failed refresh still lists what was there before; the failure goes in the
  // status line rather than replacing a perfectly good list with an error.
  const bits = [`${shown} of ${total} shown`];
  if (state.via) bits.push(`via ${state.via}`);
  if (!workingDomain) bits.push("set a Working Domain to enable Edit");
  if (state.error) bits.push(state.error);
  if (activeTab === "template") bits.push(...usageStatusBits());
  contentStatusEl.textContent = [...bits, ...state.warnings].join(" · ");
};

const setContentMessage = (text) => {
  contentEl.replaceChildren(
    Object.assign(document.createElement("div"), {
      className: "empty",
      textContent: text,
    }),
  );
};

// Which editor a row opens is the one place the Elementor flag changes what the
// panel does rather than what it says. Unknown falls to WordPress deliberately:
// post.php?action=elementor works on a post Elementor never built, quietly
// converting it, so guessing wrong in that direction edits the document.
const editTarget = (item) => {
  if (item.kind === "template" || item.elementor === true) {
    return {
      url: elementorEditUrl(workingDomain, item.id),
      hint: "Edit in Elementor",
    };
  }
  return {
    url: wpAdminEditUrl(workingDomain, item.id),
    hint:
      item.elementor === null
        ? "Elementor status unknown for this post type — opens the WordPress editor"
        : "Edit in WordPress",
  };
};

const linkButton = (label, url, { hint, disabledHint }) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "edit";
  btn.textContent = label;
  btn.disabled = !url;
  btn.title = url ? `${hint} — ${url}` : disabledHint;
  btn.addEventListener("click", () => {
    if (url) openInNewTab(url);
  });
  return btn;
};

const renderTabs = () => {
  // Refresh only ever re-fetches the active tab, so it says which one.
  refreshContentBtn.textContent = `Refresh ${TAB_TITLES[activeTab]}`;
  // The usage index answers a template-shaped question, so the button that
  // builds it is only offered where its result is readable. Hidden rather than
  // disabled: a permanently dead button on two of three tabs reads as broken.
  scanUsageBtn.hidden = activeTab !== "template";
  for (const btn of contentTabsEl.querySelectorAll(".tab")) {
    const kind = btn.dataset.kind;
    btn.setAttribute("aria-selected", kind === activeTab ? "true" : "false");
    // A loaded tab keeps its count visible while you are on another one, so the
    // shape of the site is readable without clicking through.
    const { rows, loading } = tabState[kind];
    const badge = loading ? "…" : rows ? String(rows.length) : "";
    let count = btn.querySelector(".count");
    if (!badge) {
      count?.remove();
    } else {
      if (!count) {
        count = document.createElement("span");
        count.className = "count";
        btn.append(count);
      }
      count.textContent = badge;
    }
  }
};

// The count doubles as the disclosure control, so the number being read is the
// thing being clicked. Zero stays on screen and goes quiet: "nothing uses this"
// is an answer worth having, and hiding the pill would make an unused template
// indistinguishable from one the scan never covered.
const usesToggle = (item, uses) => {
  const key = String(item.id);
  const open = usageOpen.has(key);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "uses-toggle";
  btn.textContent = uses.length ? `${open ? "▾" : "▸"} ${uses.length}` : "0";
  btn.disabled = !uses.length;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.title = uses.length
    ? `${uses.length} tagged layer(s) reference this template`
    : "No tagged layer references this template — nothing on the site uses it, " +
      "or a layer was renamed without keeping its #id tag";
  btn.addEventListener("click", () => {
    if (open) usageOpen.delete(key);
    else usageOpen.add(key);
    renderContent();
  });
  return btn;
};

// One usage: which document holds the tagged layer, and what the layer is
// called. The document is the answer to "where", so it leads; the layer name is
// how you find it once you are in there.
const usageRow = (use) => {
  const el = document.createElement("div");
  el.className = "usage";

  const text = document.createElement("div");
  text.className = "text";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = use.docTitle || `(untitled #${use.docId})`;
  text.append(name);

  const bits = [use.typeLabel, statusLabel(use.status)].filter(Boolean);
  // The root index is what tells two roots of one multi-root template apart, so
  // it is shown wherever the tag carries one.
  if (use.root) bits.push(`root ${use.root}`);
  if (use.name) bits.push(`layer "${use.name}"`);
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = bits.join(" · ");
  text.append(sub);
  el.append(text);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  // Every indexed document is Elementor-built — the scan filters on
  // _elementor_edit_mode — so Edit never has to choose an editor, and the trap
  // where post.php?action=elementor quietly converts a post it never built
  // cannot be reached here.
  actions.append(
    linkButton("Edit", elementorEditUrl(workingDomain, use.docId), {
      hint: "Edit in Elementor",
      disabledHint: "Set a Working Domain to build the Edit link",
    }),
    linkButton(
      "View",
      contentViewUrl(workingDomain, {
        id: use.docId,
        status: use.status,
        link: use.link,
        viewable: use.viewable,
      }),
      {
        hint: use.status === "publish" ? "View page" : "Preview draft",
        disabledHint: workingDomain
          ? "This document has nothing viewable to open"
          : "Set a Working Domain to build the View link",
      },
    ),
  );
  el.append(actions);
  return el;
};

const usageList = (uses, { orphans = false } = {}) => {
  const list = document.createElement("div");
  list.className = `usages${orphans ? " orphans" : ""}`;
  list.append(...uses.map(usageRow));
  return list;
};

// Tags naming a template that is not on this site, as their own collapsible
// group. Keyed on a sentinel no real template id can equal.
const orphanGroup = (orphans) => {
  const group = document.createElement("div");
  group.className = "content-row";
  const row = document.createElement("div");
  row.className = "template";

  const text = document.createElement("div");
  text.className = "text";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = "Tags with no template";
  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent =
    "the template these layers name is not on this site — deleted, or on another one";
  text.append(name, sub);
  row.append(text);

  const open = usageOpen.has(ORPHAN_KEY);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "uses-toggle";
  btn.textContent = `${open ? "▾" : "▸"} ${orphans.length}`;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  btn.title = `${orphans.length} tagged layer(s) pointing at a missing template`;
  btn.addEventListener("click", () => {
    if (open) usageOpen.delete(ORPHAN_KEY);
    else usageOpen.add(ORPHAN_KEY);
    renderContent();
  });
  row.append(btn);
  group.append(row);

  if (open) {
    const list = usageList(orphans, { orphans: true });
    // The id is the only trace of what each one was pointing at, and it is not on
    // the usage row itself — a missing template has no title to show.
    for (const [i, el] of [...list.children].entries()) {
      const sub = el.querySelector(".sub");
      if (sub) sub.textContent = `#${orphans[i].templateId} · ${sub.textContent}`;
    }
    group.append(list);
  }
  return group;
};

const renderContent = () => {
  renderTabs();
  const state = tabState[activeTab];

  // A failed refresh keeps whatever was already listed — the error goes in the
  // status line rather than throwing away a good list.
  const items = activeItems();
  if (!items) {
    setContentMessage(
      state.error
        ? `Could not load ${TAB_LABELS[activeTab]}`
        : state.loading
          ? "Loading…"
          : "Not loaded",
    );
    renderContentStatus(0, 0);
    return;
  }

  if (!items.length) {
    setContentMessage(`No ${TAB_LABELS[activeTab]} on this site`);
    renderContentStatus(0, 0);
    return;
  }

  const terms = searchTerms(contentSearchEl.value);
  const rows = items
    .filter((item) => matchesTerms(item, terms))
    .map((item) => {
      // The wrapper is what an expanded row expands inside of, and it carries the
      // separator so a row and its usage list read as one group.
      const group = document.createElement("div");
      group.className = "content-row";
      const row = document.createElement("div");
      row.className = "template";
      group.append(row);

      const text = document.createElement("div");
      text.className = "text";
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = item.title || "(untitled)";
      text.append(name);
      if (item.sub) {
        const subEl = document.createElement("span");
        subEl.className = "sub";
        subEl.textContent = item.sub;
        text.append(subEl);
      }
      row.append(text);

      if (item.badge) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Elementor";
        badge.title = item.docType
          ? `Built with Elementor · ${item.docType}`
          : "Built with Elementor";
        row.append(badge);
      }

      const type = document.createElement("span");
      type.className = "type";
      type.textContent = item.type;
      row.append(type);

      const uses = item.kind === "template" ? usageRowsFor(item) : null;
      if (uses) row.append(usesToggle(item, uses));

      const actions = document.createElement("div");
      actions.className = "row-actions";
      const target = editTarget(item);
      actions.append(
        linkButton("Edit", target.url, {
          hint: target.hint,
          disabledHint: "Set a Working Domain to build the Edit link",
        }),
        linkButton("View", contentViewUrl(workingDomain, item), {
          hint: item.status === "publish" ? "View page" : "Preview draft",
          disabledHint:
            item.kind === "template"
              ? "The library did not return a permalink for this template"
              : "Set a Working Domain to build the View link",
        }),
      );
      row.append(actions);

      if (uses?.length && usageOpen.has(String(item.id))) {
        group.append(usageList(uses));
      }
      return group;
    });

  // Counted before the orphan block is appended: that block is not one of the
  // rows the search filtered, and letting it inflate "N of M shown" would make
  // the count disagree with the list.
  const shown = rows.length;

  // Orphans belong to no template row, so they get their own group at the end.
  // Dropping them would be the one genuinely misleading outcome here — a tag
  // pointing nowhere is a broken link on a real page, and nothing else in the
  // panel would ever mention it.
  //
  // Only with the search box empty. They are not templates, so no search term
  // can be said to match them, and appending them to a filtered list would
  // answer a search with rows that do not match it.
  if (activeTab === "template" && !terms.length && usageIndex?.orphans.length) {
    rows.push(orphanGroup(usageIndex.orphans));
  }

  if (!rows.length) {
    setContentMessage("Nothing matches that search");
    renderContentStatus(0, items.length);
    return;
  }
  contentEl.replaceChildren(...rows);
  renderContentStatus(shown, items.length);
};

const NO_TAB =
  "No Elementor editor or WordPress admin tab open — open one, then Refresh.";

const loadTab = async (kind) => {
  const state = tabState[kind];
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  state.warnings = [];
  if (kind === activeTab) {
    refreshContentBtn.disabled = true;
    renderContent();
  } else {
    renderTabs();
  }

  // Prefer a tab on the Working Domain, so a second client's WP tab cannot
  // answer for this one.
  const preferOrigin = parseWorkingDomain(workingDomain)?.origin || "";
  const request = TAB_REQUESTS[kind];

  try {
    const { tab, reply } = await askElementorTab(
      { __elementorTools: true, ...request },
      { preferOrigin },
    );
    // Which tab answered is worth showing. Two tabs can serve these reads by
    // different routes, and a list that came from the wrong one — or by the
    // wrong route — is otherwise indistinguishable from a broken endpoint.
    state.via = tab
      ? (tab.url || "").includes("action=elementor")
        ? "editor"
        : "wp-admin"
      : null;
    if (!reply) {
      state.error = NO_TAB;
    } else if (!reply.ok) {
      state.error = reply.error;
    } else {
      state.rows =
        kind === "template" ? reply.templates || [] : reply.posts || [];
      // Per-type failures and truncation are reported, never silent: a list
      // that quietly dropped a post type reads as "that type has nothing in it".
      state.warnings = reply.warnings || [];
    }
  } catch (err) {
    state.error = err?.message || String(err);
  } finally {
    state.loading = false;
    if (kind === activeTab) refreshContentBtn.disabled = false;
    renderContent();
  }
};

// Switching tabs shows what is already there and only reaches the network for a
// tab that has never loaded. Re-fetching on every switch would undo the point
// of splitting the requests up.
const selectTab = (kind) => {
  if (!ALL_KINDS.includes(kind) || kind === activeTab) return;
  activeTab = kind;
  browser.storage.local.set({ contentTab: kind });
  contentSearchEl.placeholder = `Search ${TAB_LABELS[kind]}…`;
  renderContent();
  if (!tabState[kind].rows && !tabState[kind].loading) loadTab(kind);
};

contentSearchEl.addEventListener("input", renderContent);
contentSearchEl.addEventListener("search", renderContent);
refreshContentBtn.addEventListener("click", () => loadTab(activeTab));
scanUsageBtn.addEventListener("click", () => scanUsage());

contentTabsEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".tab");
  if (btn) selectTab(btn.dataset.kind);
});

// ---- Animation presets ------------------------------------------------------
// A preset is a JSON file the user edits by hand: "New" writes a template with a
// fresh id and every Motion Effects field commented, "Import" turns a filled-in
// file into a preset. The id is what decides replace-or-add, so re-importing an
// edited export updates the preset in place.
const PRESETS_KEY = "animationPresets";
const DELAY_ACCUMULATION_KEY = "animationDelayAccumulation";

const presetFields = window.__AnimationPresetFields;

let presets = [];
let presetStatusTimer = 0;
// The one row action waiting on a second click, as `{ id, kind }`. A destructive
// button asks before it acts, and it asks in the row rather than through a
// window.confirm — the panel avoids browser modals for the same reason the
// in-editor tools do. One at a time on purpose: two rows both offering "Sure?"
// is a misclick waiting to happen.
let armed = null;
let armedTimer = 0;
// Which preset's name is being edited. Renaming is an inline input rather than a
// window.prompt, for the same reason nothing here uses window.alert.
let renamingId = null;

const showPresetStatus = (text, level = "info") => {
  presetStatusEl.textContent = text;
  presetStatusEl.classList.toggle("error", !!text && level === "error");
  clearTimeout(presetStatusTimer);
  if (text) {
    presetStatusTimer = setTimeout(() => {
      presetStatusEl.textContent = "";
      presetStatusEl.classList.remove("error");
    }, 6000);
  }
};

const savePresets = () => browser.storage.local.set({ [PRESETS_KEY]: presets });

const delayAccumulation = () => Math.max(0, Number(presetDelayEl.value) || 0);

// An anchor with a blob URL rather than browser.downloads: it needs no extra
// manifest permission, and the panel is an extension page so the blob is its own
// origin's.
const downloadJson = (filename, text) => {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
};

const presetSlug = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "preset";

const exportPreset = (preset) =>
  downloadJson(
    `animation-preset-${presetSlug(preset.name)}-${preset.id}.json`,
    presetFields.stringifyPreset(preset),
  );

// The run reports that it *started*, same as the hotkey Run buttons: the tool
// logs its own per-layer results, and the panel re-renders the log live.
const applyPreset = async (preset, btn) => {
  showPresetStatus("");
  btn.disabled = true;
  try {
    const { tab, reply } = await askElementorTab({
      __elementorTools: true,
      type: "run-action",
      action: "applyAnimationPreset",
      args: {
        presetId: preset.id,
        delayAccumulation: delayAccumulation(),
      },
    });
    if (!reply) {
      showPresetStatus(
        "No Elementor editor tab open — open one, then try again.",
        "error",
      );
    } else if (!reply.ok) {
      showPresetStatus(
        `Could not apply "${preset.name}" — ${reply.error}`,
        "error",
      );
    } else {
      showPresetStatus(`Applying "${preset.name}" — results in Logs`);
      // The tool logs into the editor page, and the panel is a separate popup
      // window, so bring that tab forward to see what happened.
      await focusTab(tab);
    }
  } catch (err) {
    showPresetStatus(
      `Could not apply "${preset.name}" — ${err?.message || err}`,
      "error",
    );
  } finally {
    btn.disabled = false;
  }
};

const disarm = () => {
  clearTimeout(armedTimer);
  armed = null;
};

const isArmed = (id, kind) => armed?.id === id && armed?.kind === kind;

// Arming cancels an open rename: the two are alternative things to be doing to
// one row, and leaving a rename input focused under a "Sure?" button reads as if
// the confirm applied to the name.
const arm = (id, kind) => {
  clearTimeout(armedTimer);
  renamingId = null;
  armed = { id, kind };
  armedTimer = setTimeout(() => {
    disarm();
    renderPresets();
  }, 4000);
  renderPresets();
};

const deletePreset = async (preset) => {
  presets = presets.filter((p) => p.id !== preset.id);
  disarm();
  await savePresets();
  renderPresets();
  showPresetStatus(
    `Deleted "${preset.name}" — export first if you want it back`,
  );
};

// New and Replace both capture off the selection, so the request and its
// no-tab case live in one place.
const capturePreset = async () => {
  const { reply } = await askElementorTab({
    __elementorTools: true,
    type: "capture-preset",
  });
  return (
    reply || {
      ok: false,
      error: "No Elementor editor tab open — open one, then try again.",
    }
  );
};

// Re-capture into an existing preset. The values are replaced wholesale; the id
// and the name are not — the id is what Import matches on, and the name is the
// user's rather than the layer's.
const replacePreset = async (preset) => {
  disarm();
  renderPresets();
  showPresetStatus("Reading the selected layer…");
  try {
    const reply = await capturePreset();
    if (!reply.ok) {
      showPresetStatus(reply.error, "error");
      return;
    }
    const at = presets.findIndex((p) => p.id === preset.id);
    if (at < 0) {
      showPresetStatus("That preset is no longer in the list", "error");
      return;
    }
    const captured = presetFields.presetFromValues(
      reply.values,
      presets[at].name,
    );
    presets[at] = { ...captured, id: preset.id, name: presets[at].name };
    await savePresets();
    renderPresets();
    const from = reply.layer?.title
      ? `"${reply.layer.title}"`
      : reply.layer?.id || "the selection";
    showPresetStatus(
      [
        `Replaced the values in "${presets[at].name}" from ${from} (${reply.via})`,
        reply.missing?.length
          ? `${reply.missing.length} field(s) absent on that layer, defaulted`
          : "",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  } catch (err) {
    showPresetStatus(
      `Could not replace "${preset.name}" — ${err?.message || err}`,
      "error",
    );
  }
};

// The input stays open until it is committed or cancelled explicitly — clicking
// away leaves it alone. Committing on blur would either discard the edit
// silently or swallow the click that caused the blur, because the commit
// re-renders the row out from under it.
const commitRename = async (preset, value) => {
  const next = String(value || "").trim();
  renamingId = null;
  const at = presets.findIndex((p) => p.id === preset.id);
  if (!next || at < 0 || next === presets[at].name) {
    renderPresets();
    return;
  }
  presets[at] = { ...presets[at], name: next };
  await savePresets();
  renderPresets();
  showPresetStatus(`Renamed to "${next}"`);
};

const cancelRename = () => {
  renamingId = null;
  renderPresets();
};

const renameInput = (preset) => {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "text-input preset-rename";
  input.value = preset.name || "";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.title = "Enter to save, Escape to cancel";
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitRename(preset, input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  });
  return input;
};

const presetButton = (label, className, title, onClick) => {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
};

// A row action that overwrites something: first click arms it, second runs it.
const confirmButton = (preset, kind, label, title, run) => {
  const hot = isArmed(preset.id, kind);
  return presetButton(
    hot ? "Sure?" : label,
    hot ? "edit danger" : "edit",
    hot ? "Click again to confirm" : title,
    () => (hot ? run() : arm(preset.id, kind)),
  );
};

const renderPresets = () => {
  if (!presets.length) {
    presetsEl.replaceChildren(
      Object.assign(document.createElement("div"), {
        className: "empty",
        textContent:
          "None yet — select a layer in the editor and press New to copy its Motion Effects",
      }),
    );
    return;
  }
  let focusEl = null;
  const rows = presets.map((preset) => {
    const row = document.createElement("div");
    row.className = "template";

    const editing = renamingId === preset.id;
    let name;
    if (editing) {
      name = renameInput(preset);
      focusEl = name;
    } else {
      name = presetButton(
        preset.name || "(unnamed)",
        "preset-name",
        `Apply to the shift-clicked layers, or the selected one · id ${preset.id}`,
        () => applyPreset(preset, name),
      );
    }

    const actions = document.createElement("div");
    actions.className = "row-actions";
    actions.append(
      presetButton(
        editing ? "✓" : "✎",
        "edit",
        editing ? "Save the name" : "Rename this preset",
        () => {
          if (editing) {
            commitRename(preset, name.value);
            return;
          }
          disarm();
          renamingId = preset.id;
          renderPresets();
        },
      ),
      confirmButton(
        preset,
        "replace",
        "⟳",
        "Replace this preset's values with the selected layer's",
        () => replacePreset(preset),
      ),
      presetButton("Export", "edit", "Save this preset as a JSON file", () =>
        exportPreset(preset),
      ),
      confirmButton(preset, "delete", "✕", "Delete this preset", () =>
        deletePreset(preset),
      ),
    );

    row.append(name, actions);
    return row;
  });
  presetsEl.replaceChildren(...rows);
  // replaceChildren threw the old input away, so focus has to be re-established
  // on the new one — otherwise clicking Rename puts a caret nowhere.
  if (focusEl) {
    focusEl.focus();
    focusEl.select();
  }
};

// New copies the selected layer's Motion Effects into a preset and adds it
// straight away — no file in the middle. A selection is required, so this
// reports rather than creating an empty preset there is no way to fill in.
presetNewBtn.addEventListener("click", async () => {
  showPresetStatus("Reading the selected layer…");
  presetNewBtn.disabled = true;
  try {
    const reply = await capturePreset();
    if (!reply.ok) {
      showPresetStatus(reply.error, "error");
      return;
    }
    const preset = presetFields.presetFromValues(
      reply.values,
      reply.layer?.title,
    );
    presets.push(preset);
    await savePresets();
    renderPresets();
    const from = reply.layer?.title
      ? `"${reply.layer.title}"`
      : reply.layer?.id || "the selection";
    showPresetStatus(
      [
        `Added "${preset.name}" from ${from} (${reply.via})`,
        reply.missing?.length
          ? `${reply.missing.length} field(s) absent on that layer, defaulted`
          : "",
        "✎ renames it",
      ]
        .filter(Boolean)
        .join(" · "),
    );
  } catch (err) {
    showPresetStatus(
      `Could not create a preset — ${err?.message || err}`,
      "error",
    );
  } finally {
    presetNewBtn.disabled = false;
  }
});

presetImportBtn.addEventListener("click", () => {
  // Reset first: picking the same file twice in a row fires no change event
  // otherwise, which reads as a dead button.
  presetFileEl.value = "";
  presetFileEl.click();
});

presetFileEl.addEventListener("change", async () => {
  const file = presetFileEl.files?.[0];
  if (!file) return;
  let text = "";
  try {
    text = await file.text();
  } catch (err) {
    showPresetStatus(
      `Could not read that file — ${err?.message || err}`,
      "error",
    );
    return;
  }
  const res = presetFields.parsePreset(text);
  if (!res.ok) {
    showPresetStatus(res.error, "error");
    return;
  }
  const at = presets.findIndex((p) => p.id === res.preset.id);
  const replaced = at >= 0;
  if (replaced) presets[at] = res.preset;
  else presets.push(res.preset);
  await savePresets();
  renderPresets();
  showPresetStatus(
    [
      replaced ? `Replaced "${res.preset.name}"` : `Added "${res.preset.name}"`,
      ...(res.warnings || []),
    ].join(" · "),
  );
});

presetDelayEl.addEventListener("change", () => {
  browser.storage.local.set({
    [DELAY_ACCUMULATION_KEY]: delayAccumulation(),
  });
});

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
      showHotkeyError(
        "No Elementor editor tab open — open one, then try again.",
      );
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
    "pureContainerReset",
    "unlinkNewElements",
    "skipWord",
    "workingDomain",
    "hotkeyBindings",
    "contentTab",
    "templateUsageIndex",
    "animationPresets",
    "animationDelayAccumulation",
  ])
  .then((state) => {
    renderLayer(state.selectedLayer || null);
    renderLogs(state.logs || []);
    replaceChildrenEl.checked = !!state.replaceChildrenStyles;
    overlayEl.checked = !!state.overlayEnabled;
    overlayFroggyEl.checked = !!state.overlayFroggy;
    pureContainerResetEl.checked =
      state.pureContainerReset === undefined
        ? DEFAULT_PURE_CONTAINER_RESET
        : !!state.pureContainerReset;
    unlinkNewEl.checked =
      state.unlinkNewElements === undefined
        ? DEFAULT_UNLINK_NEW_ELEMENTS
        : !!state.unlinkNewElements;
    skipWordEl.value =
      state.skipWord === undefined ? DEFAULT_SKIP_WORD : state.skipWord;
    workingDomain = state.workingDomain || "";
    workingDomainEl.value = workingDomain;
    hotkeyBindings = mergeWithDefaults(state.hotkeyBindings || null);
    presets = Array.isArray(state.animationPresets)
      ? state.animationPresets
      : [];
    presetDelayEl.value = state.animationDelayAccumulation ?? "";
    renderPresets();
    // The usage index renders from cache immediately and only ever rescans on
    // demand — the walk behind it reads every document on the site, which is not
    // something a panel should do just because it opened.
    //
    // With a Working Domain set, a cache from a different origin is discarded
    // rather than drawn: showing one site's usage counts against another site's
    // templates is wrong in the most confusing possible way. With none set there
    // is nothing to compare, so the cache is trusted and the next scan corrects
    // it.
    usageCache = usableUsageCache(
      state.templateUsageIndex,
      parseWorkingDomain(workingDomain)?.origin || "",
    );
    rebuildUsageIndex();
    if (ALL_KINDS.includes(state.contentTab)) activeTab = state.contentTab;
    contentSearchEl.placeholder = `Search ${TAB_LABELS[activeTab]}…`;
    renderHotkeys();
    // Only the tab that is actually on screen. The other two load the first
    // time they are opened, if they ever are.
    loadTab(activeTab);
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
  if (changes.pureContainerReset) {
    pureContainerResetEl.checked =
      changes.pureContainerReset.newValue === undefined
        ? DEFAULT_PURE_CONTAINER_RESET
        : !!changes.pureContainerReset.newValue;
  }
  if (changes.unlinkNewElements) {
    unlinkNewEl.checked =
      changes.unlinkNewElements.newValue === undefined
        ? DEFAULT_UNLINK_NEW_ELEMENTS
        : !!changes.unlinkNewElements.newValue;
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
    // Pointing the panel at another site invalidates the usage index outright.
    // Nothing about site A's tags is true of site B, and the counts are the one
    // thing here that would look perfectly plausible while being wrong.
    const origin = parseWorkingDomain(workingDomain)?.origin || "";
    if (origin && usageCache && usageCache.origin !== origin) {
      usageCache = null;
      usageIndex = null;
      usageOpen.clear();
    }
    // The Edit and View links are built from it, so they have to be rebuilt
    // with it.
    renderContent();
  }
  if (changes.hotkeyBindings) {
    hotkeyBindings = mergeWithDefaults(changes.hotkeyBindings.newValue || null);
    if (!recordingActionId) renderHotkeys();
  }
  if (changes.animationPresets) {
    presets = Array.isArray(changes.animationPresets.newValue)
      ? changes.animationPresets.newValue
      : [];
    disarm();
    // The list this input was bound to is gone, so the edit has nowhere to land.
    renamingId = null;
    renderPresets();
  }
  if (
    changes.animationDelayAccumulation &&
    document.activeElement !== presetDelayEl
  ) {
    presetDelayEl.value = changes.animationDelayAccumulation.newValue ?? "";
  }
});

/* ------------------------------------------------------------- components */

// The component system lives entirely in Component/ and owns its own window.
// This panel holds exactly ONE button for it — everything component-shaped
// (sync, new, insert, detach, the site-wide tree) lives in that window, so this
// file never grows a second copy of the component UI and deleting Component/
// still removes the feature outright.
//
// It is a window rather than a message to a tab because nothing here needs an
// editor: the command centre reads the site through a WordPress tab and manages
// its own cache. Actions that DO need `elementor` are its problem, not this
// file's.
const componentOpenBtn = document.getElementById("component-open");
const componentStatusEl = document.getElementById("component-status");

const COMPONENT_PANEL_URL = browser.runtime.getURL(
  "Component/component-panel.html",
);

const showComponentStatus = (text, tone = "") => {
  if (!componentStatusEl) return;
  componentStatusEl.textContent = text;
  componentStatusEl.className = `templates-status${tone ? ` ${tone}` : ""}`;
};

// Focus the window if it is already up rather than opening a second one — two
// command centres would keep two copies of the index cache and race each
// other's writes to it. Same guard background.js uses for this panel.
componentOpenBtn?.addEventListener("click", async () => {
  componentOpenBtn.disabled = true;
  try {
    const wins = await browser.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w.tabs && w.tabs.some((t) => t.url === COMPONENT_PANEL_URL)) {
        await browser.windows.update(w.id, { focused: true });
        showComponentStatus("Command Center focused.", "ok");
        return;
      }
    }
    await browser.windows.create({
      url: COMPONENT_PANEL_URL,
      type: "popup",
      width: 620,
      height: 860,
    });
    showComponentStatus("Command Center opened.", "ok");
  } catch (err) {
    showComponentStatus(`Could not open — ${err?.message || err}`, "warn");
  } finally {
    componentOpenBtn.disabled = false;
  }
});
