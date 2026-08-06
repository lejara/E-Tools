// Loaded by UI/panel.html and Automation/automation.html. Neither window has a
// page bridge — they are extension pages, not editor pages — so anything that has
// to reach WordPress or Elementor is asked of a *tab* that can. This is that ask,
// in one place, because the panel and the Automation window would otherwise carry
// two copies of the ranking below and drift on which tab answers.
//
// Same dual-context mechanism as template-format.js, for the same reason.
(() => {
  // Returns { tab, reply } — which tab answered matters to the caller: run-action
  // has to bring that editor forward so the tool's own modal is visible, and the
  // Automation window reports the responder so a list fetched by the wrong route
  // is not mistaken for a broken endpoint.
  //
  // Two kinds of tab answer. An editor tab answers everything (core_utils.js,
  // hotkeys.js, automation-agent.js); a plain wp-admin tab answers list-templates
  // (Tools/admin-templates.js) and list-posts (Tools/wp-pages.js, which also runs
  // in the editor) but stays silent on run-action, so an editor-only message
  // simply falls through to the next candidate.
  const askElementorTab = async (message, { preferOrigin = "" } = {}) => {
    const tabs = await browser.tabs.query({});
    const urlOf = (t) => t.url || "";
    // tab.url is only populated where the extension holds host permission for
    // that tab; fall back to broadcasting rather than assuming it is there.
    const editors = tabs.filter((t) => urlOf(t).includes("action=elementor"));
    const admins = tabs.filter(
      (t) => !editors.includes(t) && urlOf(t).includes("/wp-admin/"),
    );
    // One ranking across both kinds of tab, not editors-as-a-block followed by
    // admins-as-a-block. Grouping first meant a background editor on any site
    // outranked the wp-admin tab in front of the user, so list-templates went
    // down the editor's page-bridge path while list-posts — which wp-pages.js
    // answers in either tab — went to the admin one. Same panel, two sources,
    // and only one of them failing.
    //
    //   origin  the Working Domain names the site being asked about, so another
    //           client's tab must never answer for it
    //   active  the tab in front of the user, which is the one they mean
    //   editor  a tiebreak only: it can service every message, including
    //           run-action, which an admin tab declines
    //
    // Ranking editor below active costs one declined message before run-action
    // finds its tab, and buys the panel agreeing with what is on screen.
    const matchesOrigin = (t) =>
      !!preferOrigin && urlOf(t).startsWith(`${preferOrigin}/`);
    const score = (t) =>
      (matchesOrigin(t) ? 4 : 0) +
      (t.active ? 2 : 0) +
      (editors.includes(t) ? 1 : 0);
    const known = [...editors, ...admins];
    const candidates = (known.length ? known : tabs.slice()).sort(
      (a, b) => score(b) - score(a),
    );
    for (const tab of candidates) {
      try {
        const reply = await browser.tabs.sendMessage(tab.id, message);
        if (reply) return { tab, reply };
      } catch (_) {
        // No content script listening in that tab — expected for most of them.
      }
    }
    return { tab: null, reply: null };
  };

  const focusTab = async (tab) => {
    if (!tab) return;
    try {
      await browser.tabs.update(tab.id, { active: true });
      if (tab.windowId !== undefined) {
        await browser.windows.update(tab.windowId, { focused: true });
      }
    } catch (_) {
      // The tab can be gone by now; the run itself already happened.
    }
  };

  // These windows live in a popup, which cannot hold tabs — a created tab has to
  // be put in a normal browser window rather than left to default to this one.
  // Returns the tab so a caller that intends to drive it (and close it) can.
  const openTab = async (url, { active = true, ownWindow = false, offset = 0 } = {}) => {
    // `ownWindow` is the automation run's path, and it is about THROTTLING, not
    // about tidiness. Firefox suspends requestAnimationFrame in hidden tabs and
    // Elementor builds its preview through rAF, so a background *tab* can simply
    // never finish loading — which reads as a slow site rather than as a stalled
    // one. Only the selected tab of a window counts as visible, so N concurrent
    // editors need N windows: putting them in one window would leave all but the
    // front one hidden and throttled, which is the situation being escaped.
    //
    // Unfocused so the run does not steal the keyboard, but deliberately NOT
    // minimized — a minimized window is hidden and throttles exactly like a
    // background tab. Staggered so they cannot land perfectly stacked, since a
    // fully occluded window can also be marked hidden (the automation browser
    // turns occlusion tracking off as well; this holds without it).
    if (ownWindow) {
      const win = await browser.windows.create({
        url,
        focused: false,
        state: "normal",
        width: 1280,
        height: 860,
        left: 60 + offset * 56,
        top: 60 + offset * 56,
      });
      return win?.tabs?.[0] || null;
    }
    const wins = await browser.windows.getAll({});
    const normal = wins.filter((w) => w.type === "normal");
    const target = normal.find((w) => w.focused) || normal[0];
    if (target) {
      const tab = await browser.tabs.create({
        url,
        windowId: target.id,
        active,
      });
      if (active) await browser.windows.update(target.id, { focused: true });
      return tab;
    }
    const win = await browser.windows.create({ url });
    return win?.tabs?.[0] || null;
  };

  const openInNewTab = (url) => openTab(url, { active: true });

  window.__TabBridge = { askElementorTab, focusTab, openTab, openInNewTab };
})();
