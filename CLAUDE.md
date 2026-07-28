# Elementor Tool

Typical flow each release: npm run bump → npm run sign → install the .xpi from about:addons.
Browser extension (MV3, Firefox) that adds hotkey-driven tools to Elementor's WordPress editor.

## Structure: UI -> Tools

```
├── manifest.json        # MV3 manifest
├── background.js        # toolbar-icon click → opens UI/panel.html
├── hotkeys.js           # global keybindings (dispatches to tools)
├── hotkey-defaults.js   # dual-context: ACTIONS table + binding formatting
├── template-format.js   # dual-context: template metadata, search, Edit-URL building
├── UI/                  # window opened from the toolbar icon
│   ├── panel.html
│   └── panel.js         # reads browser.storage.local, re-renders on change; site-template list
└── Tools/               # one self-contained tool per file
    ├── preview-override.js   # forces fixed widths on mobile/tablet preview
    ├── core_utils.js         # shared helpers on window.__ElementorTools (log, selectLayerById, callBridge, insertSiteTemplate, listSiteTemplates, pairTrees, normalizeName)
    ├── page-bridge.js        # injected into page world; runs Elementor $e commands via postMessage
    ├── multi-select.js       # shared subsystem: shift+click in navigator toggles blue-tint selection
    ├── layer-root-finder.js  # captures the currently selected Elementor layer
    ├── replace-styles.js     # copies source layer styles onto same-named descendants of root
    ├── replace-layer.js      # replaces same-named descendants of root with a copy of source layer
    ├── batch-rename.js       # renames every multi-selected layer to one name (inline modal)
    ├── template-sync.js      # name-matches top containers to site templates; styles them, or replaces them outright
    ├── template-insert.js    # multi-select picker over the template library, inserts the ticked templates
    ├── template-decouple.js  # swaps Elementor Template widgets for a copy of the template's own content
    └── overlay.js            # draggable in-page HUD (root layer, logs, Edit-in-Elementor link)
```

- Load order: `template-format.js` first (`core_utils.js` reads `normalizeName` off it), then `core_utils.js`, then `multi-select.js`, then other tools, then `hotkeys.js`.
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

`choose()` takes two shapes:

- `choose(items, labelOf, buttonText)` → `items[] | null` — a plain checklist (`template-decouple.js`).
- `choose({ buildItems, labelOf, buttonText, toggles })` → `{ items, toggles } | null` — adds option checkboxes above the list. `buildItems(toggleState)` is a **callback, not an array**, because a toggle can change which items even qualify, so flipping one rebuilds the list rather than filtering it (`template-sync.js`).

Tick state is tracked as the set of *unticked* items keyed on identity, so an item surviving a rebuild keeps its state and newly-qualifying ones arrive ticked. Everything starts ticked in both shapes.

## Page bridge

`callBridge(op, payload, { timeout })` — default timeout is 3s. Ops that hit the network (`insert-template`, `list-templates`) pass 15s: a timeout there is worse than slow, because the insert still lands and orphans a copy in the document.

Ops: `ping` · `copy` · `paste-style` · `paste` · `delete` · `insert-template` · `list-templates` · `describe-tree` · `describe-selection` · `list-containers` · `list-template-widgets` · `history-start` / `history-end`.

`insert-template` takes optional placement: `intoId` appends inside that container, `afterId` lands the template directly after that element, neither means the end of the page. `import` can only append, so the `afterId` case imports into the anchor's parent and then moves the block into position (copy → paste at index → delete, the same shuffle as `replace-container`). The parent there is taken off the anchor object rather than through a second `getContainer` call — a top-level element's parent is the document container, which `getContainer` cannot resolve.

`describe-selection` reports the editor's current selection: id, name, type, `canHoldChildren`, parent, index. It tries `elementor.selection`, then the panel's edited element, then the navigator's editing row, and returns which one answered in `via` — the navigator alone would mean the tool only works with the navigator open. The document root is never a selection; some versions report it when nothing is selected, so a candidate with no parent is skipped.

`list-template-widgets` is the only op that reads a widget's `settings`. Everything else describes structure; the Template widget's whole identity is `settings.template_id`, so it needs its own walk.

