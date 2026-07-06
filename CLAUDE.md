# Elementor Tool

Browser extension (MV3, Firefox) that adds tools to Elementor's WordPress editor.

## Structure: UI -> Tools

```
├── manifest.json        # MV3 manifest
├── background.js        # toolbar-icon click → opens UI/panel.html in a new window
├── hotkeys.js           # global keybindings (dispatches to tools)
├── UI/                  # extension-page window opened from the toolbar icon
│   ├── panel.html
│   └── panel.js         # reads browser.storage.local, re-renders on change
└── Tools/               # one self-contained tool per file
    ├── preview-override.js   # forces fixed widths on mobile/tablet preview
    └── layer-root-finder.js  # resolves the currently selected Elementor layer
```

- Content scripts load in this order: tools first, then `hotkeys.js`.
- Tools are independent — no shared globals across files. State reaches the panel window via `browser.storage.local` (e.g. `selectedLayer`).
- Add a new tool: drop a file into `Tools/`, append its path to `content_scripts[0].js` in `manifest.json`.
