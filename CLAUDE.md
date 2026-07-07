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
    ├── core_utils.js         # shared helpers on window.__ElementorTools (log, selectLayerById)
    └── layer-root-finder.js  # captures the currently selected Elementor layer
```

- Load order: `core_utils.js` first, then other tools, then `hotkeys.js`.
- Tools share `window.__ElementorTools` inside the editor page; cross-window state uses `browser.storage.local` (`selectedLayer`, `logs`).
- Hotkeys: `Ctrl+Shift+1` capture selected layer · `Ctrl+Shift+4` reselect stored layer.
- Add a tool: drop a file in `Tools/`, append its path to `content_scripts[0].js` in `manifest.json`.
