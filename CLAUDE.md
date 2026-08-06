# Elementor Tool

Typical flow each release: npm run bump → npm run sign → install the .xpi from about:addons.
Automation runs go in their own browser: `npm run auto` — see "Firefox throttles what it cannot see".
Browser extension (MV3, Firefox) that adds hotkey-driven tools to Elementor's WordPress editor.

## Structure: UI -> Tools

```
├── manifest.json        # MV3 manifest
├── background.js        # toolbar-icon click → UI/panel.html · opens the Automation window · the single writer for the activity log
├── hotkeys.js           # global keybindings (dispatches to tools)
├── hotkey-defaults.js   # dual-context: ACTIONS table + binding formatting
├── template-format.js   # dual-context: template/post metadata, search, list normalization, Edit & View URL building
├── animation-preset-fields.js # dual-context: the Motion Effects field table, preset file build/parse/validate
├── edge-preset-format.js # dual-context: the Edge Preset schema, child-index paths, tag matching, file parse/validate
├── tab-bridge.js        # dual-context: askElementorTab / focusTab / openTab — the tab-ranking both windows share
├── UI/                  # window opened from the toolbar icon
│   ├── panel.html
│   └── panel.js         # reads browser.storage.local, re-renders on change; site-content list
├── Automation/          # the batch runner, in its own window
│   ├── automation.html
│   ├── automation.css
│   ├── automation.js    # the GUI *and* the run loop — pickers, state machine, worker pool
│   └── automation-agent.js # content script: runs one page (the window's phase order, then save)
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
    ├── template-sync.js      # tag-matches page containers to site templates; styles them, or replaces them outright
    ├── template-insert.js    # multi-select picker over the template library, inserts the ticked templates
    ├── template-decouple.js  # swaps Elementor Template widgets for a copy of the template's own content
    ├── animation-presets.js  # applies a saved Motion Effects preset to the selection, with delay accumulation
    ├── edge-presets.js       # Edge Presets: preset storage, capture receiver, and the apply pipeline
    ├── wp-rest.js            # shared wp-admin REST access: wp_rest nonce + authenticated JSON GET
    ├── admin-templates.js    # serves the panel's template list from wp-admin (no editor, no page bridge)
    ├── wp-pages.js           # serves the panel's post list — every post type, with the Elementor flag
    ├── template-index.js     # the site-wide walk for template usage — types → docs → _elementor_data → #id tags
    └── overlay.js            # draggable in-page HUD (root layer, logs, Edit-in-Elementor link)
```

- Load order: `template-format.js` first (`core_utils.js` reads `normalizeName` off it), then `core_utils.js`, then `multi-select.js`, then other tools, then `hotkeys.js`. `wp-rest.js` must precede `admin-templates.js`, `wp-pages.js` and `template-index.js` — all three read `window.__WpRest` and bail without it. `template-index.js` also reads `window.__ElementorTemplateFormat` for the tag rule. `animation-preset-fields.js` must precede `Tools/animation-presets.js`, which reads `window.__AnimationPresetFields` and bails without it. `edge-preset-format.js` must precede **both** `Tools/breakpoint-flyout.js` (which reads `STORAGE_KEY` off it to push the armed preset) and `Tools/edge-presets.js` (which bails without it) — it sits with the other dual-context files, before `core_utils.js`. `Automation/automation-agent.js` goes last but one, after every tool it drives.
- `Tools/breakpoint-flyout.js` loads **before** `Tools/edge-presets.js` and calls `ns.captureEdgeField` off the namespace at message time, not at load time — so that order is not a constraint, and must not become one.
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

Tick state is tracked as the set of _unticked_ items, so an item surviving a rebuild keeps its state and newly-qualifying ones arrive ticked. Everything starts ticked in both shapes.

**`keyOf` is what makes "survives a rebuild" true, and its absence was a silent bug.** The set is keyed on object identity by default, so a `buildItems` that constructs fresh objects each call — which any builder computing labels or grouping rows *must* — re-ticked everything the user had unticked, on **every** toggle flip, including toggles that do not change the row set at all. `template-sync.js` passes `keyOf: (r) => r.target.id`. Identity remains the default only so the legacy array form, which never rebuilds, is unaffected.

### Cancelling a run

**Every template tool can be stopped with ESC or a Cancel button, at any point.** These runs open with a multi-second library fetch and then keep going for a minute, and the hotkeys sit next to each other — an accidental `Ctrl+Shift+7` must not be something the user has to wait out.

`modal.allowCancel()` arms it; `modal.cancelled()` is the latched flag the run polls. Both a button and ESC, deliberately: ESC alone is invisible, and a modal with no button reads as "you are stuck with this".

- **A cancel is a request honoured at the next boundary, not a kill.** Nothing on the content-script side can abort an Elementor command already in flight, and pretending otherwise is how you get a half-applied paste. So the loops ask between templates, between roots, between targets, and between style chunks — `STYLE_CHUNK` was already the unit of "still alive", which makes it the natural unit of "still wanted".
- **A read may be abandoned; a mutation may not.** `ns.untilCancelled(promise, modal)` races a read against the cancel and resolves to the `ns.CANCELLED` sentinel, which is what makes ESC feel instant during a fetch instead of taking effect whenever the fetch lands. It is **never** used on a mutation: abandoning the wait on an `insert-template` is exactly what leaves an orphan copy nobody is expecting — the same reasoning as "A timeout is not an answer" below. An insert already in flight is always awaited in full, and the cancel is taken at the boundary after it.
- **The cleanup still runs.** Every `finally` is on the normal path — the staging copy is deleted, the history log is closed — so a cancelled run is still exactly one undo step. Both tools say so in the log (`Ctrl+Z undoes everything this run did`), because otherwise the user is left guessing which half landed.
- **`choose()` does not hand the buttons back.** The chooser owns the button row and ESC for its own Cancel, so a run must call `allowCancel()` again after the confirm resolves. ESC _during_ the confirm still cancels the whole thing, as it always did.
- **"Cancelled" and "cancelled after changing things" are different facts.** A cancel before the first mutation finishes with `Cancelled — nothing was changed.`; after it, the normal summary is kept and prefixed. Rows the run never reached say `cancelled — not inserted` / `left linked` rather than sitting on "waiting" forever.
- **`template-insert.js` repeats the control** (`addCancel`) rather than importing it, since it drives its own shells. Its listener is detached on `close`/`fail`/`finish` — two capturing ESC handlers alive at once would have one keypress reach both the notice and the picker.
- A run that never touched the document skips its own verification read (`list-containers` in sync, the nested re-scan in decouple), which would otherwise be a round trip spent confirming that nothing happened.

## Page bridge

`callBridge(op, payload, { timeout, waitLimit, onWait })` — default timeout is 3s. Ops that hit the network (`insert-template`, `list-templates`, `prefetch-templates`) pass 15s or more.

Ops: `ping` · `copy` · `paste-style` · `apply-style-pairs` · `apply-advanced-settings` · `apply-preset-settings` · `read-preset-settings` · `apply-edge-preset` · `apply-edge-structural` · `paste` · `delete` · `rename` · `create-element` · `insert-template` · `prefetch-templates` · `list-templates` · `describe-tree` · `describe-selection` · `describe-document` · `list-containers` · `list-template-widgets` · `save-document` · `configure-pure-reset` · `history-start` / `history-end`.

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

#### Holding a group of style keys back

`preserve` names groups from `PRESERVE_GROUPS` that the **target** keeps as its own. `template-sync.js` is the only caller (`replace-styles.js` passes none and is unchanged).

**It has to be save-and-put-back, not a filtered paste.** `paste-style` is all-or-nothing: it walks the _target's_ controls and writes every style-transfer one, taking the source's value or **the control's default** where the source has none. So a background image the template lacks is not merely left alone by a paste — it is cleared. Verified on this build: a container holding `PAGE-PHOTO.jpg` at `cover / top center` came out of a plain paste holding the template's `TEMPLATE.jpg` at `contain / center center`, overlay included.

- **Snapshot before the paste, diff after it, write back only what moved.** Most nodes carry no background at all, and where neither side has one the diff is empty and the restore costs **no Elementor command** — measured `kept: 0` on a neutral pair. Where a source _does_ carry an image, a bare target correctly ends up with no image rather than inheriting one.
- **The diff is `canonJSON`, not `JSON.stringify`.** Elementor serialises a media or slider object's keys in whatever order last wrote it, so a plain compare calls two identical values different and writes 253 keys back per node. Same reasoning as `canon()` in `animation-preset-fields.js`; the page world can't read that global, so this is its own copy.
- **`toJSON()` is a shallow clone**, so a snapshotted value object is still the model's own — `copyValue` deep-copies it, or the "before" and "after" would be the same object.
- **Groups are name tests, resolved against the live control list**, never a key table: the responsive suffixes depend on the site's enabled breakpoints and the `hover_` variants double the set. Breakpoint suffixes come off longest-first so `mobile_extra` is not read as `mobile`. A widget's leading underscore is stripped before the test — `resolveControlKey`'s rule in the other direction — which is what makes one group name work on both. Cached per `elType|widgetType`, since a sync asks this once per target per pair.
- **Default render, and `options.external` stays off**, for the same reasons as `apply-advanced-settings`. Verified the preserved image reaches the preview: the live element computes `background-image: url(PAGE-PHOTO.jpg)` after the restore.

The groups, measured on a container (Elementor 4.2.1 / Pro 4.0.4, five breakpoints):

| group | keys | what it is |
| --- | --- | --- |
| `background-image` | 72 (36 × normal/hover) | `background_image` and the seven controls that frame it — `position`, `xpos`, `ypos`, `attachment`, `repeat`, `size`, `bg_width` |
| `background-overlay` | 181 | the whole `section_background_overlay`, minus its 7 layout controls |
| `background` | 386 · widget 171 | every `background*` control there is — colour, gradient, video, slideshow, the type chooser, the Background section's own `background_motion_fx_*` — plus `overlay_*`. A strict superset of the two above |
| `motion-effects` | 72 · widget 72 | the Advanced tab's Motion Effects section — `motion_fx*` · `sticky`, `sticky_*` · `animation`, `animation_*` |