`history-start`/`history-end` wrap a burst of `$e.run` calls in one undo step via `document/history/start-log`. Both degrade to no-ops (`logId: null`) rather than failing the caller.

## Template sync

`Tools/template-sync.js` — one click, no layer selection required. Lists site templates, reads the document's top-level containers, and for each container whose name matches a template title: inserts the template, pairs the two trees, copies styles node-by-node, then deletes the inserted copy in a `finally`.

- **Top-container names** come from the model (`settings._title`), not the navigator DOM — the navigator does not need to be open. A container that was never renamed reports `""` and simply never matches.
- **Name matching** is trimmed, whitespace-collapsed, case-insensitive. A title that resolves to two or more templates is dropped as ambiguous rather than guessed.
- **Tree pairing** (`ns.pairTrees`) aligns rather than marching in lockstep — see below.
- **Multi-root templates are normal, and each root is its own template.** Elementor saves whatever was selected, so a template's JSON often holds several top-level elements. Every root is handled independently, keyed on *that root's* layer name — so one saved template can act as a kit of named blocks. A root with no name falls back to the template's own title, which keeps ordinary single-root templates working unchanged. Do not reintroduce a single-root requirement.
- **Two-level matching.** A template enters the queue when its *title* matches some top container; the *root names* inside it then decide what each root actually styles. A root can therefore target a container other than the one that pulled its template in. A template whose title matches nothing is never fetched — that keeps the run to one insert per matched template instead of fetching the whole library.
- The whole run is one undo step, and `copy` clobbers Elementor's clipboard (same as the other tools).

### Nested matching

**Match nested containers** is a toggle in the confirm modal, off by default. Off, only top-level containers (`depth === 0`) can be targets. On, the whole page is searched, so a `TW Card` template styles every `TW Card` nested anywhere in the document.

- Nested candidates must match the template root's **name and type**. Top-level matching stays name-only on purpose: the candidate set there is tiny, and a type clash is more useful surfaced as a pairing failure than silently dropped.
- The toggle changes which *templates* qualify, not just which targets — a template whose title matches only a nested node is invisible when the toggle is off. That is why `choose` rebuilds its list from `buildQueue(toggleState)`.
- Nested targets are processed **outermost first** (sorted by `depth`).
- **Replace + nested needs the ancestor guard.** Replacing a container deletes its descendants, so any later target inside it has a stale id and the bridge would throw. `tally.replaced` plus `isDescendantOf` skips those with a warning. Styles mode needs no guard — nothing is deleted, so ids stay valid.
- Known gap: if an *inner* target is replaced before an outer one from a different template, the inner work is silently discarded. Depth sorting prevents this within a single root's target list, not across templates.

### Two operations, one pipeline

`template-sync.js` runs both `Ctrl+Shift+6` (style) and `Ctrl+Shift+7` (replace) through the same discovery pipeline — list templates, read top containers, match by name, insert once per template, walk roots. They differ only in the per-target action, selected via the `OPS` table:

- `OPS.styles` → `applyRootToTarget` — pairs the trees and pastes styles node by node.
- `OPS.replace` → `replaceRootIntoTarget` — calls the `replace-container` bridge op. No pairing at all: the template's structure wholesale becomes the page's, so nothing has to line up. **Destructive** — the page container's current content is deleted.

Add an operation by extending `OPS`, not by forking the pipeline.

`replace-container` does copy → paste-at-index → delete-target page-side in one op, so the parent lookup and index can't drift between round trips. The staging copy survives each replace, so one template can replace several targets before being cleaned up. It takes `sourceIds` (an array) as well as the original single `sourceId`, so a multi-root template drops all of its roots into the one slot, in order.

## Template decouple

`Tools/template-decouple.js` (`Ctrl+Shift+9`) unpicks Elementor Pro's **Template widget**: it swaps each widget for a copy of the template's own content, in place, so the content becomes ordinary editable elements that no longer track the template.

**This tool does not match on names.** The Template widget stores its target in `settings.template_id`, so the link is exact — titles appear in the UI as labels and nowhere else. That is the whole difference from `template-sync`, and it is why a failed `list-templates` call is non-fatal here: the run degrades to showing bare ids and carries on.

