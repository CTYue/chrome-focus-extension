const DEFAULTS = { maxWindows: 1, maxTabs: 20, enabled: true };

async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
}

async function render() {
  const [settings, allWindows, currentTab] = await Promise.all([
    getSettings(),
    chrome.windows.getAll({ windowTypes: ['normal'] }),
    chrome.tabs.getCurrent(),
  ]);

  const normalWindows = allWindows.filter((w) => !w.incognito);
  const windowId = currentTab?.windowId ?? normalWindows[0]?.id;
  const tabs = windowId ? await chrome.tabs.query({ windowId }) : [];

  const windowCount = normalWindows.length;
  const tabCount = tabs.length;

  document.getElementById('enabledToggle').checked = settings.enabled;

  const wv = document.getElementById('windowCount');
  wv.textContent = windowCount;
  wv.className = 'stat-value' + (windowCount >= settings.maxWindows ? ' at-limit' : '');
  document.getElementById('windowLimit').textContent = `limit: ${settings.maxWindows}`;

  const tv = document.getElementById('tabCount');
  tv.textContent = tabCount;
  const tabLimitLabel = settings.maxTabs > 0 ? `limit: ${settings.maxTabs}` : 'unlimited';
  tv.className = 'stat-value' + (settings.maxTabs > 0 && tabCount >= settings.maxTabs ? ' at-limit' : '');
  document.getElementById('tabLimit').textContent = tabLimitLabel;
}

document.getElementById('enabledToggle').addEventListener('change', async (e) => {
  await chrome.storage.sync.set({ enabled: e.target.checked });
  await render();
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('mergeBtn').addEventListener('click', async () => {
  const btn = document.getElementById('mergeBtn');
  const status = document.getElementById('mergeStatus');

  btn.disabled = true;
  btn.textContent = 'Merging...';

  const result = await chrome.runtime.sendMessage({ action: 'mergeAllWindows' });

  btn.disabled = false;
  btn.textContent = 'Merge Windows';

  if (result.windowsMerged === 0) {
    status.textContent = 'Already a single window — nothing to merge.';
  } else {
    status.textContent = `Merged ${result.windowsMerged} window${result.windowsMerged > 1 ? 's' : ''} — tabs sorted by open time.`;
  }
  status.style.display = 'block';
  setTimeout(() => { status.style.display = 'none'; }, 3000);

  await render();
});

render();
