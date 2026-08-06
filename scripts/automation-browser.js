// Launches a SECOND Firefox, dedicated to automation runs, with background-tab
// throttling switched off. Your everyday Firefox is not touched and its
// about:config is not edited — that was the whole reason for going this route.
//
// Why a separate browser at all: Firefox clamps setTimeout to >=1s in background
// tabs and suspends requestAnimationFrame in hidden ones. An automation run opens
// editors it is not looking at, so both apply, and neither can be turned off from
// inside an extension — prefs are a browser-level setting. web-ext can set them at
// launch, so the automation browser gets them and nothing else does.
//
// The profile lives OUTSIDE the repo on purpose. The repo sits in OneDrive, and a
// Firefox profile is a directory of live sqlite files — letting OneDrive sync it
// invites both corruption and a permanent upload loop.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.join(__dirname, "..");

// LOCALAPPDATA is the right home for this on Windows: machine-local, never roamed,
// never synced. The homedir fallback keeps the script runnable elsewhere.
const base =
  process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share");
const profileDir = path.join(base, "ElementorToolAutomation", "firefox-profile");

// Every one of these exists to stop Firefox from slowing down a tab it thinks
// nobody is looking at. Set at launch rather than written into the profile, so
// they are visible here rather than buried in a user.js nobody would find again.
const PREFS = [
  // The budget throttler: background tabs earn a timer "budget" and are throttled
  // hard once it runs out. Off entirely, and the budget uncapped as a belt-and-
  // braces second answer in case a future Firefox reads only one of them.
  "dom.timeout.enable_budget_timer_throttling=false",
  "dom.timeout.background_throttling_max_budget=-1",
  // The flat clamp that applies to background tabs regardless of budget: normally
  // 1000ms, which alone would stretch the readiness poll and every callBridge
  // deadline measured in the editor tab.
  "dom.min_background_timeout_value=0",
  "dom.min_background_timeout_value_without_budget_throttling=0",
  // Occlusion tracking marks a window "hidden" when another window fully covers
  // it — which would re-throttle the editor windows the run opens the moment
  // anything is stacked on top of them. This is what makes the one-window-per-
  // editor change reliable instead of dependent on how the windows happen to land.
  "widget.windows.window_occlusion_tracking.enabled=false",
];

const created = !fs.existsSync(profileDir);

const args = [
  "web-ext",
  "run",
  "--source-dir",
  root,
  "--firefox-profile",
  profileDir,
  // Run IN the profile rather than a throwaway copy of it, so the WordPress login,
  // the Edge Presets and the working domain all survive between runs. Safe here in
  // a way it would not be on a real profile: this directory exists only for this.
  "--profile-create-if-missing",
  "--keep-profile-changes",
  ...PREFS.flatMap((p) => ["--pref", p]),
  ...process.argv.slice(2),
];

console.log(`Profile: ${profileDir}${created ? "  (creating)" : ""}`);
if (created) {
  console.log(
    "First run: sign in to WordPress in this browser and set the Working Domain.\n" +
      "Both persist here, so you only do it once.",
  );
}
console.log("Throttling prefs applied:");
for (const p of PREFS) console.log(`  ${p}`);
console.log("");

const res = spawnSync("npx", args, {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
process.exit(res.status ?? 1);
