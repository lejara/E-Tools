# Elementor Tool

Typical flow each release: npm run bump → npm run sign → install the .xpi from about:addons.
Browser extension (MV3, Firefox) that adds hotkey-driven tools to Elementor's WordPress editor.

## Structure: UI -> Tools

```
├── manifest.json        # MV3 manifest
├── background.js        # toolbar-icon click → opens UI/panel.html
├── hotkeys.js           # global keybindings (dispatches to tools)
├── hotkey-defaults.js   # dual-context: ACTIONS table + binding formatting
├── template-format.js   # dual-context: template/post metadata, search, list normalization, Edit & View URL building
├── animation-preset-fields.js # dual-context: the Motion Effects field table, preset file build/parse/validate
├── UI/                  # window opened from the toolbar icon
│   ├── panel.html
│   └── panel.js         # reads browser.storage.local, re-renders on change; site-content list
└── Tools/               # one self-contained tool per file
    ├── preview-override.js   # forces fixed widths on mobile/tablet preview
    ├── core_utils.js         # shared helpers on window.__ElementorTools (log, selectLayerById, callBridge, insertSiteTemplate, createTemplateWidget, createContainer, listSiteTemplates, pairTrees, normalizeName)
    ├── page-bridge.js        # injected into page world; runs Elementor $e commands via postMessage
    ├── multi-select.js       # shared subsystem: shift+click in navigator toggles blue-tint selection
    ├── breakpoint-flyout.js       # loader for the module below + its storage-backed copy/paste channel
    ├── breakpoint-flyout-page.js  # page world: click a responsive field for an all-breakpoints flyout; right-click any field to copy/paste
    ├── pure-container-reset.js # pushes the panel's two create-hook flags to the page world
    ├── layer-root-finder.js  # captures the currently selected Elementor layer
    ├── replace-styles.js     # copies source layer styles onto same-named descendants of root
    ├── replace-layer.js      # replaces same-named descendants of root with a copy of source layer
    ├── batch-rename.js       # renames every multi-selected layer to one name (inline modal)
    ├── template-sync.js      # name-matches top containers to site templates; styles them, or replaces them outright
    ├── template-insert.js    # multi-select picker over the template library, inserts the ticked templates
    ├── template-decouple.js  # swaps Elementor Template widgets for a copy of the template's own content
    ├── animation-presets.js  # applies a saved Motion Effects preset to the selection, with delay accumulation
    ├── wp-rest.js            # shared wp-admin REST access: wp_rest nonce + authenticated JSON GET
    ├── admin-templates.js    # serves the panel's template list from wp-admin (no editor, no page bridge)
    ├── wp-pages.js           # serves the panel's post list — every post type, with the Elementor flag
    └── overlay.js            # draggable in-page HUD (root layer, logs, Edit-in-Elementor link)
```

- Load order: `template-format.js` first (`core_utils.js` reads `normalizeName` off it), then `core_utils.js`, then `multi-select.js`, then other tools, then `hotkeys.js`. `wp-rest.js` must precede `admin-templates.js` and `wp-pages.js` — both read `window.__WpRest` and bail without it. `animation-preset-fields.js` must precede `Tools/animation-presets.js`, which reads `window.__AnimationPresetFields` and bails without it.
- Tools share `window.__ElementorTools` inside the editor page; cross-window state uses `browser.storage.local` (`selectedLayer`, `logs`).
- Hotkeys: `Ctrl+Shift+1` capture root layer · `Ctrl+Shift+2` replace styles · `Ctrl+Shift+3` replace layer · `Ctrl+Shift+4` batch rename · `Ctrl+Shift+5` reselect stored root · `Ctrl+Shift+6` sync template styles · `Ctrl+Shift+7` replace with template · `Ctrl+Shift+8` insert site templates · `Ctrl+Shift+9` decouple templates.
- Add a tool: drop a file in `Tools/`, append its path to `content_scripts[0].js` in `manifest.json`.

## Network requests always get a modal

**Any tool that makes a network round trip must put a modal up first, before awaiting.** Fetching the template library takes long enough to feel broken, and a hotkey that does nothing visible for two seconds reads as a dead hotkey — users press it again, and now two runs are in flight.

The rule:

- Open the modal **before** the `await`, not after it resolves.
- Say what is being waited on ("Fetching site templates…"), not just a spinner.
- Failures stay **in the modal** with a dismiss button. No `window.alert` — it is modal to the whole browser, unstyled, and loses the surrounding context.
- Keep it up for the whole operation and finish with a result the user can read, rather than closing silently on success.

`template-sync.js` satisfies this by opening its progress modal first and using the status line as the phase indicator. `template-insert.js` uses `openNotice()` for the library fetch, then swaps to the picker.

### The shared progress modal

`ns.openProgressModal(title, { id })` in `core_utils.js` is that modal — status line, scrolling row log, `choose()` checklist, `finish()` summary with **Copy details**. `template-sync.js` and `template-decouple.js` both drive it; pass your own `id` so two tools can't collide. `template-insert.js` keeps its own picker because a searchable checkbox list is a genuinely different shape.

Build a third tool on this rather than copying it — it was three files' worth of duplication before it was extracted.

**The row log follows the tail with `scrollTop`, never `scrollIntoView`.** `scrollIntoView` scrolls every ancestor, so it forces a layout of the whole editor page on every row — thousands of times in a long run — and it yanks the view back down the moment the user scrolls up to read a warning. Instead a `scroll` listener tracks whether the user is pinned to the bottom (so the common path reads no layout at all) and a `requestAnimationFrame` guard collapses a burst of rows into one scroll per frame. `template-insert.js` repeats the pattern in its own progress shell.

`choose()` takes two shapes:

- `choose(items, labelOf, buttonText)` → `items[] | null` — a plain checklist (`template-decouple.js`).
- `choose({ buildItems, labelOf, buttonText, toggles })` → `{ items, toggles } | null` — adds option checkboxes above the list. `buildItems(toggleState)` is a **callback, not an array**, because a toggle can change which items even qualify, so flipping one rebuilds the list rather than filtering it (`template-sync.js`).

Tick state is tracked as the set of _unticked_ items keyed on identity, so an item surviving a rebuild keeps its state and newly-qualifying ones arrive ticked. Everything starts ticked in both shapes.

## Page bridge

`callBridge(op, payload, { timeout, waitLimit, onWait })` — default timeout is 3s. Ops that hit the network (`insert-template`, `list-templates`, `prefetch-templates`) pass 15s or more.

Ops: `ping` · `copy` · `paste-style` · `apply-style-pairs` · `apply-advanced-settings` · `apply-preset-settings` · `read-preset-settings` · `paste` · `delete` · `rename` · `create-element` · `insert-template` · `prefetch-templates` · `list-templates` · `describe-tree` · `describe-selection` · `list-containers` · `list-template-widgets` · `configure-pure-reset` · `history-start` / `history-end`.

`configure-pure-reset` is the odd one out: every other op answers a question or performs an edit, and that one installs a **listener** — see Pure container reset.

`apply-advanced-settings` and `apply-preset-settings` share `resolveControlKey` — **exact match, then strip a leading underscore, then add one.** Widgets prefix _some_ advanced controls and containers do not, and it is not a rule you can write down: a widget carries `_animation` and `_animation_delay` but plain `animation_duration`. Measured on this Elementor Pro build, 6 of the Motion Effects section's 61 settings need the added underscore on a widget and the other 55 resolve exactly. A hand-written prefix table would write `animation_delay` onto a widget, where the real key is `_animation_delay`, and the value would land nowhere with nothing raised.

### `create-element` is the cheap path, and the linked one

`create-element` builds one element from nothing — `{ elType, widgetType, settings, intoId, afterId }` → `{ id }`. It exists because a **Template widget needs no template content at all**: its whole identity is `settings.template_id` (the field `list-template-widgets` reads), so pointing a fresh one at a template is a single `document/elements/create`. None of `insert-template`'s work applies — no library fetch, no clone, no `regenerateIds` — because nothing is being copied. `ns.createTemplateWidget(templateId, { intoId, afterId })` is the util; `ns.createContainer` is the same op with `elType: "container"`.

That makes it the **inverse of `template-decouple.js`**: decoupling replaces the widget with a copy of the content, this replaces the content with a widget. A widget-mode insert therefore stays linked — later edits to the template follow — where a content insert produces an independent copy.

