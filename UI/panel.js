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
// Mirrors MIN_MATCH_RATIO in Tools/core_utils.js. Stored as a fraction and shown
// as a percentage — the field is a judgement call a human sets, and "50" reads
// better there than "0.5". Empty means "never set, use the default", which is
// why clearing it removes the key rather than writing one.
const DEFAULT_MIN_MATCH_RATIO = 0.5;
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
const minMatchEl = document.getElementById("opt-min-match");
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
const slugCsvBtn = document.getElementById("slug-csv");
const slugRunBtn = document.getElementById("slug-run");
const slugFileEl = document.getElementById("slug-file");
const slugStatusEl = document.getElementById("slug-status");
const slugReportEl = document.getElementById("slug-report");
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

const showMinMatch = (stored) => {
  minMatchEl.value =
    typeof stored === "number" && stored >= 0 && stored <= 1
      ? String(Math.round(stored * 100))
      : "";
};
// Set from the mirrored constant rather than trusted to the markup, so the
// number the user sees as "the default" cannot drift from the one in force.
minMatchEl.placeholder = String(Math.round(DEFAULT_MIN_MATCH_RATIO * 100));

minMatchEl.addEventListener("change", () => {
  const raw = minMatchEl.value.trim();
  if (!raw) {
    // Removed, not set to undefined: the reader tells "never set" from "set to
    // something unusable" and both fall back, but only an absent key leaves the
    // field showing its placeholder.
    browser.storage.local.remove("minMatchRatio");
    return;
  }
  const pct = Math.min(100, Math.max(0, Math.round(Number(raw))));
  if (!Number.isFinite(pct)) {
    showMinMatch(undefined);
    browser.storage.local.remove("minMatchRatio");
    return;
  }
  minMatchEl.value = String(pct);
  browser.storage.local.set({ minMatchRatio: pct / 100 });
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
// Lives in tab-bridge.js, loaded by this page and by the Automation window. The
// tab ranking is the part that must not fork: both windows are asking the same
// question of the same set of tabs.
const { askElementorTab, focusTab, openInNewTab } = window.__TabBridge;

// The Automation window is its own popup, opened by the background script so the
// focus-or-create rule lives in one place.
document.getElementById("open-automation").addEventListener("click", () => {
  browser.runtime
    .sendMessage({ __elementorTools: true, type: "open-automation" })
    .catch(() => {});
});

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

// ---- Slug & SEO transfer ----------------------------------------------------
// One button that moves each CSV row's slug, SEO title and SEO description onto
// the page named in its `new_page` column, renaming whatever already holds that
// slug to "<slug>-alt" first. Tools/slug-transfer.js is the engine — nothing is
// installed on the site, it drives core REST plus Rank Math's own updateMeta
// route. This half holds the CSV and the confirm.
//
// THE CSV IS DATA, NOT CODE. It is picked here and parsed here, and the rows
// travel with the request. Nothing about it is stored on the server, so
// correcting a row is picking the file again — no plugin re-upload, no generated
// PHP to go stale, and no second copy for the two halves to disagree about.
const SLUG_CSV_KEY = "slugTransferCsv";
// Destructuring this directly was a live hazard: a missing global throws a
// TypeError at load, which aborts the REST of panel.js — the storage read, the
// hotkey list, every listener below this line. One unloaded file would present as
// a panel that renders nothing and answers nothing, with the cause thirty
// sections away. Same reasoning, same fix, as the `missing` guard in
// Tools/admin-templates.js: carry on and say what did not load.
const slugFormat = window.__SlugTransferFormat || null;
const readCsv = slugFormat
  ? slugFormat.readCsv
  : () => ({
      rows: [],
      skipped: [],
      warnings: [],
      error:
        "slug-transfer-format.js did not load — check the <script> tags in UI/panel.html",
    });

// { fileName, loadedAt, rows, skipped, warnings } — persisted, so the CSV is
// loaded once rather than every time the panel is reopened.
let slugCsv = null;
// The dry run's result, and the armed state: with a plan in hand the button
// applies it. Cleared by anything that could make the plan untrue — a new CSV, a
// failure, a different site answering.
let slugPlan = null;
let slugPlanOrigin = "";
let slugResult = null;
let slugBusy = false;
// Whether the in-flight run is an apply or another read. Not derivable from
// slugPlan: a zero-write plan is still a plan, and clicking it re-reads.
let slugApplying = false;
let slugError = "";

const NO_WP_TAB =
  "No WordPress admin tab open — open wp-admin on the Working Domain, then Run.";

// The transfer's durable record. Everything else it says lives in the status line
// and the report box, and both are gone the moment the panel is closed or the CSV
// is reloaded — which is exactly the wrong property for the one feature here that
// rewrites live URLs. A run that moved seven pages' addresses has to leave a trace
// somebody can read afterwards.
//
// Goes through background.js, the single writer, for the reason CLAUDE.md gives:
// concurrent read-modify-write against storage.local silently drops entries. The
// direct write is the same fallback core_utils.js keeps, so a line is never lost
// to a background page that did not answer.
const slugLog = async (level, message) => {
  const entry = { level, message: `Slug transfer: ${message}`, time: Date.now() };
  try {
    const res = await browser.runtime.sendMessage({
      __elementorTools: true,
      type: "log-entry",
      entry,
    });
    if (res?.ok) return;
  } catch (_) {}
  try {
    const { logs = [] } = await browser.storage.local.get("logs");
    await browser.storage.local.set({ logs: [entry, ...logs].slice(0, 500) });
  } catch (_) {}
};

// One line per row, saying what actually happened to it rather than what was
// planned. Written for both phases: a plan nobody applied is still worth being
// able to look back at, and it is the only way to tell "the run did nothing"
// apart from "the run was never reached".
const logSlugReport = async (report) => {
  const s = report.summary || {};
  const phase = report.dry_run ? "planned" : "APPLIED";
  await slugLog(
    s.failed ? "warn" : "info",
    `${phase} on ${report.site} — ${s.rows} row(s), ${s.slugs_set} slug(s), ` +
      `${s.reparented || 0} moved, ${s.renamed} renamed to -alt, ${s.seo_set} SEO field(s), ` +
      `${s.already} already correct, ${s.failed} failed ` +
      `(auto-redirect ${report.auto_redirect === true ? "ON" : report.auto_redirect === false ? "off" : "unknown"})`,
  );
  for (const warning of report.warnings || []) await slugLog("warn", warning);
  for (const row of report.rows || []) {
    if (row.error) {
      await slugLog("error", `${row.slug} (line ${row.line}) — ${row.error}`);
      continue;
    }
    const bits = [];
    if (row.slug_action === "done") bits.push(`slug → ${row.slug_written || row.slug}`);
    else if (row.slug_action === "set") bits.push(`slug ${row.target?.slug} → ${row.slug}`);
    else if (row.slug_action === "already") bits.push("slug already correct");
    const where = row.parent_slug ? `"${row.parent_slug}"` : "top level";
    if (row.parent_action === "done") bits.push(`moved under ${where}`);
    else if (row.parent_action === "set") bits.push(`parent → ${where}`);
    else if (row.parent_action === "skipped" || row.parent_action === "failed") {
      bits.push(`parent NOT set (${row.parent_note || "unknown"})`);
    }
    for (const occ of row.renames || []) {
      bits.push(`#${occ.id} ${occ.slug} → ${occ.new_slug || occ.rename_to}`);
    }
    const seo = (row.seo || []).filter((x) => x.action === "done" || x.action === "set");
    if (seo.length) bits.push(`${seo.length} SEO field(s)`);
    const bad = (row.seo || []).filter((x) => x.action === "failed");
    if (bad.length) bits.push(`${bad.length} SEO field(s) FAILED`);
    if (row.front_page) {
      bits.push(`front page → #${row.front_page.to}${row.front_page.result ? ` (${row.front_page.result})` : ""}`);
    }
    await slugLog(
      bad.length ? "warn" : "info",
      `${row.slug} (line ${row.line}) #${row.target?.id} — ${bits.join(", ") || "nothing to do"}`,
    );
  }
};

const slugRowCount = () => slugCsv?.rows?.length || 0;

// How many writes the plan actually amounts to. It is the button's label, so it
// has to count the same things the run reports: a slug that is already right and
// SEO that already matches are not changes, and a plan of zero must not read as
// "ready to apply".
const slugPlanWrites = (plan) => {
  if (!plan) return 0;
  let n = 0;
  for (const row of plan.rows || []) {
    if (row.error) continue;
    if (row.slug_action === "set") n += 1;
    if (row.parent_action === "set") n += 1;
    n += (row.renames || []).length;
    for (const seo of row.seo || []) if (seo.action === "set") n += 1;
    if (row.front_page) n += 1;
  }
  return n;
};

const slugSub = (parent, text, tone = "") => {
  const el = document.createElement("div");
  el.className = tone ? `sub ${tone}` : "sub";
  el.textContent = text;
  parent.appendChild(el);
};

const SEO_LABEL = { title: "SEO title", desc: "SEO description" };
const SEO_TONE = { set: "act", done: "done", failed: "warn", already: "" };

const renderSlugRow = (row, applied) => {
  const wrap = document.createElement("div");
  wrap.className = "content-row st-row";
  const line = document.createElement("div");
  line.className = "template";
  const text = document.createElement("div");
  text.className = "text";

  const name = document.createElement("div");
  name.className = row.error ? "name bad" : "name";
  name.textContent = row.slug;
  text.appendChild(name);

  if (row.error) {
    slugSub(text, row.error, "warn");
  }
  if (row.target) {
    slugSub(
      text,
      `${row.target.title || "(untitled)"} · #${row.target.id} · ` +
        `${row.target.post_type} · ${row.target.status} · /${row.target.path}/`,
    );
  } else if (!row.error) {
    slugSub(text, row.new_page);
  }

  if (row.slug_action === "set") {
    slugSub(text, `slug: ${row.target?.slug} → ${row.slug}`, "act");
  } else if (row.slug_action === "done") {
    slugSub(text, `slug set to ${row.slug_written || row.slug}`, "done");
  } else if (row.slug_action === "already") {
    slugSub(text, `slug already ${row.slug} — left alone`);
  } else if (row.slug_action === "suffixed") {
    slugSub(text, `slug became ${row.slug_written}`, "warn");
  }

  // The move gets its own line, like the front page does, because it changes a
  // live URL on its own — a page can keep its slug and still end up somewhere
  // else entirely.
  const parentLabel = row.parent_slug ? `"${row.parent_slug}"` : "top level";
  if (row.parent_action === "set") {
    slugSub(text, `parent: → ${parentLabel} (#${row.parent_to || 0})`, "act");
  } else if (row.parent_action === "done") {
    slugSub(text, `moved under ${parentLabel}`, "done");
  } else if (row.parent_action === "skipped" || row.parent_action === "failed") {
    slugSub(text, `parent not set — ${row.parent_note || "unknown"}`, "warn");
  }
  if (row.parent_error) {
    slugSub(text, `parent "${row.parent_slug}": ${row.parent_error}`, "warn");
  }

  for (const occ of row.renames || []) {
    const done = occ.result === "renamed";
    slugSub(
      text,
      `-alt: "${occ.title || "(untitled)"}" #${occ.id} ${occ.slug} → ` +
        `${occ.new_slug || occ.rename_to}${done ? "" : occ.result ? ` (${occ.result})` : ""}`,
      done ? "done" : occ.result ? "warn" : "act",
    );
  }
  for (const other of row.same_name || []) {
    // No path on these — they come straight off the collision search, which
    // reads a flat list and never walks a parent chain. Naming the parent id is
    // both cheaper and more useful, since "which parent" is the entire reason
    // this row is being left alone.
    slugSub(
      text,
      `left alone: #${other.id} "${other.slug}" ` +
        `(parent ${other.parent || "top level"}) — ${other.why}`,
    );
  }

  for (const seo of row.seo || []) {
    const label = SEO_LABEL[seo.field] || seo.field;
    if (seo.action === "none-in-csv") {
      slugSub(text, `${label}: none in CSV — not touched`);
    } else if (seo.action === "already") {
      slugSub(text, `${label}: already matches`);
    } else if (seo.action === "failed") {
      slugSub(text, `${label}: write failed`, "warn");
    } else {
      slugSub(
        text,
        `${label}: ${applied ? "written" : "will set"} — ${seo.value}`,
        SEO_TONE[seo.action] || "act",
      );
    }
  }

  // The front page is the one line here that changes what a visitor sees at the
  // site root, so it gets its own row rather than riding along in a note.
  if (row.front_page) {
    const fp = row.front_page;
    slugSub(
      text,
      `front page: #${fp.from} "${fp.from_title}" → #${fp.to} "${fp.to_title}"` +
        (fp.result ? ` (${fp.result})` : ""),
      fp.result && fp.result !== "done" ? "warn" : fp.result ? "done" : "act",
    );
  }

  for (const note of row.notes || []) slugSub(text, note, "warn");

  line.appendChild(text);

  // Which spreadsheet row this is. A report that says "no post found" is only
  // actionable if you can find the row it came from, and a slug is not what the
  // CSV is sorted by.
  if (row.line) {
    const where = document.createElement("div");
    where.className = "type";
    where.textContent = `line ${row.line}`;
    line.appendChild(where);
  }

  // The one row action worth having: a plan that names the wrong page is only
  // recognisable by opening it, and every row here is about to have its URL
  // rewritten.
  if (row.target?.edit_link) {
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const edit = document.createElement("a");
    edit.className = "edit";
    edit.textContent = "Edit";
    edit.href = row.target.edit_link;
    edit.target = "_blank";
    edit.rel = "noopener";
    actions.appendChild(edit);
    line.appendChild(actions);
  }

  wrap.appendChild(line);
  return wrap;
};

const renderSlugReport = () => {
  const report = slugResult || slugPlan;
  if (!report) {
    slugReportEl.hidden = true;
    slugReportEl.replaceChildren();
    return;
  }
  slugReportEl.hidden = false;
  const kids = [];

  const head = document.createElement("div");
  head.className = "usages-note";
  const s = report.summary || {};
  // auto_redirect is stated on every report, not only when it blocks. It is the
  // one setting that decides whether a clean-looking run is actually clean, so
  // "it was off when this ran" belongs in the record.
  const auto =
    report.auto_redirect === true
      ? "auto-redirect ON"
      : report.auto_redirect === false
        ? "auto-redirect off"
        : "auto-redirect unknown";
  head.textContent =
    `${report.dry_run ? "Plan" : "Applied"} on ${report.site} · ` +
    `SEO: ${report.seo?.label || "none detected"} · ${auto} · ` +
    `${s.rows} row(s), ${s.slugs_set} slug(s), ${s.reparented || 0} moved, ` +
    `${s.renamed} renamed to -alt, ` +
    `${s.seo_set} SEO field(s), ${s.already} already correct, ${s.failed} failed`;
  kids.push(head);

  for (const warning of report.warnings || []) {
    const el = document.createElement("div");
    el.className = "usages-note";
    el.style.color = "#e0b060";
    el.textContent = warning;
    kids.push(el);
  }

  for (const row of report.rows || []) {
    kids.push(renderSlugRow(row, !report.dry_run));
  }
  slugReportEl.replaceChildren(...kids);
};

const renderSlug = () => {
  const rows = slugRowCount();
  const writes = slugPlanWrites(slugPlan);

  slugCsvBtn.disabled = slugBusy;
  slugRunBtn.disabled = slugBusy || !rows;
  slugRunBtn.classList.toggle("armed", !!slugPlan && writes > 0);
  // A plan with nothing in it leaves the button reading "Run", not "Apply 0" —
  // clicking then re-reads the site, which is the only useful thing left to do.
  // An enabled button that returns early is a dead button.
  slugRunBtn.textContent = slugBusy ? "…" : slugPlan && writes ? `Apply ${writes}` : "Run";

  const bits = [];
  if (!slugCsv) {
    bits.push("No CSV loaded — click CSV… to pick the migration file");
  } else {
    bits.push(`${slugCsv.fileName}: ${rows} row(s)`);
    if (slugCsv.skipped?.length) {
      bits.push(`${slugCsv.skipped.length} without a new_page (skipped)`);
    }
    for (const w of slugCsv.warnings || []) bits.push(w);
  }
  if (slugBusy) {
    bits.push(slugApplying ? "applying…" : "reading the site…");
  } else if (slugPlan) {
    bits.push(
      writes
        ? "review the plan below, then click Apply — this rewrites live URLs"
        : "nothing left to do; the site already matches the CSV",
    );
  }

  slugStatusEl.textContent = slugError || bits.join(" · ");
  slugStatusEl.classList.toggle("error", !!slugError);
  renderSlugReport();
};

const loadSlugCsv = async (file) => {
  slugError = "";
  let text = "";
  try {
    text = await file.text();
  } catch (err) {
    slugError = `Could not read that file — ${err?.message || err}`;
    renderSlug();
    return;
  }
  const parsed = readCsv(text);
  if (parsed.error) {
    slugError = parsed.error;
    slugLog("error", `could not read ${file.name} — ${parsed.error}`);
    renderSlug();
    return;
  }
  if (!parsed.rows.length) {
    slugError =
      "No rows with a new_page — that column names the page that receives the slug, " +
      "so there is nothing to transfer yet";
  }
  slugCsv = { fileName: file.name, loadedAt: Date.now(), ...parsed };
  // A plan describes the CSV it was built from. A new file makes it a promise
  // about rows that may no longer exist, so it is dropped rather than re-labelled.
  slugPlan = null;
  slugPlanOrigin = "";
  slugResult = null;
  await browser.storage.local.set({ [SLUG_CSV_KEY]: slugCsv });
  slugLog(
    parsed.rows.length ? "info" : "warn",
    `loaded ${file.name} — ${parsed.rows.length} row(s) with a new_page, ` +
      `${parsed.skipped.length} skipped without one` +
      (parsed.warnings.length ? `; ${parsed.warnings.length} warning(s)` : ""),
  );
  for (const w of parsed.warnings) slugLog("warn", `${file.name}: ${w}`);
  renderSlug();
};

const runSlugTransfer = async () => {
  if (slugBusy || !slugRowCount()) return;
  // Only a plan that would actually write anything arms the button. A zero-write
  // plan falls back to re-planning, matching the label renderSlug() gave it.
  const applying = !!slugPlan && slugPlanWrites(slugPlan) > 0;

  slugBusy = true;
  slugApplying = applying;
  slugError = "";
  renderSlug();

  const preferOrigin = parseWorkingDomain(workingDomain)?.origin || "";
  // Logged before the ask, not after. "Nothing happened" is the failure this is
  // for, and a run that never got a reply leaves no other evidence it was even
  // attempted — the status line goes back to idle and looks identical to a button
  // that was never clicked.
  slugLog(
    "info",
    `${applying ? "APPLY" : "plan"} requested — ${slugCsv.rows.length} row(s)` +
      `${preferOrigin ? `, expecting ${preferOrigin}` : ", no Working Domain set"}`,
  );
  try {
    const { reply } = await askElementorTab(
      {
        __elementorTools: true,
        type: "slug-transfer",
        options: { rows: slugCsv.rows, dryRun: !applying },
      },
      { preferOrigin },
    );
    if (!reply) throw new Error(NO_WP_TAB);

    // Which site answered is the one thing worth refusing over. The tab ranking
    // PREFERS the Working Domain, it does not guarantee it — a popup panel has no
    // active tab of its own, so with no wp-admin tab open on that origin some
    // other site's tab will happily answer. Rewriting one client's page URLs
    // because their tab was open is not a mistake a report can undo.
    const answered = reply.origin || "";
    if (preferOrigin && answered && answered !== preferOrigin) {
      throw new Error(
        `${answered} answered, not the Working Domain (${preferOrigin}) — ` +
          "open wp-admin there and try again",
      );
    }
    // And the apply has to land on the same site the plan was read from. Planning
    // on staging and applying wherever the ranking points next is the same
    // failure arriving a click later.
    if (applying && slugPlanOrigin && answered !== slugPlanOrigin) {
      throw new Error(
        `the plan was read from ${slugPlanOrigin} but ${answered} answered — ` +
          "nothing was applied, Run again to re-plan",
      );
    }
    if (!reply.ok) throw new Error(reply.error);
    // An `ok` with no report is a broken contract, not a broken site, and it has
    // to say which. It shipped once — the engine returned the report flattened
    // into the reply, so `ok` was true and `result` undefined, and the only
    // symptom was "can't access property summary, report is undefined" from
    // whichever line touched it first. Name the cause here instead.
    if (!reply.result?.summary) {
      throw new Error(
        "the responding tab answered ok but sent no report — reload the extension " +
          "so Tools/slug-transfer.js matches this panel, then Run again",
      );
    }

    if (applying) {
      slugResult = reply.result;
      slugPlan = null;
      slugPlanOrigin = "";
    } else {
      slugPlan = reply.result;
      slugPlanOrigin = answered;
      slugResult = null;
    }
    await logSlugReport(reply.result);
  } catch (err) {
    slugError = err?.message || String(err);
    slugLog("error", `${applying ? "apply" : "plan"} failed — ${slugError}`);
    // Disarmed on any failure. The site may have moved under the plan — half of
    // pass A can have landed — so the next click has to read it again rather than
    // apply a plan that was true a moment ago.
    slugPlan = null;
    slugPlanOrigin = "";
  } finally {
    slugBusy = false;
    slugApplying = false;
    renderSlug();
  }
};

slugCsvBtn.addEventListener("click", () => slugFileEl.click());
slugFileEl.addEventListener("change", () => {
  const file = slugFileEl.files?.[0];
  // Cleared so re-picking the same path fires change again — the usual way a
  // corrected CSV is reloaded is by saving over it and picking it once more.
  slugFileEl.value = "";
  if (file) loadSlugCsv(file);
});
slugRunBtn.addEventListener("click", () => runSlugTransfer());

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
    "minMatchRatio",
    "workingDomain",
    "hotkeyBindings",
    "contentTab",
    "templateUsageIndex",
    "animationPresets",
    "animationDelayAccumulation",
    "slugTransferCsv",
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
    showMinMatch(state.minMatchRatio);
    workingDomain = state.workingDomain || "";
    workingDomainEl.value = workingDomain;
    hotkeyBindings = mergeWithDefaults(state.hotkeyBindings || null);
    presets = Array.isArray(state.animationPresets)
      ? state.animationPresets
      : [];
    presetDelayEl.value = state.animationDelayAccumulation ?? "";
    renderPresets();
    // The CSV survives the panel closing, but a PLAN never does. It describes the
    // site as it was at that moment, and the whole point of the two clicks is that
    // the second one follows a review of the first — restoring an armed plan from a
    // previous session would put an Apply button in front of somebody who never saw
    // what it applies.
    slugCsv = state.slugTransferCsv?.rows ? state.slugTransferCsv : null;
    renderSlug();
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
  if (changes.minMatchRatio && document.activeElement !== minMatchEl) {
    showMinMatch(changes.minMatchRatio.newValue);
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
  if (changes.slugTransferCsv) {
    const next = changes.slugTransferCsv.newValue;
    slugCsv = next?.rows ? next : null;
    // Same rule as on load: the rows this plan was built from are gone, so the
    // plan is no longer a description of anything.
    slugPlan = null;
    slugPlanOrigin = "";
    slugResult = null;
    renderSlug();
  }
});
