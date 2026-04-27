const DEFAULTS = {
  maxWindows: 1,
  maxTabs: 20,
  enabled: true,
  notifyBlocked: true,
  autoCloseTabs: false,
  maxTabAgeHours: 48,
};

async function loadSettings() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  document.getElementById('enabled').checked = settings.enabled;
  document.getElementById('notifyBlocked').checked = settings.notifyBlocked;
  document.getElementById('maxWindows').value = settings.maxWindows;
  document.getElementById('maxTabs').value = settings.maxTabs;
  document.getElementById('autoCloseTabs').checked = settings.autoCloseTabs;
  document.getElementById('maxTabAgeHours').value = settings.maxTabAgeHours;
}

document.getElementById('saveBtn').addEventListener('click', async () => {
  const maxWindows = Math.max(1, parseInt(document.getElementById('maxWindows').value, 10) || 1);
  const maxTabs = Math.max(0, parseInt(document.getElementById('maxTabs').value, 10) || 0);
  const maxTabAgeHours = Math.max(1, parseInt(document.getElementById('maxTabAgeHours').value, 10) || 48);

  // Clamp values back to valid range and reflect in inputs.
  document.getElementById('maxWindows').value = maxWindows;
  document.getElementById('maxTabs').value = maxTabs;
  document.getElementById('maxTabAgeHours').value = maxTabAgeHours;

  await chrome.storage.sync.set({
    enabled: document.getElementById('enabled').checked,
    notifyBlocked: document.getElementById('notifyBlocked').checked,
    maxWindows,
    maxTabs,
    autoCloseTabs: document.getElementById('autoCloseTabs').checked,
    maxTabAgeHours,
  });

  const status = document.getElementById('saveStatus');
  status.classList.add('visible');
  setTimeout(() => status.classList.remove('visible'), 2000);
});

// Prevent typing invalid values in number inputs.
document.getElementById('maxWindows').addEventListener('change', (e) => {
  const v = parseInt(e.target.value, 10);
  e.target.value = isNaN(v) || v < 1 ? 1 : Math.min(v, 20);
});

document.getElementById('maxTabs').addEventListener('change', (e) => {
  const v = parseInt(e.target.value, 10);
  e.target.value = isNaN(v) || v < 0 ? 0 : Math.min(v, 500);
});

document.getElementById('maxTabAgeHours').addEventListener('change', (e) => {
  const v = parseInt(e.target.value, 10);
  e.target.value = isNaN(v) || v < 1 ? 1 : Math.min(v, 168);
});

loadSettings();