- **The image and its framing travel together.** Keeping a page's portrait shot but taking the template's `cover / center center` reframes it anyway, so the framing is part of "keep the image".
- **Colour, gradient, video and slideshow are out of `background-image`**, and so is `background_background` (the type chooser). That group says only "the photo is the page's own", and the template still owns what _kind_ of background this is. The consequence: a template whose background type is not `classic` leaves a preserved image in the model and invisible on screen. That is the honest reading of a template saying "no image background here" — the alternative freezes the type and the template could never change it. `background` is the group for "leave the background alone entirely", and it has none of that subtlety by design.
- **A widget resolves 72 keys and no overlay** — widgets have no overlay section — so the group needs no scoping to containers. Verified: a heading kept `_background_image` and took the source's `_background_color`.
- **`background` catches `overlay_*` too**, because the overlay's blend mode is the one control in that section not named after the background. The overlay's **CSS filters are deliberately left out**: `css_filters_*` is an overlay control on a container but the *image's own* filters on an image widget, and a predicate that sees only a control name cannot tell those apart. A container's overlay filters therefore still sync.
- **`motion-effects` is deliberately the same set `animation-preset-fields.js` manages** — scrolling effects, mouse effects, sticky, and the entrance animation with its duration and delay. Name families rather than a key list for the usual reason: the entrance animation and every sticky offset carry a variant per enabled breakpoint. Verified live that all 61 preset keys exist on a container and every one falls in this group; keep them from drifting.
- **`motion_fx` is anchored (`/^motion_fx/`), and this is the trap.** A container also carries a **`background_motion_fx_*` family** — the Background section's own scroll effects, 36 keys of it. An unanchored `includes("motion_fx")` swept those into `motion-effects`, so "Keep animations" quietly preserved a slice of the page's background with no background option ticked. Anchoring leaves them to `background`, where they belong. Measured after the fix: the two groups share **0** keys. `handle_motion_fx_asset_loading` is named explicitly (a target keeping its motion effects should keep its own answer about loading their assets); its `background_`-prefixed twin is excluded by the same anchor.
- **Groups may overlap freely.** `preserveKeysFor` walks each control once however many groups claim it, so `background` alongside `background-image` costs nothing and needs no folding at the call site. Verified: `background-image` (72) and `background-overlay` (181) are both proper subsets of `background` (386), and ticking all four resolves 458 keys on a container.

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

`describe-document` reports the document this editor has open — `id`, `title`, `status`, `docType`, `isDirty`, and `isTemplate`. Three jobs read it: the Automation window's "you are in" line, the gate on Edge Preset capture, and the readiness probe.

- **`isTemplate` must be certain, because capture binds a preset to whatever it says.** Three independent signals, tried in order — `cfg.post_type === "elementor_library"`, then `post_type=elementor_library` in `urls.exit_to_dashboard`, then `?elementor_library=` in `urls.permalink` — and `isTemplateVia` reports which one spoke, so a wrong answer is diagnosable rather than mysterious. Failing all three means "not a template", which makes capture **refuse**: the safe direction, since the alternative binds a preset to a page id naming no template.
- **`isDirty` is the one field with no fallback.** A false "clean" would let a capture snapshot a value the template does not have, and under a snapshot format nothing downstream could ever notice. `null` means unknown and every caller treats that as dirty.

`save-document` is the only thing in this codebase that saves. Nothing else does, which is why a sync whose tab is closed changes nothing — and why the Automation tool's cancel can be "close the tab".

- **`document/save/default` decides publish-vs-draft from the post's own status**, which is exactly what is wanted: a published page is republished, and a **draft stays a draft** rather than being pushed live by a batch pointed at a hundred documents.
- **An unchanged document is skipped, and that is the point, not an optimisation.** Saving anyway moves `post_modified` and writes a revision for a page the run decided not to touch. `force: true` overrides it; nothing passes that today.
- **`stillChanged` is read back after the save.** A save that reports the document still changed did not take, and the tab is closed immediately afterwards — this is the last moment anything can notice.

`history-start`/`history-end` wrap a burst of `$e.run` calls in one undo step via `document/history/start-log`. Both degrade to no-ops (`logId: null`) rather than failing the caller.

## Template tag

Every layer these tools create carries the template's id as a suffix on its layer name — `TW Hero #4821` — and, when the template has more than one root, **which root it is**: `TW Hero #4821.2`. Written by `template-insert`, `template-sync`'s **replace** op and `template-decouple`; it is the **only** thing `template-sync` and Edge Presets match on. Helpers live in `template-format.js`: `templateTagKey` · `withTemplateTag` · `parseTemplateTag` · `stripTemplateTag`.

- **Why the layer name.** It is the only per-layer field readable on every Elementor version, and it stays visible in the navigator — the link is never invisible state the user can't see or fix.
- **The tag, and nothing but the tag.** It is exact; a name is hand-typed and drifts. A renamed layer still resolves to the template it came from — and a layer whose tag was deleted resolves to nothing, deliberately, because guessing from a name in a tool that writes to live pages produces confident wrong results.
- **A style sync no longer writes it.** Matching is tag-only, so a container a sync touches already carries one; the rename only ever overwrote the user's layer name with the library title. A **replace** still writes it and must — see "What a run writes".
- **The root index is what makes multi-root templates work.** It is 1-based, matching how the tools label roots, and it is a _position_ — re-saving a template with its roots reordered re-points the tags. That is inherent to identifying a root by where it sits; there is nothing else stable to key on.
- **One place builds tag strings** (`templateTagKey`) and the same key is what the page-node index is keyed on, so a writer and a reader cannot disagree about the shape.
- **`stripTemplateTag` has no caller in `template-sync` any more.** It existed so tagging a layer would not break the name match that found it; with the name pass gone, its remaining users are `withTemplateTag` and the panel. Keep it exported — the tag helpers are one dual-context set.
- **`withTemplateTag` rewrites its own tag and appends anything else.** Same key ⇒ unchanged, so naming twice is idempotent. A tag for the _same template_ is replaced in place (`#4821.1` → `#4821.3` when a root moves). Any other trailing `#n` is treated as part of a hand-typed name and kept: `Card #2` + 4821 → `Card #2 #4821`.
- **A bare `#id` on a multi-root template is reported, not guessed.** It predates the template having several roots, so nothing says which root it holds — and guessing would style, or destroy, the wrong block. The modal lists the offending layers and says to add `.1`…`.N` or re-insert. A _single_-root template accepts `#id` and `#id.1` interchangeably, so a template that has since lost roots still finds its blocks.
- Only roots are tagged, so tree pairing is unaffected at the root. A tagged layer nested _inside_ a synced block (tagged by an earlier run) misses `pairTrees`' `type + name` pass and aligns on the type-only pass instead — degraded, not broken, which is what that second pass exists for. Now that a style sync writes no names, this can only arise from an insert or a decouple.

## Template sync

`Tools/template-sync.js` — one click, no layer selection required. Lists site templates, reads the document's containers, and for each container carrying a template's `#id` tag: inserts the template, pairs the two trees, copies styles node-by-node, then deletes the inserted copy in a `finally`.

### Matching is by id tag, and by nothing else

A page node's layer name is read for exactly one thing: the `#<templateId>[.<root>]` tag on the end of it. There is **no name-matching pass**, at either level.

There used to be one — a template whose _title_ matched a container's name entered the queue, and a root whose _own name_ matched a container claimed it — to catch containers built by hand and never tagged. It is gone. A tag is exact; a name is hand-typed and drifts; and guessing in something that writes to a live page produces confident wrong results. Do not reintroduce it.

- **An untagged container is invisible to this tool.** That is the point, not a gap. The on-ramp is `template-insert` (tags what it creates), `template-decouple` (tags what it decouples), a replace (below), or typing `#<id>` on the end of a layer name by hand.
- **This is the rule the rest of the toolset already followed.** `template-decouple` matches on `settings.template_id`; Edge Presets match on the tag alone; `template-insert` matches nothing. Sync was the last name-matcher.
- **Titles no longer collide**, so there is no ambiguity to report — `byId` is keyed on the template's own id and cannot have two entries. The `byName` index, the `ambiguous` set and `GENERIC_ROOT_NAMES` all went with the name pass.
- **A root's own layer name now only labels the modal.** It decides nothing, so an unnamed root is perfectly usable and is no longer warned about.
- **Layer names come from the model** (`settings._title`), not the navigator DOM — the navigator does not need to be open.

### What a run writes

- **The styles operation writes styles and nothing else.** No rename, no structural change to the page's own tree: unaligned nodes are reported and left alone. The one transient exception is the staging copy, inserted at the end of the page and deleted in the same `finally`, inside the same undo step.
- **A replace renames; a style sync does not.** `op.rename` in `OPS` is the switch. A replace pastes the template root's own `_title` over the target, tag included, so without the rename the block would drop out of the very index it was found by and could never be matched again. A style sync has nothing to establish — tag-only matching means the container it touched was already tagged.
- The rename is still `<template title> #<tag>`, always the library title, never the root's or the container's own name. Roots of a kit therefore share a name, and the root index in the tag is what distinguishes them.
- **Tree pairing** (`ns.pairTrees`) aligns rather than marching in lockstep — see below.
- **Multi-root templates are normal, and each root is its own template.** Elementor saves whatever was selected, so a template's JSON often holds several top-level elements. Every root is handled independently, by its `#id.N` tag — so one saved template can act as a kit of blocks, named or not. Do not reintroduce a single-root requirement, and do not warn about kits: `tally.multiRoot` is reported as information, and does not colour the run's outcome.
- **Two-level matching.** A template enters the queue when a page node carries its id; the _root indexes_ in those tags then decide which container each of its roots acts on. A root can therefore target a container other than the one that pulled its template in. A template nothing points at is never fetched — that keeps the run to one insert per matched template instead of fetching the whole library.
- **One container is claimed by at most one root.** A container carries one tag, and a tag names one template and one root index. The `self` branch of the replace guard is therefore unreachable and kept only as a guard; `row.acts` is a list for the allowlist's sake, not because it can hold two.
- The whole run is one undo step, and `copy` clobbers Elementor's clipboard (same as the other tools).

### Nested matching

**Match nested containers** is a toggle in the confirm modal, off by default. Off, only top-level containers (`depth === 0`) can be targets. On, the whole page is searched, so a template's tag is honoured wherever it is nested.