- **Placement** reuses `replace-container` rather than importing at a chosen index. The index is resolved page-side from the widget's own id at the moment of the swap, so earlier swaps shifting its siblings cannot misplace it. Two Template widgets sitting side by side in one container is the normal case, not an edge case.
- **Grouped by template, not by widget.** Several widgets routinely point at one template — three cards holding the same button, say. The template is inserted once as a staging copy, pasted into each target, and deleted in a `finally`. One network fetch per distinct template, not per widget.
- **Skip word** applies to the widget's own layer name, so a single widget can be held back without unticking it every run.
- **Nested Template widgets are left alone, by design.** Decoupled content can itself contain Template widgets; the run re-scans afterwards, reports anything carrying an id it hadn't seen before, and stops. A second keypress is safer than a recursive walk that a self-referencing template would send round forever.

Checklist labels are `"<template>" — inside "<parent>"`, which collides readily — three containers all named "Card" holding the same template read identically. Repeats are numbered `(2 of 3)` in document order so the rows can be told apart. Don't drop that: an ambiguous checklist is worse than no checklist, because unticking the wrong row is silent.

## Template insert

`Tools/template-insert.js` (`Ctrl+Shift+8`) is independent of name matching: it lists the whole library in a searchable modal with a checkbox per template, and inserts everything ticked at the end of the page — or at the current selection, see below. Insertion follows **tick order**, not list order, so the sequence is controllable. The whole batch is one undo step.

Each row shows the title, then author and last-modified date beneath it, with the template type on the right. Elementor's field names for those vary by version, so `list-templates` tries several candidates (`human_modified_date` → `human_date` → `modified` → `date`) and prefers the server's own preformatted string, which is already in the site's locale and timezone. It also returns `fields` — the raw key list from the first template — so a missing column can be diagnosed without guessing.

Search is multi-term over title, type *and* author — every whitespace-separated term must appear somewhere, in any order, so `hero prim` finds "TW Hero Primary". `Select shown` ticks everything currently matching; a ticked template hidden by a later search still counts toward the total and the status line says how many are hidden, so the count never looks wrong.

### Insert at the selection

A checkbox above the search box redirects the batch to whatever the editor has selected. **The selected element's type decides what "at" means** — a container takes the templates as its last children; anything else cannot hold children, so they land directly after it. The row spells out which of the two it will do, and the status line always ends with the destination (`→ inside "Hero"` / `→ end of page`) so it is readable without re-reading the checkbox.

- **Off by default.** Inserting at the end of the page is what this tool has always done, and the selection is only whatever happened to be clicked last — a silent redirect based on that would be a surprise.
- The selection is read **once, before the picker opens**, in the same `Promise.all` as the library fetch. The picker is a full-screen overlay, so the selection cannot change underneath it. A failed read is non-fatal: the option is simply not offered, and the modal says nothing is selected rather than showing a dead checkbox.
- **The anchor advances.** In the after-a-sibling case each insert re-anchors on the element it just created, so several templates keep their tick order instead of each one landing in front of the last. The inside-a-container case needs no such bookkeeping — appending is already in order.

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

## Panel: site template list

The panel has a **Site Templates** section — the same library as `template-insert.js`, but browsable outside the editor: search box, title + author/date + type per row, and an **Edit** button that opens that template in Elementor in a new tab.

- **The panel has no page bridge.** Only an editor tab holds Elementor's REST nonce, so the panel asks one: `browser.tabs.sendMessage` → the `runtime.onMessage` listener at the bottom of `core_utils.js` → `listSiteTemplates()`. That listener sits behind the file's `action=elementor` guard, so only editor tabs answer and the panel can take the first responder. No editor tab open ⇒ "No Elementor editor tab open — open one, then Refresh."
- `tab.url` is only populated where host permission is held, so the query filters on it when present and **broadcasts to every tab otherwise** — tabs without the listener just reject, which is the intended miss.
- **Edit URLs come from the Working Domain field**, not from the tab: `{origin}/wp-admin/post.php?post={templateId}&action=elementor`. Empty or unparseable domain ⇒ the button is disabled with a tooltip saying why, rather than opening a guessed URL. Editing the field re-renders the rows immediately.
- Tabs open in a **normal** browser window — the panel is a popup window and cannot hold tabs, so defaulting the `windowId` would misfire.
- A failed Refresh keeps the list that was already there and puts the error in the status line; only a panel that never loaded shows an empty state.