- **Placement is `insert-template`'s, minus the shuffle.** `create` takes `options.at` directly, so reaching a non-tail index needs no copy → paste → delete.
- **`edit: false`.** The default opens the panel for the created element; a batch would do that once per widget and leave the last one selected.
- **A widget cannot be a direct child of the document.** The root takes containers only, so the op refuses rather than leaving behind a layer nothing can hold — which is why widget mode builds a wrapper (below) instead of appending to the page.
- **An unregistered `widgetType` is refused** when `widgetsCache` is readable. Creating one succeeds and renders nothing, so a site without Elementor Pro would quietly accumulate empty layers instead of being told Pro is missing.
- Not in `REPLAYABLE_OPS` — it mutates, so it is waited on, never re-sent. The default `waitLimit` is right: a lost answer orphans a created element.
- It creates `elType: "container"`, not `section`. The whole codebase already assumes flexbox containers (`CHILD_BEARING`, template-sync's "top containers"); a section-only site gets Elementor's own error in the modal row.

### Style batches run page-side

**`apply-style-pairs` is where a style sync spends its time, and it must stay page-side.** Driven a pair at a time from the content script, each node cost two `postMessage` round trips — and a sync over a large page is thousands of pairs, so the messaging dominated the run rather than the Elementor commands. The op takes `[{ sourceId, targetIds }]` and does the whole copy → paste-style loop in one message.

- **`targetIds` is a list because `paste-style` takes every container in one command.** One template root routinely styles several page containers, so a source node is copied once rather than once per target. `replace-styles.js` deep mode has always grouped this way; that is where the shape comes from.
- **Chunked, not one call.** `STYLE_CHUNK` (40) in `template-sync.js` bounds it: the page world cannot yield mid-op, so a thousand pairs in one message freezes the tab with no progress and no way to tell whether it is still working. A chunk is the unit of "still alive", and the timeout scales with it (`5000 + n * 400`).
- **A failing pair is recorded and the batch carries on**, which is what the per-pair loop did. One unstylable node must not abandon the rest of the block.
- Callers pass `waitLimit: 3`. It is a mutation so it is never re-sent, and unlike an insert a called-off wait leaves no orphan behind.

### A timeout is not an answer

**An expired deadline re-arms; it does not abandon the request.** The bridge is still working in the page world, and for anything network-backed the work lands _after_ the deadline passes — an `insert-template` that "timed out" has still inserted the template. Dropping the pending entry there is exactly what leaves an orphaned copy in the document with nobody expecting it. So the request stays pending and a late response still resolves the original caller; only after `waitLimit` re-arms (10 by default) does `callBridge` give up, and the error then says how long it actually waited.

- **Read-only ops are re-sent on each re-arm; document mutations are only waited on.** `REPLAYABLE_OPS` is the list — reads, plus `copy`, which writes the clipboard and nothing else. Re-sending a `paste`, `delete` or `import` would do the work twice, and re-sending a `delete` would turn a success into "No container for id". A resend reuses the same `requestId`, so whichever response arrives first wins and the rest are ignored by the `pending.has` guard.
- **`onWait` is how a tool says "still waiting"** instead of freezing its modal on a stale phase. The three template tools pass one; `template-insert` writes to its status line because its progress shell has no `note()`.
- **An op that already degrades to a no-op gets `waitLimit: 1`.** Re-arming buys nothing when failure is survivable, and it costs real time. `history-start` / `history-end` and `describe-selection` all pass 1 for that reason, and on `history-end` it matters most: it runs in a `finally` _after_ `finish()` has told the user the run is over, so a re-arming wait would hold the undo group open long enough for the user's next edit to join this run's undo step — with the hotkey still locked. The rule of thumb is that `waitLimit` should be high where a lost answer orphans something (`insert-template`) and 1 where it merely costs a feature.

### Batch inserts preload their content, 3 at a time

`prefetch-templates` warms the page-side content cache for a whole batch with several requests in flight (`ns.prefetchTemplates(templates)`, `PREFETCH_CONCURRENCY = 3`). `template-sync`, `template-insert` and `template-decouple` all run it once the selection is known and before `history-start` — nothing there changes the document.

**Only the network wait is parallelised.** The inserts themselves stay strictly serial: `document/elements/copy` writes a single clipboard, and paste indices are measured against a document every insert changes, so overlapping the _edits_ would interleave them. The fetch is the slow part anyway.

Preload failure is non-fatal by design — that template's own insert fetches it again and reports in the usual place — which is why `prefetchTemplates` passes `waitLimit: 1`. That value is load-bearing: its _span_ is already the longest in the codebase (a ten-template batch asks for 60s), so re-arming would make a pure optimization the slowest thing in the run.

`templateContentCache` holds the **in-flight promise**, not the resolved value, so a prefetch and the insert that follows it share one request instead of racing into two. A rejection is evicted from the cache; otherwise one failed fetch would poison that template for the lifetime of the page.

`rename` sets `settings._title` through `document/elements/settings`, so it is undoable and the navigator relabels itself — it works with the navigator closed, unlike `batch-rename.js`, which types into the navigator DOM. Two shapes: `{ ids, title }` for one name across a batch, `{ items: [{ id, title }] }` when the name is derived per element. Equal names are grouped into one command, and a name that already matches is skipped entirely (reported as `unchanged`) so a re-run touches nothing. Name _formatting_ stays in `template-format.js` — the page world cannot read that global, and a second copy of the tag regex here is exactly how the two would drift.

**Never pass `options: { external: true }` on that settings command.** External marks the change as coming from outside the panel, which makes Elementor re-render the element — and re-rendering a live, populated container in the preview made a styled container disappear from the page. `_title` has no selectors attached, so the model change alone is what relabels the navigator; `render: false` says so explicitly.

**`insert-template` regenerates every element id before importing** (`regenerateIds`), and this is not optional. A template's JSON carries the ids of the elements it was saved from; importing it raw re-uses them, so a template saved from a container that is _still on the page_ produces a second element with the same id. Every lookup afterwards can then resolve to the wrong one — which is how a style sync deleted the page's own container instead of its staging copy, with undo unable to restore it because the history entries pointed at the duplicated id too. Elementor's library modal regenerates ids on its way in; calling `document/elements/import` directly skips that. `freshId` checks each candidate against a `liveIds()` snapshot — one walk of the document, taken per import — and adds every id it hands out to that set, so two elements of the _same_ template cannot collide either. It used to ask `elementor.getContainer` per candidate, which is a recursive document lookup asked once per element in the template; an empty snapshot (no preview container) degrades exactly as the old thrown-lookup path did.

`template-sync` keeps a second net for this: `tally.pageIds` snapshots the page before any insert, and a template whose inserted ids collide with it is abandoned **before** the `try`, so nothing is styled and nothing is deleted. An orphaned copy is a nuisance; deleting the original is not recoverable.

`insert-template` takes optional placement: `intoId` appends inside that container, `afterId` lands the template directly after that element, neither means the end of the page. `import` can only append, so the `afterId` case imports into the anchor's parent and then moves the block into position (copy → paste at index → delete, the same shuffle as `replace-container`). The parent there is taken off the anchor object rather than through a second `getContainer` call — a top-level element's parent is the document container, which `getContainer` cannot resolve.

`describe-selection` reports the editor's current selection: id, name, type, `canHoldChildren`, parent, index. It tries `elementor.selection`, then the panel's edited element, then the navigator's editing row, and returns which one answered in `via` — the navigator alone would mean the tool only works with the navigator open. The document root is never a selection; some versions report it when nothing is selected, so a candidate with no parent is skipped.

`list-template-widgets` is the only op that reads a widget's `settings`. Everything else describes structure; the Template widget's whole identity is `settings.template_id`, so it needs its own walk. It also returns the widget's **Advanced tab** as `advanced` — see below.

### Transferring an Advanced tab

`apply-advanced-settings` writes one element's Advanced tab onto the elements that replaced it. `template-decouple.js` is the caller: a Template widget's own padding, CSS classes, motion effects and so on are **not in the template's content**, so a plain content swap drops them.

- **Captured at scan time, in `list-template-widgets`.** `replace-container` deletes the widget, so by the time there is somewhere to put these values the element holding them is gone. `advancedSettings()` diffs `settings.toJSON()` against `settings.defaults` and keeps only what the user actually moved — a widget carries ~550 advanced controls and all but a handful are untouched, which is what makes it cheap enough to ride along with every scan.
- **Keys are resolved against the _target's_ live control list, not a mapping table.** Widgets prefix advanced controls with an underscore and containers mostly don't (`_padding` → `padding`). Reading the schema is what keeps this working across Elementor versions.
- **The lookup spans every tab on the target.** A widget's `_background_*` sits under Advanced while a container's `background_*` sits under Style; filtering the target by tab loses ~245 keys that map perfectly well. This is the easy mistake here.
- **The control `type` travels with the value** because the source is deleted before the write. A key that resolves to a different type is dropped rather than written — same name, different value shape. Measured on Elementor 4.2.1: 499 of a Template widget's 553 advanced controls resolve onto a container with **zero** type mismatches. The rest (`_mask_*`, `_element_width`, `_element_vertical_align`) have no container twin and come back in `dropped` for the caller to report.
- **`_title` and `_element_cache` are never transferred.** `_title` is the navigator label and the decouple writes its own tagged name there.
- **Default render, unlike `rename`.** These controls carry selectors, so the model change alone leaves the preview stale — `render: false` would put the padding in the model and nowhere on screen. `options.external` still stays off, for the reason documented on `rename`.
- **Multi-root: `_element_id` is dropped, everything else repeats.** Several siblings land where one widget stood; repeating spacing across them is a judgement call the modal warns about, but the same CSS ID on three elements is three duplicate DOM ids. The toggle is **on by default** — decoupling is meant to produce the same block, unlinked, and silently losing the widget's box was the gap this closes.

`history-start`/`history-end` wrap a burst of `$e.run` calls in one undo step via `document/history/start-log`. Both degrade to no-ops (`logId: null`) rather than failing the caller.

## Template tag

Every layer these tools create carries the template's id as a suffix on its layer name — `TW Hero #4821` — and, when the template has more than one root, **which root it is**: `TW Hero #4821.2`. Written by `template-insert`, `template-sync` (both ops) and `template-decouple`; read by `template-sync` as its **first** matching pass. Helpers live in `template-format.js`: `templateTagKey` · `withTemplateTag` · `parseTemplateTag` · `stripTemplateTag`.

- **Why the layer name.** It is the only per-layer field readable on every Elementor version, and it stays visible in the navigator — the link is never invisible state the user can't see or fix.
- **Id first, name second.** The tag is exact; a name is hand-typed and drifts. A renamed layer still resolves to the template it came from, and name matching only has to answer for layers that were never tagged (hand-built containers).
- **The root index is what makes multi-root templates work.** It is 1-based, matching how the tools label roots, and it is a _position_ — re-saving a template with its roots reordered re-points the tags. That is inherent to identifying a root by where it sits; there is nothing else stable to key on.
- **One place builds tag strings** (`templateTagKey`) and the same key is what the page-node index is keyed on, so a writer and a reader cannot disagree about the shape.
- **Name matching strips the tag** before comparing (`stripTemplateTag`). Without that, tagging a layer would break the very name match that found it — `TW Hero #4821.2` still matches a root named `TW Hero`.
- **`withTemplateTag` rewrites its own tag and appends anything else.** Same key ⇒ unchanged, so naming twice is idempotent. A tag for the _same template_ is replaced in place (`#4821.1` → `#4821.3` when a root moves). Any other trailing `#n` is treated as part of a hand-typed name and kept: `Card #2` + 4821 → `Card #2 #4821`.
- **A bare `#id` on a multi-root template is reported, not guessed.** It predates the template having several roots, so nothing says which root it holds — and guessing would style, or destroy, the wrong block. The modal lists the offending layers and says to add `.1`…`.N` or re-insert. A _single_-root template accepts `#id` and `#id.1` interchangeably, so a template that has since lost roots still finds its blocks.
- Only roots are tagged, so tree pairing is unaffected at the root. A tagged layer nested _inside_ a synced block (tagged by an earlier run) misses `pairTrees`' `type + name` pass and aligns on the type-only pass instead — degraded, not broken, which is what that second pass exists for.

## Template sync

`Tools/template-sync.js` — one click, no layer selection required. Lists site templates, reads the document's top-level containers, and for each container whose name matches a template title: inserts the template, pairs the two trees, copies styles node-by-node, then deletes the inserted copy in a `finally`.

- **Top-container names** come from the model (`settings._title`), not the navigator DOM — the navigator does not need to be open. A container that was never renamed reports `""` and simply never matches.
- **Matching is two-pass: tag, then name.** A page node carrying `#<templateId>` resolves to that template exactly (`byId`, which cannot collide); only an untagged node falls through to the name. Both passes run at the queue level (which templates get fetched — the id part alone) and at the target level (which containers a root acts on — the full key, root index included).
- **Name matching** is trimmed, whitespace-collapsed, case-insensitive, and ignores any id tag. A title that resolves to two or more templates is dropped as ambiguous rather than guessed.
- **Every touched target is renamed** to `<template title> #<tag>` afterwards, through the shared `nameTargets`. For a replace that is the only thing keeping the link: the paste brings the template's own root name with it, so without this the container's identity — tag included — would be gone and the next run could not find it. The name is **always** the library title, never the root's or the container's own name; roots of a kit therefore share a name, and the root index in the tag is what distinguishes them. Matching still consults the root's name (below), so hand-built untagged containers keep working.
- **Tree pairing** (`ns.pairTrees`) aligns rather than marching in lockstep — see below.
- **Multi-root templates are normal, and each root is its own template.** Elementor saves whatever was selected, so a template's JSON often holds several top-level elements. Every root is handled independently — by its `#id.N` tag first, then by _that root's_ layer name — so one saved template can act as a kit of blocks, named or not. A root with no name falls back to the template's own title, which keeps ordinary single-root templates working unchanged. Do not reintroduce a single-root requirement, and do not warn about kits: `tally.multiRoot` is reported as information, and does not colour the run's outcome.
- **Two-level matching.** A template enters the queue when a page node carries its id or its _title_ matches one; the _tags and root names_ inside it then decide what each root actually styles. A root can therefore target a container other than the one that pulled its template in. A template nothing points at is never fetched — that keeps the run to one insert per matched template instead of fetching the whole library.
- The whole run is one undo step, and `copy` clobbers Elementor's clipboard (same as the other tools).

### Nested matching

**Match nested containers** is a toggle in the confirm modal, off by default. Off, only top-level containers (`depth === 0`) can be targets. On, the whole page is searched, so a `TW Card` template styles every `TW Card` nested anywhere in the document.

- Nested candidates must match the template root's **name and type**. Top-level matching stays name-only on purpose: the candidate set there is tiny, and a type clash is more useful surfaced as a pairing failure than silently dropped.
- The toggle changes which _templates_ qualify, not just which targets — a template whose title matches only a nested node is invisible when the toggle is off. That is why `choose` rebuilds its list from `buildQueue(toggleState)`.
- Nested targets are processed **outermost first** (sorted by `depth`).
- **Replace + nested needs the ancestor guard.** Replacing a container deletes its descendants, so any later target inside it has a stale id and the bridge would throw. `tally.replaced` plus `firstAncestorIn` (which walks the target's own ancestors and asks the set, rather than testing descendancy once per already-replaced container) skips those with a warning. Styles mode needs no guard — nothing is deleted, so ids stay valid.
- Known gap: if an _inner_ target is replaced before an outer one from a different template, the inner work is silently discarded. Depth sorting prevents this within a single root's target list, not across templates.

### Two operations, one pipeline

`template-sync.js` runs both `Ctrl+Shift+6` (style) and `Ctrl+Shift+7` (replace) through the same discovery pipeline — list templates, read top containers, match by name, insert once per template, walk roots. They differ only in the per-target action, selected via the `OPS` table:

- `OPS.styles` → `applyRootToTarget` — pairs the trees and pastes styles node by node.
- `OPS.replace` → `replaceRootIntoTarget` — calls the `replace-container` bridge op. No pairing at all: the template's structure wholesale becomes the page's, so nothing has to line up. **Destructive** — the page container's current content is deleted.

Add an operation by extending `OPS`, not by forking the pipeline.

`op.run` returns **the ids to name** — the target itself for styles, the newly pasted roots for replace — or `null` when it failed or skipped. That is what keeps naming in the shared pipeline instead of inside each operation; a new operation only has to say which elements now represent the block.

`tally.skippedReplaced` guards a target that is _already_ replaced as well as one inside a replaced ancestor. Two templates can legitimately land on one container — by id tag from one and by name from another — and the second replace would otherwise hand the bridge a deleted id.

`replace-container` does copy → paste-at-index → delete-target page-side in one op, so the parent lookup and index can't drift between round trips. The staging copy survives each replace, so one template can replace several targets before being cleaned up. It takes `sourceIds` (an array) as well as the original single `sourceId`, so a multi-root template drops all of its roots into the one slot, in order.

## Template decouple

`Tools/template-decouple.js` (`Ctrl+Shift+9`) unpicks Elementor Pro's **Template widget**: it swaps each widget for a copy of the template's own content, in place, so the content becomes ordinary editable elements that no longer track the template.

**This tool does not match on names.** The Template widget stores its target in `settings.template_id`, so the link is exact — titles appear in the UI as labels and nowhere else. That is the whole difference from `template-sync`, and it is why a failed `list-templates` call is non-fatal here: the run degrades to showing bare ids and carries on.

- **Placement** reuses `replace-container` rather than importing at a chosen index. The index is resolved page-side from the widget's own id at the moment of the swap, so earlier swaps shifting its siblings cannot misplace it. Two Template widgets sitting side by side in one container is the normal case, not an edge case.
- **Grouped by template, not by widget.** Several widgets routinely point at one template — three cards holding the same button, say. The template is inserted once as a staging copy, pasted into each target, and deleted in a `finally`. One network fetch per distinct template, not per widget.
- **The decoupled content is named and tagged** `<template title> #<tag>`. Decoupling is what destroys `settings.template_id`, so the tag is the only remaining trace of where the content came from — and it is what lets `template-sync` still find and re-style the block. The name is the library title; the widget's own layer name only stands in when the library fetch failed and there is no title to use. A multi-root template lands several siblings in the widget's place, so each takes its root index and they stay individually addressable.
- **The widget's Advanced tab comes with it** — padding, margin, z-index, CSS classes, motion effects. None of that lives in the template's content, so without this a decoupled block loses the box it sat in. A toggle in the confirm modal, **on by default**; the mechanics are `apply-advanced-settings`, above. Non-fatal by design: the content has already landed and the widget is already gone, so a failure degrades the row rather than failing the run.
- **Skip word** applies to the widget's own layer name, so a single widget can be held back without unticking it every run.
- **Nested Template widgets are left alone, by design.** Decoupled content can itself contain Template widgets; the run re-scans afterwards, reports anything carrying an id it hadn't seen before, and stops. A second keypress is safer than a recursive walk that a self-referencing template would send round forever.

Checklist labels are `"<template>" — inside "<parent>"`, which collides readily — three containers all named "Card" holding the same template read identically. Repeats are numbered `(2 of 3)` in document order so the rows can be told apart. Don't drop that: an ambiguous checklist is worse than no checklist, because unticking the wrong row is silent.

## Template insert

`Tools/template-insert.js` (`Ctrl+Shift+8`) is independent of name matching: it lists the whole library in a searchable modal with a checkbox per template, and inserts everything ticked at the end of the page — or at the current selection, and as content or as Template widgets; both are checkboxes, see below. Insertion follows **tick order**, not list order, so the sequence is controllable. The whole batch is one undo step.

Each row shows the title, then author and last-modified date beneath it, with the template type on the right. Elementor's field names for those vary by version, so `list-templates` tries several candidates (`human_modified_date` → `human_date` → `modified` → `date`) and prefers the server's own preformatted string, which is already in the site's locale and timezone. It also returns `fields` — the raw key list from the first template — so a missing column can be diagnosed without guessing.

Search is multi-term over title, type _and_ author — every whitespace-separated term must appear somewhere, in any order, so `hero prim` finds "TW Hero Primary". `Select shown` ticks everything currently matching; a ticked template hidden by a later search still counts toward the total and the status line says how many are hidden, so the count never looks wrong.

### Inserted roots are named and tagged

Every root an insert creates is renamed to `<name> #<templateId>` (`rename` op, inside the same undo step). An imported root otherwise reads as a generic "Container" in the navigator, and the tag is what makes the block findable — and re-syncable — later.

The name is **always the template's title from the library**, whatever the root was called inside the template. Each root of a multi-root template therefore gets the same name, and its tag carries the position (`#4821.1`, `#4821.2`) — the tag is the identity, not the name. A failed rename is non-fatal — the insert already landed, so it degrades to `rename failed` on the row rather than failing the batch.

### Insert at the selection

A checkbox above the search box redirects the batch to whatever the editor has selected. **The selected element's type decides what "at" means** — a container takes the templates as its last children; anything else cannot hold children, so they land directly after it. The row spells out which of the two it will do, and the status line always ends with the destination (`→ inside "Hero"` / `→ end of page`) so it is readable without re-reading the checkbox.

- **Off by default.** Inserting at the end of the page is what this tool has always done, and the selection is only whatever happened to be clicked last — a silent redirect based on that would be a surprise.
- The selection is read **once, before the picker opens**, in the same `Promise.all` as the library fetch. The picker is a full-screen overlay, so the selection cannot change underneath it. A failed read is non-fatal: the option is simply not offered, and the modal says nothing is selected rather than showing a dead checkbox.
- **The anchor advances.** In the after-a-sibling case each insert re-anchors on the element it just created, so several templates keep their tick order instead of each one landing in front of the last. The inside-a-container case needs no such bookkeeping — appending is already in order.

### Insert as Template widget

A second checkbox switches the whole ticked batch from a copy of each template's content to **one Elementor Pro Template widget per template**, pointed at it via `create-element`. Same hotkey, same picker, same tick order, same undo step. **Off by default** — a copy is what this tool has always produced, and the two make very different documents: a widget stays linked, so template edits follow it, while a copy is independent from the moment it lands.

- **The end of the page needs a wrapper.** A widget cannot be a direct child of the document, so widget mode builds **one** container at the end of the page (named `Template Widgets`, because an unnamed one reads as "Container") and puts the whole batch inside it. One wrapper, not one per widget — the batch is a batch. If the container cannot be created nothing is attempted, and every row says so rather than sitting on "waiting".
- The **at-selection** cases need no wrapper: a selected container already holds widgets, and a selected non-container puts them after it inside its own parent. Both compose with this checkbox, and the status line's destination reflects whichever combination is set.
- **No prefetch.** `prefetchTemplates` warms template _content_, and widget mode never reads any — it writes an id into a setting. Warming it would be work the run doesn't use, and a preload failure on those rows would describe something that never happens.
- **Named with the title, no `#id` tag.** The tag exists because a copy keeps no other trace of its origin; a widget holds `settings.template_id`, an exact link a rename cannot break, so a tag would be a second answer to a settled question. `template-decouple.js` is what writes the tag — at the point where it destroys `template_id`.

### Progress modal

The run drives a modal (`ElementorTools-template-sync-modal`) that opens immediately, reports each phase, keeps a per-target live status row, and stays open at the end with a summary plus **Copy details**. The confirm step is always shown — there is deliberately no skip-confirm setting.

Confirm is a **checklist** (`modal.choose`), not a yes/no. Every matched template starts ticked, so the default is the full match set and unticking is the deliberate act; `All` / `None` buttons handle long lists, and the primary button is disabled at zero. It resolves to the chosen items in their original order, or `null` on cancel. On resolve it removes only its own rows, so notes logged before the confirm (ambiguous-title warnings) survive into the progress view.

Roots whose layer name is empty or a generic Elementor default (`GENERIC_ROOT_NAMES`, currently just `container`) are skipped with a warning rather than guessed at. Templates with more than one root are processed in full, then re-warned in a block at the end of the run so the notice isn't lost in a long log.

On a pairing failure the modal shows the divergence path plus both tree shapes, which is normally enough to see the cause without opening a console:

```
root: template is "section" but page is "container"
    template: section[container[widget:heading]] (3 nodes)
    page:     container[widget:heading] (2 nodes)
```

`ns.summarizeTree(node, depth)` and `ns.countNodes(node)` produce those; both live in `core_utils.js`.

## Animation presets

`Tools/animation-presets.js` overrides an element's **Motion Effects** dropdown — the whole `section_effects` block on the Advanced tab — from a saved preset. The UI is entirely in the panel (`Animation Presets`): `New`, `Import…`, a button per preset carrying its name, and `✎` rename · `⟳` re-capture · `Export` · `✕` delete per row. **There is no hotkey**, because which preset to apply cannot be expressed as a keystroke.

**A preset is authored in Elementor, not in a text editor.** `New` copies the selected layer's Motion Effects into a preset and adds it — style a block with Elementor's own UI, then capture it. That is why there is no blank template to fill in: the controls are conditional, unit-bearing and slider-shaped, and Elementor's panel is simply a better editor for them than JSON is. Export → edit → Import remains for tuning a captured preset by hand.

**Apply means the tab now equals the preset.** All 61 settings are reset to their Elementor defaults and then the preset's own values are written over the top, so a field the preset omits goes back to default rather than keeping what the previous preset left there. That is what makes applying two presets in a row predictable, and it is the whole reason the op resets rather than merges.

- The reset is `document/elements/reset-settings` — a real Elementor command, so it is history-tracked and undoes together with the write as **one** step. 61 default-valued writes would do the same thing; this is one command instead.
- **It does not make the saved document leaner, and it was never going to.** Elementor's settings model always carries every control (~856 on a container) and strips default-valued keys itself at save time — `toJSON({ remove: ['default'] })` is what gets persisted. Delete-then-write and write-the-defaults produce byte-identical saved JSON. The reason to prefer the reset is that it is one command, not that it saves space.

### The field table is hardcoded; the key it resolves to is not

`animation-preset-fields.js` holds all 61 fields with their type, Elementor default and a hand-written comment, captured from Elementor Pro on 2026-07-31. It is deliberately a snapshot: the point of a preset file is that a human reads and edits it, and a comment generated at runtime cannot be reviewed before it ships. Re-diff it against `container.settings.controls` after an Elementor upgrade — anything new simply goes unmanaged until it is added.

What is _not_ hardcoded is the key each field goes by on a given element. Every key in the table is the **container** spelling; `apply-preset-settings` resolves it against the target's own control list, which is what makes one preset work on both containers and widgets. See `resolveControlKey` above for why a prefix table is the wrong shape.

- **The section has 65 controls and 61 settings.** `ai_animation` (a raw_html "Animate With AI" button), `handle_motion_fx_asset_loading` (hidden bookkeeping), `anchor_offset_description` (raw_html help text) and `sticky_divider` are not settings and are absent from the table.
- **Sliders are objects, not numbers** — `{"size":4,"unit":"px","sizes":[]}`, and the viewport ranges nest `{"start":20,"end":80}`. Every slider comment says so, because writing `4` puts garbage in the model.
- **Default comparison ignores key order.** Elementor serialises a slider's keys in a different order than this file does, so a plain `JSON.stringify` compare calls an untouched default "changed" and writes it back. `canon()` sorts keys first. Without it a preset that sets nothing sends a 61-field message.
- Everything in the section is in scope: Scrolling Effects, Mouse Effects, Sticky _and_ Entrance Animation. This is Pro-only territory apart from the entrance animation, and Pro is assumed.

### Preset files

`{ id, name, fields: { <key>: { comment, value } } }`. **`id` decides replace-or-add** — importing a file whose id matches an existing preset overwrites it in place, name included, so the loop is Export → edit → Import.

- **`New` requires a selection and writes no file.** With nothing selected there is nothing to copy, so it reports instead of creating an empty preset there would be no way to fill in. The new preset takes the layer's own name (`Untitled preset` when the layer has none) and is saved straight to `browser.storage.local`.
- **Capture reads through `read-preset-settings`**, the exact inverse of the write and the reason both directions agree: one `resolveControlKey`, one canonical key list. It answers **every** requested key, defaults included, because a preset describes the whole tab — "this effect is off" is a fact a preset has to be able to state, and an omitted key cannot. A key the element lacks falls back to the Elementor default, so a preset captured from a widget still carries container-only fields and applies to either.
- **`⟳` re-captures into an existing preset**, replacing its values wholesale from the selected layer. The `id` and the `name` survive: the id is what Import matches on, and the name is the user's rather than the layer's — so a preset can be re-tuned in Elementor and pulled back in without the presets that reference it by id going stale.
- **Two captures of one layer are two presets.** Same name, different ids, both listed — `✎` renames them apart, and `⟳` is the alternative when you meant to update rather than add.
- **`⟳` and `✕` both arm before they act** — first click shows `Sure?`, second does it, 4s to change your mind. One armed action exists at a time (`armed = { id, kind }`), because two rows both offering `Sure?` is a misclick waiting to happen, and arming cancels an open rename since a focused input under a `Sure?` button reads as if the confirm applied to the name.
- **Rename is an inline input, and it stays open until it is committed or cancelled** (`Enter` / `✓` saves, `Escape` discards). Clicking away deliberately leaves it alone: committing on blur either discards the edit silently or swallows the click that caused the blur, because the commit re-renders the row out from under it. Anything that rewrites the stored list — a capture, an import, a delete — drops the edit, since the preset it was bound to is no longer the one in hand.
- **Import is tolerant, export is canonical.** A field may be `{comment, value}` or a bare value, so stripping the comments by hand does not break a preset. Comments are re-attached from the current table on export, and an unknown key is _reported_ rather than kept — a typo in a key is otherwise indistinguishable from a field that had no effect.
- A file with no `id` is imported as a new preset with a generated one rather than rejected.

### Delay Accumulation

A panel field, not a preset property — the same preset gets staggered differently run to run. With **more than one** layer shift-clicked, layer _N_ gets `base + accumulation × (N − 1)`, where base is the preset's own `animation_delay` (0 if it sets none). One layer gets the preset's delay untouched.

- **Order is shift-click order, and it comes for free.** `selectedIds` in `multi-select.js` is a `Set`, and JS iterates insertion order, so `getIds()` already answers in the order the user clicked. Deselecting renumbers what is left; re-selecting a row puts it at the **end**, which is what "the order it was selected in" means.
- `animation_delay` is the one non-responsive field in the entrance group (`animation` has five breakpoint variants, the delay has none), so a stagger is one value per layer with nothing to decide per breakpoint.
- When a stagger is in effect the computed number is written on **every** layer including the first, rather than leaving layer 1 unset — `0` and "no delay" should not look different in the document for no reason.

### Reporting

Shift-click always wins over the navigator selection: it is an explicit act, and its order is the whole input to the stagger. With nothing shift-clicked it falls back to `describe-selection`, which is always a single element. **Capture uses the same resolution but reads only the first** — the layer wearing badge #1 — because picking one of several has to be predictable and visible, and that badge is both.

Capture answers the panel over its own `capture-preset` message rather than `run-action`: the panel needs the values _back_, and `run-action` deliberately replies as soon as a run has started. The listener returns `undefined` for every other message type so the page's other listeners stay free to answer.

Results go to the **log**, not a modal — nothing here touches the network, so the modal rule does not apply, and the panel already re-renders the log live. One line for the run (layer count, field count, the delay sequence), one warning per layer that skipped a field, one line for the outcome. **Every skip is reported**: a field that could not be written is a value the user put in the preset and did not get, which is exactly where silence reads as success.

Targets are sent in batches of `NODE_CHUNK` (20). The page world cannot yield mid-op and each element costs two Elementor commands, so a batch is the unit of "still alive" and the timeout scales with it — the same reasoning as `STYLE_CHUNK` in `template-sync.js`.

**Known limitation: a preset leaves no trace on the element.** Unlike the template tag, nothing records which preset an element carries, so "re-apply preset X everywhere it was used" is not a question this design can answer. Accepted deliberately.

## Pure container reset

Two panel checkboxes, both **on by default**, riding one `document/elements/create` hook:

- **Pure Container Reset** zeroes `padding`, `margin` and `flex_gap` on every new container, at every breakpoint.
- **Unlink Fields On New Elements** forces the "link values together" button off on every new element — see below.

There is no hotkey and no modal for either: they are passive, they react to the editor rather than being invoked, and nothing here touches the network.

This is the only feature in the codebase that **reacts to an Elementor command** instead of issuing one, and that shape is where all of its design decisions come from.

**They are two flags, not one option with a mode**, because their scopes genuinely differ — the reset is about a container's box, the unlink is about a button every element type has. `configure-pure-reset` carries both in one message: one hook serves both, and pushing them separately would leave the page world briefly holding a stale half of the pair. `getConditions` fires if _either_ applies, and `hookFlagsFor(model)` is the single place that decides which.

**Both write in one settings command.** They overlap — `padding` is a box control _and_ a link-bearing one — and a control holds a single value object, so two commands would mean the second overwriting the first's work on the shared keys. Measured on a container with both on: 15 zeroed, 40 unlinked, **40 keys written**, not 55.

- **It is a real `$e.hooks` data-after hook on `document/elements/create`**, registered page-side in `page-bridge.js` by extending `$e.modules.hookData.After`. Both that class and `$e.hooks.registerDataAfter` were verified present on this Elementor build before the code was written — a monkey-patch of `$e.run` was the alternative and is strictly worse, because Elementor's own internals reach commands by routes that do not all go through `$e.run`.
- **A hook fires in the page world, so a content script cannot be on the other end of one.** `Tools/pure-container-reset.js` therefore owns nothing but the on/off flag: it reads `pureContainerReset` from storage, pushes it through `configure-pure-reset`, and re-pushes on change. The hook itself reads the flag in `getConditions`, so toggling the option never attaches or detaches anything — there is no half-removed hook to get wrong.
- `undefined` means "never set, use the default" and the default is **on**, the same distinction `skipWord` draws. The default is stated in both `UI/panel.js` and `Tools/pure-container-reset.js`, because the panel loads no content scripts.

### Telling a new container from a copied one

**Paste funnels through `document/elements/create`.** Measured on this build: pasting a container fires `create` with `elType: "container"` and `document/elements/paste` sitting in `$e.commands.currentTrace`. So "not when I paste" is answered by the **trace**, via `COPY_COMMANDS` — `paste`, `import`, `duplicate`, `paste-area`, `document/ui/*` and `browser-import`.

That is exact, and the obvious alternative is not. Inferring it from whether the spacing is still at its defaults would zero a _pasted_ container that happened to carry no spacing — precisely the case the exclusion exists to protect.

- **Nested containers need no special case.** Each one is its own `create`, so each gets its own hook fire.
- **`create-element` suppresses itself** with a counter, and the counter wraps the whole command **regardless of `elType`**. `ns.createContainer` builds the wrapper a widget-mode batch insert needs somewhere to put its widgets, and `ns.createTemplateWidget` builds the widgets themselves — both are the extension adding elements, not the user. That second one only started mattering when the unlink option brought widgets into scope; it was already covered. Every _other_ tool here reaches the document through paste or import, which `COPY_COMMANDS` already covers.

### The decision is synchronous, the write is not

`getConditions` runs while the trace still says how the container came to exist; `apply` only captures the ids and defers the write with `setTimeout`. Running a settings command inline would fire it while Elementor is still finishing the create it is reporting — and by the time the deferred callback runs, `currentTrace` is empty, which is why the copy test **cannot** be moved down into `apply`.

The consequence is that the zeroing lands as **its own undo step**, which is accepted rather than worked around: grouping it with the create would mean holding a history log open across a deferral.

### The keys come from the live control list

Never a hardcoded table, for two reasons that both bite:

- **The responsive suffixes depend on which breakpoints the site has enabled.** The site this was built against carries `tablet_extra` and `mobile_extra` on top of the usual `tablet`/`mobile`; a default install does not. Hardcoding the common set would silently miss the rest. On that site 15 keys resolve — 5 padding, 5 margin, 5 `flex_gap`.
- **A container's gap control is `flex_gap` (type `gaps`), not `gap`.** Section and column markup carries a _different_ control literally named `gap` — a select holding "default"/"narrow"/"extended". `BOX_ZEROS` is keyed on control **type**, so that one has no zero and is skipped rather than being written a dimensions value.

The two shapes differ and are not interchangeable: `dimensions` takes `{top,right,bottom,left}`, `gaps` takes `{column,row}`. Both are written as `"0"` rather than `""` — empty means "inherit whatever the kit or theme says", which is the default this feature exists to override.

### Unlink new elements

Elementor defaults the link button **on** (`isLinked: true`) for both control types that have one. This option flips it off at creation, so a fresh element starts with its sides independently editable.

- **Detection is by control _type_, never by name.** `LINKED_TYPES` is `dimensions` and `gaps` — measured on this build a container has 30 of the first and 10 of the second, and **every one of them holds `isLinked`**, so the button is a property of the type.
- **That is what makes widgets need no special case.** A widget prefixes some of these controls with an underscore (`_padding` where a container has `padding`), so a name-based rule would need the `resolveControlKey` mapping; a type-based one never sees the difference. Verified on a `heading`: 30 controls unlinked, keys including `_margin_tablet_extra`, with no mapping table involved.
- **It applies to every new element, not just containers** — a widget's padding has the same button. The zeroing stays containers-only, which is why the two flags cannot be one.
- **Values are preserved; only the flag moves.** A control the reset is not zeroing is written back with its own current value and `isLinked: false`, so `border_radius` keeps its sides. A control already unlinked is left out of the payload entirely rather than restated.
- **`BOX_ZEROS` holds no `isLinked`, deliberately.** It used to assert `true`, which meant zeroing a box quietly _re-linked_ it whatever this option said. The flag is now carried from the live value in one place (`createSettings`), so with the unlink option off, a zeroed container keeps the button exactly where the user left it — verified: `padding.isLinked` stays `true` and `border_radius` never enters the payload.
- **The cost is real and was chosen.** A flipped `isLinked` is not a default value, so Elementor cannot strip it at save — every new container carries ~40 extra keys in its saved JSON (~30 on a widget). `dimensions` covers `border_width` and `border_radius`, not just padding and margin.
- Stored as `unlinkNewElements`; `undefined` means "never set, use the default" and the default is **on**, the same distinction `skipWord` draws.
- **The breakpoint flyout honours the same flag** — see "Honouring the unlink option" under Breakpoint flyout. Between them, the two cover the create path and the edit path, so a field that starts unlinked is not quietly re-linked by editing it.

### Reporting

Every write reports to the **log** — no modal, since nothing here touches the network and the user did not invoke it. The panel already re-renders the log live, so a passive feature announcing itself there is how you can tell it is working at all.

**This is the bridge's one unsolicited message.** Every other page → content-script message answers a request and carries its `requestId`; the hook fires off an Elementor command instead, so it has nothing to answer on. `emit(event, detail)` posts `{ __ns, __event }` and `pure-container-reset.js` listens for it. `core_utils.js` exports `ns.BRIDGE_NS` so the listener matches on the same namespace the bridge sends on rather than repeating the literal a third time. The existing `callBridge` listener ignores these — they have neither `__ready` nor `__response`.

- **One line per element, not per drop.** A drag that auto-creates a wrapper _and_ an inner container is two creates, so two writes and two lines. Rolling them into one would hide the nested one, which is the part worth being able to see.
- **The line names what actually happened**, since either option can be off: `container d12e35f: zeroed 15, unlinked 40 field(s)`, or `heading a1b2c3f: unlinked 30 field(s)` when only the unlink applies.
- **A fresh element has no `_title`**, so the label is the element kind plus the bare id. The kind is the `widgetType` where there is one — "widget" alone does not say which — and a named element gets `container "Hero" (d12e35f)`.
- **Three outcomes, three lines.** A successful write reports its counts; a failed settings command is a warning with the error; **nothing resolved is also a warning** — on a container that means the control names moved in an Elementor upgrade, which must not read as a silent success.
- **The one silent case** is an element deleted between the hook firing and the deferred write landing. Nothing was written, but there is no element left for that to be wrong about.

## Breakpoint flyout

`Tools/breakpoint-flyout-page.js` adds two things to Elementor's panel, deliberately scoped differently. **There is no hotkey, no button and no field list.**

- **Left-click a responsive field** — its label or the empty part of its row — opens a flyout showing that field at every active breakpoint at once, instead of cycling the device switcher one breakpoint at a time.
- **Right-click any field at all** opens a small menu with Copy and Paste for that field's value.

The row _is_ the affordance; there is no icon. Only the label and the row's own whitespace are clickable, and the cursor changes on exactly that region — a click on an input, the unit picker or Elementor's device switcher passes straight through, so nothing that used to work stops working. `PASSTHROUGH` expresses that as a rule about **structure** (every control nests its inputs under `.elementor-control-input-wrapper`, `.e-units-wrapper`, or the switcher div) rather than a blocklist of control types that would need extending each time Elementor adds one.

Right-click keeps the native menu inside text entry, where spellcheck and text copy/paste are worth more than ours.

### The detection rule, and the field that carries it

A responsive control is generated once per breakpoint and the copies chain through a **top-level `parent`** on the control config. The head of that chain — `parent` null with a `responsive` object present — is the control the user sees.

**It is `cfg.parent`, not `cfg.responsive.parent`.** That second one does not exist, and reading it is silent rather than loud: every variant then looks like a base, so a button appears on all 620 responsive rows and each flyout shows exactly one device. Measured on Elementor 4.2.1, a container has 904 controls of which 620 are responsive, partitioning **exactly** into 124 bases × 5 devices — that arithmetic is the check that the walk is right.

Breakpoints come from `elementor.breakpoints.getActiveBreakpointsList({ withDesktop: true })`, reversed so the widest is first. Never hardcode the list: the site this was built against runs both "extra" breakpoints (`mobile, mobile_extra, tablet, tablet_extra, desktop`), and a five-device site is not the default shape.

Only 17 of the 85 switcher-bearing rows on the Layout tab are bases; the other 68 are the per-device variant rows Elementor renders hidden. Filtering on the base rule is what keeps it to one button per field.

### The views are Elementor's own

Each breakpoint row is a real Elementor control view — `elementor.getControlView(type)` instantiated with the live view's `{model, container, elementSettingsModel, elementEditSettings, element}`. Nothing here reimplements a slider, a dimensions group, a media picker or a unit dropdown, and that is deliberate: the flyout inherits every control type the install has, including ones added by a future Elementor version.

The view's `el` is appended **before** `render()`, so controls that measure themselves during init do it while in the document.

**Showing a non-active device's row takes `display: block !important` on the row, and nothing less.** This is the easy thing to get wrong, because it looks like it should be a class. It is not:

- The row renders its **full markup** — a tablet slider is ~5k of real HTML with its 7 inputs present — so nothing is missing or failing to build.
- Removing `elementor-hidden-control` does **not** reveal it. Measured on 4.2.1 the row still computes `display: none` with that class gone.
- It is **not an inline style**. There is none, and clearing `el.style.display` changes nothing.
- The rule cannot be found from script: 37 of the editor's 38 stylesheets are readable and none of their `display: none` rules match the element, so it lives in the one sheet `cssRules` throws on. It therefore cannot be beaten on specificity — only with `!important` on our own rows.

Symptom if this regresses: the flyout shows Desktop correctly and every other device as a bare label with empty space under it.

### Staging: the copy is the whole mechanism

Edits are buffered and nothing reaches the document until **Apply**. Two per-instance overrides do it — Elementor's own view code is untouched.

**`getControlValue` must return a copy, and a stable one.** This is the non-obvious part. Compound controls do not write through `setSettingsModel`, or even through `settings.set` — **they mutate the object `getControlValue` handed them, in place**. Return the live object out of the settings model and those keystrokes edit the document directly: no `set()` call, no `$e` command, no history entry, and nothing for Cancel to undo. This was measured, not guessed — a dimensions control moved a container's border width with `settings.set` stubbed out entirely and the history stack untouched at 2 items.

So `working` holds one deep copy per key, seeded lazily on first read. It has to be **stable across calls**, not fresh each time: a control that mutates and then re-reads must see its own edit, which a throwaway copy would silently swallow.

`dirty` is separate from `working` because reading a key seeds a copy without changing anything — committing all of `working` would rewrite untouched breakpoints for no reason. Only `dirty` keys are written.

A **proxy container** (`Object.create(container)` with a cloned `settings`) was tried first and does not work: Elementor reaches back through the container on change and dies on `renderWithChildren`.

### Apply

One `$e.run('document/elements/settings')` with every dirty key, **wrapped in a history log** (`document/history/start-log` / `end-log`, the same grouping `page-bridge.js` uses).

The wrapper is load-bearing. A bare `$e.run` here does **not** get its own history entry — on 4.2.1 it coalesces into whatever item is already open, leaving the edit unundoable on its own. With the log it is exactly one entry, titled _Edit breakpoints_. A null `logId` degrades to no grouping rather than failing, matching `history-start`.

**Apply is the only thing that commits.** `✕`, `Cancel`, `Escape`, clicking outside, and a panel re-render that removes the anchor row all discard silently. Since nothing was ever written, discarding is just dropping the buffer.

### Every breakpoint is editable, and the unset ones say so

The flyout lists **every active breakpoint**, whether or not it holds a value. Elementor seeds all controls into the settings model, so a breakpoint that was never touched is not missing — it is present holding the control's default, and editing it is no different from editing a set one.

Variants are deliberately **not** filtered by `condition`. Measured on 4.2.1 the condition is all-or-nothing per family — 10 of the 17 visible responsive fields on a container drop all 5 variants, and none drops a subset — so filtering could only ever remove a breakpoint the user asked to be able to set. A family whose condition fails outright is hidden in the panel and cannot be clicked in the first place.

A device label is **faded and italic when that breakpoint is still at the control's default**, which is what "no value yet" means once every key is seeded. It is a read-out, not a restriction: the control below it is fully editable. The label updates from the _staged_ value, so a breakpoint un-fades the moment it is given a value and re-fades if cleared back to default, all before anything is committed.

### The cascade is previewed live

Elementor renders a breakpoint that has no value of its own using the nearest **wider** one that does. The flyout shows the same thing, and keeps showing it _while you edit_: change Desktop and every inheriting row beneath it moves with it, immediately. Without that the flyout displays a cascade the document would never produce — set Desktop to 400 and the faded Tablet Landscape underneath would sit there still reading 340.

The load-bearing distinction is between a value and a _preview_ of one:

- **`inheriting` is tracked explicitly**, as a set of keys. It has to be: the preview is a real value sitting in `working`, so an inherited `340` is otherwise indistinguishable from a deliberately-set `340` — the row would un-fade and start behaving as its own value.
- **`isOwnValue` — not `isUnset` — drives the fade.** An inheriting row usually displays a _non-default_ number and must still read as unset. This is the trap: the obvious "does it look like the default" test gets it exactly backwards for every inheriting row.
- **Touching an inheriting row is what gives it a value of its own** (`inheriting.delete` in `setSettingsModel`), and rows below it then re-cascade from it.
- **Clearing a set row back to default returns it to inheriting**, and it picks the cascade back up.
- **Previews are never committed.** Only `dirty` is written, and a preview never enters it.
- `refreshCascade` is guarded against re-entry: it calls `applySavedValue` to re-render a control, and a control that answered by writing back would loop.

`isUnset` canonicalises key order before comparing. On 4.2.1 that is precaution rather than a fix — all 620 responsive controls compare identically either way — but `canon()` in `animation-preset-fields.js` exists for exactly this reason on a neighbouring control set, and the failure mode is silent. Differing key _sets_ are a real difference and correctly read as set.

### Copy and paste, on every field

The right-click menu covers **all** controls, not just responsive ones, and one shape makes that possible: a non-responsive control is simply a family of one whose single device is `base`. `controlInfo` returns that shape for everything, so copy, paste and the flyout share a code path instead of forking on responsiveness.

- **A variant row resolves to its base.** Right-clicking `width_tablet` (the row Elementor shows while the panel is on Tablet) copies the whole family, not that one device. `resolveBase` walks `parent` upward; the same resolution is what lets a left-click on a variant open the family flyout.
- **Paste maps by DEVICE, never by key.** The entire point is pasting between two _different_ fields, whose key names differ — `padding` into `margin`. `base` and `desktop` are interchangeable in both directions, so a non-responsive field and a responsive one can trade values.
- **A type mismatch is refused, not coerced.** Elementor reuses control names across wildly different types and the value shapes are not interchangeable; a slider object written into a select is silently meaningless, so the menu says `Type mismatch: slider → select` and does nothing.
- **Paste commits immediately — no staging and no Apply.** That is deliberate: paste is already an explicit act, and a second confirmation for it would be ceremony. Once a family is a list of `(key, device)`, responsive and non-responsive are the _same_ operation, so there is one code path — build the settings object, write it in one command. It is still one undo step.
- **A flyout open on the pasted field is discarded first.** Its staging buffer is stale the moment a paste lands, and its Apply would clobber the pasted values.
- Sections are skipped: they are layout, not values.

### Whole sections

Right-clicking a **section header** — "Layout", "Background" — copies or pastes everything in it. Same menu, same transport; `infoForView` returns a section shape instead of a field shape and the two paths diverge only where they must.

- **Identity is the section's `name`, never its label.** A container's Layout is `section_layout_container` and a widget's is `section_layout`, so matching on name refuses a cross-element paste that matching on the word "Layout" would happily accept. Paste is allowed **only** into the same section name; unlike two fields of one type, section keys mean nothing outside their section, so there is no mapping to attempt.
- **A section is copied whole, defaults included** — paste is defined as making the target one-to-one with the source. Copying only the keys that happen to be set would leave the target's own extras in place and the two would not match. Same reasoning as animation presets, where Apply means the tab now equals the preset. The consequence is real and intended: pasting a section the source never touched clears the target's.
- **Sections are big and mostly untouched.** On a container: `section_background` is 212 controls with 0 set, `section_layout_container` 94 with 2. So a section paste routinely writes ~100 keys that are all defaults — that is the point, not waste.
- **The target decides what exists.** Only keys the target actually has a control for are written, so a payload from a build with extra controls cannot write orphans.
- A section header never gets `ROW_CLASS`: it has no value of its own to expand, and left-click stays Elementor's for collapse/expand.
- Whole section commits as **one** undo step, like everything else here.

`commitSettings` is the single place anything reaches the document — the flyout's Apply and paste both go through it, so neither the history-log grouping nor the unlink option below can drift between them.

### Honouring the unlink option

The panel's **Unlink Fields On New Elements** flag applies here too: anything this file writes to a `dimensions` or `gaps` control lands with `isLinked: false`. Apply, paste-field and paste-section are all covered, because all three go through `commitSettings` and that is where it is applied.

- **At commit, never at seed.** Forcing the flag into `working` when a row is seeded is the obvious-looking place and is wrong: `isUnset` compares the staged value against the control default, so a forced flag makes _every_ row differ from its default, `isOwnValue` reports the whole family as set, the fade disappears and the cascade preview stops. Measured: a default `padding_tablet` reads unset, the same value with `isLinked: false` reads set.
- **Only the flag moves.** Values are whatever the user typed, so a row edited with the link button still on keeps its four equal sides and simply arrives unlinked. Nothing is lost, which is what makes overriding a deliberate in-flyout link click acceptable rather than destructive.
- **Off is free.** With the option off, `withUnlinked` returns the caller's own object, so there is no copy and no behaviour change.
- **The flag is pushed over the `__bpf` channel**, because `browser.storage` is unreachable from the page world — the same reason that channel exists for the clipboard. `breakpoint-flyout.js` pushes on `script.onload` (the first moment the page-world listener exists) and again on change, and skips its own `__config` message in the clipboard listener, which would otherwise answer it with "unknown op".
- **Page-side it defaults to off**, deliberately not mirroring the panel's on. A lost push then degrades to this file's previous behaviour — a missing feature — where the other way round it would flip a flag the user had switched off.
- `LINKED_TYPES` is duplicated from `page-bridge.js`. Two page-world scripts share no scope, the same boundary that keeps the template-tag regex out of the bridge; change one, change both.

**Known gap:** the flyout _displays_ whatever the model holds, so an element created before the option was switched on (or a pasted one, which the create hook excludes) shows its rows linked until you Apply. Un-linking on open would mean writing to the document just by looking at it, which is the one thing the staging design exists to prevent.

### A write does not refresh the panel

**Every commit has to tell the affected control views to re-read.** A settings write updates the model and the preview, but the input already rendered in the panel keeps its old value: Elementor assumes the panel itself made any change, so the on-screen control never re-reads. The symptom is that a paste appears to do nothing until you select another element and come back.

The shape of it is counter-intuitive and worth keeping: writing `min_height` across three breakpoints left the **visible** desktop input empty while the **hidden** tablet and mobile rows updated themselves. It is specifically the row on screen that goes stale — the one being looked at.

`refreshPanelControls` walks the panel's children and calls `applySavedValue()` on any view whose control name was written. Deliberately **not** `options: { external: true }`, which is the other way to get this result: external re-renders the element, and re-rendering a live populated container is what made one disappear from the preview (see `rename` in `page-bridge.js`). This touches the panel only and never the render path.

**The transport is `browser.storage.local`, not the system clipboard.** Both ends of a copy are this extension, `storage` is a permission already held, and reading the real clipboard from a page-world script is blocked in Firefox regardless. Copy _also_ writes the JSON to the system clipboard, best-effort, purely so the payload can be inspected or saved — nothing reads it back. Hand-authored JSON is therefore not a paste source; that is the accepted cost of needing no new permissions.

### Page world, and why

This is the one tool that is **not** content-script driven. Every other tool reaches the page through `callBridge`; this one instantiates Backbone views and drives them per keystroke, so a postMessage round trip per interaction is the wrong seam.

`breakpoint-flyout.js` is mostly the loader — the same script-tag pattern `core_utils.js` uses for `page-bridge.js`. It holds exactly one piece of logic, and only because it cannot delegate it: `browser.storage` is unreachable from the page world, so the copy/paste transport has to live on the content-script side of a small `__bpf` postMessage channel. Nothing else belongs there; anything else put in that file would be in the wrong world to reach `elementor`.

Buttons are re-injected on panel churn by a `MutationObserver`, the pattern `multi-select.js` uses for its tints.

## Panel: site content list

The panel has one **Site Content** section listing the whole site — Elementor library templates _and_ every post type — through a single search box, with three filter buttons and **Edit** / **View** on each row.

It was two things once: a Site Templates list, and a plan for a separate Pages list. One list with filters is what it became, because the search box, the row layout, the tab plumbing and the Working-Domain URL building were going to be duplicated wholesale otherwise.

- **`Templates` · `Pages` · `Other` are tabs, not filters** — exclusive, one at a time. Stored as `contentTab`.
- **Each tab owns its own request, rows, error and warnings.** That separation is the whole speed story, below. `rows: null` means "never loaded" and is a different thing from an empty array: the first says "Not loaded", the second says "no pages on this site".
- **The rows are unified before anything reads them.** `asRow()` in `panel.js` is the one place a template or a post becomes the same shape; search, sort and both buttons see only that. A template's second line is `author · date`, a post's is `status · date` — same slot, different facts.
- **Search spans both shapes** via `matchesTerms`' `extra` field: a template contributes its author, a post contributes its post-type slug, status, doc type, and the literal word `elementor` so the badge is searchable like any other text. The placeholder names the current tab, because the search only ever covers that tab.
- A loaded tab keeps its **row count on the tab itself**, so the shape of the site stays readable without clicking through.

### What makes a refresh fast

Four things, in rough order of how much they buy:

- **Refresh re-fetches the active tab and nothing else.** One tab is one message: `list-templates`, or `list-posts` with `include: ["page"]` / `exclude: ["page"]`. The Pages tab no longer paginates every CPT on the site to render a list of pages.
- **A tab that has never been opened costs nothing.** Only the tab on screen loads at startup; the others load the first time they are selected, if they ever are.
- **Switching tabs does not re-fetch.** A loaded tab renders from what it already has — re-fetching on every switch would give back everything the split just won. Refresh is the only thing that goes back to the network.
- **Pagination runs four pages at a time** (`PAGE_CONCURRENCY`). Page 1 has to land before the page count is known, but pages 2..N have no dependency on each other; they were serial only because a `while` loop is the obvious way to write it.
- **`/wp/v2/types` is cached** for the page's lifetime. Post types are registered at boot and cannot change under a live tab, so it is one round trip on the first refresh and none after — including across a tab switch.

**Do not put `_fields` on `/wp/v2/types`.** It answers with an object _keyed by slug_, not an array of records, so `_fields` filters the top-level keys — `post`, `page`, … — none of which are named `slug` or `rest_base`. `?_fields=slug,rest_base,name,viewable` returns **`{}` with a 200**, which reads as "this site has no post types" and silently empties the Pages and Other tabs. This was shipped once and cost a debugging session; the trim it buys is worth nothing next to the cache above. `_fields` is fine on the collection endpoints, which _are_ arrays — that is where `meta._elementor_edit_mode` is doing real work.

### The Elementor badge

A post row carries an **Elementor** badge exactly when wp-admin's posts table would show its `— Elementor` label, and for the same reason. That label comes from the `display_post_states` filter, and the whole test behind it is one meta key:

```php
Document::is_built_with_elementor()  =>  (bool) get_meta( '_elementor_edit_mode' )
```

Elementor registers that key with `show_in_rest` — unconditionally, on `rest_api_init`, for every post type with `elementor` support — so `wp-pages.js` reads the same answer with `?context=edit&_fields=…,meta._elementor_edit_mode`.

- **The nested `meta.<key>` form is load-bearing.** `_elementor_data` is registered on the same object and its value is the _entire page document_ as a string. Asking for a bare `meta` would pull a megabyte per row. Name the keys.
- **`context=edit` is mandatory** — those meta keys are edit-context only, and so are drafts. That is also what makes the nonce matter.
- **Absent key and empty value are different answers.** A post type Elementor does not support has no such key registered at all; that stays `null` and the panel says nothing, rather than reporting "not Elementor" as a fact it did not establish.
- Do not reach for `elementor/v2/site-navigation/recent-posts` instead. It returns exactly this plus a prebuilt edit URL, but its experiment is `'default' => STATE_INACTIVE, 'hidden' => true` — off by default and not even toggleable in the experiments UI.

### Edit and View

- **Edit picks an editor from the flag.** Elementor for a template or a post built with it, WordPress otherwise — and **unknown falls to WordPress deliberately**: `post.php?action=elementor` works on a post Elementor never built, quietly converting it, so a wrong guess in that direction edits the document.
- **View is the permalink for a published post, the preview route for anything else.** `link` on an unpublished post is the permalink it _would_ have and does not render, so those get `{origin}/?p={id}&preview=true`, which works for a signed-in editor. A type with `viewable: false` disables the button.
- Both URLs come from the **Working Domain** field, not from the responding tab. Empty or unparseable ⇒ disabled with a tooltip saying why. Editing the field re-renders the rows immediately.
- **Templates get a View button too**, from the `url` the library endpoint already returns — `{origin}/?elementor_library=<slug>`. `elementor_library` is not a viewable _post type_, but that permalink renders. Take the field; do not derive it from the title, because a slug stops being a slugified title the moment WordPress deduplicates it (`hero`, `hero-2`). `normalizeTemplateList` carries `url` and `status` for this, in **both** copies — `template-format.js` and the page-world one in `page-bridge.js`.
- Tabs open in a **normal** browser window — the panel is a popup window and cannot hold tabs, so defaulting the `windowId` would misfire.

### Which tab answers

- **The panel has no page bridge**, so it asks a tab that can reach the endpoints: `browser.tabs.sendMessage` → a `runtime.onMessage` listener. Neither kind of tab open ⇒ "No Elementor editor or WordPress admin tab open — open one, then Refresh."
- **One ranking across both kinds of tab: origin, then active, then editor.** `askElementorTab` scores every candidate rather than trying editors as a block and admin tabs as a block. Grouping first was a real bug: a background editor on _any_ site outranked the wp-admin tab in front of the user, so `list-templates` went down the editor's page-bridge path while `list-posts` — which `wp-pages.js` answers in either tab — went to the admin one. Same panel, two sources, only one of them failing.
  - `origin` (the Working Domain) outranks everything: another client's tab must never answer for this site.
  - `active` outranks `editor`. That costs one declined message before `run-action` finds its tab, and buys the panel agreeing with what is on screen.
- **The status line names the responder** (`via editor` / `via wp-admin`). Two tabs can serve these reads by different routes, and a list fetched by the wrong route is otherwise indistinguishable from a broken endpoint — which is precisely what made the bug above hard to see.
- `tab.url` is only populated where host permission is held, so the query filters on it when present and **broadcasts to every tab otherwise** — tabs without the listener just reject, which is the intended miss.
- A failed Refresh keeps the list that was already there and puts the error in the status line; only a panel that never loaded shows an empty state.

### Serving the list from wp-admin

Three files split the job, and the split matters:

- **`Tools/wp-rest.js`** — the `wp_rest` nonce and an authenticated JSON GET. Guarded on `/wp-admin/` only, so it loads on editor _and_ plain admin pages.
- **`Tools/admin-templates.js`** — `list-templates`, excluding the editor (`action=elementor`), because `core_utils.js` already answers that there.
- **`Tools/wp-pages.js`** — `list-posts`, on **every** `/wp-admin/` page including the editor, since nothing else answers it.

**No page bridge is injected, and the fetches stay in the content script's own world.** Same-origin, so the login cookie rides along with no SameSite question to answer, and there is no page-world `<script>` tag for a site's CSP to reject. Doing this from the background page instead would be a _worse_ bet on both counts: an extension-origin request is cross-site, and WordPress leaves its login cookies at the browser default of `SameSite=Lax`, which is not sent on a cross-site subresource fetch.

**The nonce comes from `admin-ajax.php?action=rest-nonce`, not `wpApiSettings`.** The global is page-world and unreadable from a content script — but it is also merely _usually_ there, enqueued by whichever plugin pulled in `wp-api-request`. The admin-ajax handler is WP core, so it is on every admin page, and it returns the identical value. It answers `-1`/`0` with an HTTP **200** for a logged-out session, so the body is checked rather than the status; that is what turns a bare 401 into "Not signed in to WordPress on this site".

- **The in-flight nonce promise is cached, not the value** — a page listing asks once and then makes a request per post type, and without this they would race into one fetch each. A rejection is evicted; otherwise one blip would poison the tab for its lifetime. Same reasoning as `templateContentCache` in `page-bridge.js`.
- **A 401/403 buys exactly one silent retry** with a fresh nonce. Nonces expire in 12–24h and a long-lived admin tab will eventually present a stale one, which is indistinguishable from being logged out until you retry.
- **`run-action` is not handled by either admin file, deliberately.** `hotkeys.js` is editor-only; returning `undefined` leaves `askElementorTab` free to try the next tab rather than resolving a run nothing here can perform.
- **Only one file answers `ping` per page type.** `core_utils.js` on the editor, `admin-templates.js` on plain admin. `wp-pages.js` answers neither `ping` nor anything but `list-posts` — a third listener replying to one message means two replies racing, and `sendMessage` keeps whichever lands first.

`wp-pages.js` walks `/wp/v2/types` and then paginates each type's collection at `per_page=100`, reading `X-WP-TotalPages` for the bound. It takes `include` / `exclude` slug lists so the panel can ask for one tab's worth rather than the whole site.

- **Per-type failures and truncation are reported, never silent.** An editor routinely lacks `edit_others_posts` on a CPT or two; that type contributes a warning to the status line instead of failing the run. A list that quietly dropped a post type reads as "that type has nothing in it".
- `SKIP_TYPES` drops WordPress's own bookkeeping types and `elementor_library` — the Templates filter already lists that through Elementor's endpoint, which knows about template _type_ in a way `wp/v2` does not.
- `title.rendered` is HTML and gets decoded through **`DOMParser`, not `innerHTML`**. These are site-supplied strings on every admin page, and `web-ext lint` fails an `innerHTML` assignment outright (`UNSAFE_VAR_ASSIGNMENT`).

### Panel: Run buttons

Every row in the panel's Hotkeys list has a **Run** button beside it, so the tools are reachable without the keyboard. It rides the same `askElementorTab` bridge as the template list — `run-action` → the `runtime.onMessage` listener in `hotkeys.js` → the **same `runners` table the keydown handler uses**. Do not give the buttons their own dispatch: one entry point per action is what stops a button and its key from drifting.

- The reply reports that the run _started_, not that it finished. Tools draw their own modals and a template sync can take a minute; holding `sendMessage` open for that would time out the panel for no gain. Failures after dispatch land in the tool's own modal and the log.
- On success the panel **focuses the responding tab**. The panel is a separate popup window, so without this the tool's modal opens somewhere the user isn't looking and the click reads as dead.
- `askElementorTab` sorts active tabs first. A side-effectful run with two editors open should land in the one on screen; first-responder order was fine when the only message was a read. It does **not** pass `preferOrigin` — a run belongs in the tab the user is looking at, not in whichever tab matches a text field they may have set for something else.

### Dual-context files

`template-format.js`, `hotkey-defaults.js` and `animation-preset-fields.js` are loaded **both** as content scripts and by `panel.html`, each assigning one global. `animation-preset-fields.js` is there because the panel authors preset files and the editor applies them: one side writes the comments and validates an import, the other reads the defaults and types, and a second copy of the field table is exactly how the two would drift. That is the mechanism for anything the panel and the editor must agree on — template metadata rendering, the search predicate, `normalizeTemplateList`, and Edit-URL construction all live in `template-format.js` precisely because `panel.js`, `template-insert.js`, `admin-templates.js` and `overlay.js` would otherwise drift. Neither file may touch `location` or the DOM at load time.

**The page world is outside this mechanism.** `page-bridge.js` is injected as a page-world script and cannot read a content-script global, so its `list-templates` op carries its own copy of the field mapping that `normalizeTemplateList` holds — the same boundary that keeps the template-tag regex out of it. Those two are the one sanctioned duplication here; change one, change both. Do not "fix" it by having the bridge reach for the global.

## Tree alignment

`ns.pairTrees` diffs the two trees rather than requiring identical shapes, so an inserted or deleted layer no longer fails a whole container.

At each level the children are aligned by LCS in two passes: first on `type + name` (high confidence), then the remaining gaps on type alone, so a _renamed_ layer still aligns while an _inserted_ one becomes a gap. Aligned children recurse; unaligned ones are reported as `missing` (in the template, not on the page) or `extra` (on the page, not in the template) and are simply not styled.

Two hard failures remain:

- **Root type mismatch** — nothing below it is interpretable.
- **`MIN_MATCH_RATIO`** (0.5) — below half the nodes aligning, the two trees are not the same block, and styling the overlap would do more harm than refusing.

The ratio is `pairs / max(srcNodes, tgtNodes)` after subtracting **whole skipped subtrees from each side independently**. Counting a skipped branch's descendants would let the skip word push a container under the threshold — the opposite of what marking a branch means. There is a regression test for this in the session history; if you touch the ratio maths, re-check that a large skipped subtree leaves the ratio at 1.00.

Known characteristic: a _reordered_ child reads as one `missing` plus one `extra` and is not styled. That is inherent to LCS and is the honest answer — a moved node cannot be distinguished from a delete plus an insert.

## Skip word

Any layer whose name contains the skip word is never restyled. Default `skip`, case-insensitive substring match, configurable in the panel; clearing the field to empty disables the feature. Stored as `skipWord` — `undefined` means "never set, use the default", `""` means "explicitly off", so the two are not interchangeable.

`ns.getSkipMatcher()` returns the predicate. It is honoured by **both** style-replacing tools: `template-sync.js` and `replace-styles.js` (simple and deep modes).

A skipped node yields no style pair **and exempts its whole subtree from structural comparison** — marking a branch `skip` means that branch is allowed to have diverged from the template, which is the point. Without that exemption a diverged branch would fail the whole container and the feature would be useless.

## Multi-select subsystem

`Tools/multi-select.js` is a shared subsystem — future tools should read from it, not reinvent selection. Shift+click on a `.elementor-navigator__element[data-id]` row toggles that layer into a plugin-only set, tinted blue via the `ElementorTools-selected` class. Shift+click within the navigator but not on a row clears the whole set. A `MutationObserver` re-applies the tint by `data-id` whenever Elementor re-renders the navigator (collapse/expand/etc), so selection survives DOM churn.

Each tinted row also shows its **selection order** as a small numbered badge in the row's bottom-left. `animation-presets.js` keys its delay stagger on that order, so the order has to be visible before the run rather than inferred from the result.

- **It is a `::after` reading a `data-et-order` attribute, never an injected node.** The retint is driven by a `childList` MutationObserver, so a real element would be observed and re-inserted on every pass — a runaway. Attribute writes are not observed, which is also why the existing class toggling has never looped.
- The navigator row is already `position: relative` with `overflow: hidden` and its `::after` is unused, so this claims space Elementor is not using and needs no layout changes of its own. (The row is `display: flex`, so absolute positioning is required regardless — a static pseudo-element would become a flex item.)
- Badges sit at the row's left edge rather than the indented content's, so they line up in a readable column whatever the nesting depth.

API (on `window.__ElementorTools.multiSelect`):

- `getIds()` → `string[]` of currently selected `data-id`s, **in shift-click order** — it is a `Set`, so insertion order is click order. Re-selecting a deselected row moves it to the end.
- `has(id)` → boolean
- `clear()` — empty the set + strip tints
- `onChange(cb)` — cb receives a `Set<string>` snapshot; returns an unsubscribe fn
