// The panel's answer to "where is this template used?"
//
// The template tag ("TW Hero #4821" — see template-format.js) is an exact link
// from a layer back to the template it came from, and until now nothing could
// read it across documents: the editor only ever sees the page it has open, and
// the tag is buried in `_elementor_data` where no listing endpoint reaches it.
// This walks the whole site and pulls every tag out, so a template row in the
// panel can say which pages carry it.
//
// Runs on every /wp-admin/ page INCLUDING the editor, the same guard
// Tools/wp-pages.js uses, so either kind of tab the panel finds can serve it.
//
// It owns its own post-type walk rather than reusing list-posts, deliberately:
//   - list-posts excludes elementor_library, and a template holding another
//     template's block is an ordinary case this has to see
//   - reading `_elementor_data` needs each type's rest_base, which list-posts
//     does not return — and fetching /wp/v2/types is most of what the walk is
//   - list-posts answers one message with the whole result; this one has to be
//     driven in chunks so the panel's status line can move during a scan
//
// It shares nothing with Component/. That folder answers a different question
// (which components exist and how they descend from each other) with a similar
// walk, and the two are kept apart so deleting Component/ still removes the
// component system outright and leaves this working.
(() => {
  if (!location.pathname.includes("/wp-admin/")) return;

  const fmt = window.__ElementorTemplateFormat;
  const rest = window.__WpRest;
  // Registered even when a dependency is missing, so a load-order mistake
  // reports itself in the panel instead of looking like "no WordPress tab
  // open". Same guard as Tools/admin-templates.js.
  const missing = !fmt
    ? "template-format.js"
    : !rest
      ? "Tools/wp-rest.js"
      : null;

  const PER_PAGE = 100; // WP core's hard maximum for a collection request.
  const MAX_REQUESTS = 20; // 2000 rows of one type is past useful; truncation is reported.
  const LIST_CONCURRENCY = 4;

  // How many documents' `_elementor_data` ride in one request. This is the
  // expensive half: a rich page's data is 50-300KB, so ten of them is already a
  // few megabytes on the wire. Ten per request with three in flight keeps one
  // response from stalling for a minute while still saturating the connection.
  const READ_BATCH = 10;
  const READ_CONCURRENCY = 3;

  // WordPress's own bookkeeping types. elementor_library is deliberately NOT
  // here — unlike Tools/wp-pages.js, which skips it because the panel's
  // Templates tab lists it through Elementor's own endpoint, this scan needs it
  // twice over: a template can hold another template's tagged block, and the
  // set of library ids is what tells a usage from an orphan.
  const SKIP_TYPES = new Set([
    "attachment",
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

  // modified_gmt rather than modified, because it is the cache's change key and
  // a timezone-free clock is the only kind two stamps can be compared on.
  //
  // Naming the meta key is load-bearing for the reason wp-pages.js documents,
  // only more so here: `_elementor_data` is registered on the same meta object,
  // so a bare `meta` on the cheap pass would drag every document's full content
  // down — which is the entire cost this pass exists to avoid.
  const LIST_FIELDS = [
    "id",
    "title.rendered",
    "link",
    "status",
    "type",
    "modified_gmt",
    "meta._elementor_edit_mode",
  ].join(",");

  // context=edit is mandatory: those meta keys are edit-context only, and so are
  // drafts. It is also why the nonce matters.
  const listPath = (restBase, page) =>
    `/wp-json/wp/v2/${encodeURIComponent(restBase)}` +
    `?context=edit&status=any&orderby=modified&order=desc` +
    `&per_page=${PER_PAGE}&page=${page}&_fields=${encodeURIComponent(LIST_FIELDS)}`;

  const readPath = (restBase, ids) =>
    `/wp-json/wp/v2/${encodeURIComponent(restBase)}` +
    `?context=edit&status=any&include=${ids.join(",")}` +
    `&per_page=${Math.max(ids.length, 1)}` +
    `&_fields=${encodeURIComponent("id,meta._elementor_data")}`;

  // Titles are site-supplied HTML on every admin page. DOMParser rather than
  // innerHTML for the reason wp-pages.js documents: web-ext lint refuses an
  // innerHTML assignment outright, and parsing into a detached document neither
  // executes nor attaches anything.
  const decodeEntities = (html) => {
    const raw = String(html ?? "");
    if (!raw.includes("&")) return raw;
    const doc = new DOMParser().parseFromString(raw, "text/html");
    return doc.documentElement.textContent || "";
  };

  /* ------------------------------------------------------------------ types */

  // No _fields, and it is not an oversight — see the long note in
  // Tools/wp-pages.js. This endpoint answers with an object keyed by slug, so
  // _fields filters the top-level keys and returns {} with a 200, which reads as
  // "this site has no post types".
  //
  // Cached for the tab's lifetime: post types are registered at boot and cannot
  // change under a live tab, so a scan pays for this once.
  let typesPromise = null;
  const readTypes = () => {
    if (!typesPromise) {
      typesPromise = rest
        .getJson("/wp-json/wp/v2/types?context=edit")
        .then(({ json }) =>
          Object.values(json || {})
            .filter((t) => t && t.slug && t.rest_base && !SKIP_TYPES.has(t.slug))
            .map((t) => ({
              slug: t.slug,
              restBase: t.rest_base,
              label: t.name || t.slug,
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

  /* -------------------------------------------------------------- cheap pass */

  const shapeDoc = (raw, type) => {
    const meta = raw.meta || {};
    // Absent key and empty value are different answers, exactly as wp-pages.js
    // documents: a post type Elementor does not support has no such key
    // registered at all, so it stays null rather than being reported as a fact.
    const known = Object.prototype.hasOwnProperty.call(
      meta,
      "_elementor_edit_mode",
    );
    return {
      id: String(raw.id),
      title: decodeEntities(raw.title?.rendered) || "",
      link: raw.link || "",
      status: raw.status || "",
      typeSlug: raw.type || type.slug,
      typeLabel: type.label,
      restBase: type.restBase,
      viewable: type.viewable,
      isTemplate: type.slug === "elementor_library",
      modifiedGmt: raw.modified_gmt || "",
      elementor: known ? !!meta._elementor_edit_mode : null,
    };
  };

  const listType = async (type) => {
    const first = await rest.getJson(listPath(type.restBase, 1));
    if (!Array.isArray(first.json)) return { docs: [], truncated: false };

    const reported = Number(first.headers.get("X-WP-TotalPages"));
    const total = Number.isFinite(reported) && reported > 0 ? reported : 1;
    const last = Math.min(total, MAX_REQUESTS);

    const raws = [...first.json];
    // Page 1 has to land before the page count is known, but pages 2..N have no
    // dependency on each other.
    for (let p = 2; p <= last; p += LIST_CONCURRENCY) {
      const batch = Array.from(
        { length: Math.min(LIST_CONCURRENCY, last - p + 1) },
        (_, i) => p + i,
      );
      const got = await Promise.all(
        batch.map((n) => rest.getJson(listPath(type.restBase, n))),
      );
      for (const g of got) if (Array.isArray(g.json)) raws.push(...g.json);
    }

    return {
      docs: raws.map((raw) => shapeDoc(raw, type)),
      truncated: total > MAX_REQUESTS,
    };
  };

  // Every Elementor-built document on the site with the stamp that decides
  // whether its content has to be re-read. This is the pass that makes
  // cache-and-diff affordable: a few hundred small rows, and it is what the
  // expensive pass is filtered by.
  //
  // `templateIds` rides along separately and is taken BEFORE the Elementor
  // filter. It is the set an orphan tag is judged against, so it has to mean
  // "every template on this site" — narrowing it to Elementor-built ones would
  // report a tag pointing at a perfectly good template as broken.
  const listDocs = async () => {
    const types = await readTypes();
    const warnings = [];
    const settled = await Promise.all(
      types.map(async (type) => {
        try {
          const { docs, truncated } = await listType(type);
          if (truncated) {
            warnings.push(
              `${type.label}: only the first ${PER_PAGE * MAX_REQUESTS} were listed`,
            );
          }
          return docs;
        } catch (err) {
          // One post type the account cannot list must not cost the rest.
          // Editors routinely lack edit_others_posts on a CPT or two.
          warnings.push(`${type.label}: ${err?.message || err}`);
          return [];
        }
      }),
    );
    const all = settled.flat();
    const templateIds = all.filter((d) => d.isTemplate).map((d) => d.id);
    // `elementor === null` means the type has no Elementor support at all, so
    // there is no `_elementor_data` to read and no layer name to carry a tag.
    const docs = all.filter((d) => d.elementor === true);
    return { ok: true, origin: location.origin, docs, templateIds, warnings };
  };

  /* ---------------------------------------------------- the expensive pass */

  const tagsFromData = (raw, isTemplate) => {
    if (!raw) return { usages: [], error: null };
    let elements;
    try {
      elements = JSON.parse(raw);
    } catch (_) {
      // Reported rather than treated as "no tags here" — an unparseable document
      // is a fact about the document, and calling it empty would quietly drop
      // every usage in it.
      return { usages: [], error: "_elementor_data did not parse" };
    }
    return {
      usages: fmt.findTemplateTags(elements, { isTemplate }),
      error: null,
    };
  };

  // Read the content of specific documents and pull their tags. `targets` is
  // [{ id, restBase, isTemplate }] — the caller has already diffed against its
  // cache, so this only ever sees documents whose stamp actually moved.
  //
  // `isTemplate` has to travel with the target: it is what turns on the depth-0
  // exclusion, and this side cannot re-derive it without the type listing.
  const readDocs = async ({ targets } = {}) => {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) return { ok: true, results: {}, warnings: [] };

    // Grouped by rest base because `include` is per collection endpoint, and
    // batching is the whole reason a scan is seconds rather than minutes: one
    // request carries ten documents instead of one.
    const byBase = new Map();
    const templateFlag = new Map();
    for (const t of list) {
      if (!t?.restBase) continue;
      const id = String(t.id);
      templateFlag.set(id, !!t.isTemplate);
      if (!byBase.has(t.restBase)) byBase.set(t.restBase, []);
      byBase.get(t.restBase).push(id);
    }

    const jobs = [];
    for (const [base, ids] of byBase) {
      for (let i = 0; i < ids.length; i += READ_BATCH) {
        jobs.push({ base, ids: ids.slice(i, i + READ_BATCH) });
      }
    }

    const results = {};
    const warnings = [];
    for (let i = 0; i < jobs.length; i += READ_CONCURRENCY) {
      const slice = jobs.slice(i, i + READ_CONCURRENCY);
      const got = await Promise.all(
        slice.map(async (job) => {
          try {
            const { json } = await rest.getJson(readPath(job.base, job.ids));
            return { job, rows: Array.isArray(json) ? json : [] };
          } catch (err) {
            // A whole batch failing must not abandon the scan. The documents in
            // it keep their previous cache entry, and the run says so.
            warnings.push(
              `${job.base} (${job.ids.length} doc(s)): ${err?.message || err}`,
            );
            return { job, rows: null };
          }
        }),
      );
      for (const { job, rows } of got) {
        if (!rows) continue;
        const seen = new Set();
        for (const row of rows) {
          const id = String(row.id);
          seen.add(id);
          results[id] = tagsFromData(
            row?.meta?._elementor_data,
            templateFlag.get(id) === true,
          );
        }
        // A document asked for and not returned was deleted, trashed out of
        // `include`'s reach, or is unreadable by this account. Recording it as
        // empty is wrong — it would silently drop that document's usages — so it
        // is reported and its cache entry is kept.
        for (const id of job.ids) {
          if (!seen.has(id)) warnings.push(`document ${id} was not returned`);
        }
      }
    }
    return { ok: true, results, warnings };
  };

  /* --------------------------------------------------------------- transport */

  const guard = async (fn) => {
    if (missing) {
      return {
        ok: false,
        error: `${missing} did not load — check content_scripts order in manifest.json`,
      };
    }
    try {
      return await fn();
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  };

  // Two messages and nothing else. `ping` is deliberately not answered:
  // core_utils.js owns it in the editor and admin-templates.js owns it on a
  // plain admin page, and a third listener replying to it would mean two
  // replies racing, of which browser.tabs.sendMessage keeps whichever lands
  // first. Same reason Tools/wp-pages.js stays silent on it.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    if (msg.type === "usage-list-docs") return guard(listDocs);
    if (msg.type === "usage-read-docs") {
      return guard(() => readDocs(msg.options || {}));
    }
    return undefined;
  });
})();
