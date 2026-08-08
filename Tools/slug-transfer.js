// The slug + SEO transfer, run entirely against WordPress's own REST endpoints.
//
// NOTHING IS INSTALLED ON THE SITE. There is no companion plugin, no mu-plugin,
// no theme edit — which also means no hooks of our own, because a WordPress hook
// has to be registered during WordPress's PHP boot and there is no way to do that
// from here. What we do instead is call the endpoints WordPress and Rank Math
// already register, so every write goes through `wp_update_post` /
// `update_post_meta` and fires the normal `post_updated` / `save_post` chain.
//
// Two sources, because one is not enough:
//
//   slug  →  /wp/v2/<type>          (core; post_name is core's own field)
//   SEO   →  /rankmath/v1/updateMeta
//
// Core REST does NOT expose Rank Math's meta — verified on this install, a page's
// `meta` object carries seven keys and none of them is rank_math_*. So the SEO
// half cannot go through /wp/v2at all. Rank Math registers its own route for
// exactly this, which is what its editor sidebar posts to.
//
// Runs on every wp-admin page INCLUDING the editor, since the editor's own URL is
// /wp-admin/post.php?...&action=elementor — one guard covers both kinds of tab the
// panel might find. It answers `slug-transfer` and nothing else; core_utils.js and
// admin-templates.js each own `ping` for their page type, and a third listener
// replying to one message means two replies racing.
(() => {
  if (!location.pathname.includes("/wp-admin/")) return;

  const rest = window.__WpRest;
  // Registered even without it, so a load-order problem reports itself in the
  // panel rather than looking like "no WordPress tab open".
  const missing = rest ? null : "Tools/wp-rest.js";

  const RM_UPDATE_META = "/wp-json/rankmath/v1/updateMeta";
  const RM_TITLE_KEY = "rank_math_title";
  const RM_DESC_KEY = "rank_math_description";
  const SETTINGS_PATH = "/wp-json/wp/v2/settings";
  const RM_OPTIONS_PAGE = "/wp-admin/admin.php?page=rank-math-options-general";

  const ALT_SUFFIX = "-alt";

  /* ---------------------------------------------------------------------
   * Rank Math's auto-redirect, which is the whole reason this file is careful
   * ------------------------------------------------------------------ */

  // Rank Math's "auto redirect on slug change" mints a 301 from a published
  // post's OLD slug whenever that slug changes. That is fatal here and in one
  // specific place: freeing `about-introhive` by renaming its current holder to
  // `about-introhive-alt` creates a 301 from `/about-introhive/` — the exact path
  // the new page is about to take. The transfer then completes, saves cleanly,
  // reports success, and every visitor to the new URL is sent to the old page.
  //
  // A companion plugin could dodge this by writing post_name directly and never
  // firing `post_updated`. From out here there is no such option: every route to
  // a slug change goes through wp_update_post. So the run REFUSES while the
  // setting is on, and says where to turn it off.
  //
  // The setting is read, never written. Rank Math keeps it inside one large
  // serialised options blob, and posting a partial shape at
  // /rankmath/v1/updateSettings risks flattening two hundred unrelated settings —
  // a far worse outcome than asking for one checkbox to be flipped.
  const readAutoRedirect = async () => {
    try {
      const res = await fetch(RM_OPTIONS_PAGE, { credentials: "same-origin" });
      if (!res.ok) return { value: null, why: `settings page returned ${res.status}` };
      const html = await res.text();
      const match = html.match(/"redirections_post_redirect"\s*:\s*(true|false)/);
      if (!match) {
        return { value: null, why: "could not find redirections_post_redirect" };
      }
      return { value: match[1] === "true", why: "" };
    } catch (err) {
      return { value: null, why: err?.message || String(err) };
    }
  };

  /* ---------------------------------------------------------------------
   * Types
   * ------------------------------------------------------------------ */

  // Cached for the tab's lifetime: post types are registered at boot and cannot
  // change under a live tab. Same reasoning, and the same trap avoided, as
  // Tools/wp-pages.js — do NOT add _fields to this endpoint, it answers with an
  // object keyed by slug and _fields would filter it down to {}.
  let typesPromise = null;
  const readTypes = () => {
    if (!typesPromise) {
      typesPromise = rest
        .getJson("/wp-json/wp/v2/types?context=edit")
        .then(({ json }) =>
          Object.values(json || {})
            .filter((t) => t && t.slug && t.rest_base)
            .map((t) => ({
              slug: t.slug,
              restBase: t.rest_base,
              label: t.name || t.slug,
              hierarchical: !!t.hierarchical,
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

  // Which types a `new_page` URL could plausibly name. `page` first because every
  // row in this migration is one, then the other viewable types — so a CSV that
  // later points at a `resource` or a `news` still resolves, without asking
  // nineteen endpoints per row.
  const lookupTypes = async () => {
    const all = await readTypes();
    const page = all.filter((t) => t.slug === "page");
    const rest_ = all.filter(
      (t) => t.slug !== "page" && t.viewable && t.slug !== "attachment",
    );
    return [...page, ...rest_];
  };

  // `status` is a parameter and not a constant because `any` is NOT universally
  // accepted: /wp/v2/media answers `rest_invalid_param` for it, since attachments
  // only ever register inherit/private/trash and the collection's enum is built
  // from that. Verified live — the whole collision search died on a 400 until
  // this was split. Everything else takes `any`, which is what makes drafts
  // visible.
  const ANY_STATUS = "any";
  const MEDIA_STATUS = "inherit,private";

  const listBy = async (restBase, query, status = ANY_STATUS) => {
    const { json } = await rest.getJson(
      `/wp-json/wp/v2/${encodeURIComponent(restBase)}` +
        `?context=edit&status=${encodeURIComponent(status)}` +
        `&per_page=100&${query}` +
        `&_fields=id,slug,status,type,parent,title,link`,
    );
    return Array.isArray(json) ? json : [];
  };

  const shape = (raw) => ({
    id: raw.id,
    title: String(raw.title?.raw ?? raw.title?.rendered ?? ""),
    slug: String(raw.slug || ""),
    post_type: String(raw.type || ""),
    status: String(raw.status || ""),
    parent: Number(raw.parent || 0),
    edit_link: `${location.origin}/wp-admin/post.php?post=${raw.id}&action=edit`,
  });

  /* ---------------------------------------------------------------------
   * Resolving a row's new_page to a post
   * ------------------------------------------------------------------ */

  // The full path a post is served at, walked up through its parents. Only called
  // when a row's path has more than one segment, so the common case costs no
  // extra requests at all.
  const pathOf = async (post, restBase) => {
    const parts = [post.slug];
    let parent = post.parent;
    let guard = 0;
    while (parent && guard < 10) {
      guard += 1;
      const found = await listBy(restBase, `include=${parent}`);
      if (!found.length) break;
      parts.unshift(String(found[0].slug || ""));
      parent = Number(found[0].parent || 0);
    }
    return parts.join("/");
  };

  // Only the PATH is used, never the host. The CSV was written against a Kinsta
  // staging host and staging hosts get renamed; matching on the host would make
  // every row unresolvable the day the site moves. A disagreement is reported as
  // a note so the mismatch stays visible rather than being assumed away.
  const resolveTarget = async (url) => {
    const notes = [];
    let parsed;
    try {
      parsed = new URL(url, location.origin);
    } catch (_) {
      return { post: null, error: "new_page is not a URL", notes };
    }
    if (parsed.host && parsed.host !== location.host) {
      notes.push(
        `CSV names ${parsed.host}; this site is ${location.host} — matched on the path only`,
      );
    }
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (!path) {
      return {
        post: null,
        error: "new_page is the site root, which has no slug to set",
        notes,
      };
    }
    const segments = path.split("/");
    const name = segments[segments.length - 1];

    for (const type of await lookupTypes()) {
      const found = await listBy(type.restBase, `slug=${encodeURIComponent(name)}`);
      if (!found.length) continue;

      // A slug is only unique within its parent, so several posts of one type can
      // answer to the last segment. Keep the ones whose whole path matches.
      let exact = found;
      if (segments.length === 1) {
        exact = found.filter((p) => Number(p.parent || 0) === 0);
      } else if (found.length > 1) {
        const resolved = [];
        for (const p of found) {
          if ((await pathOf(p, type.restBase)) === path) resolved.push(p);
        }
        exact = resolved;
      }
      const candidates = exact.length ? exact : found;

      if (candidates.length > 1) {
        // Reported, never guessed. Picking one would be picking which live page
        // gets its URL rewritten.
        const labels = candidates.map(
          (p) => `#${p.id} (${p.type}, ${p.status})`,
        );
        return {
          post: null,
          error: `/${path}/ is ambiguous — ${labels.join(", ")}`,
          notes,
        };
      }
      if (!exact.length) {
        notes.push(
          "matched on the last path segment; check the row if this page is nested",
        );
      }
      return { post: shape(candidates[0]), error: "", notes, type };
    }
    return { post: null, error: `no post found at /${path}/`, notes };
  };

  /* ---------------------------------------------------------------------
   * Resolving a row's parent
   * ------------------------------------------------------------------ */

  // post_parent is an INTEGER POST ID. WordPress stores no path anywhere: the
  // URL /solutions/legal/ is the page `legal` whose post_parent points at the row
  // whose post_name is `solutions`, and get_page_uri() walks that chain to build
  // the string. So the CSV's bare slug is authoring shorthand and has to be
  // resolved to an id before anything is written.
  //
  // Restricted to TOP-LEVEL pages, and that restriction is what makes the lookup
  // deterministic. A slug is only unique within its own parent, so `?slug=platform`
  // can legitimately answer with several pages at different depths; picking one
  // would be picking which subtree the run adopts. Zero hits and more than one
  // are both hard errors, for the same reason resolveTarget refuses an ambiguous
  // path rather than guessing.
  const parentCache = new Map();
  const resolveParentSlug = async (slug, restBase) => {
    const key = `${restBase}|${slug}`;
    if (parentCache.has(key)) return parentCache.get(key);

    let out;
    try {
      const found = (await listBy(restBase, `slug=${encodeURIComponent(slug)}`))
        .map(shape)
        .filter((p) => p.parent === 0);

      if (!found.length) {
        out = { id: 0, error: `no top-level page has the slug "${slug}"` };
      } else if (found.length > 1) {
        out = {
          id: 0,
          error:
            `"${slug}" is ambiguous — ` +
            found.map((p) => `#${p.id} (${p.status})`).join(", "),
        };
      } else if (found[0].status !== "publish") {
        // A draft parent builds the child's URL perfectly well and then 404s it
        // for every logged-out visitor. That is worse than a missing parent,
        // because the run reports success and the page looks fine while signed
        // in — so it fails the check rather than warning.
        out = {
          id: 0,
          error: `"${slug}" is #${found[0].id} but its status is "${found[0].status}" — publish it first`,
        };
      } else {
        out = { id: found[0].id, error: "", post: found[0] };
      }
    } catch (err) {
      out = { id: 0, error: `could not look up "${slug}" — ${err?.message || err}` };
    }

    parentCache.set(key, out);
    return out;
  };

  /* ---------------------------------------------------------------------
   * Who actually collides
   * ------------------------------------------------------------------ */

  // WordPress's own uniqueness rule, not a wider guess. wp_unique_post_slug()
  // compares, for a hierarchical type:
  //
  //   post_name = X AND post_type IN ( <type>, 'attachment' ) AND post_parent = P
  //
  // So a `post` named `careers` does NOT collide with a `page` named `careers` —
  // WordPress is happy to hold both — and renaming it would be pure collateral
  // damage. Attachments DO collide though, and at the same parent, which is the
  // one easy thing to miss here: an unnoticed media item on the slug is enough to
  // turn the target's write into `careers-2`.
  //
  // `destParent` is the parent the target is about to have, NOT the one it has
  // now. Once a row can move a page, those are different numbers, and asking the
  // question at the current parent frees the slug at a level nobody is moving to
  // while leaving it occupied at the level that matters — which turns the write
  // into `legal-2` at exactly the moment the run believes it succeeded.
  const findCollisions = async (slug, target, type, destParent) => {
    const hits = [];
    const bases = [[type.restBase, ANY_STATUS]];
    if (type.hierarchical) {
      const all = await readTypes();
      const media = all.find((t) => t.slug === "attachment");
      if (media) bases.push([media.restBase, MEDIA_STATUS]);
    }
    for (const [base, status] of bases) {
      for (const raw of await listBy(
        base,
        `slug=${encodeURIComponent(slug)}`,
        status,
      )) {
        if (Number(raw.id) === Number(target.id)) continue;
        const info = shape(raw);
        if (type.hierarchical && info.parent !== destParent) {
          // Same slug under a different parent is a different URL and no
          // collision at all. Reported so it is visible, never touched.
          info.why = "same slug under a different parent — no collision, left alone";
          hits.push({ ...info, collides: false });
        } else {
          info.rename_to = slug + ALT_SUFFIX;
          hits.push({ ...info, collides: true });
        }
      }
    }
    return hits;
  };

  /* ---------------------------------------------------------------------
   * Writes
   * ------------------------------------------------------------------ */

  const restBaseOf = async (postType) => {
    const all = await readTypes();
    const found = all.find((t) => t.slug === postType);
    return found ? found.restBase : "pages";
  };

  // Returns what WordPress actually stored, for both fields. It is compared
  // against what was asked for rather than trusted: a slug mismatch means
  // something still holds the slug, and the page is now on a URL the CSV never
  // named.
  const writePost = async (post, fields) => {
    const base = await restBaseOf(post.post_type);
    const json = await rest.postJson(
      `/wp-json/wp/v2/${encodeURIComponent(base)}/${post.id}`,
      fields,
    );
    return {
      slug: String(json?.slug || ""),
      parent: Number(json?.parent || 0),
    };
  };

  const writeSlug = async (post, slug) => (await writePost(post, { slug })).slug;

  // Rank Math's own route. objectType 'post' covers every post type — it
  // distinguishes posts from terms and users, not pages from CPTs.
  const writeSeo = async (postId, meta) => {
    const json = await rest.postJson(RM_UPDATE_META, {
      objectID: postId,
      objectType: "post",
      meta,
    });
    return json;
  };

  const readFrontPage = async () => {
    const { json } = await rest.getJson(SETTINGS_PATH);
    return {
      showOnFront: json?.show_on_front || "",
      pageOnFront: Number(json?.page_on_front || 0),
    };
  };

  const writeFrontPage = async (pageId) => {
    const json = await rest.postJson(SETTINGS_PATH, { page_on_front: pageId });
    return Number(json?.page_on_front || 0);
  };

  /* ---------------------------------------------------------------------
   * Plan
   * ------------------------------------------------------------------ */

  const planRow = async (row, front, providers) => {
    const plan = {
      slug: String(row.slug || ""),
      line: Number(row.line || 0),
      new_page: String(row.new_page || ""),
      permanent_url: String(row.permanent_url || ""),
      parent_slug: String(row.parent || ""),
      target: null,
      error: "",
      parent_error: "",
      notes: [],
      slug_action: "skip",
      parent_action: "none",
      parent_from: 0,
      parent_to: 0,
      parent_via_line: 0,
      renames: [],
      same_name: [],
      seo: [],
      front_page: null,
    };
    if (!plan.slug) {
      plan.error = "row has no slug";
      return plan;
    }

    const { post, error, notes, type } = await resolveTarget(plan.new_page);
    plan.notes = notes;
    if (!post) {
      plan.error = error;
      return plan;
    }
    plan.target = post;
    plan.target.path = await pathOf(post, type.restBase);

    // Where this page is going to live. ONLY the parent column decides — the
    // permanent_url is stale on this export and several rows deliberately
    // disagree with it. A blank cell is a real answer meaning "top-level", not
    // an absence, which is why the column itself is mandatory.
    plan.parent_from = post.parent;
    if (plan.parent_slug) {
      // A parent named by another row of this same CSV resolves to THAT row's
      // target, not to whatever holds the slug today. The page already exists —
      // only its slug is changing — so the id is known now and there is no
      // ordering problem in resolving it here. Pass A is about to rename the
      // page that currently answers to this slug, and nesting children under
      // the page being retired is exactly the wrong answer.
      const via = providers.get(plan.parent_slug);
      if (via && via.line !== plan.line) {
        plan.parent_to = via.id;
        plan.parent_via_line = via.line;
      } else {
        const resolved = await resolveParentSlug(plan.parent_slug, type.restBase);
        plan.parent_to = resolved.id;
        plan.parent_error = resolved.error;
      }
      if (plan.parent_to && plan.parent_to === post.id) {
        plan.parent_error = "a page cannot be its own parent";
        plan.parent_to = 0;
      }
    }

    if (!plan.parent_error && plan.parent_to !== plan.parent_from) {
      plan.parent_action = "set";
    }

    // The guard the whole run hangs on. A target that already holds its slug is
    // left alone — without it a second run treats the page's own slug as
    // occupied, by the page itself, renames it to "-alt", and the transfer eats
    // its own work. Re-running has to be safe, because that is exactly what
    // happens when one row fails and the CSV is corrected.
    //
    // The collision question is asked at the DESTINATION parent, since that is
    // where the slug has to be free.
    if (post.slug === plan.slug && plan.parent_action === "none") {
      plan.slug_action = "already";
    } else if (post.slug === plan.slug) {
      // Right slug, wrong place. The move can still collide at the destination,
      // so the occupants are searched for even though the slug is not changing.
      plan.slug_action = "already";
      for (const hit of await findCollisions(plan.slug, post, type, plan.parent_to)) {
        if (hit.collides) plan.renames.push(hit);
        else plan.same_name.push(hit);
      }
    } else {
      plan.slug_action = "set";
      for (const hit of await findCollisions(plan.slug, post, type, plan.parent_to)) {
        if (hit.collides) plan.renames.push(hit);
        else plan.same_name.push(hit);
      }
    }

    // The front page is defined by which post `page_on_front` names. When the
    // page being moved out of the way IS that post, the transfer is handing its
    // identity to the new page and the setting has to follow — otherwise the
    // slugs move and the site's homepage silently stays the old page. Derived
    // rather than configured, and shown as its own line so it is never a
    // surprise: the plan review is what authorises it.
    const displaced = plan.renames.find((r) => r.id === front.pageOnFront);
    if (displaced && front.showOnFront === "page") {
      plan.front_page = {
        from: front.pageOnFront,
        from_title: displaced.title,
        to: post.id,
        to_title: post.title,
      };
    }

    // An empty CSV cell means "this row carries no SEO", not "blank the page's
    // SEO". Two rows in the current export are in that shape.
    //
    // There is no `current` here and there cannot be: Rank Math's meta is not
    // readable through core REST, and its own route only writes. So the value is
    // written unconditionally rather than compared — which is idempotent, just
    // less talkative than a diff would have been.
    for (const [field, source, key] of [
      ["title", "seo_title", RM_TITLE_KEY],
      ["desc", "seo_description", RM_DESC_KEY],
    ]) {
      const value = String(row[source] ?? "").trim();
      plan.seo.push(
        value
          ? { field, value, meta_key: key, action: "set" }
          : { field, value: "", action: "none-in-csv" },
      );
    }

    return plan;
  };

  /* ---------------------------------------------------------------------
   * Run
   * ------------------------------------------------------------------ */

  const runTransfer = async ({ rows = [], dryRun = true } = {}) => {
    if (missing) {
      return {
        ok: false,
        error: `${missing} did not load — check content_scripts order in manifest.json`,
      };
    }
    if (!Array.isArray(rows) || !rows.length) {
      return { ok: false, error: "No rows — load the CSV first" };
    }

    try {
      const [front, auto] = await Promise.all([
        readFrontPage(),
        readAutoRedirect(),
      ]);

      // Which rows hand a parent slug to another row. Resolved up front because
      // planRow needs the answer while it is planning, and the page in question
      // already exists — only its slug is changing — so its id is knowable now.
      // Empty on a CSV where no parent is also a target, which is the normal
      // case and costs nothing.
      const wanted = new Set(
        rows.map((r) => String(r.parent || "")).filter(Boolean),
      );
      const providers = new Map();
      for (const row of rows) {
        const slug = String(row.slug || "");
        if (!slug || !wanted.has(slug) || providers.has(slug)) continue;
        const { post } = await resolveTarget(String(row.new_page || ""));
        if (post) providers.set(slug, { id: post.id, line: Number(row.line || 0) });
      }

      const plans = [];
      for (const row of rows) plans.push(await planRow(row, front, providers));

      // THE PRE-CHECK. A parent named in the CSV that does not resolve stops the
      // whole run — not the row — and it stops the plan too, because a plan that
      // silently omitted 18 reparentings would read as a complete plan. The
      // alternative to refusing is writing a slug to a page and leaving it at
      // the wrong depth, which is a live URL pointing somewhere nobody asked for.
      const parentErrors = [];
      const seenParentError = new Set();
      for (const plan of plans) {
        if (!plan.parent_error) continue;
        const key = `${plan.parent_slug}|${plan.parent_error}`;
        if (seenParentError.has(key)) continue;
        seenParentError.add(key);
        parentErrors.push({
          parent: plan.parent_slug,
          why: plan.parent_error,
          lines: plans
            .filter((p) => p.parent_error && p.parent_slug === plan.parent_slug)
            .map((p) => p.line),
        });
      }
      if (parentErrors.length) {
        return {
          ok: false,
          error:
            "Stopped before reading any further: " +
            `${parentErrors.length} parent(s) in the CSV do not resolve on this site.\n` +
            parentErrors
              .map(
                (p) =>
                  `  • "${p.parent}" — ${p.why} (line(s) ${p.lines.join(", ")})`,
              )
              .join("\n") +
            "\nCreate and publish those pages at the top level, then Run again.",
        };
      }

      const warnings = [];
      if (auto.value === true) {
        warnings.push(
          "Rank Math's auto-redirect on slug change is ON. Renaming a page to " +
            '"-alt" will mint a 301 from the slug the new page is about to take, ' +
            "which silently sends every visitor to the old page. Turn it off at " +
            "Rank Math → Settings → General → Redirections (Auto Post Redirect), " +
            "run this, then turn it back on.",
        );
      } else if (auto.value === null) {
        warnings.push(
          `Could not read Rank Math's auto-redirect setting (${auto.why}). ` +
            "Treating it as ON, because the failure mode if it is on is a silent " +
            "redirect loop onto the old page.",
        );
      }

      // The REPORT, which is the payload — not the reply. The reply is an
      // envelope, `{ ok, origin, result }`, and the two must stay separate: the
      // panel asks `reply.ok` to decide whether it got an answer at all, then
      // reads `reply.result` as the report. Returning the report flattened into
      // the reply put a truthy `ok` next to an undefined `result`, so every run
      // failed on "can't access property summary" — the one shape that looks like
      // success to the transport and like nothing to the caller.
      const result = {
        dry_run: !!dryRun,
        site: location.origin + "/",
        seo: { id: "rank-math", label: "Rank Math (rankmath/v1/updateMeta)" },
        auto_redirect: auto.value,
        rows: [],
        warnings,
        summary: {
          rows: plans.length,
          slugs_set: 0,
          already: 0,
          renamed: 0,
          reparented: 0,
          seo_set: 0,
          failed: 0,
        },
      };

      // A reparent counts here as much as a rename does. Moving a published page
      // changes its permalink exactly like a slug change, so Rank Math mints a
      // 301 from the old path — and if another row's target is about to occupy
      // that path, it is the same silent redirect onto the wrong page. The
      // original reasoning ("only a rename can create the fatal redirect") was
      // true only while every page stayed where it was.
      const needsRenames = plans.some(
        (p) => !p.error && (p.renames.length || p.parent_action === "set"),
      );

      if (dryRun) {
        result.rows = plans;
        for (const plan of plans) {
          if (plan.error) {
            result.summary.failed += 1;
            continue;
          }
          if (plan.slug_action === "set") result.summary.slugs_set += 1;
          if (plan.slug_action === "already") result.summary.already += 1;
          if (plan.parent_action === "set") result.summary.reparented += 1;
          result.summary.renamed += plan.renames.length;
          for (const seo of plan.seo) {
            if (seo.action === "set") result.summary.seo_set += 1;
          }
        }
        return { ok: true, result };
      }

      // Refused, not warned. Only a rename can create the fatal redirect, so a
      // run with nothing to rename is allowed through whatever the setting says.
      if (needsRenames && auto.value !== false) {
        return {
          ok: false,
          error:
            "Refusing to apply: Rank Math's auto-redirect on slug change is " +
            (auto.value === null ? "unreadable" : "enabled") +
            ", and this run has to rename " +
            plans.reduce((n, p) => n + p.renames.length, 0) +
            " page(s) and move " +
            plans.filter((p) => !p.error && p.parent_action === "set").length +
            ". Both change a permalink. Turn off Rank Math → Settings → General " +
            "→ Redirections → Auto Post Redirect, then Run again.",
        };
      }

      // ---- Pass A: free the slugs -------------------------------------
      // Every occupant, across every row, before any target is written. Doing it
      // per row would let row 2's target be written while row 5's occupant still
      // holds the slug row 5 needs.
      for (const plan of plans) {
        for (const occupant of plan.renames) {
          try {
            const got = await writeSlug(occupant, occupant.rename_to);
            occupant.result = "renamed";
            occupant.new_slug = got;
            result.summary.renamed += 1;
            if (got !== occupant.rename_to) {
              // WordPress appends its own counter when even "-alt" is taken. A
              // fine outcome, but not the one that was asked for.
              result.warnings.push(
                `#${occupant.id} became "${got}", not "${occupant.rename_to}" — that slug was already taken`,
              );
            }
          } catch (err) {
            occupant.result = `failed: ${err?.message || err}`;
            plan.error = `could not free the slug — #${occupant.id} still holds "${plan.slug}"`;
          }
        }
      }

      // ---- Pass B: slug + parent, then SEO, then the front page -------
      // Rows that supply a parent to another row go FIRST, so that by the time a
      // child is written the page it nests under has already succeeded or
      // failed. That is the only ordering constraint here: the parent's post id
      // is fixed (the page exists; only its slug is changing), so nothing has to
      // wait for an id to come into being.
      const providerLines = new Set(
        [...providers.values()].map((v) => v.line),
      );
      const ordered = [
        ...plans.filter((p) => providerLines.has(p.line)),
        ...plans.filter((p) => !providerLines.has(p.line)),
      ];

      for (const plan of ordered) {
        if (plan.error) {
          result.summary.failed += 1;
          result.rows.push(plan);
          continue;
        }

        // THE SLUG AND THE PARENT GO IN ONE REQUEST, and that is load-bearing
        // rather than an optimisation. wp_unique_post_slug() tests the slug
        // against the post's parent, so writing them separately asks the wrong
        // question either way round: set the slug first and it is compared at
        // the OLD parent, where the page the run is moving away from still sits,
        // and WordPress hands back "legal-2". Sending both lets it evaluate
        // uniqueness at the destination — which is the parent the collision
        // search already cleared. Measured: split into two writes, moving a page
        // to /solutions/legal/ produced legal-2 every time.
        const fields = {};
        if (plan.slug_action === "set") fields.slug = plan.slug;

        if (plan.parent_action === "set") {
          // The one dependency. If the row that was going to supply this parent
          // failed, nesting under it would put the child at a URL the CSV never
          // described — so the move is held back and the slug still written.
          const via = plan.parent_via_line
            ? plans.find((p) => p.line === plan.parent_via_line)
            : null;
          if (plan.parent_via_line && (!via || via.error)) {
            plan.parent_action = "skipped";
            plan.parent_note =
              `held back — line ${plan.parent_via_line} was going to supply ` +
              `"${plan.parent_slug}" and it failed`;
            result.warnings.push(
              `#${plan.target.id} was not moved under "${plan.parent_slug}" — line ${plan.parent_via_line} failed`,
            );
          } else {
            fields.parent = plan.parent_to;
          }
        }

        if (Object.keys(fields).length) {
          try {
            const got = await writePost(plan.target, fields);
            if (fields.slug !== undefined) {
              plan.slug_written = got.slug;
              if (got.slug !== plan.slug) {
                // Pass A was supposed to make this impossible. It happening
                // means something holds the slug at the destination that the
                // collision search did not see, and the page is now on a URL the
                // CSV never named.
                plan.slug_action = "suffixed";
                plan.error = `WordPress wrote "${got.slug}" instead of "${plan.slug}" — something still holds that slug`;
                result.summary.failed += 1;
                result.rows.push(plan);
                continue;
              }
              plan.slug_action = "done";
              result.summary.slugs_set += 1;
            } else if (plan.slug_action === "already") {
              result.summary.already += 1;
            }
            if (fields.parent !== undefined) {
              if (got.parent !== plan.parent_to) {
                plan.parent_action = "failed";
                plan.parent_note = `WordPress stored parent ${got.parent}, not ${plan.parent_to}`;
                result.warnings.push(
                  `#${plan.target.id} parent is ${got.parent}, not ${plan.parent_to}`,
                );
              } else {
                plan.parent_action = "done";
                result.summary.reparented += 1;
              }
            }
          } catch (err) {
            plan.slug_action = fields.slug !== undefined ? "failed" : plan.slug_action;
            if (fields.parent !== undefined) plan.parent_action = "failed";
            plan.error = err?.message || String(err);
            result.summary.failed += 1;
            result.rows.push(plan);
            continue;
          }
        } else if (plan.slug_action === "already") {
          result.summary.already += 1;
        }

        // SEO is written even when the slug was already right — the two halves of
        // a row are independent, and a re-run exists to finish whichever half did
        // not land last time.
        const meta = {};
        for (const seo of plan.seo) {
          if (seo.action === "set") meta[seo.meta_key] = seo.value;
        }
        if (Object.keys(meta).length) {
          try {
            await writeSeo(plan.target.id, meta);
            for (const seo of plan.seo) {
              if (seo.action === "set") {
                seo.action = "done";
                result.summary.seo_set += 1;
              }
            }
          } catch (err) {
            const why = err?.message || String(err);
            for (const seo of plan.seo) {
              if (seo.action === "set") seo.action = "failed";
            }
            // Non-fatal: the slug landed, and a row that got its URL and not its
            // metadata is worth reporting as exactly that rather than as a
            // failed row.
            result.warnings.push(`#${plan.target.id} SEO write failed — ${why}`);
          }
        }

        // Last, so a failed slug write never leaves the front page pointing at a
        // page that did not get its slug.
        if (plan.front_page) {
          try {
            const got = await writeFrontPage(plan.front_page.to);
            plan.front_page.result =
              got === plan.front_page.to ? "done" : `wrote ${got}`;
          } catch (err) {
            plan.front_page.result = `failed: ${err?.message || err}`;
            result.warnings.push(
              `front page still points at #${plan.front_page.from} — ${err?.message || err}`,
            );
          }
        }

        result.rows.push(plan);
      }

      // ---- Verify ------------------------------------------------------
      // The last moment anything can notice a slug landing on two posts at once.
      // Asked at the parent the page ENDED UP at, which is the destination when
      // the move landed and the original when it did not.
      for (const plan of plans) {
        if (!plan.target || plan.error) continue;
        try {
          const base = await restBaseOf(plan.target.post_type);
          const settled =
            plan.parent_action === "done" ? plan.parent_to : plan.parent_from;
          const holders = (
            await listBy(base, `slug=${encodeURIComponent(plan.slug)}`)
          ).filter((p) => Number(p.parent || 0) === settled);
          if (holders.length > 1) {
            result.warnings.push(
              `"${plan.slug}" is now held by ${holders.length} posts: ` +
                holders.map((p) => `#${p.id} (${p.status})`).join(", "),
            );
          }
        } catch (_) {
          // A failed verification is not a failed transfer.
        }
      }

      if (auto.value === false) {
        result.warnings.push(
          "Remember to turn Rank Math's Auto Post Redirect back on.",
        );
      }

      return { ok: true, result };
    } catch (err) {
      return { ok: false, origin: location.origin, error: err?.message || String(err) };
    }
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.__elementorTools !== true) return undefined;
    if (msg.type === "slug-transfer") {
      return runTransfer(msg.options || {}).then((r) => ({
        origin: location.origin,
        ...r,
      }));
    }
    return undefined;
  });
})();
