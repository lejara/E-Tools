const PANEL_URL = browser.runtime.getURL("UI/panel.html");
const AUTOMATION_URL = browser.runtime.getURL("Automation/automation.html");

// Focus the window if it is already open rather than stacking a second copy.
// Both of these windows hold state the user has set up — a Working Domain, a
// selection of pages, a run in progress — so a duplicate is never what was meant.
const openWindow = async (url, size) => {
  const wins = await browser.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.tabs && w.tabs.some((t) => t.url === url)) {
      await browser.windows.update(w.id, { focused: true });
      return;
    }
  }
  await browser.windows.create({ url, type: "popup", ...size });
};

browser.action.onClicked.addListener(() =>
  openWindow(PANEL_URL, { width: 500, height: 820 }),
);

// The single writer for the activity log. Every tool calls ns.log(), which sends
// its entry here instead of doing its own read-modify-write against
// browser.storage — three concurrent editor tabs during an automation run would
// otherwise drop whichever overlapping write lost the race, in the one log whose
// job is to record what failed while nobody was looking.
//
// Mirrors LOG_LIMIT in Tools/core_utils.js, which holds the fallback path. Change
// one, change both.
const LOG_LIMIT = 500;

let logChain = Promise.resolve();

const appendLog = (entry) => {
  // Chained rather than awaited in parallel: the point is that entry N+1's read
  // happens after entry N's write.
  logChain = logChain
    .then(async () => {
      const { logs = [] } = await browser.storage.local.get("logs");
      await browser.storage.local.set({
        logs: [entry, ...logs].slice(0, LOG_LIMIT),
      });
    })
    .catch(() => {});
  return logChain;
};

// The panel's entry button. Window creation stays here rather than in panel.js so
// the focus-or-create rule above has one implementation.
browser.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.__elementorTools !== true) return undefined;
  if (msg.type === "log-entry") {
    if (!msg.entry) return Promise.resolve({ ok: false });
    return appendLog(msg.entry).then(() => ({ ok: true }));
  }
  if (msg.type !== "open-automation") return undefined;
  // Wider than the panel: the Automation window shows two side-by-side pick
  // lists and a run log, which a 500px popup cannot hold.
  return openWindow(AUTOMATION_URL, { width: 900, height: 900 }).then(() => ({
    ok: true,
  }));
});
