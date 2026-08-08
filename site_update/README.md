# Slug & SEO transfer

Moves each CSV row's **slug**, **parent**, **SEO title** and **SEO description**
onto the page named in its `new_page` column, renaming whatever already holds that
slug to `<slug>-alt` first.

**Nothing is installed on the site.** It runs entirely from the extension against
endpoints WordPress and Rank Math already expose:

| what | endpoint |
| --- | --- |
| slug + parent read / write | `/wp/v2/<type>` (core — `post_name` and `post_parent` are core's own fields) |
| SEO title / description | `/rankmath/v1/updateMeta` (Rank Math's own route, the one its editor sidebar uses) |
| front page | `/wp/v2/settings` (`page_on_front`) |

Core REST does **not** expose Rank Math's meta — a page's `meta` object carries
seven keys and none of them is `rank_math_*`, verified on this install. That is why
the SEO half goes through Rank Math's route rather than `/wp/v2`.

## The `parent` column

The route a page is served at is **not** its slug. `post_name` is one path
segment; `/solutions/legal/` is the page `legal` whose `post_parent` points at the
page `solutions`. WordPress stores no path anywhere — it walks the parent chain and
joins the slugs.

So the CSV's `parent` column holds a **bare slug**, and the run resolves it to a
post ID against the site's **top-level published pages**.

- **The parent column is the only source of a parent.** `permanent_url` is stale on
  this export and several rows deliberately disagree with it; it is carried into the
  report as a label and decides nothing.
- **A blank cell means top-level**, not "leave it alone". A page currently nested
  with a blank cell is moved back to the root.
- **The column is mandatory.** A CSV without it would read as "every row is
  top-level" and move the whole site to the root, so a missing column is refused
  rather than defaulted.
- **A parent that does not resolve stops the entire run** — plan included. Missing,
  ambiguous (two top-level pages with that slug), or **draft** all count. A draft
  parent builds the child's URL fine and then 404s it for logged-out visitors, which
  is worse than a missing one because it looks like success.
- **A parent named by another row of this CSV resolves to that row's page.** The
  page already exists — only its slug is changing — so the ID is known while
  planning. Those rows are written first, and a child whose provider row failed keeps
  its slug and reports the move as held back.

**The slug and the parent are written in one request**, and that is load-bearing.
`wp_unique_post_slug()` tests the slug against the post's parent, so writing them
separately compares the new slug at the **old** parent — where the page being moved
away from still sits — and WordPress hands back `legal-2`. Sending both lets it
evaluate at the destination, which is the parent the collision search already
cleared.

## Before you run: one Rank Math setting

**Rank Math → Settings → General → Redirections → Auto Post Redirect must be OFF.**

With it on, renaming `about-introhive` to `about-introhive-alt` makes Rank Math mint
a **301 from `/about-introhive/`** — the exact path the new page is about to take.
The transfer then completes, saves cleanly, reports success, and sends every
visitor to the old page.

The run reads that setting and **refuses to apply** while it is on (or unreadable),
whenever the plan involves a rename **or a move**. A reparent changes a permalink
exactly like a slug change does, so it mints the same 301 and carries the same
hazard. Turn it off, run, turn it back on — the report reminds you.

It is read and never written: Rank Math keeps it inside one large serialised options
blob, and posting a partial shape at `/rankmath/v1/updateSettings` risks flattening
two hundred unrelated settings. One checkbox by hand beats that.

## Each run

1. Open **wp-admin** on the site, signed in as an administrator (`manage_options`).
2. Panel → set **Working Domain** to the site's origin. The run refuses if a
   different site's tab answers, which is what keeps a transfer off the wrong
   install.
3. **Slug & SEO Transfer** → **CSV…** → pick the export. The status line reports how
   many rows have a `new_page` and how many were skipped for not having one.
4. **Run.** Nothing is written — it reads the site and shows a plan: which page each
   row resolved to, what its slug becomes, **where it moves to**, which page is
   renamed to `-alt`, which SEO fields change, and whether the front page moves.
5. Read it, then click **Apply N**. The button only arms when the plan would write
   something.

A page that already has its slug **and** is already in the right place is left
alone. One that has the right slug in the wrong place is still moved.

**Re-running only works while `new_page` still resolves.** That column names the
receiving page by its current staging URL, and a successful run changes that URL —
so a second run over already-applied rows reports `no post found at /…/` rather
than "already correct". Re-point `new_page` at the new path, or only re-run the
rows that failed. This is inherent to naming a page by its URL and predates the
parent column.

## Updating the CSV

Pick the file again. The rows are parsed in the panel and travel with the request —
there is no copy on the server to go stale.

## What it will not do

- **A row with no `new_page` is skipped.** That column names the page receiving the
  slug; without one there is no destination. The current export has none in that
  state — all 25 real rows carry one.
- **Fully structural rows are dropped silently.** This export groups the sitemap
  with blank separator lines; a row with no `new_page`, no `slug` and no
  `permanent_url` names no page in any sense and is not counted as skipped.
- **An empty `seo_title` / `seo_description` is left alone, not blanked.**
- **It renames only a true collision, at the DESTINATION parent.** WordPress scopes
  slug uniqueness to `post_type` + `post_parent` (plus attachments), so a `post`
  named `careers` does not collide with a `page` named `careers` and is left alone.
  Once a row can move a page, the question has to be asked at the parent it is
  moving *to*: a page called `legal` at the top level is no obstacle to a page
  becoming `/solutions/legal/`, and one already sitting under `solutions` is.
  Same-slug pages anywhere else are reported, never touched.
- **It never touches redirects.** 1,660 active Rank Math redirects on this site; the
  run does not add, edit or delete any.

## Known limits

- **No "already matches" for SEO.** Rank Math's meta cannot be read back through
  any REST route, so the values are written unconditionally. Idempotent, just less
  talkative than a diff.
- **`post_modified` is bumped** on every page whose slug changes, because the write
  goes through `wp_update_post`. A companion plugin could have avoided that; nothing
  installed means nothing that can.
- **Collision search covers REST-exposed types only.** All 19 types on this install
  are exposed, and the authoritative check is `page` + `media` anyway. A type hidden
  from REST holding one of the slugs would show up as a `-2` suffix, which the run
  detects and reports as a failure rather than accepting.

## Worth knowing about this CSV

Current export (`…-1.csv`, 26 columns): **25 rows, 0 skipped, 0 warnings.**

- **18 of the 25 rows are moves.** 6 go under `platform`, 12 under `solutions`. The
  remaining 7 have a blank parent and are top-level.
- **Neither `platform` nor `solutions` is created by this CSV**, and no row carries
  either as its slug — so until both exist as published top-level pages, the
  pre-check stops every run and names them.
- **The homepage row can move the front page.** When the page displaced by a row is
  the one `page_on_front` names, the setting follows it, because otherwise the slugs
  move and the site's homepage silently stays the old page. Derived rather than
  configured, and shown as its own line in the plan.
- The homepage slug is `hp-dec-2024`, not `homepage` — its `permanent_url` is the
  site root, so the slug is never visible in the live URL.
- **`info architecture` and `slug_old` are ignored.** `slug_old` records what each
  page is called today; the run finds the occupant by searching for the *target*
  slug instead, so a stale `slug_old` cannot send it at the wrong page.
- Descriptions run across several physical lines inside their quotes. The parser is
  a real CSV state machine and handles it.
- Rank Math variables (`%sep%`, `%sitename%`, `%page%`) are written verbatim.

## Parent support: not yet verified live (2026-08-07)

The parent column, the pre-check and the destination-parent collision scoping were
built and tested against a **stubbed WordPress** that implements
`wp_unique_post_slug()`'s real rule — seven cases, including the two that matter
most: an occupant at the old parent is correctly left alone, and one at the
destination is correctly renamed. **Nothing has been run against the live site
yet.**

That harness caught one real bug worth recording: writing the slug and the parent
as two separate requests produced `legal-2` every time, because the first write
compared the new slug at the *old* parent. They are one request now.

## Verified on the live site (2026-08-06) — against the previous CSV

Against `env-introhive-thrillworks.kinsta.cloud`, admin session. This predates the
parent column; the row counts below refer to the older 30-row export:

- All 7 rows resolve to exactly one target and one occupant, all published, all
  top-level. **25 writes planned, 0 failures.** No media collisions, no
  cross-parent same-slug pages, no ambiguity.
- Rank Math SEO + PRO active; `/rankmath/v1/updateMeta` **write confirmed
  end-to-end** on page #64317 — the front end now renders the CSV's title in
  `<title>`, `meta[name=description]` and `og:title`, with the slug untouched.
- `redirections_post_redirect: true` — auto-redirect is currently **ON**, so an
  apply is correctly refused until it is turned off.
