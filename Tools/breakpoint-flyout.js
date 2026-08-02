// Loader + clipboard channel for the breakpoint flyout.
//
// The feature itself is page-world (Elementor's Backbone control views), so
// most of this file is just the injection — the same script-tag pattern
// core_utils.js uses for page-bridge.js.
//
// It carries one piece of logic it cannot delegate: the copy/paste transport.
// `browser.storage` is unreachable from the page world, and it is the right
// medium here rather than the OS clipboard — both ends of a copy/paste are
// this extension, storage is already a permission we hold, and reading the
// real clipboard from a page-world script is blocked in Firefox anyway. The
// page still writes the JSON to the system clipboard on copy, so the payload
// stays inspectable; storage is what the paste actually reads.
(() => {
  if (!location.search.includes("action=elementor")) return;

  const KEY = "breakpointClipboard";

  // Mirrors DEFAULT_UNLINK_NEW_ELEMENTS in Tools/pure-container-reset.js. The
  // page world cannot read browser.storage, so the flyout's copy of this flag has
  // to be pushed over the same channel the clipboard uses.
  const UNLINK_KEY = "unlinkNewElements";
  const DEFAULT_UNLINK_NEW_ELEMENTS = true;

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
      } else {
        reply({ ok: false, error: `Unknown op: ${data.op}` });
      }
    } catch (e) {
      reply({ ok: false, error: String(e && e.message ? e.message : e) });
    }
  });

  const pushConfig = (unlinkNew) => {
    window.postMessage({ __bpf: true, __config: true, unlinkNew }, "*");
  };

  const pushFromStorage = () =>
    browser.storage.local
      .get(UNLINK_KEY)
      .then((state) =>
        pushConfig(
          state[UNLINK_KEY] === undefined
            ? DEFAULT_UNLINK_NEW_ELEMENTS
            : !!state[UNLINK_KEY],
        ),
      )
      .catch(() => pushConfig(DEFAULT_UNLINK_NEW_ELEMENTS));

  const script = document.createElement("script");
  script.src = browser.runtime.getURL("Tools/breakpoint-flyout-page.js");
  // Pushed on load rather than immediately: the page-world listener does not
  // exist until its script has run, and onload is the first moment it does.
  script.onload = () => {
    script.remove();
    pushFromStorage();
  };
  (document.head || document.documentElement).appendChild(script);

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[UNLINK_KEY]) return;
    pushFromStorage();
  });
})();
