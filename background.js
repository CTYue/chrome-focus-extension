const DEFAULTS = {
  maxWindows: 1,
  maxTabs: 20,
  enabled: true,
  notifyBlocked: true,
};

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function getNormalWindows() {
  const all = await chrome.windows.getAll({ windowTypes: ['normal'] });
  return all.filter((w) => !w.incognito);
}

// ── Window / tab enforcement ──────────────────────────────────────────────────

// Redirect extra windows: move their tabs into the oldest existing window.
chrome.windows.onCreated.addListener(async (newWindow) => {
  if (newWindow.type !== 'normal' || newWindow.incognito) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  const normalWindows = await getNormalWindows();
  if (normalWindows.length <= settings.maxWindows) return;

  // Target = oldest window (lowest ID) that is not the new one.
  const targetWindow = normalWindows
    .filter((w) => w.id !== newWindow.id)
    .sort((a, b) => a.id - b.id)[0];

  if (!targetWindow) return;

  // Brief wait for the new window's tabs to finish initializing.
  await new Promise((resolve) => setTimeout(resolve, 150));

  const tabs = await chrome.tabs.query({ windowId: newWindow.id });
  const activeTab = tabs.find((t) => t.active) ?? tabs[0];

  let movedCount = 0;
  for (const tab of tabs) {
    try {
      await chrome.tabs.move(tab.id, { windowId: targetWindow.id, index: -1 });
      movedCount++;
    } catch (_) {
      // Tab may have already closed or moved — ignore.
    }
  }

  try {
    await chrome.windows.remove(newWindow.id);
  } catch (_) {
    // Window may have already closed — ignore.
  }

  await chrome.windows.update(targetWindow.id, { focused: true });

  // Switch to whichever tab was active in the blocked window.
  if (activeTab) {
    try {
      await chrome.tabs.update(activeTab.id, { active: true });
    } catch (_) {}
  }

  if (settings.notifyBlocked && movedCount > 0) {
    notify(
      'Window blocked',
      `Opened ${movedCount} tab${movedCount > 1 ? 's' : ''} in your existing window instead.`
    );
  }
});

// After a merge the target window may hold more tabs than maxTabs.
// This map remembers that post-merge count so those tabs are not
// treated as a violation — only truly new tabs beyond the baseline
// are blocked. The baseline is cleared once the user closes tabs
// back below maxTabs.
const mergeBaselines = new Map(); // windowId → tab count at merge time

// Enforce per-window tab limit.
chrome.tabs.onCreated.addListener(async (tab) => {
  // Never block the extension's own pages (options, popup).
  const url = tab.pendingUrl || tab.url || '';
  if (url.startsWith('chrome-extension://')) return;

  const settings = await getSettings();
  if (!settings.enabled || settings.maxTabs <= 0) return;

  const tabs = await chrome.tabs.query({ windowId: tab.windowId });
  const baseline = mergeBaselines.get(tab.windowId) ?? 0;
  const effectiveLimit = Math.max(settings.maxTabs, baseline);

  if (tabs.length <= effectiveLimit) return;

  try {
    await chrome.tabs.remove(tab.id);
  } catch (_) {
    // Tab may have already closed — ignore.
  }

  if (settings.notifyBlocked) {
    notify('Tab blocked', `Tab limit of ${settings.maxTabs} reached. Close a tab to open a new one.`);
  }

  await flashBadge();
});

// Once the user closes tabs below maxTabs the merge baseline is no longer needed.
chrome.tabs.onRemoved.addListener(async (_tabId, { windowId }) => {
  if (!mergeBaselines.has(windowId)) return;
  const settings = await getSettings();
  const tabs = await chrome.tabs.query({ windowId });
  if (tabs.length < settings.maxTabs) {
    mergeBaselines.delete(windowId);
  }
});

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}

async function flashBadge() {
  await chrome.action.setBadgeText({ text: '!' });
  await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  setTimeout(async () => {
    await chrome.action.setBadgeText({ text: '' });
  }, 2500);
}

// Keep badge clear when settings change.
chrome.storage.onChanged.addListener(async () => {
  await chrome.action.setBadgeText({ text: '' });
});

// Merge all normal windows into the oldest one, ordering tabs by creation time (tab ID).
async function mergeAllWindows() {
  const normalWindows = await getNormalWindows();
  if (normalWindows.length <= 1) return { windowsMerged: 0, tabsMoved: 0 };

  normalWindows.sort((a, b) => a.id - b.id);
  const targetWindow = normalWindows[0];

  // Collect every tab from every window, then sort by tab.id (ascending = creation order).
  const tabGroups = await Promise.all(
    normalWindows.map((w) => chrome.tabs.query({ windowId: w.id }))
  );
  const allTabs = tabGroups.flat().sort((a, b) => a.id - b.id);

  // Move each tab into the target window at the correct sequential position.
  let tabsMoved = 0;
  for (let i = 0; i < allTabs.length; i++) {
    try {
      await chrome.tabs.move(allTabs[i].id, { windowId: targetWindow.id, index: i });
      tabsMoved++;
    } catch (_) {
      // Tab may have closed mid-merge — ignore.
    }
  }

  // Close any now-empty extra windows.
  const windowsMerged = normalWindows.length - 1;
  for (const w of normalWindows.slice(1)) {
    try {
      await chrome.windows.remove(w.id);
    } catch (_) {}
  }

  await chrome.windows.update(targetWindow.id, { focused: true });

  // Record how many tabs ended up in the merged window so the tab-limit
  // listener can grandfather them in (tabs from merging are not violations).
  const finalTabs = await chrome.tabs.query({ windowId: targetWindow.id });
  const settings = await getSettings();
  if (finalTabs.length > settings.maxTabs) {
    mergeBaselines.set(targetWindow.id, finalTabs.length);
  }

  return { windowsMerged, tabsMoved };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'mergeAllWindows') {
    mergeAllWindows().then(sendResponse);
    return true;
  }
});
