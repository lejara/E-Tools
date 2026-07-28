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

  const matchesTerms = (t, terms) => {
    if (!terms.length) return true;
    const hay = normalizeName(`${t.title || ""} ${t.type || ""} ${t.author || ""}`);
    return terms.every((q) => hay.includes(q));
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

  window.__ElementorTemplateFormat = {
    normalizeName,
    formatDate,
    metaLine,
    searchTerms,
    matchesTerms,
    parseWorkingDomain,
    elementorEditUrl,
  };
})();
