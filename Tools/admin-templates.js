// wp-admin's answer to the panel's list-templates message.
//
// The Site Templates section used to require an Elementor editor tab open,
// which is a lot to ask when the point of that section is browsing the library
// *outside* the editor. Nothing here touches Elementor: list-templates is the
// one bridge op with no editor dependency — a nonce and a REST fetch — so an
// ordinary admin page can serve it directly.
//
// No page bridge is injected. The fetch runs in the content script's own world,
// which is what makes this small: same-origin, so the login cookie rides along
// with no SameSite question to answer, and no page-world script tag to get past
// a site's CSP. The nonce that fetch needs comes from Tools/wp-rest.js, which is
// where this file's own copy went once Tools/wp-pages.js needed the same thing.
(() => {
  // The editor already answers this through Tools/core_utils.js. Leave that
  // path alone rather than having two listeners race in one tab.
  if (location.search.includes("action=elementor")) return;
  if (!location.pathname.includes("/wp-admin/")) return;

  const fmt = window.__ElementorTemplateFormat;
  const rest = window.__WpRest;

  // Returning here on a missing dependency is what this used to do, and it made
  // the failure unreadable: no listener registered, so askElementorTab walked
  // past the tab and the panel said "no WordPress tab open" — pointing at the
  // browser instead of at the load order. Register anyway and answer with the
  // actual reason.
  const missing = !fmt
    ? "template-format.js"
    : !rest
      ? "Tools/wp-rest.js"
      : null;

  const TEMPLATE_PATH = "/wp-json/elementor/v1/template-library/templates";

  const listTemplates = async ({ source = "local" } = {}) => {
    if (missing) {
      return {
        ok: false,
        error: `${missing} did not load — check content_scripts order in manifest.json`,
      };
    }
    try {
      const { json } = await rest.getJson(
        `${TEMPLATE_PATH}?source=${encodeURIComponent(source)}`,
      );
      return {
        ok: true,
        ...fmt.normalizeTemplateList(json.templates || json, source),
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    // `context` lets the panel tell an admin responder from an editor one
    // without re-reading tab.url, which it cannot always see.
    if (msg.type === "ping") {
      return Promise.resolve({ ok: true, context: "wp-admin" });
    }
    if (msg.type === "list-templates") return listTemplates(msg.options || {});
    // run-action falls through deliberately. hotkeys.js is editor-only, and
    // returning undefined leaves the panel free to try the next tab instead of
    // resolving a run that nothing here can perform.
    return undefined;
  });
})();
