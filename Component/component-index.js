// Component system — the site-wide index.
//
// Answers "where does every component on this site live?", which no other part
// of the toolset can: the editor only ever sees the document it has open, and
// the panel has no WordPress credentials of its own.
//
// Runs on every /wp-admin/ page INCLUDING the editor, the same guard
// Tools/wp-pages.js uses, so either kind of tab the panel finds can serve it.
//
// It owns its own post-type walk rather than reusing list-posts, and that is a
// decision rather than an oversight:
//   - a content script cannot call another content script's message listener,
//     so only the panel could have driven the reuse, which would have put the
//     caching in UI/panel.js and broken "delete Component/, lose the feature"
//   - list-posts deliberately excludes elementor_library, where every base
//     lives, so templates needed a second fetch either way
//   - reading _elementor_data needs each type's rest_base, which list-posts
//     does not return — and fetching /wp/v2/types is most of what the walk is
//
// Two consumers, one world. The panel reaches it by runtime message; the
// in-editor overlay reads window.__ElementorComponentIndex directly, because a
// content script CAN share a global with another content script in the same
// tab. That is the same seam __WpRest is reached through.
(() => {
  if (!location.pathname.includes("/wp-admin/")) return;

  const fmt = window.__ElementorComponentFormat;
  const rest = window.__WpRest;
  // Registered even when a dependency is missing, so a load-order mistake
  // reports itself in the panel instead of looking like "no WordPress tab
  // open". Same guard as Tools/admin-templates.js.
  const missing = !fmt
    ? "Component/component-format.js"
    : !rest
      ? "Tools/wp-rest.js"
      : null;

  const PER_PAGE = 100; // WP core's hard maximum for a collection request.
  const MAX_REQUESTS = 20; // 2000 rows of one type is past useful; truncation is reported.
  const LIST_CONCURRENCY = 4;

  // How many documents' _elementor_data ride in one request. This is the only
  // genuinely heavy fetch in the extension: a rich page's data is 50-300KB, so
  // ten of them is already a few megabytes on the wire. Ten at a time with
  // three requests in flight keeps a single response from stalling for a
  // minute while still saturating the connection.
  const READ_BATCH = 10;
  const READ_CONCURRENCY = 3;

  // WordPress's own bookkeeping types. elementor_library is deliberately NOT
  // here — unlike Tools/wp-pages.js, which skips it because the panel's
  // Templates tab lists it through Elementor's endpoint, this index needs it:
  // every base and every parent lives in the template library.
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

  // modified_gmt does double duty and that is the point of choosing it: it is
  // the cache's change key AND the stamp staleness() compares syncedAgainst
  // against. Reusing one clock for both is why the index cannot drift out of
  // agreement with the icons it draws.
  const LIST_FIELDS = [
    "id",
    "title.rendered",
    "link",
    "status",
    "type",
    "modified_gmt",
    "meta._elementor_edit_mode",
    "meta._elementor_template_type",
  ].join(",");

  // Naming the meta key is load-bearing here for the same reason it is in
  // wp-pages.js, only more so: _elementor_data is registered on the same meta
  // object, and a bare `meta` on a listing request would drag the entire
  // document down for every row of the cheap pass.
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
  // innerHTML assignment outright, and parsing into a detached document
  // neither executes nor attaches anything.
  const decodeEntities = (html) => {
    const raw = String(html ?? "");
    if (!raw.includes("&")) return raw;
    const doc = new DOMParser().parseFromString(raw, "text/html");
    return doc.documentElement.textContent || "";
  };

  /* ------------------------------------------------------------------ types */

  // No _fields, and it is not an oversight — see the long note in
  // Tools/wp-pages.js. This endpoint answers with an object keyed by slug, so
  // _fields filters the top-level keys and returns {} with a 200, which reads
  // as "this site has no post types".
  //
  // Cached for the tab's lifetime: post types are registered at boot and
  // cannot change under a live tab.
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
      docType: known ? meta._elementor_template_type || null : null,
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

  // Every Elementor-built document on the site, with the stamp that decides
  // whether its content has to be re-read. This is the pass that makes
  // cache-and-diff affordable: it is a few hundred small rows, and it is what
  // the expensive pass is filtered by.
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
    // `elementor === null` means the type has no Elementor support at all, so
    // there is nothing to read. Only a document Elementor actually built can
    // hold a data widget.
    const docs = settled.flat().filter((d) => d.elementor === true);
    return { ok: true, origin: location.origin, docs, warnings };
  };

  /* ---------------------------------------------------- the expensive pass */

  const componentsFromData = (raw) => {
    if (!raw) return { components: [], broken: [], error: null };
    let elements;
    try {
      elements = JSON.parse(raw);
    } catch (err) {
      return { components: [], broken: [], error: "_elementor_data did not parse" };
    }
    const { found, broken } = fmt.findAllComponents(elements);
    return {
      components: found.map((f) =>
        fmt.slimComponent(f.payload, {
          widgetId: f.widgetId,
          rootNodeId: f.rootNodeId,
          rootTitle: f.rootTitle,
          depth: f.depth,
        }),
      ),
      broken,
      error: null,
    };
  };

  // Read the content of specific documents and extract their components.
  // `targets` is [{ id, restBase }] — the caller has already diffed against its
  // cache, so this only ever sees documents that actually changed.
  const readDocs = async ({ targets } = {}) => {
    const list = Array.isArray(targets) ? targets : [];
    if (!list.length) return { ok: true, results: {}, warnings: [] };

    // Grouped by rest base because `include` is per collection endpoint, and
    // batching is the whole reason this is minutes rather than hours: one
    // request carries ten documents instead of one.
    const byBase = new Map();
    for (const t of list) {
      const base = t.restBase;
      if (!base) continue;
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(String(t.id));
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
            // A whole batch failing must not abandon the scan. The documents
            // in it keep their previous cache entry, and the run says so.
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
          seen.add(String(row.id));
          results[String(row.id)] = componentsFromData(row?.meta?._elementor_data);
        }
        // A document asked for and not returned was deleted, trashed out of
        // `include`'s reach, or is unreadable by this account. Recording it as
        // empty is wrong — it would silently drop that document's components
        // from the tree — so it is reported and its cache entry is kept.
        for (const id of job.ids) {
          if (!seen.has(id)) warnings.push(`document ${id} was not returned`);
        }
      }
    }
    return { ok: true, results, warnings };
  };

  /* ----------------------------------------------- the component template list

     What the in-editor Insert picker offers. Only the template library can be
     a parent — an instance sitting on a page can never be one — so this is a
     far smaller scan than the whole site, and it is what makes the picker
     usable before anyone has ever pressed Refresh. */

  const listComponentTemplates = async () => {
    const types = await readTypes();
    const library = types.find((t) => t.slug === "elementor_library");
    if (!library) {
      return { ok: false, error: "this site has no elementor_library post type" };
    }
    const { docs } = await listType(library);
    const live = docs.filter((d) => d.elementor === true);
    const { results, warnings } = await readDocs({
      targets: live.map((d) => ({ id: d.id, restBase: d.restBase })),
    });

    const templates = [];
    for (const doc of live) {
      const found = results[doc.id];
      if (!found || found.error) continue;
      // The template's OWN component is the outermost one in it. Anything
      // nested deeper is an instance this template merely contains, and
      // inserting the template would bring it along rather than target it.
      const own = (found.components || []).reduce(
        (a, b) => (a === null || b.depth < a.depth ? b : a),
        null,
      );
      if (!own) continue;
      templates.push({
        templateId: doc.id,
        title: doc.title,
        status: doc.status,
        modifiedGmt: doc.modifiedGmt,
        docType: doc.docType,
        name: own.name,
        role: own.role,
        componentId: own.id,
        overrideCount: own.overrideCount,
      });
    }
    templates.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return { ok: true, templates, warnings };
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

  // Reached directly by the in-editor overlay, which shares this world.
  window.__ElementorComponentIndex = {
    listDocs: () => guard(listDocs),
    readDocs: (opts) => guard(() => readDocs(opts)),
    listComponentTemplates: () => guard(listComponentTemplates),
  };

  // Reached by the panel, which does not. Returns undefined for anything else
  // so the other listeners in this tab stay free to answer their own messages.
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorComponents !== true) return undefined;
    if (msg.type === "index-list-docs") return guard(listDocs);
    if (msg.type === "index-read-docs") return guard(() => readDocs(msg.options || {}));
    if (msg.type === "index-list-component-templates") {
      return guard(listComponentTemplates);
    }
    return undefined;
  });
})();
