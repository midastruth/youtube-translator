function showBadge(tabId, text, color) {
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
  setTimeout(() => chrome.action.setBadgeText({ tabId, text:"" }), 2500);
}

chrome.action.onClicked.addListener(tab => {
  if (tab.id === undefined) return;

  chrome.tabs.sendMessage(tab.id, { action:"downloadVtt" }, response => {
    if (chrome.runtime.lastError) {
      showBadge(tab.id, "!", "#d93025");
      return;
    }
    if (response?.ok) {
      showBadge(tab.id, "✓", "#188038");
    } else {
      showBadge(tab.id, "!", "#d93025");
    }
  });
});
