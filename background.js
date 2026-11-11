// Clicking the toolbar icon opens the viewer so you can pick or drop a notebook.
const viewerUrl = chrome.runtime.getURL('viewer.html');

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: viewerUrl });
});

// First install: open the viewer, which shows the one-time setup steps.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.tabs.create({ url: viewerUrl });
});
