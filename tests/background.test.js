'use strict';

jest.useFakeTimers();

// ── Chrome API mock factory ──────────────────────────────────────────────────

function makeChrome() {
  return {
    windows: {
      onCreated: { addListener: jest.fn() },
      getAll:    jest.fn().mockResolvedValue([]),
      remove:    jest.fn().mockResolvedValue(undefined),
      update:    jest.fn().mockResolvedValue(undefined),
    },
    tabs: {
      onCreated: { addListener: jest.fn() },
      onRemoved: { addListener: jest.fn() },
      query:     jest.fn().mockResolvedValue([]),
      move:      jest.fn().mockResolvedValue(undefined),
      remove:    jest.fn().mockResolvedValue(undefined),
      update:    jest.fn().mockResolvedValue(undefined),
    },
    storage: {
      sync:      { get: jest.fn() },
      onChanged: { addListener: jest.fn() },
    },
    notifications: { create: jest.fn() },
    action: {
      setBadgeText:            jest.fn().mockResolvedValue(undefined),
      setBadgeBackgroundColor: jest.fn().mockResolvedValue(undefined),
    },
    runtime: {
      onMessage: { addListener: jest.fn() },
    },
  };
}

const DEFAULTS = { maxWindows: 1, maxTabs: 20, enabled: true, notifyBlocked: true };

// Shorthand builders
const mkWin = (id, extra = {}) => ({ id, type: 'normal', incognito: false, ...extra });
const mkTab = (id, windowId, extra = {}) => ({ id, windowId, active: false, ...extra });

// ── Test suite ───────────────────────────────────────────────────────────────

