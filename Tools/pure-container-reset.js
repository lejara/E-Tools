(() => {
  if (!location.search.includes("action=elementor")) return;

  const ns = window.__ElementorTools;
  if (!ns) return;

  // Mirrors the DEFAULT_* pair in UI/panel.js. Both on by default: a stored
  // `undefined` means the option has never been touched, not that it was turned
  // off — the same distinction skipWord draws.
  const DEFAULT_PURE_CONTAINER_RESET = true;
  const DEFAULT_UNLINK_NEW_ELEMENTS = true;

  const KEYS = ["pureContainerReset", "unlinkNewElements"];
  const DEFAULTS = {
    pureContainerReset: DEFAULT_PURE_CONTAINER_RESET,
    unlinkNewElements: DEFAULT_UNLINK_NEW_ELEMENTS,
  };

  const enabledFrom = (key, value) =>
    value === undefined ? DEFAULTS[key] : !!value;

  // Both options live page-side, because they are a reaction to an Elementor
  // command rather than a request: $e.hooks fires inside the page world and a
  // content script cannot be on the other end of it. So this file's entire job
  // is to keep the page-world hook's flags in step with the panel.
  //
  // waitLimit 1, and no modal. This is not a network round trip — the rule in
  // CLAUDE.md is about operations the user is waiting on, and nobody is waiting
  // on a settings push. A lost one costs the feature until the next toggle,
  // which is why a re-arm buys nothing worth the wait.
  //
  // One op carries both flags because one hook serves both: pushing them
  // separately would let the page world sit briefly on a stale half of the pair.
  const push = async ({ enabled, unlinkNew }) => {
    const result = await ns.callBridge(
      "configure-pure-reset",
      { enabled, unlinkNew },
      { waitLimit: 1 },
    );
    if (!result.ok) {
      ns.log("warn", `New-element hook: could not reach it — ${result.error}`);
      return;
    }
    // Registration is reported once, on the call that actually attaches the
    // hook. A site whose Elementor has no hooks API says so here rather than
    // looking like a checkbox that silently does nothing.
    if (result.justRegistered) {
      // "containers", not "elements": both options are scoped to the user adding
      // a container, so a line promising to watch everything would misdescribe it.
      ns.log(
        "info",
        `Watching new containers — zero spacing: ${enabled ? "on" : "off"}, unlink fields: ${unlinkNew ? "on" : "off"}`,
      );
    }
    if (result.registerError) {
      ns.log(
        "warn",
        `New-element hook could not be registered — ${result.registerError}`,
      );
    }
  };

  const pushFromStorage = () =>
    browser.storage.local
      .get(KEYS)
      .then((state) =>
        push({
          enabled: enabledFrom("pureContainerReset", state.pureContainerReset),
          unlinkNew: enabledFrom("unlinkNewElements", state.unlinkNewElements),
        }),
      )
      .catch(() =>
        push({
          enabled: DEFAULT_PURE_CONTAINER_RESET,
          unlinkNew: DEFAULT_UNLINK_NEW_ELEMENTS,
        }),
      );

  // The work itself happens page-side, so the log line has to come back out. The
  // hook fires off an Elementor command rather than a bridge request, which is
  // why this listens for an unsolicited __event instead of reading a reply.
  //
  // One line per element, not one per drop: a drag that auto-creates a wrapper
  // and an inner container is two creates and therefore two writes, and rolling
  // them into a single line would hide the nested one — which is exactly the part
  // worth being able to see.
  const label = (data) => {
    const kind = data.kind || "element";
    return data.title
      ? `${kind} "${data.title}" (${data.id})`
      : `${kind} ${data.id}`;
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__ns !== ns.BRIDGE_NS) return;
    if (data.__event !== "pure-reset") return;

    if (data.error) {
      ns.log("warn", `${label(data)}: settings write failed — ${data.error}`);
      return;
    }
    // Nothing resolved at all. Not a failure, but not the intended outcome
    // either — on a container it means the control names moved in an Elementor
    // upgrade, which must not read as a silent success.
    const parts = [];
    if (data.zeroed) parts.push(`zeroed ${data.zeroed}`);
    if (data.unlinked) parts.push(`unlinked ${data.unlinked}`);
    if (!parts.length) {
      ns.log("warn", `${label(data)}: no matching controls found`);
      return;
    }
    ns.log("info", `${label(data)}: ${parts.join(", ")} field(s)`);
  });

  pushFromStorage();

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!KEYS.some((key) => changes[key])) return;
    // Re-read both rather than patching the changed one in: the two flags travel
    // together, and reading is cheaper than tracking a shadow copy of the pair.
    pushFromStorage();
  });
})();
