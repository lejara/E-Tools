const PANEL_URL = browser.runtime.getURL("UI/panel.html");

browser.action.onClicked.addListener(async () => {
  const wins = await browser.windows.getAll({ populate: true });
  for (const w of wins) {
    if (w.tabs && w.tabs.some((t) => t.url === PANEL_URL)) {
      await browser.windows.update(w.id, { focused: true });
      return;
    }
  }
  await browser.windows.create({
    url: PANEL_URL,
    type: "popup",
    width: 500,
    height: 820,
  });
});
