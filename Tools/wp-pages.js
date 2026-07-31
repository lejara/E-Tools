// The panel's answer to "what is on this site?" — every post type in one list,
// each row carrying the same "is this Elementor?" answer the wp-admin posts
// table shows.
//
// Runs on every wp-admin page *including the editor*: the editor's own URL is
// /wp-admin/post.php?...&action=elementor, so this one guard covers both kinds
// of tab the panel might find, and neither has to be the "right" one.
//
// It answers list-posts and nothing else. core_utils.js and admin-templates.js
// each own `ping` for their page type; a third listener answering it would mean
// two replies racing in one tab, and browser.tabs.sendMessage keeps whichever
// arrives first.
(() => {
  if (!location.pathname.includes("/wp-admin/")) return;

  const rest = window.__WpRest;
  // Registered even without it, so a load-order problem reports itself in the
  // panel rather than looking like "no WordPress tab open". See the same guard
  // in Tools/admin-templates.js.
  const missing = rest ? null : "Tools/wp-rest.js";

  const PER_PAGE = 100; // WP core's hard maximum for a collection request.
  // 2000 rows of one type is already past what the panel's list is useful for,
  // and an unbounded loop against a mis-reported header would hang the refresh.
  // Truncation is reported rather than silent.
  const MAX_REQUESTS = 20;
  // Page 1 has to land before the page count is known, but pages 2..N have no
  // dependency on each other — they were serial only because a while loop is
  // the obvious way to write it. Four in flight turns a 10-page type from ten
  // round trips into four, and the rows are re-sorted in the panel anyway.
  const PAGE_CONCURRENCY = 4;

  // Types that exist for WordPress's own bookkeeping rather than for the user,
  // plus elementor_library — the Templates filter already lists that through
  // Elementor's own endpoint, which knows about template *type* in a way
  // wp/v2 does not.
  const SKIP_TYPES = new Set([
    "attachment",
    "elementor_library",
    "nav_menu_item",
    "revision",
    "wp_block",
    "wp_font_face",
    "wp_font_family",
    "wp_global_styles",
    "wp_navigation",
    "wp_template",
    "wp_template_part",
  ]);

  // wp-admin labels a row "— Elementor" through the display_post_states filter,
  // and the whole test behind it is one meta key:
  //
  //   Document::is_built_with_elementor()
  //     => (bool) get_meta( '_elementor_edit_mode' )
  //
  // Elementor registers that key with show_in_rest — unconditionally, on
  // rest_api_init, for every post type with 'elementor' support — so the same
  // answer is one field away here.
  //
  // The nested meta.<key> form is load-bearing. _elementor_data is registered on
  // the same object and its value is the entire page document as a string, so
  // asking for a bare "meta" would drag a megabyte down per row. Naming the two
  // keys keeps the payload to what is displayed.
  const FIELDS = [
    "id",
    "title.rendered",
    "link",
    "status",
    "type",
    "modified",
    "meta._elementor_edit_mode",
    "meta._elementor_template_type",
  ].join(",");

  // Those meta keys are edit-context only, and so are drafts. context=edit is
  // what makes both readable; it is also why the nonce matters.
  const listPath = (restBase, page) =>
    `/wp-json/wp/v2/${encodeURIComponent(restBase)}` +
    `?context=edit&status=any&orderby=modified&order=desc` +
    `&per_page=${PER_PAGE}&page=${page}&_fields=${encodeURIComponent(FIELDS)}`;

  // title.rendered is HTML, so "Bob&#8217;s Page" has to be decoded before it
  // reaches a textContent assignment in the panel.
  //
  // DOMParser rather than the usual innerHTML-into-a-textarea trick: this file
  // runs on every wp-admin page, the titles are site data, and assigning
  // untrusted markup to innerHTML is the one thing web-ext lint refuses to let
  // past. Parsing into a detached document neither executes nor attaches
  // anything. The early return keeps it off the common path — most titles carry
  // no entity at all.
  const decodeEntities = (html) => {
    const raw = String(html ?? "");
    if (!raw.includes("&")) return raw;
    const doc = new DOMParser().parseFromString(raw, "text/html");
    return doc.documentElement.textContent || "";
  };

  const shapeItem = (raw, type) => {
    const meta = raw.meta || {};
    // Absent key vs. present-but-empty are different answers. A post type
    // Elementor does not support has no such key registered at all, and
    // reporting that as "not built with Elementor" would be a guess dressed up
    // as a fact — so it stays null and the panel says nothing.
    const known = Object.prototype.hasOwnProperty.call(
      meta,
      "_elementor_edit_mode",
    );
    return {
      kind: type.slug === "page" ? "page" : "other",
      id: raw.id,
      title: decodeEntities(raw.title?.rendered) || "",
      link: raw.link || "",
      status: raw.status || "",
      typeSlug: raw.type || type.slug,
      typeLabel: type.label,
      viewable: type.viewable,
      modified: raw.modified || null,
      elementor: known ? !!meta._elementor_edit_mode : null,
      docType: known ? meta._elementor_template_type || null : null,
    };
  };

  const fetchType = async (type) => {
    const first = await rest.getJson(listPath(type.restBase, 1));
    if (!Array.isArray(first.json)) return { items: [], truncated: false };

    const reported = Number(first.headers.get("X-WP-TotalPages"));
    const total = Number.isFinite(reported) && reported > 0 ? reported : 1;
    const last = Math.min(total, MAX_REQUESTS);

    const batches = [];
    for (let p = 2; p <= last; p += PAGE_CONCURRENCY) {
      batches.push(
        Array.from(
          { length: Math.min(PAGE_CONCURRENCY, last - p + 1) },
          (_, i) => p + i,
        ),
      );
    }

    const raws = [...first.json];
    for (const batch of batches) {
      const got = await Promise.all(
        batch.map((p) => rest.getJson(listPath(type.restBase, p))),
      );
      for (const g of got) if (Array.isArray(g.json)) raws.push(...g.json);
    }

    return {
      items: raws.map((raw) => shapeItem(raw, type)),
      truncated: total > MAX_REQUESTS,
    };
  };

  // No _fields here, and it is not an oversight. This endpoint answers with an
  // object *keyed by slug* rather than an array of records, so _fields filters
  // the top-level keys — `post`, `page`, … — none of which are named `slug` or
  // `rest_base`. Asking for the four fields we want returns `{}` with a 200,
  // which reads as "this site has no post types" and empties the list.
  //
  // Cached for the page's lifetime instead: post types are registered at boot
  // and cannot change under a live tab, so this is one round trip on the first
  // refresh and none on any that follow, including a tab switch. That was the
  // bulk of the saving anyway.
  const TYPES_PATH = "/wp-json/wp/v2/types?context=edit";
  let typesPromise = null;

  const readTypes = () => {
    if (!typesPromise) {
      typesPromise = rest
        .getJson(TYPES_PATH)
        .then(({ json }) =>
          Object.values(json || {})
            .filter((t) => t && t.slug && t.rest_base && !SKIP_TYPES.has(t.slug))
            .map((t) => ({
              slug: t.slug,
              restBase: t.rest_base,
              label: t.name || t.slug,
              // A type WordPress will not render has nothing for a View button
              // to open, so the panel disables it rather than producing a dead
              // link.
              viewable: t.viewable !== false,
            })),
        )
        .catch((err) => {
          typesPromise = null;
          throw err;
        });
    }
    return typesPromise;
  };

  // The panel asks for one tab's worth at a time: Pages sends include:["page"],
  // Other sends exclude:["page"]. Fetching every post type to render one of them
  // was the bulk of what made a refresh slow.
  const listPosts = async ({ include = null, exclude = null } = {}) => {
    if (missing) {
      return {
        ok: false,
        error: `${missing} did not load — check content_scripts order in manifest.json`,
      };
    }
    try {
      const all = await readTypes();
      const types = all.filter(
        (t) =>
          (!include || include.includes(t.slug)) &&
          (!exclude || !exclude.includes(t.slug)),
      );
      const warnings = [];
      const settled = await Promise.all(
        types.map(async (type) => {
          try {
            const { items, truncated } = await fetchType(type);
            if (truncated) {
              warnings.push(
                `${type.label}: showing the first ${PER_PAGE * MAX_REQUESTS}`,
              );
            }
            return items;
          } catch (err) {
            // One post type the account cannot list must not cost the rest of
            // them. Editors routinely lack edit_others_posts on a CPT or two.
            warnings.push(`${type.label}: ${err?.message || err}`);
            return [];
          }
        }),
      );
      return {
        ok: true,
        origin: location.origin,
        posts: settled.flat(),
        types: types.map((t) => ({ slug: t.slug, label: t.label })),
        warnings,
      };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    if (msg.type === "list-posts") return listPosts(msg.options || {});
    return undefined;
  });
})();
