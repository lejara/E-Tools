# Elementor Tool

Browser extension (MV3, Firefox) that adds hotkey-driven tools to Elementor's WordPress editor.

## Structure: UI -> Tools

```
├── manifest.json        # MV3 manifest
├── background.js        # toolbar-icon click → opens UI/panel.html
├── hotkeys.js           # global keybindings (dispatches to tools)
├── UI/                  # window opened from the toolbar icon
│   ├── panel.html
│   └── panel.js         # reads browser.storage.local, re-renders on change
└── Tools/               # one self-contained tool per file
    ├── preview-override.js   # forces fixed widths on mobile/tablet preview
    ├── core_utils.js         # shared helpers on window.__ElementorTools (log, selectLayerById, callBridge)
    ├── page-bridge.js        # injected into page world; runs Elementor $e commands via postMessage
    ├── multi-select.js       # shared subsystem: shift+click in navigator toggles blue-tint selection
    ├── layer-root-finder.js  # captures the currently selected Elementor layer
    ├── replace-styles.js     # copies source layer styles onto same-named descendants of root
    ├── replace-layer.js      # replaces same-named descendants of root with a copy of source layer
    └── batch-rename.js       # renames every multi-selected layer to one name (inline modal)
```

- Load order: `core_utils.js` first, then `multi-select.js`, then other tools, then `hotkeys.js`.
- Tools share `window.__ElementorTools` inside the editor page; cross-window state uses `browser.storage.local` (`selectedLayer`, `logs`).
- Hotkeys: `Ctrl+Shift+1` capture root layer · `Ctrl+Shift+2` replace styles · `Ctrl+Shift+3` replace layer · `Ctrl+Shift+4` batch rename · `Ctrl+Shift+5` reselect stored root.
- Add a tool: drop a file in `Tools/`, append its path to `content_scripts[0].js` in `manifest.json`.

## Multi-select subsystem

`Tools/multi-select.js` is a shared subsystem — future tools should read from it, not reinvent selection. Shift+click on a `.elementor-navigator__element[data-id]` row toggles that layer into a plugin-only set, tinted blue via the `ElementorTools-selected` class. Shift+click within the navigator but not on a row clears the whole set. A `MutationObserver` re-applies the tint by `data-id` whenever Elementor re-renders the navigator (collapse/expand/etc), so selection survives DOM churn.

API (on `window.__ElementorTools.multiSelect`):
- `getIds()` → `string[]` of currently selected `data-id`s
- `has(id)` → boolean
- `clear()` — empty the set + strip tints
- `onChange(cb)` — cb receives a `Set<string>` snapshot; returns an unsubscribe fn
