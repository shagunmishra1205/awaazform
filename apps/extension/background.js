// AwaazForm background worker.
// - The toolbar button shows or hides the widget on the current page (asking for access on sites other than forms).
// - It relays between the widget (an extension iframe) and the content script of the same tab. Using the
//   extension's own messaging, not window.postMessage, means the page's scripts can neither read nor fake it.

const FORM_SITES = /^https:\/\/(docs\.google\.com\/forms|forms\.office\.com|forms\.microsoft\.com|forms\.cloud\.microsoft)\//;

async function ensureContent(tab) {
  try {
    await chrome.tabs.sendMessage(tab.id, { awaazform: true, type: 'ping' });
    return true;
  } catch {
    if (!/^https?:/.test(tab.url || '')) return false;
    const origin = new URL(tab.url).origin + '/*';
    const granted = FORM_SITES.test(tab.url) || (await chrome.permissions.contains({ origins: [origin] }))
      || (await chrome.permissions.request({ origins: [origin] }).catch(() => false));
    if (!granted) return false;
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    return true;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id && (await ensureContent(tab))) chrome.tabs.sendMessage(tab.id, { awaazform: true, type: 'toggle' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || msg.awaazform !== 'tab' || !sender.tab?.id) return;
  // Only our own widget page may drive the content script.
  if (!sender.url?.startsWith(chrome.runtime.getURL('widget.html'))) return;
  chrome.tabs.sendMessage(sender.tab.id, { ...msg, awaazform: true }, { frameId: 0 })
    .then(respond)
    .catch((err) => respond({ ok: false, error: String(err?.message || err) }));
  return true;
});