- Nested candidates must match the template root's **tag and element type**. Top-level matching stays tag-only on purpose: the candidate set there is tiny, and a type clash is more useful surfaced as a pairing failure than silently dropped.
- **The modal opens on nested when the top level has no rows.** Landing on "Nothing matches" with the fix one checkbox away reads as a dead end; the toggle is off by default because scanning the whole page is the broader act, not because an empty top-level plan is a meaningful answer.
- The toggle changes which _templates_ qualify, not just which targets — a template tagged only on a nested node is invisible when the toggle is off. That is why `choose` rebuilds its list from `buildQueue(toggleState)`.
- Nested targets are processed **outermost first** (sorted by `depth`).
- **Replace + nested needs the ancestor guard.** Replacing a container deletes its descendants, so any later target inside it has a stale id and the bridge would throw. `tally.replaced` plus `firstAncestorIn` (which walks the target's own ancestors and asks the set, rather than testing descendancy once per already-replaced container) skips those with a warning. Styles mode needs no guard — nothing is deleted, so ids stay valid.
- Known gap: if an _inner_ target is replaced before an outer one from a different template, the inner work is silently discarded. Depth sorting prevents this within a single root's target list, not across templates.

### The confirm list is one row per page container

The checklist lists **targets, not templates** — one row per container the run will touch, in **document order**, labelled `"<template>" → "<container>"`. A multi-root template contributes a row per root (`"TW Hero" root 2 → "Intro block"`), and three containers matching one template are three rows. Ticking is a statement about a container: untick it and no root, from any template, touches it.

It used to be one row per template, which collapsed both of those. Measured over 30 of this site's 120 templates: 7 are multi-root, the largest has **14 roots**, and 6 of the 7 have entirely unnamed roots — so a single "TW Whatever" row was hiding an unreviewable amount.

- **Repeats are numbered `(2 of 3)` in document order.** Three sibling containers named "Card" from one template read identically otherwise, and an ambiguous checklist is worse than none because unticking the wrong row is silent. Same rule, same reason, as `template-decouple.js`.
- **`resolveTargets` is shared by the checklist and the run**, and that is the whole point: the list promises a set of containers and the run has to act on exactly that set. It reads only `title` and the element type off a root, which is all a JSON root and a live `describe-tree` node have in common — that is what lets the list be built before anything is inserted.
- **`tally.allowed` gates the run's target loop.** It is also the net for a plan/run disagreement: a container the list never offered is not in the set, so the run can only ever do *less* than it promised, never more. The reverse — the right container reached by the *wrong root* — is what the root-count check below catches.
- **A template whose every target is unticked is never inserted**, so unticking still saves the whole round trip it used to.

#### Roots have to be known before the confirm

Which containers a template reaches is decided by its roots' names and tags, so the content must be fetched **before** the checklist rather than after it. `prefetch-templates` grew a `withRoots` flag for this: it already fetches the JSON, and `templateRoots` is already the arbiter `insert-template` uses, so reading the roots there is one network pass instead of two. `describeJsonRoot` shapes a root the way `describe-tree` shapes a live node.

- **The price is fetching matched templates the user then unticks.** Still only matched templates — never the library — so the property that a template nothing points at is never fetched still holds.
- **A failed fetch is no longer merely "slower".** That template contributes no rows, so unlike a plain warm it is reported: `could not read template #N — …. It is not listed below.` Left silent it would read as "nothing matched".
- **Roots are fetched for the `nested: true` superset**, so flipping the toggle rebuilds the list with no network at all.
- **The list is built from JSON roots; the run works from imported ones.** They agree in every observed case, and if they ever did not the root indexes would have shifted — `#id.2` would name a different block than the row promised. `tally.plannedRoots` compares the two counts per insert and warns, because `allowed` cannot see that kind of wrongness.
- **Roots that reach nothing are reported only for templates the run never inserts.** A template that *is* inserted reports every one of its roots itself, from the live insert; saying it twice is worse than once. `tally.skippedRoots` is seeded with the first group and incremented by the second, and the two sets cannot overlap by construction.

### Keeping what the page already has

Three toggles on the styles operation say which of the page node's own values survive a sync. Each one names `PRESERVE_GROUPS` entries, and the mechanics are `preserve` on `apply-style-pairs`, above.

| toggle | default | groups |
| --- | --- | --- |
| Keep background image & overlay | **on** | `background-image`, `background-overlay` |
| Keep all background styles | **on** | `background` |
| Keep animations | **on** | `motion-effects` |

- **The toggle carries its own groups and its own log line.** `OPS.styles.toggles` rows hold `groups` and `note`, and the run collects `preserve` by iterating them. **Add a fourth option by adding a row there**, not by growing a list at the call site — that inline `choice.toggles.keepBackground ? … : []` is what this replaced.
- **They are the styles operation's toggles, not the pipeline's.** `OPS.styles.toggles` is appended to the shared `nested` one, because a replace pastes no styles: the page node's values go with the rest of its content and there is nothing to hold back.
- **The two background toggles overlap, and that is fine.** `background` is a strict superset, so ticking both is not a conflict — see the group table above. With the defaults below they _are_ both on, which makes the narrow one redundant until the broad one is unticked; that is what it is there for. "Keep the photo but take the template's colours" is a real intent, and it is why the broad one could not simply replace it.
- **All three are on by default.** A template is a layout: what a sync is wanted for is structure, spacing and typography, and a page's own imagery and motion are the parts that most often should _not_ be overwritten by whatever the template's author left on those layers. So the defaults leave both alone and the unticking is the deliberate act — the same reasoning the narrow background toggle already shipped with, applied to the other two.
- **Keep animations covers the whole Motion Effects section**, matching what a saved animation preset writes. Measured live (Elementor Pro, five breakpoints): a plain `paste-style` moved the source's `animation`, `animation_delay`, `motion_fx_motion_fx_scrolling` and `motion_fx_translateY_effect` onto the target, and with this group in `preserve` the target kept all four while still taking the template's `background_color`. `isStyleTransferControl` returns **true** for every key in the group, so none of this is theoretical — a sync overwrote animations before this option existed.
- **Reported per row and in the summary** (`3 node(s) kept own values`) because a preserved value is a value the template asked for and did not get. Silence there would read as a clean sync. The count is nodes-that-kept-something, not keys.

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

Both the library-fetch notice and the progress view take ESC / Cancel (`addCancel`, this file's own copy of the shared modal's control — see "Cancelling a run"), so a batch stops between templates rather than running to the end.

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

The run drives a modal (`ElementorTools-template-sync-modal`) that opens immediately, reports each phase, keeps a per-target live status row, and stays open at the end with a summary plus **Copy details**. The confirm step is always shown — there is deliberately no skip-confirm setting. ESC or Cancel stops the run at its next boundary, at every phase including the opening fetch — see "Cancelling a run".

Confirm is a **checklist** (`modal.choose`), not a yes/no — one row per page container, see above. Every matched container starts ticked, so the default is the full match set and unticking is the deliberate act; `All` / `None` buttons handle long lists, and the primary button is disabled at zero. It resolves to the chosen items in their original order, or `null` on cancel. On resolve it removes only its own rows, so notes logged before the confirm (ambiguous-title warnings) survive into the progress view.

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

## Edge presets

`Tools/edge-presets.js` force-pushes named fields from a template onto every
instance of it. **There is no hotkey** — which fields to push cannot be expressed
as a keystroke, the same reason animation presets have none.

**Why it exists:** `paste-style` only transfers *style* controls, so a sync cannot
touch a button's label, a link URL, an icon, or any other non-style setting. An
Edge Preset is the named list of fields to push anyway — the edges a sync cannot
reach, hence the name. Applying is defined as writing **only** the named fields;
nothing else on the element is touched.

**Applying makes no network request at all.** The values are a snapshot, the
instances are found by their `#id.N` tag, and the paths are walked page-side. An
Edge-Presets-only run over a hundred pages is bounded by editor load time and
nothing else — where a sync pays a library fetch plus an insert per matched
template per page.

**Two ways to apply, one entry point.** A **Run on page** button per preset row in
the Automation window applies it to whatever page an editor tab has open, and an
automation run applies every preset whose template is in the allowlist. Both go
through `run-action` → the `runners` table in `hotkeys.js` → `ns.applyEdgePresets`,
for the reason that table exists: a button and its automated twin must not drift.
`applyEdgePreset` sits there without a binding, exactly like `applyAnimationPreset`
— which preset to apply cannot be expressed as a keystroke. The manual button's
reply reports only that the run *started*; the per-instance results, skips
included, go to the log.

### Authored in the template's own editor

Capture is a third item on the breakpoint flyout's right-click menu, next to Copy
and Paste, and it is offered **only** while a preset is selected in the Automation
window. **Structural** captures live on a second surface — right-click a layer in
the navigator — because a layer's position and its name are not field rows; see
Structural edits below.

- **The template editor is what makes the binding exact.** The document id *is* the
  template id, so nothing is inferred — no tag to consult, no ancestor walk to get
  wrong. Capture in a page editor is refused.
- **One preset is bound to one template; many presets may share a template.** The
  binding is set by the first capture and enforced by `mergeCapture`, which is the
  one place that knows a preset is single-template.
- **The address is the root index plus a child-index path.** `edgeAddress` walks
  *upward* from the clicked element and stops at the document container, whose
  direct children are the template's roots. Root index is 1-based, matching the tag
  and how every tool here labels roots; it is the first component of the address,
  so captures from different roots of a kit coexist in one preset.
- **Parents are compared by id, never by identity.** `children` hands back fresh
  wrappers — the same reason `indexInParent` in `page-bridge.js` falls back to an
  id match.
- **Capture is refused while the template is dirty.** A snapshot taken from an
  unsaved template silently disagrees with the template it names, and under a
  snapshot format nothing downstream could ever notice. Asked page-side at click
  time (`elementor.saver.isEditorChanged()`) rather than pushed in as config,
  because it changes on every keystroke.
- **Every other refusal is reported on click, not by hiding the item.** Wrong
  editor, wrong template, unsaved — the menu item appears whenever a preset is
  armed and explains itself, rather than leaving the user hunting for where Capture
  went.
- **Capturing the same field twice replaces it in place.** Node identity is
  `root:path`, field identity is `field:<control>` or `section:<name>`, so
  authoring is idempotent — the same instinct `withTemplateTag` follows.

### Values key by control key, not by device

`edge-preset-format.js` holds the schema, and this is the one place it
deliberately departs from the flyout's clipboard payload.

The clipboard **has** to key a field by device, because its whole point is pasting
between two *different* fields whose key names differ (`padding` into `margin`). An
Edge Preset never does that: it writes the same field of the same widget type it
was captured from, and the type check at apply time is what guarantees it. The key
names on both ends are therefore identical by construction, the device mapping has
nothing to do, and dropping it makes apply one uniform loop over `[key, value]` for
fields and whole sections alike — with **no second copy of
`resolveBase`/`buildFamily` in the bridge** to drift from the flyout's.

A section capture is stored whole, defaults included, for the same reason a section
copy is: paste is defined as making the target one-to-one with the source.

### The type check is the whole safety model

A child index is a position, and deleting a layer above the target shifts every
index after it. So `apply-edge-preset` compares the captured signature
(`widget:button`, `container`) against what the path actually landed on, and a
mismatch **skips** — it never writes and never tries to repair the path.

- **Repair was considered and rejected.** Aligning the instance against the template
  with `ns.pairTrees` would survive inserted and deleted siblings, but it needs the
  template's own JSON — which would cost the "no network at all" property that makes
  an Edge-Presets-only run fast. A wrong write to a real page is far worse than a
  reported skip.
- **Only the leaf is checked.** An intermediate step that diverged almost always
  produces a wrong leaf type anyway, so storing the whole chain would buy detection
  the skip already gives.
- A path that runs off the end of the tree, and a key the target has no control for,
  are reported the same way. **Every skip is reported**: a field that could not be
  written is a value the user put in the preset and did not get, which is exactly
  where silence reads as success.

### Matching an instance is tag-only

An untagged block is invisible to Edge Presets even if its name matches a template
title: a name is hand-typed and drifts, and guessing in something that *writes*
would produce confident wrong results.

- **`template-sync` now follows the same rule**, so this is no longer the narrower
  of the two. It used to fall back to a name pass and to tag every target it
  touched, which meant a sync-then-edge run could adopt a hand-built container and
  the preset would find it in the same pass. That is gone in both directions: the
  styles op writes no names, so **neither half of an automation run tags anything**,
  and a block that is not already tagged is invisible to both. The phase-order
  warning in the Automation window is now only about the style paste overwriting a
  preset's style-transfer fields — the tag is no longer at stake, because a sync
  never writes one.
- **Root index is honoured.** A preset captured from `#4821.1` applies only to
  `#4821.1` instances. A bare `#4821` matches root 1 only — the same rule
  `template-sync` already follows, since a single-root template accepts `#4821` and
  `#4821.1` interchangeably.
- **Inside a template document, depth-0 nodes are skipped**, exactly the exclusion
  `findTemplateTags` makes for the usage index and for the same reason: a template's
  own roots are named `<title> #<id>` by the tools that put them there, so matching
  them would apply a preset to the very element it was captured from. It is about
  position, not about which template the tag names.

### Snapshot, not live link

A preset stores the **values** as they were at capture time. Editing the template
later does not update the preset — re-capture does.

Live-reading the template's saved JSON at apply time was the alternative and would
delete the staleness bug outright. Snapshot was chosen for the self-contained,
exportable, zero-network preset, and **the staleness is a real accepted cost**: change
a template's field, forget to re-capture, and the run pushes the old value with
nothing to flag it. `⟳`-style re-capture is the mitigation, and it is the user's job.

### Structural edits

A preset may also carry **one** structural edit — `add`, `rename` or `remove` a
node. Captured by right-clicking a layer in the **navigator** (not the panel: a
layer's position and its name are not field rows, so there was nowhere in the
flyout for this to live), and only while a preset is armed.

**The address is the node's PARENT plus its child index**, and that is
deliberately *exactly* as strong as a field capture's address — no stronger. It
buys nothing on its own, and believing otherwise is the trap: a container's type
check is near-worthless because every container answers to `container`.

**The confidence comes from Matching Conditions.** Author-declared gates,
evaluated against the matched parent before anything is written. That is the
whole answer to "is this node missing or merely moved": the tool stops inferring
and the author states the precondition. Four kinds — child count, a child named X
exists/doesn't, a child of type X exists/doesn't, and the child at index N is
type X. `CONDITION_KINDS` in `edge-preset-format.js` is the table the GUI renders
from; the evaluator in `page-bridge.js` carries its own switch on the same `kind`
strings, because the page world cannot read that global. Change one, change both.

- **An unrecognised condition kind never passes.** A gate nobody understands is a
  gate that is not gating, and this op writes to real pages.
- **`index-type` is auto-attached to every rename and remove**, and is not
  removable in the GUI. It *is* the leaf type check a field capture already gets;
  without it an edit addressed at the parent would be strictly less safe than the
  thing it is modelled on.
- **A failed gate is `gated`, never `skipped`.** Three outcomes, not two — a gate
  firing is the preset doing exactly what it was told, and folding it into
  "skipped" makes a correct run read as a broken one across a hundred pages.
  `gated` is logged at info; only a genuine skip warns.
- **Idempotency is the author's job, through a condition.** An `add` with no gate
  fires every run and duplicates. The natural guard is `no child named X`, which
  is why a node with no `_title` is **refused at capture** rather than at apply
  time — an unnamed node cannot be guarded, so it must never be authored.

### Structural edits run last, and that ordering is load-bearing

A field capture is addressed by a child-index path, and adding or removing a node
shifts every index after it. So `applyEdgePresets` collects every structural edit
across **all** presets during the field pass and applies them afterwards. Field
writes therefore always resolve against a tree nothing has touched.

Within the structural phase, `apply-edge-structural` takes the whole page's edits
in **one** call and runs three passes that are never interleaved: resolve every
parent path to a container, refuse collisions, then snapshot each parent's
children, evaluate the conditions against that snapshot, and write.

- **It is not chunked, unlike every other batched op here.** The collision guard
  can only see two edits landing on one container if both are in the same call;
  chunking would let a collision through by splitting the pair. The count is
  bounded by (presets with an edit) × (instances on the page), which is small.
- **One structural edit per preset**, refused at capture rather than replacing the
  existing one — two in a preset can invalidate each other's indices, and the
  honest fix is a second preset run afterwards, so it says that instead of
  silently dropping the work the user just did.
- **One structural edit per container per run**, enforced page-side where the
  resolved ids are known. The content script cannot see this: two different paths
  in two different presets can land on the same element. Both are refused rather
  than letting the first win.
- **An added subtree gets fresh element ids** (`regenerateIds` + `liveIds`, the
  same machinery `insert-template` uses, and for the same reason — a duplicate id
  is how a sync once deleted a page's own container with undo unable to restore
  it). `create-element` is the wrong primitive here: it does not regenerate.

  Both halves verified live on Elementor 4.2.1: `document/elements/create` **does**
  build a nested subtree from a model carrying `elements` (a container with a
  heading and a button came back with both children, right types, right titles, at
  the requested index) — so `create` is right and `import` + `moveToIndex` is not
  needed. And it **reuses the model's `id` verbatim**: a model with `id:
  "zzTEST1"` produced a container whose id was `zzTEST1`. The regeneration is
  load-bearing, not defensive.
- **`_element_id` is stripped from the captured subtree, recursively.**
  `template-decouple` does this when one widget becomes several siblings; here one
  captured node is planted on every instance of every page, so the same CSS ID
  would go site-wide.
- **A missing named anchor is a skip, not a gate.** For `before`/`after` placement
  the anchor *is* the address, so not finding it means we do not know where the
  node goes — which is different from a precondition the author declared and that
  legitimately failed.

### Review mode

A run option that skips `save-document` entirely, leaves every editor tab open,
and reports the document as `awaiting review` rather than `done`. It exists for
`remove`: a normal run closes the tab the moment the save lands, so the history
log goes with it and there is nothing left to undo.

- **`beforeunload` must not close review tabs**, or the window closing would
  destroy exactly the unsaved work the mode protects. It closes `openTabs`, and
  `runOne` removes each tab from that set as it finishes — a tab still mid-run
  stays in, which is right, because it has nothing worth preserving yet.
- **Capped at `REVIEW_MAX_DOCS` (20) and refused above it.** Every tab stays on
  screen, so the document count *is* the number of editors left open; nobody is
  reviewing sixty pages by hand anyway.
- **Nothing is persisted until the user clicks**, so a crash loses the whole run.
  That is the inverse of the normal property and was chosen deliberately.

### Files and the armed preset

`{ v, id, name, templateId, templateTitle, nodes: [{ root, path, elType, widgetType, label, fields }], edits: [...] }`.
`v` is **2**; a v1 file still reads, it simply carries no `edits`. A hand-edited
file with two edits keeps the first and *reports* the second rather than dropping
it in silence — its author expected both to run.
**`id` decides replace-or-add** on import, so Export → hand-edit → Import updates a
preset in place. Import is tolerant and export is canonical, the same contract
animation presets ship with; a malformed node is *reported* and dropped rather than
kept, because a typo is otherwise indistinguishable from a field that had no effect.
A file with no `id` is imported as a new preset. A file from a **newer** `v` is
refused outright rather than half-read.

`edgePresetArmed` holds the selected preset's **id**, not a copy of it, so a rename
cannot leave two disagreeing versions of one name in play. `breakpoint-flyout.js`
pushes it — plus the document from `describe-document` — over the same `__bpf`
channel the clipboard uses, because `browser.storage` is unreachable from the page
world. The document is cached after the first successful read (it cannot change
without a page load) and retried twice on load, since Elementor is frequently still
booting at `document_idle`.

**`breakpoint-flyout.js` owns the channel; `edge-presets.js` owns the storage.** The
capture op is delegated through `ns.captureEdgeField` rather than implemented in the
loader, so there is exactly one listener answering one message — two listeners
replying to one `__bpf` message would race and `askContentScript` would keep
whichever landed first, the same trap CLAUDE.md already documents for `ping`.

## Automation tool

`Automation/` runs template sync and Edge Presets over many documents unattended.
Its own window, opened from a button at the bottom of `UI/panel.html`, holding both
the run GUI and the Edge Presets manager.

**It is not a WebDriver script, and that was a decision.** A Node + geckodriver
runner was the starting design; the extension can already do all of it —
`browser.tabs.create` opens editors, content scripts auto-inject, the agent *is*
inside the editor so readiness needs no page-world probing, and saving is one bridge
op. The Node route additionally needed geckodriver pinning, a login flow, a new
postMessage channel for triggering and reporting, and a second copy of the WP-REST
reads, because Selenium's `executeScript` runs in the page world and **cannot** see
`window.__WpRest` or message the extension. What it would have bought — a separate
profile, unattended scheduling, killing a wedged browser — was not worth that.

### The run loop lives in the window

Not in the background script. Background ownership would only buy surviving the
window being closed, and **closing the window is already the cancel gesture**.

- **Cancel abandons in-flight pages by closing their tabs.** Safe by construction:
  the save is the last thing a page does, so an abandoned page was never written to.
  The pending `sendMessage` rejects into `runOne`'s catch, which checks
  `cancelRequested` and records `cancelled` rather than a failure.
- `beforeunload` closes every tab the run opened, so a cancelled run does not leave
  three editors behind.
- Paying for a port protocol and MV3 event-page keepalive to protect work that is
  safe to lose would be the wrong trade.

### One message runs one page

`Automation/automation-agent.js` is a content script, so it can simply await each
phase: the phases the window asked for, in the order it asked for them, then the
save. The window driving four separate messages per page would have to guess at
the boundaries and would leave a page half-processed whenever a reply went
missing.

- **Distinct message types, not `run-action`.** That deliberately replies as soon as
  a run has *started*, and its runners drop their arguments — so neither the
  allowlist nor the report could travel on it.
- **The agent encodes no phase order.** `PHASES` is a table of the two phases and
  `args.phases` is the sequence; the run is a loop over it. The order lives once,
  in `MODES` in `automation.js`, where the GUI that offers it lives — a second copy
  here is exactly how a select labelled one way would come to run the other.
  - **An empty or unrecognised phase list throws rather than falling back.** A
    guessed order means writing to a real page something the window never asked
    for, so it goes to the listener's error channel and the row reports it. Same
    direction as an unrecognised Edge Preset condition, which never passes.
  - **The save stays last, always**, and is not a phase. It is what makes an
    abandoned page an untouched page, which is the whole cancel model.
  - A phase that hard-fails does **not** stop the next one — nothing is saved
    either way, and the second phase's report is worth having.
- **"Ready" is five questions, and getting it wrong is silent.** This is the one
  that actually bit, twice, on live runs. `list-containers` answers `ok: true` with
  an **empty list** while the preview container exists but its children are not
  built — so the sync sees no top containers, concludes the page holds no
  templates, and skips it. On a page with five of them. "No matches" is a
  legitimate answer, so nothing looks wrong.
  - `ping` → `describe-document` → **the preview iframe's own `readyState`** →
    `list-containers` → **settling**.
  - The iframe is same-origin, so its load state is a real signal rather than an
    inference. It is created dynamically, so the *top* document reaching
    `complete` proves nothing and is not used.
  - **The saved document config is the ground truth, and settling is now the
    backstop.** `list-containers` returns `saved: { top, total, via }` from
    `savedElementCounts()` — the element tree the editor booted with, read off the
    server response *before* a single view is built. That is the one count that is
    already correct at the moment the question is worth asking.
  - **It compares TOTAL elements, not the top level.** A page whose top containers
    exist while their descendants are still rendering passes any depth-0 test and
    then breaks nested matching, which the top-level check cannot see at all.
  - `saved.via` names which candidate answered (`documents.getCurrent().config.elements`,
    then `config.document.elements`), the same shape and reason as `isTemplateVia`.
    `via: null` means unreadable, and the blind settle below carries it instead.
  - **`UNDERCOUNT_GRACE` is the escape hatch, and it must stay.** The 1:1
    correspondence between saved elements and walked containers holds on this
    build, but a future Elementor rendering one fewer node would otherwise turn
    every run into a 120s timeout. A count that has **stopped growing** has
    finished building, whatever the arithmetic says — so eight still polls accept
    it and the run *reports* the shortfall rather than swallowing it.
  - `topLevelExpected` from `elementor.elements.length` (the document model) is
    kept as an independent second gate. **That check alone was not enough** and
    shipping it was the second bug: `elementor.elements` fills in *with* the
    preview, not before it, so early on both counts are 0 and agree.
  - **Settling was the third bug, and it was the live one.** With `expected` at 0
    or `null` during a boot, the model gate was skipped **entirely** and the only
    thing left was `SETTLE_EMPTY` — three polls at 800ms. **2.4 seconds decided
    whether a page was empty**, which is nowhere near a large page's boot, so a
    still-building editor passed for an empty one and the page was skipped in
    silence. Settling now only decides the empty case, and only `SETTLE_EMPTY_BLIND`
    (12) when `saved.via` is null; with the config readable it is a formality.
  - The timeout is 120s: three Elementor editors booting at once on a slow site is
    routinely tens of seconds, and failing early would report a working site as
    broken.
- **The document that answered must be the one that was asked for.** `runOne`
  compares `ready.doc.id` against `job.id` and fails the row otherwise. The id came
  back on every readiness reply and was being thrown away, so a redirect, a session
  bouncing through wp-login, or a URL that resolved elsewhere would sync **and
  save** the wrong page — with every phase reporting a clean result about a
  document nobody selected.
- **Every branch of `runTemplateOperation` must return a value.** One bare `return;`
  survived on the "no template matches" path, and an automation run cannot tell
  `undefined` from "the tool is not loaded in this tab" — which is exactly what it
  reported, on a tab where the tool was loaded and working. A wrong diagnosis sent
  the investigation in the wrong direction for a whole run.
- **A phase that hard-fails leaves the page unsaved.** `ok: false` means the run
  stopped somewhere it did not expect to, so what the model holds is unknown; not
  saving leaves the server copy exactly as it was, which is both safe and
  re-runnable. This does not conflict with "always save what was edited" — a page
  that is not saved was never edited. A sync reporting `failed: 3` is a *different
  thing* and **is** saved: carrying on past individual failures is what the sync is
  designed to do, and discarding the rest of its work would make one bad container
  cost the whole page.

### Firefox throttles what it cannot see

A run opens editors nobody is looking at, and Firefox treats those as free to slow
down: background tabs get `setTimeout` clamped to ≥1s, and **hidden tabs have
`requestAnimationFrame` suspended outright**. Elementor builds its preview through
rAF, so a hidden editor does not merely load slowly — it can never finish. From the
window that looks identical to a slow site.

Two halves, because neither is sufficient alone:

- **One unfocused window per editor, not a background tab.** `openTab`'s
  `ownWindow` option. Only the *selected* tab of a window counts as visible, so N
  concurrent editors need N windows — sharing one would leave all but the front one
  hidden, which is the situation being escaped. Unfocused so the run does not steal
  the keyboard, and deliberately **not minimized**: a minimized window is hidden and
  throttles exactly like a background tab. Staggered by `index % concurrency` so
  they cannot land perfectly stacked, since a fully occluded window can be marked
  hidden too.
- **`npm run auto`** launches a second Firefox through `web-ext` with the throttling
  prefs off (`scripts/automation-browser.js`). Prefs are browser-level and **cannot
  be set from inside an extension**, which is the whole reason this script exists.
  It also turns off Windows occlusion tracking, which is what makes the staggering
  above a belt rather than the only defence.

Notes on that script:

- **It is a separate browser, and the profile lives outside the repo.** The repo is
  in OneDrive and a Firefox profile is a directory of live sqlite files; syncing one
  invites corruption and a permanent upload loop. It goes under `LOCALAPPDATA`.
- **`--keep-profile-changes` against a dedicated profile**, so the WordPress login,
  the Edge Presets and the working domain survive between runs. That flag would be
  reckless against a real profile; it is correct here because the directory exists
  for nothing else.
- The extension id is fixed in `browser_specific_settings`, so `storage.local`
  is stable across launches rather than a fresh sandbox each time.
- **A Playwright/geckodriver runner was reconsidered here and refused again.**
  Everything it would buy is the prefs, which `web-ext` already sets; against that
  it costs a second harness, a hand-seeded profile, and a pinned extension UUID
  just to reach the Automation page — Playwright does not support installing
  Firefox add-ons. Same conclusion as the original decision at the top of this
  section, reached from a different direction.

**The run reports which it was.** The readiness reply carries `env`
(`hidden`, `visibilityState`, `frameMs`) from a one-shot rAF probe, cached per tab.
`frameMs: null` means no frame ever arrived — the signature of a suspended tab
rather than a slow site — and `throttleNote` turns that into a log line naming
`npm run auto`. The probe is self-selecting: an unthrottled tab answers in ~16ms,
and only the tab worth learning about pays the full 1.2s window.

### The allowlist gates both halves

One template selection drives the whole run. `template-sync`'s `auto` option bag
carries `templateIds`, and `edge-presets.js` filters its presets against the same
list — a preset whose template is not ticked does not run. Because a preset already
knows its own template, **there is no separate preset → template mapping table
anywhere**.

- Without it a run updating two templates would re-sync the other thirty on every
  page — a great deal of mutation nobody asked for, on pages nobody will review.
- A ticked container can be reached by several templates (by id tag from one, by name
  from another); under an allowlist only the allowed ones are inserted for it.

### `auto` skips the confirm, and only there

`runTemplateOperation(op, auto)` replaces the confirm checklist with the choices
`auto` carries and returns a summary instead of only drawing one.

CLAUDE.md's rule that the confirm is always shown is a rule about a **hotkey**, where
the keypress is the only thing the user said. An automation run has already been
specified page by page and template by template in its own GUI; re-asking inside
each of a hundred editor tabs would not make it safer, it would make it impossible.
The hotkey and the panel's Run button both call with nothing and still get the
checklist — and the keydown path passes the *event* to its runner, which drops it,
so an accidental keypress can never arrive looking like an automation run.

Toggles are resolved in one place for both paths: `auto.toggles` is a key → boolean
map and anything it omits falls back to that row's own `default`, so the group names
stay in `OPS` and a drifted key degrades to the recommended state rather than
silently to "off".

### The GUI

- **Two pickers, both searchable, and searching never narrows the selection.** A
  ticked row hidden by a later search still counts, and the count line says how many
  are hidden — so the number can never look wrong. The bulk button is labelled
  **Shown**, not All, because that is what it ticks. Same rule as
  `template-insert.js`.
- **Documents to process covers Pages · Templates · Other.** Template documents are
  selectable because a template can contain a tagged instance of *another* template,
  and a pages-only run would never reach that copy. The Templates list serves both
  the include-picker and that target tab — one fetch.
- A document ticked on two tabs is one job: template ids and post ids are both
  WordPress post ids, so the id alone is the identity.
- **Run modes are a phase list, and the label names its order.** `MODES` in
  `automation.js` is the single definition — value → label → ordered phases — and
  the `<select>` is *rendered from it* rather than written into `automation.html`,
  so a label cannot promise an order the run does not perform. Sync → Edge Presets ·
  Edge Presets → Sync · Sync only · Edge Presets only. The last is the fast one — no
  network at all per page.
  - **Ask in phases, never by comparing `mode` to a string.** `phasesFor()` is the
    accessor; the sync toggles grey out on `!phases.includes("sync")` and the
    opening row state comes from `phases[0]`. The old `mode === "edge"` tests would
    each have needed a new case for every mode added.
  - **Sync-then-edge is the default, and the reverse warns once per run.** One
    thing changes and it does not show up as a failure: a style-transfer field a
    preset writes is overwritten by the paste that follows, silently, because a
    preset that wrote its value and lost it still counts as applied. The non-style
    fields presets exist for survive either order, which is what makes edge-first
    usable at all.
    - It used to be **two** things, and the second is gone: the sync tagged every
      target it touched, so running the presets first meant they could not see a
      container the sync was about to adopt. Neither half writes a tag now — both
      match on one — so the two phases see exactly the same set of instances
      whichever order they run in.
  - **The report carries `phases` beside `mode`**, because the mode key alone does
    not say which half ran first and a report read months later has to.
- **States.** Run: `idle → running → cancelling → finished | cancelled | error`.
  Per document: `queued → opening → waiting → syncing ⇄ edge → saving → done |
  review | failed | cancelled` — the two middle phases in the chosen order. Three at
  once is only legible as three rows
  moving, which is why progress is a row per document rather than a single bar.
  `review` is distinct from `done` on purpose — nothing reached the server, so it
  is work that still needs a human.
- **Leave tabs open for review** turns off the save entirely — see Review mode
  under Edge presets. It is the only safety net a `remove` has.
- **Reads go through `tab-bridge.js`**, the same ranked ask the panel uses — this
  window has no page bridge either. `workingDomain` is deliberately the *same*
  storage key the panel uses: it names the site being worked on, and two windows
  disagreeing about that is the one setting that must never differ.
- **The report is a download, not a file on disk.** An extension page has no
  filesystem. `Copy log` and `Download report` (JSON: per-document state, note,
  error and the full phase reports) are the honest version of that.
- **The Edge Presets tab carries the manual `Run on page` button**, disabled while a
  preset is unbound — an unbound preset matches nothing, and reporting zero
  instances would read as a result rather than as unfinished authoring.
- **That button names the document it dispatched to**, and it has to. Which editor
  answers is the tab ranking's call — origin, then *active* — and this window is a
  popup, so the editor on screen is often **not** the active tab: with two editors
  open and a third tab active, both editors score equally and the first in query
  order wins. Verified live, where a run intended for a page landed in the
  template's own editor and correctly wrote nothing. Unnamed, that is
  indistinguishable from a preset that matched nothing.
- **A row button's label says what the click DOES, not what the state is.** It read
  `Capturing` when armed once, and since `New preset` auto-arms, the first thing a
  user meets on a fresh preset is that button — so clicking it to "select" the
  preset silently disarmed it. It reads `✓ Stop capturing` now; which preset is
  armed is already carried by the banner and the card border.

### The activity log has one writer

`ns.log` now sends its entry to `background.js`, which appends it. It used to do its
own read-modify-write against `browser.storage.local`, which is a race — and an
automation run makes it a certainty: three editor tabs are live at once, each logging
steadily, and two overlapping `get`→`set` pairs silently drop whichever entry lost.
Losing lines is not acceptable in the log whose whole job is to record what failed
while nobody was watching.

- The direct write stays as a **fallback**, so a line is never lost to a background
  page that did not answer — that degrades to the old race rather than to nothing.
- `LOG_LIMIT` went 50 → **500**, mirrored in `background.js` (the writer) and
  `core_utils.js` (the fallback). A 50-entry window would have thrown away everything
  but the last page or two of a hundred-document run. Change one, change both.
- Sync failures that previously only reached the modal now also call `ns.log`. In an
  automated run the tab is closed the moment the page is done, so a failure that only
  ever reached a modal is a failure nobody will ever read.

### Verified on a live site

- **`document/save/default` resolves AFTER its ajax completes.** Measured on a real
  page: the op took **5.7s** and came back `saved: true`, `status: "publish"`,
  `stillChanged: false`, with `modified_gmt` advanced server-side and the content
  persisted. So closing the tab immediately after the save is safe, and the
  `stillChanged` read-back stays as the net rather than the only defence.
- **A published page is republished, never downgraded to a draft.**
- **A page the run did not change is not saved.** Verified by its `modified_gmt`
  standing still across a run that reported `not saved — nothing changed`.
- **A hard failure really does leave the page untouched.** A page whose sync failed
  kept both its old `modified_gmt` and a deliberately planted marker value, while
  its partner in the same run was saved.

### Known risk, still unverified

- **`browser.tabs.remove` versus Elementor's unsaved-changes prompt.** The cancel path
  closes tabs that may hold unsaved changes. `tabs.remove` is expected to force-close
  without running `beforeunload` dialogs; if it does not, a cancel will stall behind
  a modal. Cancel has not been exercised on a live run yet.

## Pure container reset

Two panel checkboxes, both **on by default**, riding one `document/elements/create` hook. **Both are scoped to one event: the user adding a new container.**

- **Pure Container Reset** zeroes `padding`, `margin` and `flex_gap` on the new container, at every breakpoint.
- **Unlink Fields On New Elements** forces the "link values together" button off on it — see below.

There is no hotkey and no modal for either: they are passive, they react to the editor rather than being invoked, and nothing here touches the network.

This is the only feature in the codebase that **reacts to an Elementor command** instead of issuing one, and that shape is where all of its design decisions come from.

**Nothing but a user-added container is ever touched.** Three independent gates say so, and each one closes a hole the others cannot see:

1. **`hookFlagsFor`** — the model must be `elType: "container"` and must arrive with **no children**.
2. **The trace allowlist** — every command in `$e.commands.currentTrace` must be a user route.
3. **The suppression counter** — this extension's own creates hold the hook off explicitly.

**Off means off, at both ends.** `getConditions` asks `!pureResetEnabled && !unlinkNewEnabled` **first** and returns before looking at anything else, so a disabled feature costs two booleans and touches nothing — no write, no log line. The write is deferred (below), so `applyPureReset` re-checks both flags against the live values before writing: an option switched off during the deferral does not get a last write in.

**They are two flags, not one option with a mode**, because what they write differs — the reset zeroes the box, the unlink moves a button that sits on 40 controls, `border_radius` included. `configure-pure-reset` carries both in one message: one hook serves both, and pushing them separately would leave the page world briefly holding a stale half of the pair. `getConditions` fires if _either_ applies, and `hookFlagsFor(model)` is the single place that decides which.

**The unlink used to fire on every new element** — a widget's padding carries the same link button, so it looked like free coverage. It was not: every dropped heading took ~30 non-default keys into the saved document plus a log line, from a pair of options a user switches on to tidy up _containers_. Widgets are out of scope now, and `hookFlagsFor` returns early for them.

**Both write in one settings command.** They overlap — `padding` is a box control _and_ a link-bearing one — and a control holds a single value object, so two commands would mean the second overwriting the first's work on the shared keys. Measured on a container with both on: 15 zeroed, 40 unlinked, **40 keys written**, not 55.

- **It is a real `$e.hooks` data-after hook on `document/elements/create`**, registered page-side in `page-bridge.js` by extending `$e.modules.hookData.After`. Both that class and `$e.hooks.registerDataAfter` were verified present on this Elementor build before the code was written — a monkey-patch of `$e.run` was the alternative and is strictly worse, because Elementor's own internals reach commands by routes that do not all go through `$e.run`.
- **A hook fires in the page world, so a content script cannot be on the other end of one.** `Tools/pure-container-reset.js` therefore owns nothing but the on/off flag: it reads `pureContainerReset` from storage, pushes it through `configure-pure-reset`, and re-pushes on change. The hook itself reads the flag in `getConditions`, so toggling the option never attaches or detaches anything — there is no half-removed hook to get wrong.
- `undefined` means "never set, use the default" and the default is **on**, the same distinction `skipWord` draws. The default is stated in both `UI/panel.js` and `Tools/pure-container-reset.js`, because the panel loads no content scripts.

### Telling a new container from every other kind

Every route funnels through `document/elements/create`, so `$e.commands.currentTrace` is what tells them apart. Measured on Elementor 4.2.1 / Pro 4.0.4:

| route | trace | children |
| --- | --- | --- |
| drag Container out of the Elements panel | `preview/drop`, `…/create` | 0 |
| the `+` button → a layout preset | `…/create` | 0 |
| **this extension's own `$e.run`** | `…/create` | varies |
| paste | `…/paste`, `…/create` | ≥1 |
| duplicate | `…/duplicate`, `…/create` | ≥1 |

**`USER_CREATE_COMMANDS` is an allowlist, and that direction is the point.** The trace must consist _entirely_ of `document/elements/create` and `preview/drop`; one unrecognised command anywhere in it means this create belongs to some larger operation. The blocklist this replaced (`COPY_COMMANDS`) had to name every command that would ever wrap a create — paste, import, duplicate, the section→container converter, Elementor AI, whatever ships next — and everything it failed to name got its spacing zeroed. An allowlist inverts the failure: an unrecognised route is left alone, which is the only safe default for a destructive write.

Inferring it from whether the spacing is still at its defaults is the other obvious alternative and is worse still — it would zero a _pasted_ container that happened to carry no spacing, precisely the case the exclusion exists to protect.

- **Row three is why the suppression counter is not optional.** Our own creates are byte-identical to the `+` route by trace alone, so the trace can never exclude them.
- **A model arriving with children is never a user-added container.** Verified on every add route — `c100`, `r100`, and the `50-50` preset, which fires **three separate creates** rather than one nested model — a user's new container is always empty. Paste, duplicate and this extension's subtree inserts all carry children. This is the gate that catches an injection whose trace looks like the `+` button (a tool that forgot to suppress) _before_ anything is zeroed.
- **Nested containers need no special case.** Each one is its own `create`, so each gets its own hook fire.
- **The suppression counter lives on `window`** as `__ElementorToolsSuppressCreateHook`, not in `page-bridge.js`'s closure, because the other end of it is a **separate page-world script** and shares no scope with it — the same boundary that keeps the template-tag regex out of the bridge. It is a counter and not a boolean because a suppressed run issues several creates and can nest.
- **This counter is a contract with a different extension, and it is the only one.** The component system was split out into **Elementor Components** (`../Elementor_Components`), whose `component-page.js` repeats the key name and the `++`/`--` protocol as a MIRROR. It still works because the **page world is shared across extensions** even though content-script sandboxes are not. Nothing in either build fails loudly if it drifts — the symptom is component instances silently losing their spacing. Do not rename the key.
- **Everything this extension injects is held out.** `create-element` — so `ns.createContainer`'s wrapper and `ns.createTemplateWidget`'s widgets. Every _other_ tool here reaches the document through paste or import, which the allowlist excludes anyway. The component extension holds its own creates out through the counter above: that was a real bug once, because component inserts and syncs build containers from a **parent component's own JSON** and the hook was zeroing the padding, margin and gap off them the moment they appeared — silently reshaping every instance away from its base.

### The decision is synchronous, the write is not

`getConditions` runs while the trace still says how the container came to exist; `apply` only captures the ids and defers the write with `setTimeout`. Running a settings command inline would fire it while Elementor is still finishing the create it is reporting — and by the time the deferred callback runs, `currentTrace` is empty, which is why the trace test **cannot** be moved down into `apply`. The _flag_ test is the opposite: it is re-asked in `applyPureReset` precisely because that runs later, so switching an option off is honoured even mid-deferral.

The consequence is that the zeroing lands as **its own undo step**, which is accepted rather than worked around: grouping it with the create would mean holding a history log open across a deferral.

### The keys come from the live control list

Never a hardcoded table, for two reasons that both bite:

- **The responsive suffixes depend on which breakpoints the site has enabled.** The site this was built against carries `tablet_extra` and `mobile_extra` on top of the usual `tablet`/`mobile`; a default install does not. Hardcoding the common set would silently miss the rest. On that site 15 keys resolve — 5 padding, 5 margin, 5 `flex_gap`.
- **A container's gap control is `flex_gap` (type `gaps`), not `gap`.** Section and column markup carries a _different_ control literally named `gap` — a select holding "default"/"narrow"/"extended". `BOX_ZEROS` is keyed on control **type**, so that one has no zero and is skipped rather than being written a dimensions value.

The two shapes differ and are not interchangeable: `dimensions` takes `{top,right,bottom,left}`, `gaps` takes `{column,row}`. Both are written as `"0"` rather than `""` — empty means "inherit whatever the kit or theme says", which is the default this feature exists to override.

### Unlink new elements

Elementor defaults the link button **on** (`isLinked: true`) for both control types that have one. This option flips it off at creation, so a fresh element starts with its sides independently editable.

- **Detection is by control _type_, never by name.** `LINKED_TYPES` is `dimensions` and `gaps` — measured on this build a container has 30 of the first and 10 of the second, and **every one of them holds `isLinked`**, so the button is a property of the type.
- **Containers only, like the zeroing.** It fired on every new element once, and the type-based rule is what made that look free — a widget prefixes some of these controls with an underscore (`_padding` where a container has `padding`), so a name-based rule would have needed the `resolveControlKey` mapping while a type-based one never sees the difference. Keep the type rule anyway: it is what would make a future re-widening a one-line change, and it is why `BOX_CONTROL`'s name test and this one cannot be merged.
- **Values are preserved; only the flag moves.** A control the reset is not zeroing is written back with its own current value and `isLinked: false`, so `border_radius` keeps its sides. A control already unlinked is left out of the payload entirely rather than restated.
- **`BOX_ZEROS` holds no `isLinked`, deliberately.** It used to assert `true`, which meant zeroing a box quietly _re-linked_ it whatever this option said. The flag is now carried from the live value in one place (`createSettings`), so with the unlink option off, a zeroed container keeps the button exactly where the user left it — verified: `padding.isLinked` stays `true` and `border_radius` never enters the payload.
- **The cost is real and was chosen.** A flipped `isLinked` is not a default value, so Elementor cannot strip it at save — every new container carries ~40 extra keys in its saved JSON. `dimensions` covers `border_width` and `border_radius`, not just padding and margin. Paying it on ~30 keys per _widget_ as well is what tipped the scope back to containers.
- Stored as `unlinkNewElements`; `undefined` means "never set, use the default" and the default is **on**, the same distinction `skipWord` draws.
- **The breakpoint flyout honours the same flag** — see "Honouring the unlink option" under Breakpoint flyout. Between them, the two cover the create path and the edit path, so a field that starts unlinked is not quietly re-linked by editing it. The flyout is deliberately **not** narrowed to containers along with the create hook: it writes only the field the user just edited on the element they chose, so scoping it out of widgets would silently re-link a widget field on every edit — the exact regression that bullet exists to prevent.

### Reporting

Every write reports to the **log** — no modal, since nothing here touches the network and the user did not invoke it. The panel already re-renders the log live, so a passive feature announcing itself there is how you can tell it is working at all.

**This is the bridge's one unsolicited message.** Every other page → content-script message answers a request and carries its `requestId`; the hook fires off an Elementor command instead, so it has nothing to answer on. `emit(event, detail)` posts `{ __ns, __event }` and `pure-container-reset.js` listens for it. `core_utils.js` exports `ns.BRIDGE_NS` so the listener matches on the same namespace the bridge sends on rather than repeating the literal a third time. The existing `callBridge` listener ignores these — they have neither `__ready` nor `__response`.

- **One line per container, not per drop.** A `50-50` preset is three creates, so three writes and three lines — verified. A drag that auto-creates a wrapper counts the wrapper only, since the widget inside it is out of scope now. Rolling them into one would hide the nested ones, which is the part worth being able to see.
- **The line names what actually happened**, since either option can be off: `container d12e35f: zeroed 15, unlinked 40 field(s)`, or `container d12e35f: zeroed 15 field(s)` when the unlink is off. A silent run means the hook declined — that is the intended reading, and it is why nothing is logged when both options are off.
- **A fresh element has no `_title`**, so the label is the element kind plus the bare id, and a named one gets `container "Hero" (d12e35f)`. `elementKind` still prefers `widgetType` over `elType`; with the scope on containers that never fires, and it is left in place for the same reason `LINKED_TYPES` is.
- **Three outcomes, three lines.** A successful write reports its counts; a failed settings command is a warning with the error; **nothing resolved is also a warning** — on a container that means the control names moved in an Elementor upgrade, which must not read as a silent success.
- **The one silent case** is an element deleted between the hook firing and the deferred write landing. Nothing was written, but there is no element left for that to be wrong about.

## Breakpoint flyout

`Tools/breakpoint-flyout-page.js` adds two things to Elementor's panel, deliberately scoped differently. **There is no hotkey, no button and no field list.**

- **Left-click a responsive field** — its label or the empty part of its row — opens a flyout showing that field at every active breakpoint at once, instead of cycling the device switcher one breakpoint at a time.
- **Right-click any field at all** opens a small menu with Copy and Paste for that field's value — plus **Capture** into the armed Edge Preset, when there is one and this is that template's editor. See Edge presets for why capture lives here: the flyout is where a field row can be clicked at all, and `controlInfo`/`sectionInfo` already resolve exactly what a capture needs.

The row _is_ the affordance; there is no icon. Only the label and the row's own whitespace are clickable, and the cursor changes on exactly that region — a click on an input, the unit picker or Elementor's device switcher passes straight through, so nothing that used to work stops working. `PASSTHROUGH` expresses that as a rule about **structure** (every control nests its inputs under `.elementor-control-input-wrapper`, `.e-units-wrapper`, or the switcher div) rather than a blocklist of control types that would need extending each time Elementor adds one.

Right-click keeps the native menu inside text entry, where spellcheck and text copy/paste are worth more than ours.

It also owns the **navigator** right-click menu (Add / Rename / Remove node, for
Edge Preset structural edits), and that lives here for the same reason the field
capture does: this file already resolves an element to an address and can talk to
the content script. It is intercepted **only while a preset is armed** — Elementor
has its own navigator context menu, and taking it away permanently to serve a
feature nobody is currently using would be a bad trade. `buildMenu` is the shell
both menus share, so their outside-click and Escape handling cannot drift.

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

### Template usage

Every row on the **Templates** tab carries a usage count that expands into the
list of documents holding a layer tagged for that template. It answers the
question the template tag was always able to answer and nothing could ask: *where
is this template actually used?*

`Tools/template-index.js` is the walk — `/wp/v2/types` → each type's collection →
`_elementor_data` for the documents that changed — and `template-format.js` owns
both halves of the rule (`findTemplateTags` reads, `buildUsageIndex` groups),
next to the tag regex that writes it. `UI/panel.js` holds the cache and draws the
dropdown.

- **The tag is the whole mechanism.** A layer name carrying `#4821` is an exact
  link back to template 4821, so a usage is a tag and nothing more. There is
  deliberately **no name matching** here, unlike `template-sync.js`: a name pass
  exists there to catch hand-built containers that were never tagged, and
  guessing at that in a *report* would produce confident wrong answers about
  where a template lives.
- **It shares nothing with the component system.** That answered a different
  question with a similar walk, and the two were deliberately kept apart so that
  removing one left the other working. That rule is what let the component system
  be lifted out into its own extension (**Elementor Components**,
  `../Elementor_Components`) without touching this file. The duplicated walk is
  the accepted cost, and it has now paid for itself.

#### Depth 0 is skipped inside a template, always

The one exclusion, and it is unconditional: in an `elementor_library` document
every depth-0 node is ignored. A template's own roots are named
`<title> #<id>` by the tools that put them there — `template-insert` on the way
in, `template-sync` renaming **every** target it touches — so counting them would
report each template as using itself, on every row, permanently.

It is about **position, not about which template the tag names**. A root tagged
for some *other* template is still a root of this one, and the next sync re-tags
it anyway. Children still count at every depth: a template legitimately contains
a block cut from another template, and that block is nested by definition.

#### Its own scan button, and why it cannot ride Refresh

`Scan Usage` sits beside `Refresh Templates` and is hidden on the other two tabs.
The two cost wildly different things — Refresh is one call to Elementor's library
endpoint, a usage scan has to read every document's `_elementor_data`, because a
layer name is not something any listing endpoint returns. Folding it into Refresh
would make the list that is already fast feel broken.

Cache-and-diff on two stamps, the same shape and the same reasoning the Command
Center documents: `modifiedGmt` is what a document says now, `indexedGmt` is what
it said when its content was last **successfully read**. One field cannot do
both — stamping the fresh value against a failed read makes the next scan skip it
forever and its usages vanish silently. Documents with no tags are cached too, or
they look unread on every scan and are re-fetched forever.

The cache renders instantly on open and only ever rescans on click. Pointing the
**Working Domain** at another site discards it outright: nothing about site A's
tags is true of site B, and the counts are the one thing here that would look
perfectly plausible while being wrong.

#### Zero is an answer, and so is a tag pointing nowhere

- **A template with no uses keeps its pill** and goes quiet rather than losing it.
  Hiding it would make an unused template indistinguishable from one the scan
  never covered — and "nothing uses this" is often the reason someone opened the
  list.
- **Orphans get their own group at the end**, prefixed with the id they name.
  A tag naming a template that is not on this site is a broken link on a real
  page, and nothing else in the panel would ever mention it. Shown only with the
  search box empty: they are not templates, so no search term can be said to
  match them.
- **The known-template set comes from the walk, not from the library endpoint**,
  and is taken *before* the Elementor filter — narrowing it would report a tag
  pointing at a perfectly good template as broken. An empty set means the scan
  never established which ids exist, so nothing is called an orphan on the
  strength of it.
- **The root index is shown wherever the tag carries one** (`root 2`), because it
  is what tells two roots of one multi-root template apart.
- Every indexed document is Elementor-built (the scan filters on
  `_elementor_edit_mode`), so a usage row's **Edit** never has to choose an
  editor and the trap where `post.php?action=elementor` quietly converts a post
  it never built cannot be reached. **View** is the permalink for a published
  post and the preview route otherwise, with the `elementor_library`
  `viewable: false` correction the Command Center also makes.

Known gap, inherited from the tag itself: a layer renamed without keeping its
`#id` drops out of the index. That is the same trade `template-sync` makes — the
tag is exact, and a name is hand-typed and drifts.

### Panel: Run buttons

Every row in the panel's Hotkeys list has a **Run** button beside it, so the tools are reachable without the keyboard. It rides the same `askElementorTab` bridge as the template list — `run-action` → the `runtime.onMessage` listener in `hotkeys.js` → the **same `runners` table the keydown handler uses**. Do not give the buttons their own dispatch: one entry point per action is what stops a button and its key from drifting.

- The reply reports that the run _started_, not that it finished. Tools draw their own modals and a template sync can take a minute; holding `sendMessage` open for that would time out the panel for no gain. Failures after dispatch land in the tool's own modal and the log.
- On success the panel **focuses the responding tab**. The panel is a separate popup window, so without this the tool's modal opens somewhere the user isn't looking and the click reads as dead.
- `askElementorTab` sorts active tabs first. A side-effectful run with two editors open should land in the one on screen; first-responder order was fine when the only message was a read. It does **not** pass `preferOrigin` — a run belongs in the tab the user is looking at, not in whichever tab matches a text field they may have set for something else.

### Dual-context files

`template-format.js`, `hotkey-defaults.js`, `animation-preset-fields.js`, `edge-preset-format.js` and `tab-bridge.js` are loaded **both** as content scripts (or by both extension windows) and by `panel.html`, each assigning one global. `edge-preset-format.js` is there because the editor captures into a preset and the Automation window authors, validates and exports one: the schema, the child-index path encoding and the tag-matching rule have to be a single definition. `tab-bridge.js` is the odd one — it is loaded by the two *windows* rather than by content scripts, because both ask the same ranked question of the same set of tabs and a forked ranking is what let a background editor answer for the wrong site once already. The template usage index is the newest thing riding this: `findTemplateTags` runs in a content script and `buildUsageIndex` runs in the panel, and both live beside the tag regex they depend on so a reader and a writer cannot drift. `animation-preset-fields.js` is there because the panel authors preset files and the editor applies them: one side writes the comments and validates an import, the other reads the defaults and types, and a second copy of the field table is exactly how the two would drift. That is the mechanism for anything the panel and the editor must agree on — template metadata rendering, the search predicate, `normalizeTemplateList`, and Edit-URL construction all live in `template-format.js` precisely because `panel.js`, `template-insert.js`, `admin-templates.js` and `overlay.js` would otherwise drift. Neither file may touch `location` or the DOM at load time.

**The page world is outside this mechanism.** `page-bridge.js` is injected as a page-world script and cannot read a content-script global, so its `list-templates` op carries its own copy of the field mapping that `normalizeTemplateList` holds — the same boundary that keeps the template-tag regex out of it. Those two are the one sanctioned duplication here; change one, change both. Do not "fix" it by having the bridge reach for the global.

## Tree alignment

`ns.pairTrees` diffs the two trees rather than requiring identical shapes, so an inserted or deleted layer no longer fails a whole container.

At each level the children are aligned by LCS in **three passes of decreasing confidence**, and each pair carries which pass produced it:

| pass | key | what it recovers |
| --- | --- | --- |
| `strict` | `type + name`, in order | an identity match |
| `loose` | `type` alone, within a gap | a renamed layer |
| `moved` | `type + name`, ignoring order | a reordered layer |

Aligned children recurse; unaligned ones are reported as `missing` (in the template, not on the page) or `extra` (on the page, not in the template) and are simply not styled.

**Pass 3 is why a reordered child is no longer lost.** LCS is order-preserving by construction, so two siblings that swapped places used to come out as one `missing` plus one `extra` and neither got styled. The move pass only pairs leftovers whose strict key is unique on **both** sides _and_ carries a real name: an unnamed container's strict key degenerates to its bare type, and pairing two of those across a level would be a guess about position rather than a recovery of identity. There is a unit test for exactly that case.

### The gate is the template's coverage, not the larger tree's

Two hard failures remain:

- **Root type mismatch** — nothing below it is interpretable.
- **`templateCoverage < minRatio`** — `pairs / srcNodes`, default `MIN_MATCH_RATIO` (0.5), overridable per site from the panel's **Minimum Template Match (%)** field via `ns.getMatchThreshold()`.

The denominator used to be `max(srcNodes, tgtNodes)`, and that was wrong in one common, expensive way: a page block holding the whole template faithfully _plus_ twenty layers somebody added scored 10/30 and was **refused outright**, even though all ten template nodes had found homes and nothing was ambiguous. Extra content on the page is not evidence that the block is wrong.

So the two questions are kept apart:

- `templateCoverage` = `pairs / srcNodes` — "did the template apply?" **This is the only gate.**
- `pageCoverage` = `pairs / tgtNodes` — "how much of the page did we touch?" Reported, never refused. Below `LOW_PAGE_COVERAGE` (0.5) the result carries `lowPageCoverage` and the row goes amber with the counts, because a template landing on a block ten times its size is what a tag on the wrong container looks like — and it is the one shape that would otherwise read as a clean sync.

Both are computed after subtracting **whole skipped subtrees from each side independently**. Counting a skipped branch's descendants would let the skip word push a container under the threshold — the opposite of what marking a branch means. If you touch the ratio maths, re-check that a large skipped subtree leaves the ratio at 1.00; the unit test covers it.

### What it reports back

- **`how` — `{strict, loose, moved}`.** A row reading `40/40 node(s) styled` reads identically whether every node matched on its name or all forty were positional guesses on unnamed containers, and those are very different results to trust. The run surfaces `N of M node(s) aligned by position, not by name` per target and sums it into `tally.looseNodes`. The root pair is not counted — it is the match, established before the walk starts.
- **`divergence` — the worst level, not the leaves.** Every level with unaligned children is recorded; the one with the most is formatted as `root > [1] "Content": template has 3 child(ren), page has 1, 1 aligned`. It names the single layer to open, where a flat list of leaf paths names what fell out of it. Path steps carry the target's own layer name for the same reason — a bare `[2]` is an index into a tree the user cannot see from the modal.
- **`rootSkipped`.** The root itself carrying the skip word returns `ok: true` with no pairs, rather than being walked. This was a bug: the walk skips such a node and returns, which for the root means zero pairs against a denominator floored at 1 — a 0% ratio, reported as "too different to be the same block". Marking a container `skip` is exactly how you hold it back, so that read was precisely backwards. `applyRootToTarget` now reports it the same way the replace operation always did.

**The low-ratio failure also returns `pairs`, and no caller here reads it.** It is for "Link to Component" in **Elementor Components**, which ships a verbatim copy of `core_utils.js` and needs the already-computed alignment to offer "Link anyway". Leave the field in: every caller checks `ok` first so it costs nothing, and removing it would silently break that feature the next time this file is ported across.

## Skip word

Any layer whose name contains the skip word is never restyled. Default `skip`, case-insensitive substring match, configurable in the panel; clearing the field to empty disables the feature. Stored as `skipWord` — `undefined` means "never set, use the default", `""` means "explicitly off", so the two are not interchangeable.

`ns.getSkipMatcher()` returns the predicate. It is honoured by **both** style-replacing tools: `template-sync.js` and `replace-styles.js` (simple and deep modes).

A skipped node yields no style pair **and exempts its whole subtree from structural comparison** — marking a branch `skip` means that branch is allowed to have diverged from the template, which is the point. Without that exemption a diverged branch would fail the whole container and the feature would be useless.

**A replace checks the whole subtree; a style sync checks node by node.** That asymmetry is not an inconsistency, it is the difference between the two operations. A style sync touches one node at a time and `pairTrees` exempts the marked branch, so the target's own name is all it has to test. A replace **deletes the target's entire subtree**, so a skip-marked layer anywhere inside it is destroyed — checking only the target's own name silently threw away the exact branches the skip word exists to protect. `tally.firstSkippedDescendant` walks the children map built from the run's own `list-containers` read (no extra round trip), and a match skips the target with the offending layer named, counted as `skippedProtected`.

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

## Component system — moved out

The Figma-style component model (base / instance / overrides, the `-(Comp-Data)-`
widget, sync, the Command Center) was **split into its own extension**:
**Elementor Components**, at `../Elementor_Components`. Its `CLAUDE.md` carries
the full documentation — schema, override derivation, the plan/apply ordering,
the wrap bug, staleness, the site index.

The two extensions install side by side and are independent. What still connects
them:

- **`__ElementorToolsSuppressCreateHook`** — the one real contract. See "Pure
  container reset" above. The page world is shared across extensions, so it works;
  nothing fails loudly if the key name drifts.
- **Three files were copied there verbatim** — `template-format.js`,
  `Tools/core_utils.js` and `Tools/multi-select.js`. Content-script sandboxes are
  per-extension, so `window.__ElementorTools` and `window.__WpRest` could not be
  reached across the boundary and a copy was the only option. A fix to any of the
  three here is worth porting across.

Do not re-add a `Component/` folder to this repo.
