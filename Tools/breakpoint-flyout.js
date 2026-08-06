// Loader + clipboard channel for the breakpoint flyout.
//
// The feature itself is page-world (Elementor's Backbone control views), so
// most of this file is just the injection — the same script-tag pattern
// core_utils.js uses for page-bridge.js.
//
// It carries the pieces that cannot be delegated, and they are all the same kind
// of thing: state that lives on this side of the page-world boundary.
//
//   · the copy/paste transport. `browser.storage` is unreachable from the page
//     world, and it is the right medium here rather than the OS clipboard — both
//     ends of a copy/paste are this extension, storage is already a permission we
//     hold, and reading the real clipboard from a page-world script is blocked in
//     Firefox anyway. The page still writes the JSON to the system clipboard on
//     copy, so the payload stays inspectable; storage is what the paste reads.
//   · the unlink flag, pushed in as config.
//   · the Edge Preset capture channel: which preset is armed (storage) and which
//     document this editor has open (the bridge's `describe-document`). The
//     capture itself is handed to Tools/edge-presets.js, which owns preset
//     storage — this file owns the *channel*, and one listener answering one
//     message is what keeps two replies from racing.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const KEY = "breakpointClipboard";

  // Mirrors DEFAULT_UNLINK_NEW_ELEMENTS in Tools/pure-container-reset.js. The
  // page world cannot read browser.storage, so the flyout's copy of this flag has
  // to be pushed over the same channel the clipboard uses.
  const UNLINK_KEY = "unlinkNewElements";
  const DEFAULT_UNLINK_NEW_ELEMENTS = true;

  // Which Edge Preset the Automation window has selected. Stored as the id alone
  // rather than a copy of the preset, so a rename cannot leave two disagreeing
  // versions of the same name in play.
  const ARMED_KEY = "edgePresetArmed";

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__bpf !== true || data.__response) return;
    // Our own config push, which postMessage delivers back to this listener too.
    // Without this it would fall through to the unknown-op reply below.
    if (data.__config) return;

    const reply = (extra) =>
      window.postMessage(
        { __bpf: true, __response: true, requestId: data.requestId, ...extra },
        "*",
      );

    try {
      if (data.op === "copy") {
        await browser.storage.local.set({ [KEY]: data.payload });
        reply({ ok: true });
      } else if (data.op === "paste") {
        const stored = await browser.storage.local.get(KEY);
        reply({ ok: true, data: stored?.[KEY] ?? null });
      } else if (data.op === "edge-capture" || data.op === "edge-structural") {
        // Delegated, not implemented here: preset storage belongs to
        // edge-presets.js. Read off the namespace at call time so the manifest
        // order between the two files does not matter.
        const fn =
          data.op === "edge-capture"
            ? window.__ElementorTools?.captureEdgeField
            : window.__ElementorTools?.captureEdgeStructural;
        if (!fn) {
          reply({ ok: false, error: "Edge presets are not loaded" });
        } else {
          reply(await fn(data.payload || {}));
        }
      } else {
        reply({ ok: false, error: `Unknown op: ${data.op}` });
      }
    } catch (e) {
      reply({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  // Which document this editor has open. Cached after the first successful read
  // because it cannot change without a page load, and asked through the bridge so
  // the "is this a template?" heuristic has exactly one implementation — see
  // `describe-document` in page-bridge.js.
  //
  // A failed read is simply not cached: at document_idle Elementor is often not
  // up yet, and the next push asks again.
  let docInfo = null;

  const readDoc = async () => {
    if (docInfo) return docInfo;
    const tools = window.__ElementorTools;
    if (!tools?.callBridge) return null;
    const res = await tools
      .callBridge("describe-document", {}, { waitLimit: 1 })
      .catch(() => null);
    if (!res?.ok) return null;
    docInfo = {
      isTemplate: !!res.isTemplate,
      id: res.id ?? null,
      title: res.title || "",
    };
    return docInfo;
  };

  // Fields are pushed only when known, and the page-world listener applies only
  // what a message carries, so these two pushes never clobber each other.
  const pushUnlink = (unlinkNew) => {
    window.postMessage({ __bpf: true, __config: true, unlinkNew }, "*");
  };

  const pushUnlinkFromStorage = () =>
    browser.storage.local
      .get(UNLINK_KEY)
      .then((state) =>
        pushUnlink(
          state[UNLINK_KEY] === undefined
            ? DEFAULT_UNLINK_NEW_ELEMENTS
            : !!state[UNLINK_KEY],
        ),
      )
      .catch(() => pushUnlink(DEFAULT_UNLINK_NEW_ELEMENTS));

  const pushEdge = async () => {
    const F = window.__EdgePresetFormat;
    if (!F) return;
    try {
      const stored = await browser.storage.local.get([
        ARMED_KEY,
        F.STORAGE_KEY,
      ]);
      const armedId = stored[ARMED_KEY] || null;
      const list = Array.isArray(stored[F.STORAGE_KEY])
        ? stored[F.STORAGE_KEY]
        : [];
      const preset = armedId ? list.find((p) => p?.id === armedId) : null;
      window.postMessage(
        {
          __bpf: true,
          __config: true,
          edgeArmed: preset
            ? {
                id: preset.id,
                name: preset.name || "(unnamed)",
                templateId: preset.templateId || null,
              }
            : null,
          edgeDoc: await readDoc(),
        },
        "*",
      );
    } catch (_) {}
  };

  const script = document.createElement("script");
  script.src = browser.runtime.getURL("Tools/breakpoint-flyout-page.js");
  // Pushed on load rather than immediately: the page-world listener does not
  // exist until its script has run, and onload is the first moment it does.
  script.onload = () => {
    script.remove();
    pushUnlinkFromStorage();
    pushEdge();
    // Elementor is frequently still booting at document_idle, so the document
    // read above can come back empty. Two cheap retries beat leaving Capture
    // silently unavailable until the next storage change.
    setTimeout(pushEdge, 3000);
    setTimeout(pushEdge, 9000);
  };
  (document.head || document.documentElement).appendChild(script);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[UNLINK_KEY]) pushUnlinkFromStorage();
    // The preset list matters as well as the armed id: a rename or a first
    // capture (which binds the template) changes what the menu item must say.
    if (
      changes[ARMED_KEY] ||
      (window.__EdgePresetFormat &&
        changes[window.__EdgePresetFormat.STORAGE_KEY])
    ) {
      pushEdge();
    }
  });
})();
