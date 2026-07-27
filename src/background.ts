// MV3 service worker. Registers the side panel + (future) notifications &
// cross-tab state coordination.
chrome.runtime.onInstalled.addListener(async (): Promise<void> => {
  console.log("[auction-helper] installed");
  try {
    // Clicking the toolbar action icon toggles the side panel.
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    // Register the panel page for all tabs.
    await chrome.sidePanel.setOptions({ path: "sidepanel.html" });
  } catch (error) {
    console.error("[auction-helper] side panel setup", error);
  }
});
