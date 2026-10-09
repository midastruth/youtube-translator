export {};

function showBadge(tabId: number, text: string, color: string) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text:"" }), 2500);
}

chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined) return;

  const tabId = tab.id;
  chrome.tabs.sendMessage(tabId, { action:"downloadVtt" }, (response: { ok?: boolean } | undefined) => {
    if (chrome.runtime.lastError) {
      showBadge(tabId, "!", "#d93025");
      return;
    }
    if (response?.ok) {
      showBadge(tabId, "✓", "#188038");
    } else {
      showBadge(tabId, "!", "#d93025");
    }
  });
});
