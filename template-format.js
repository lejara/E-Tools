// Loaded both as a content script and by UI/panel.html — the panel's template
// list and the in-editor picker have to describe a template the same way, and
// the Edit links they build have to point at the same URL. Same dual-context
// pattern as hotkey-defaults.js.
(() => {
  // Layer names, template titles and search terms are all hand-typed.
  // Compare them forgivingly.
  const normalizeName = (value) =>
    String(value || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();

  // The endpoint may hand back a preformatted localized string, a unix
  // timestamp in seconds or milliseconds, or a MySQL datetime. Prefer the
  // server's own string — it is already in the site's locale and timezone.
  const formatDate = (t) => {
    if (t.humanModified) return String(t.humanModified);
    if (t.humanDate) return String(t.humanDate);

    const raw = t.modified ?? t.date;
    if (raw === null || raw === undefined || raw === "") return "";

    const num = Number(raw);
    if (Number.isFinite(num) && num > 0) {
      const d = new Date(num > 1e12 ? num : num * 1000);
      if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
    }
    const d = new Date(String(raw).replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
    return String(raw);
  };

  const metaLine = (t) => {
    const bits = [];
    if (t.author) bits.push(t.author);
    const when = formatDate(t);
    if (when) bits.push(when);
    return bits.join(" · ");
  };

  // Every whitespace-separated term must appear somewhere in the title, type
  // or author, so "hero prim" finds "TW Hero Primary" regardless of ordering,
  // and an author name narrows the list too.
  const searchTerms = (query) => normalizeName(query).split(" ").filter(Boolean);

  // `extra` is what lets one search box serve rows of different shapes: a
  // template contributes its author, a post contributes its status and post
  // type, and neither has to know the other exists.
  const matchesTerms = (t, terms) => {
    if (!terms.length) return true;
    const hay = normalizeName(
      `${t.title || ""} ${t.type || ""} ${t.author || ""} ${t.extra || ""}`,
    );
    return terms.every((q) => hay.includes(q));
  };

  const STATUS_LABELS = {
    publish: "Published",
    draft: "Draft",
    pending: "Pending",
    private: "Private",
    future: "Scheduled",
    trash: "Trash",
    "auto-draft": "Auto-draft",
  };

  const statusLabel = (status) => {
    const key = String(status || "").toLowerCase();
    return STATUS_LABELS[key] || key;
  };

  // The template list's second line is "author · date"; a post's is
  // "status · date". Same slot, same separator, different facts.
  const postMetaLine = (p) => {
    const bits = [];
    const status = statusLabel(p.status);
    if (status) bits.push(status);
    const when = formatDate({ modified: p.modified });
    if (when) bits.push(when);
    return bits.join(" · ");
  };

  // Every layer these tools create carries the template's id as a "#123"
  // suffix on its layer name — and, when the template has more than one root,
  // which root it is: "#123.2". A name is hand-typed and drifts; the tag is the
  // exact link back to the template, and the layer name is the only per-layer
  // field readable on every Elementor version — with the bonus that it stays
  // visible in the navigator, so the link is never invisible state.
  //
  // The root index is 1-based, matching how the tools label roots ("root 2"),
  // and it is the whole reason two roots of one template can be told apart on
  // the page. It is a position, so re-saving a template with its roots in a
  // different order re-points the tags — that is inherent to identifying a root
  // by where it sits.
  const TEMPLATE_TAG = /#(\d+)(?:\.(\d+))?\s*$/;

  const asPositiveInt = (value) => {
    const s = String(value ?? "").trim();
    return /^\d+$/.test(s) && Number(s) > 0 ? s : null;
  };

  // "4821" for a single-root template, "4821.2" for the second root of a
  // multi-root one. Every tag is built here, so the tools that write tags and
  // the tools that look them up cannot disagree on the shape.
  const templateTagKey = (templateId, rootIndex) => {
    const id = asPositiveInt(templateId);
    if (!id) return null;
    const root = asPositiveInt(rootIndex);
    return root ? `${id}.${root}` : id;
  };

  const parseTemplateTag = (name) => {
    const m = TEMPLATE_TAG.exec(String(name ?? ""));
    if (!m) return null;
    const root = m[2] ? Number(m[2]) : null;
    return { id: m[1], root, key: templateTagKey(m[1], root) };
  };

  const withTemplateTag = (name, templateId, rootIndex) => {
    const base = String(name ?? "").trim();
    const key = templateTagKey(templateId, rootIndex);
    if (!key) return base;
    const existing = parseTemplateTag(base);
    if (existing?.key === key) return base;
    // Our own tag for this template is rewritten in place — a root index moves
    // when a template is re-saved. Any other trailing "#n" is left alone: it is
    // part of a hand-typed name ("Card #2"), and the tag goes after it.
    const bare =
      existing && existing.id === asPositiveInt(templateId)
        ? stripTemplateTag(base)
        : base;
    return bare ? `${bare} #${key}` : `#${key}`;
  };

  // Name matching has to ignore the tag, or tagging a layer would break the
  // very name match that found it. Strip before comparing; the tag gets its own
  // index for the id pass.
  const stripTemplateTag = (name) =>
    String(name ?? "")
      .replace(TEMPLATE_TAG, "")
      .trim();

  // Elementor's template-library payload, flattened to the shape every consumer
  // here reads. Field names vary across Elementor versions, so take the first of
  // several candidates and hand back the raw key list so a missing column can be
  // diagnosed without guessing.
  //
  // Tools/page-bridge.js carries its own copy of this mapping, and has to: the
  // bridge is injected into the *page* world, which cannot read a content-script
  // global. Same boundary that keeps the tag regex out of it. Change one, change
  // both.
  const normalizeTemplateList = (raw, source = "local") => {
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    const templates = list.map((t) => ({
      templateId: t.template_id,
      title: t.title,
      type: t.type,
      source: t.source || source,
      author: t.author || t.user || null,
      date: t.date ?? null,
      modified: t.modified ?? t.post_modified ?? null,
      humanDate: t.human_date || null,
      humanModified:
        t.human_modified_date || t.humanModifiedDate || t.modified_date || null,
      // The library hands back the template's own public permalink
      // ("/?elementor_library=<slug>"). It is the panel's View link, and it
      // beats deriving one from the title — a slug is not a slugified title
      // once WordPress has deduplicated it.
      url: t.url || null,
      status: t.status || null,
    }));
    return { templates, fields: list.length ? Object.keys(list[0]) : [] };
  };

  const parseWorkingDomain = (raw) => {
    if (!raw) return null;
    const trimmed = String(raw).trim();
    if (!trimmed) return null;
    try {
      const withProto = /^https?:\/\//i.test(trimmed)
        ? trimmed
        : `https://${trimmed}`;
      const u = new URL(withProto);
      return { hostname: u.hostname, origin: u.origin };
    } catch {
      return null;
    }
  };

  // Elementor's editor URL for any post id — templates and pages alike.
  const elementorEditUrl = (workingDomain, postId) => {
    const parsed = parseWorkingDomain(workingDomain);
    if (!parsed || postId === null || postId === undefined || postId === "") {
      return null;
    }
    return `${parsed.origin}/wp-admin/post.php?post=${encodeURIComponent(postId)}&action=elementor`;
  };

  // WordPress's own editor, for a post Elementor did not build. Same shape as
  // elementorEditUrl so the panel can pick between them by one flag.
  const wpAdminEditUrl = (workingDomain, postId) => {
    const parsed = parseWorkingDomain(workingDomain);
    if (!parsed || postId === null || postId === undefined || postId === "") {
      return null;
    }
    return `${parsed.origin}/wp-admin/post.php?post=${encodeURIComponent(postId)}&action=edit`;
  };

  // A published post has a permalink already. For anything else `link` is the
  // permalink it *would* have and does not render, so an unpublished post needs
  // the preview route instead — which works for a signed-in editor.
  const contentViewUrl = (workingDomain, item) => {
    if (!item || item.viewable === false) return null;
    if (item.status === "publish" && item.link) return item.link;
    const parsed = parseWorkingDomain(workingDomain);
    if (!parsed || item.id === null || item.id === undefined) return null;
    return `${parsed.origin}/?p=${encodeURIComponent(item.id)}&preview=true`;
  };

  window.__ElementorTemplateFormat = {
    normalizeName,
    formatDate,
    metaLine,
    postMetaLine,
    statusLabel,
    searchTerms,
    matchesTerms,
    normalizeTemplateList,
    templateTagKey,
    withTemplateTag,
    parseTemplateTag,
    stripTemplateTag,
    parseWorkingDomain,
    elementorEditUrl,
    wpAdminEditUrl,
    contentViewUrl,
  };
})();
