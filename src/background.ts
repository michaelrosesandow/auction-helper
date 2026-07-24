// MV3 service worker. Will host notifications + cross-tab state coordination.
chrome.runtime.onInstalled.addListener((): void => {
  console.log("[auction-helper] installed");
});
