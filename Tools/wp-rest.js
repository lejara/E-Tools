// Authenticated WordPress REST access for content scripts that run outside the
// Elementor editor's page bridge.
//
// The nonce is the whole reason this file exists. wpApiSettings is a page-world
// global and a content script cannot read it, but admin-ajax's rest-nonce
// handler returns the identical value and is WP core rather than something a
// plugin happens to enqueue — so it answers on every admin page, which makes it
// the more reliable source even where the global would have been readable.
//
// Tools/admin-templates.js found that first and Tools/wp-pages.js needed the
// same thing plus pagination; the second copy is where it moved here. Change the
// nonce source here, not in a caller.
(() => {
  if (!location.pathname.includes("/wp-admin/")) return;

  let pending = null;

  const readNonce = async () => {
    const res = await fetch("/wp-admin/admin-ajax.php?action=rest-nonce", {
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`Nonce request failed: ${res.status}`);
    const value = (await res.text()).trim();
    // A logged-out or unprivileged session is answered with "-1" or "0" and an
    // HTTP 200, so the body has to be checked rather than the status. Saying
    // "not signed in" beats letting the REST call come back as a bare 401.
    if (!/^[a-z0-9]{6,}$/i.test(value)) {
      throw new Error("Not signed in to WordPress on this site");
    }
    return value;
  };

  // The in-flight promise is cached, not the value, so a burst of parallel
  // requests shares one nonce fetch instead of racing into several. A rejection
  // is evicted; otherwise one network blip would poison the tab for its
  // lifetime. Same reasoning as templateContentCache in page-bridge.js.
  const nonce = ({ fresh = false } = {}) => {
    if (fresh) pending = null;
    if (!pending) {
      pending = readNonce().catch((err) => {
        pending = null;
        throw err;
      });
    }
    return pending;
  };

  // Resolves to { json, headers } — a paginated list read needs X-WP-TotalPages
  // off the response, which a bare json return would have thrown away.
  const getJson = async (path, { retried = false } = {}) => {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "X-WP-Nonce": await nonce() },
    });
    // A nonce outlives the page it was minted on by 12-24h, so a long-lived
    // admin tab will eventually present an expired one. That reads as 401/403
    // with a perfectly good session behind it, and is worth exactly one silent
    // retry before the error surfaces to the panel as "not signed in".
    if ((res.status === 401 || res.status === 403) && !retried) {
      await nonce({ fresh: true });
      return getJson(path, { retried: true });
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = body?.message ? ` — ${body.message}` : "";
      throw new Error(`${path.split("?")[0]} failed: ${res.status}${detail}`);
    }
    return { json: body, headers: res.headers };
  };

  window.__WpRest = { nonce, getJson };
})();
