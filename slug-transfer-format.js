// The migration CSV, parsed. Dual-context in the same sense as
// template-format.js: it assigns one global, touches neither `location` nor the
// DOM at load time, and is the single definition of what a row means.
//
// It lives on the EXTENSION side rather than in the WordPress plugin, and that is
// the whole point of the design. The CSV is edited between passes of the
// transfer — rows gain a `new_page` as pages are built — and baking the rows into
// PHP would mean re-uploading the plugin every time the spreadsheet changed, with
// a stale copy on the server that nothing could notice. The panel loads the CSV,
// this file turns it into rows, and the rows travel with the request. The plugin
// stores nothing.
(() => {
  // The columns this transfer reads. Everything else in the export — schema_data,
  // the social_* set, redirect_to/redirect_type, `info architecture`, `slug_old` —
  // is deliberately out of scope.
  //
  // `parent` is REQUIRED, and that is a safety rule rather than a formality. A
  // blank cell means "this page is top-level", so a CSV missing the column
  // entirely would read as "every row is top-level" and the run would move the
  // whole site to the root. Absent and blank have to be different answers, and
  // the only way to tell them apart is to refuse the file that has no column.
  //
  // `permanent_url` is carried for the report and NOTHING else. It is stale by
  // design on this export — the parent column is the only source of a parent, and
  // several rows deliberately disagree with the URL they were exported with.
  const COLUMNS = [
    "new_page",
    "permanent_url",
    "parent",
    "slug",
    "seo_title",
    "seo_description",
  ];

  // A real parser rather than split(","). This export quotes descriptions that
  // contain commas, doubled quotes AND embedded newlines — one row runs its
  // description across four physical lines — so splitting on either character
  // silently shifts every column after it and the slug column stops being the
  // slug column.
  const parseCsv = (text) => {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;

    // Strip a BOM (Excel writes one) and normalise CRLF, so a Windows-saved
    // export does not leave \r on the end of every last column.
    const src = String(text).replace(/^﻿/, "").replace(/\r\n?/g, "\n");

    for (let i = 0; i < src.length; i += 1) {
      const ch = src[i];
      if (quoted) {
        if (ch === '"') {
          if (src[i + 1] === '"') {
            field += '"';
            i += 1;
          } else {
            quoted = false;
          }
        } else {
          field += ch;
        }
        continue;
      }
      if (ch === '"') {
        quoted = true;
      } else if (ch === ",") {
        row.push(field);
        field = "";
      } else if (ch === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else {
        field += ch;
      }
    }
    if (field !== "" || row.length) {
      row.push(field);
      rows.push(row);
    }
    // A trailing newline, and any blank line inside the file, is not a record.
    return rows.filter((r) => r.some((c) => c.trim() !== ""));
  };

  // Returns { rows, skipped, warnings, error } — never throws. The panel shows
  // whichever of those came back, so a malformed CSV reports itself instead of
  // leaving the button looking broken.
  //
  // `rows` is exactly what gets POSTed. `skipped` is the rows with no `new_page`:
  // that column names the page that RECEIVES the slug, so a row without one
  // describes a destination that does not exist yet. There is nothing to write
  // and nothing to guess, so it is dropped — and counted, because "23 rows were
  // not part of this" is a fact worth seeing before pressing Run.
  const readCsv = (text) => {
    const table = parseCsv(text);
    if (!table.length) {
      return { rows: [], skipped: [], warnings: [], error: "That file is empty" };
    }

    const header = table[0].map((h) => h.trim());
    const missing = COLUMNS.filter((c) => !header.includes(c));
    if (missing.length) {
      return {
        rows: [],
        skipped: [],
        warnings: [],
        error: `CSV is missing the column(s): ${missing.join(", ")}`,
      };
    }

    const at = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)]));
    const rows = [];
    const skipped = [];
    const warnings = [];

    table.slice(1).forEach((cells, i) => {
      const get = (c) => String(cells[at[c]] ?? "").trim();
      const line = i + 2; // 1-based, and the header is line 1.
      const newPage = get("new_page");
      const slug = get("slug");
      const parent = get("parent");

      // Spacer rows. This export groups the sitemap with blank separator lines
      // that still carry a stray cell somewhere, so parseCsv's all-blank filter
      // does not catch them. They name no page in any sense, so they are dropped
      // silently rather than padding the skipped count with seven "line N"
      // entries that mean nothing to the operator.
      if (!newPage && !slug && !get("permanent_url")) return;

      if (!newPage) {
        skipped.push(slug || get("permanent_url") || `line ${line}`);
        return;
      }
      // A row that names a destination but no slug cannot be acted on, and it is
      // a different thing from a row that names neither — the first is a mistake
      // in the spreadsheet, the second is simply not ready yet.
      if (!slug) {
        warnings.push(`line ${line}: has a new_page but no slug — skipped`);
        return;
      }
      // A parent is a bare slug, resolved against the site's top-level pages.
      // A path or a URL cannot be resolved by the lookup and would fail the
      // pre-check anyway; saying so here names the line, which the pre-check
      // cannot.
      if (parent && /[/:]/.test(parent)) {
        warnings.push(
          `line ${line}: parent "${parent}" looks like a path or URL — ` +
            "only a bare slug is supported",
        );
      }
      rows.push({
        line,
        new_page: newPage,
        permanent_url: get("permanent_url"),
        parent,
        slug,
        seo_title: get("seo_title"),
        seo_description: get("seo_description"),
      });
    });

    // Two rows claiming one slug is unresolvable here and destructive there: the
    // first would take the slug and the second would rename it to "-alt" as an
    // occupant, undoing the first. Reported before anything is sent.
    const seen = new Map();
    for (const row of rows) {
      const prev = seen.get(row.slug);
      if (prev) {
        warnings.push(
          `lines ${prev} and ${row.line} both claim the slug "${row.slug}"`,
        );
      } else {
        seen.set(row.slug, row.line);
      }
    }

    return { rows, skipped, warnings, error: "" };
  };

  window.__SlugTransferFormat = { COLUMNS, parseCsv, readCsv };
})();