### Panel: Run buttons

Every row in the panel's Hotkeys list has a **Run** button beside it, so the tools are reachable without the keyboard. It rides the same `askElementorTab` bridge as the template list — `run-action` → the `runtime.onMessage` listener in `hotkeys.js` → the **same `runners` table the keydown handler uses**. Do not give the buttons their own dispatch: one entry point per action is what stops a button and its key from drifting.

- The reply reports that the run *started*, not that it finished. Tools draw their own modals and a template sync can take a minute; holding `sendMessage` open for that would time out the panel for no gain. Failures after dispatch land in the tool's own modal and the log.
- On success the panel **focuses the responding tab**. The panel is a separate popup window, so without this the tool's modal opens somewhere the user isn't looking and the click reads as dead.
- `askElementorTab` sorts active tabs first. A side-effectful run with two editors open should land in the one on screen; first-responder order was fine when the only message was a read.

### Dual-context files

`template-format.js` and `hotkey-defaults.js` are loaded **both** as content scripts and by `panel.html`, each assigning one global. That is the mechanism for anything the panel and the editor must agree on — template metadata rendering, the search predicate, and Edit-URL construction all live in `template-format.js` precisely because `panel.js`, `template-insert.js` and `overlay.js` would otherwise drift. Neither file may touch `location` or the DOM at load time.

## Tree alignment

`ns.pairTrees` diffs the two trees rather than requiring identical shapes, so an inserted or deleted layer no longer fails a whole container.

At each level the children are aligned by LCS in two passes: first on `type + name` (high confidence), then the remaining gaps on type alone, so a *renamed* layer still aligns while an *inserted* one becomes a gap. Aligned children recurse; unaligned ones are reported as `missing` (in the template, not on the page) or `extra` (on the page, not in the template) and are simply not styled.

Two hard failures remain:

- **Root type mismatch** — nothing below it is interpretable.
- **`MIN_MATCH_RATIO`** (0.5) — below half the nodes aligning, the two trees are not the same block, and styling the overlap would do more harm than refusing.

The ratio is `pairs / max(srcNodes, tgtNodes)` after subtracting **whole skipped subtrees from each side independently**. Counting a skipped branch's descendants would let the skip word push a container under the threshold — the opposite of what marking a branch means. There is a regression test for this in the session history; if you touch the ratio maths, re-check that a large skipped subtree leaves the ratio at 1.00.

Known characteristic: a *reordered* child reads as one `missing` plus one `extra` and is not styled. That is inherent to LCS and is the honest answer — a moved node cannot be distinguished from a delete plus an insert.

## Skip word

Any layer whose name contains the skip word is never restyled. Default `skip`, case-insensitive substring match, configurable in the panel; clearing the field to empty disables the feature. Stored as `skipWord` — `undefined` means "never set, use the default", `""` means "explicitly off", so the two are not interchangeable.

`ns.getSkipMatcher()` returns the predicate. It is honoured by **both** style-replacing tools: `template-sync.js` and `replace-styles.js` (simple and deep modes).

A skipped node yields no style pair **and exempts its whole subtree from structural comparison** — marking a branch `skip` means that branch is allowed to have diverged from the template, which is the point. Without that exemption a diverged branch would fail the whole container and the feature would be useless.

## Multi-select subsystem

`Tools/multi-select.js` is a shared subsystem — future tools should read from it, not reinvent selection. Shift+click on a `.elementor-navigator__element[data-id]` row toggles that layer into a plugin-only set, tinted blue via the `ElementorTools-selected` class. Shift+click within the navigator but not on a row clears the whole set. A `MutationObserver` re-applies the tint by `data-id` whenever Elementor re-renders the navigator (collapse/expand/etc), so selection survives DOM churn.

API (on `window.__ElementorTools.multiSelect`):

- `getIds()` → `string[]` of currently selected `data-id`s
- `has(id)` → boolean
- `clear()` — empty the set + strip tints
- `onChange(cb)` — cb receives a `Set<string>` snapshot; returns an unsubscribe fn