describe('background', () => {
  let onWindowCreated, onTabCreated, onTabRemoved, onMessage;

  beforeEach(() => {
    jest.resetModules();

    global.chrome = makeChrome();
    chrome.storage.sync.get.mockResolvedValue({ ...DEFAULTS });

    require('../background.js');

    // Capture registered listeners
    onWindowCreated = chrome.windows.onCreated.addListener.mock.calls[0][0];
    onTabCreated    = chrome.tabs.onCreated.addListener.mock.calls[0][0];
    onTabRemoved    = chrome.tabs.onRemoved.addListener.mock.calls[0][0];
    onMessage       = chrome.runtime.onMessage.addListener.mock.calls[0][0];
  });

  // Trigger mergeAllWindows through the message channel and await the result.
  function callMerge() {
    return new Promise((resolve) => {
      onMessage({ action: 'mergeAllWindows' }, {}, resolve);
    });
  }

  // ── Window limit ───────────────────────────────────────────────────────────

  describe('window limit enforcement', () => {
    // Helper: run the window-created handler to completion, flushing all
    // async steps and the internal 150 ms setTimeout in the right order.
    async function fireWindowCreated(newWindow) {
      const p = onWindowCreated(newWindow);
      await jest.runAllTimersAsync(); // drains microtasks, then fires the 150 ms timer
      await p;
    }

    test('skips popup-type windows', async () => {
      await onWindowCreated(mkWin(2, { type: 'popup' }));
      expect(chrome.windows.getAll).not.toHaveBeenCalled();
    });

    test('skips incognito windows', async () => {
      await onWindowCreated(mkWin(2, { incognito: true }));
      expect(chrome.windows.getAll).not.toHaveBeenCalled();
    });

    test('does nothing when Focus Mode is disabled', async () => {
      chrome.storage.sync.get.mockResolvedValue({ ...DEFAULTS, enabled: false });
      await onWindowCreated(mkWin(2));
      expect(chrome.windows.getAll).not.toHaveBeenCalled();
    });

    test('allows a window when within the configured limit', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1)]);

      await fireWindowCreated(mkWin(1));

      expect(chrome.tabs.move).not.toHaveBeenCalled();
      expect(chrome.windows.remove).not.toHaveBeenCalled();
    });

    test('moves tabs to the oldest window when limit is exceeded', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query.mockResolvedValue([mkTab(10, 2, { active: true }), mkTab(11, 2)]);

      await fireWindowCreated(mkWin(2));

      expect(chrome.tabs.move).toHaveBeenCalledWith(10, { windowId: 1, index: -1 });
      expect(chrome.tabs.move).toHaveBeenCalledWith(11, { windowId: 1, index: -1 });
    });

    test('closes the extra window after moving its tabs', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query.mockResolvedValue([mkTab(10, 2)]);

      await fireWindowCreated(mkWin(2));

      expect(chrome.windows.remove).toHaveBeenCalledWith(2);
    });

    test('focuses the target window and activates the originally-active tab', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query.mockResolvedValue([mkTab(10, 2, { active: true }), mkTab(11, 2)]);

      await fireWindowCreated(mkWin(2));

      expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
      expect(chrome.tabs.update).toHaveBeenCalledWith(10, { active: true });
    });

    test('sends a notification when notifyBlocked is enabled', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query.mockResolvedValue([mkTab(10, 2)]);

      await fireWindowCreated(mkWin(2));

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Window blocked' }),
      );
    });

    test('omits notification when notifyBlocked is disabled', async () => {
      chrome.storage.sync.get.mockResolvedValue({ ...DEFAULTS, notifyBlocked: false });
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query.mockResolvedValue([mkTab(10, 2)]);

      await fireWindowCreated(mkWin(2));

      expect(chrome.notifications.create).not.toHaveBeenCalled();
    });
  });

  // ── Tab limit ──────────────────────────────────────────────────────────────

  describe('tab limit enforcement', () => {
    test('never blocks extension own pages (options, popup)', async () => {
      // Even with 21 tabs already open, opening the options page must be allowed.
      const tabs = Array.from({ length: 21 }, (_, i) => mkTab(i + 1, 1));
      chrome.tabs.query.mockResolvedValue(tabs);

      await onTabCreated(mkTab(22, 1, { pendingUrl: 'chrome-extension://abcdef/options.html' }));

      expect(chrome.tabs.remove).not.toHaveBeenCalled();
    });

    test('does nothing when Focus Mode is disabled', async () => {
      chrome.storage.sync.get.mockResolvedValue({ ...DEFAULTS, enabled: false });
      await onTabCreated(mkTab(1, 1));
      expect(chrome.tabs.query).not.toHaveBeenCalled();
    });

    test('does nothing when maxTabs is 0 (unlimited)', async () => {
      chrome.storage.sync.get.mockResolvedValue({ ...DEFAULTS, maxTabs: 0 });
      await onTabCreated(mkTab(1, 1));
      expect(chrome.tabs.query).not.toHaveBeenCalled();
    });

    test('allows tabs within the limit', async () => {
      const tabs = Array.from({ length: 10 }, (_, i) => mkTab(i + 1, 1));
      chrome.tabs.query.mockResolvedValue(tabs);

      await onTabCreated(mkTab(10, 1));

      expect(chrome.tabs.remove).not.toHaveBeenCalled();
    });

    test('blocks a new tab when the limit is exceeded', async () => {
      const tabs = Array.from({ length: 21 }, (_, i) => mkTab(i + 1, 1));
      chrome.tabs.query.mockResolvedValue(tabs);

      await onTabCreated(mkTab(21, 1));

      expect(chrome.tabs.remove).toHaveBeenCalledWith(21);
    });

    test('sends a notification when a tab is blocked', async () => {
      const tabs = Array.from({ length: 21 }, (_, i) => mkTab(i + 1, 1));
      chrome.tabs.query.mockResolvedValue(tabs);

      await onTabCreated(mkTab(21, 1));

      expect(chrome.notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Tab blocked' }),
      );
    });
  });

  // ── Merge baseline ─────────────────────────────────────────────────────────

  describe('merge baseline', () => {
    test('onTabRemoved does nothing when no baseline exists for that window', async () => {
      await onTabRemoved(99, { windowId: 1 });
      expect(chrome.tabs.query).not.toHaveBeenCalled();
    });

    test('baseline allows tab creation up to the post-merge count', async () => {
      // Set up a merge that produces 25 tabs (above maxTabs=20) → baseline=25
      const w1 = Array.from({ length: 15 }, (_, i) => mkTab(i + 1, 1));
      const w2 = Array.from({ length: 10 }, (_, i) => mkTab(i + 16, 2));
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query
        .mockResolvedValueOnce(w1)
        .mockResolvedValueOnce(w2)
        .mockResolvedValueOnce([...w1, ...w2]); // final count = 25

      await callMerge();

      // 23 tabs (within baseline of 25) — should NOT be blocked
      chrome.tabs.query.mockResolvedValueOnce(
        Array.from({ length: 23 }, (_, i) => mkTab(i + 1, 1)),
      );
      await onTabCreated(mkTab(23, 1));

      expect(chrome.tabs.remove).not.toHaveBeenCalled();
    });

    test('baseline blocks tabs that exceed the post-merge count', async () => {
      const w1 = Array.from({ length: 15 }, (_, i) => mkTab(i + 1, 1));
      const w2 = Array.from({ length: 10 }, (_, i) => mkTab(i + 16, 2));
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query
        .mockResolvedValueOnce(w1)
        .mockResolvedValueOnce(w2)
        .mockResolvedValueOnce([...w1, ...w2]); // 25 tabs → baseline = 25

      await callMerge();

      // 26 tabs → exceeds baseline of 25 → must be blocked
      chrome.tabs.query.mockResolvedValueOnce(
        Array.from({ length: 26 }, (_, i) => mkTab(i + 1, 1)),
      );
      await onTabCreated(mkTab(26, 1));

      expect(chrome.tabs.remove).toHaveBeenCalledWith(26);
    });
  });

  // ── mergeAllWindows ────────────────────────────────────────────────────────

  describe('mergeAllWindows', () => {
    test('returns zero counts when only one window is open', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1)]);

      const result = await callMerge();

      expect(result).toEqual({ windowsMerged: 0, tabsMoved: 0 });
      expect(chrome.tabs.move).not.toHaveBeenCalled();
    });

    test('picks the window with the lowest ID as the merge target', async () => {
      // Windows arrive unsorted; window 1 should still be chosen.
      chrome.windows.getAll.mockResolvedValue([mkWin(3), mkWin(1), mkWin(2)]);
      chrome.tabs.query
        .mockResolvedValueOnce([mkTab(10, 1)]) // win 1
        .mockResolvedValueOnce([mkTab(20, 2)]) // win 2
        .mockResolvedValueOnce([mkTab(30, 3)]) // win 3
        .mockResolvedValueOnce([mkTab(10, 1), mkTab(20, 1), mkTab(30, 1)]); // final count

      await callMerge();

      const targetWindowIds = chrome.tabs.move.mock.calls.map(([, dest]) => dest.windowId);
      expect(targetWindowIds.every((id) => id === 1)).toBe(true);
    });

    test('sorts all tabs by ID (creation order) across windows', async () => {
      // Tab IDs interleaved: 10 & 30 in win1, 20 in win2.
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query
        .mockResolvedValueOnce([mkTab(10, 1), mkTab(30, 1)])
        .mockResolvedValueOnce([mkTab(20, 2)])
        .mockResolvedValueOnce([mkTab(10, 1), mkTab(20, 1), mkTab(30, 1)]);

      await callMerge();

      expect(chrome.tabs.move).toHaveBeenNthCalledWith(1, 10, { windowId: 1, index: 0 });
      expect(chrome.tabs.move).toHaveBeenNthCalledWith(2, 20, { windowId: 1, index: 1 });
      expect(chrome.tabs.move).toHaveBeenNthCalledWith(3, 30, { windowId: 1, index: 2 });
    });

    test('closes every extra window after merging', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2), mkWin(3)]);
      chrome.tabs.query
        .mockResolvedValueOnce([mkTab(1, 1)])
        .mockResolvedValueOnce([mkTab(2, 2)])
        .mockResolvedValueOnce([mkTab(3, 3)])
        .mockResolvedValueOnce([mkTab(1, 1), mkTab(2, 1), mkTab(3, 1)]);

      const result = await callMerge();

      expect(chrome.windows.remove).toHaveBeenCalledWith(2);
      expect(chrome.windows.remove).toHaveBeenCalledWith(3);
      expect(result.windowsMerged).toBe(2);
    });

    test('focuses the target window after the merge', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query
        .mockResolvedValueOnce([mkTab(1, 1)])
        .mockResolvedValueOnce([mkTab(2, 2)])
        .mockResolvedValueOnce([mkTab(1, 1), mkTab(2, 1)]);

      await callMerge();

      expect(chrome.windows.update).toHaveBeenCalledWith(1, { focused: true });
    });

    test('reports the correct tabsMoved count', async () => {
      chrome.windows.getAll.mockResolvedValue([mkWin(1), mkWin(2)]);
      chrome.tabs.query
        .mockResolvedValueOnce([mkTab(1, 1), mkTab(3, 1)])
        .mockResolvedValueOnce([mkTab(2, 2)])
        .mockResolvedValueOnce([mkTab(1, 1), mkTab(2, 1), mkTab(3, 1)]);

      const result = await callMerge();

      expect(result.tabsMoved).toBe(3);
    });
  });
});
