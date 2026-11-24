// Shared by the worker-side suites that follow an AI summary block from a
// worker save to what the popup does with it on the next open. The page must
// load ../shared.js, ../ai-cache.js, fixtures/chrome-mock.js and
// fixtures/sw-realm.js first: receipts live in the page's real IndexedDB and
// are read back with ai-cache.js's own functions, the ones the popup and the
// worker call.

const _pbpPopupSummaryPool = [];

async function _pbpCreatePopupSummarySlot() {
  const realm = await pbpSwRealm.loadRealmScripts([
    "shared.js",
    "ai-cache.js",
    "popup-ai.js",
  ]);
  realm.win.updateCharCount = () => {};
  realm.win.autoResizeTextarea = () => {};
  realm.win.pbpAiGetSummaryOwnership = (...args) => pbpAiGetSummaryOwnership(...args);
  const slot = { realm, busy: 0 };
  _pbpPopupSummaryPool.push(slot);
  return slot;
}

async function _pbpAcquireIdlePopupSummarySlot() {
  const idle = _pbpPopupSummaryPool.find((s) => s.busy === 0 && s.realm);
  if (idle) return idle;
  return _pbpCreatePopupSummarySlot();
}

async function pbpFixturePopupSummary({ service = "pinboard", account, url, notes, existingBookmark = null }) {
  // Ensure at least two idle slots exist when concurrent popups are constructed,
  // while keeping total live iframes bounded to the maximum concurrency (1-2).
  if (!_pbpPopupSummaryPool.some((s) => s.busy === 0 && s.realm)) {
    await _pbpCreatePopupSummarySlot();
  }
  const fields = {
    "description-input": { value: notes },
    "url-input": { value: url },
    "linkding-description-input": { value: "" },
  };
  const shown = [];
  const state = { range: null, value: "", checked: null };

  const mountOn = (realm) => {
    realm.win.$id = (id) => fields[id] || null;
    realm.win.pbpPopupAiAccountIsCurrent = (candidate) => candidate === account;
    realm.win.pageInfo = { url };
    realm.win.existingBookmark = existingBookmark;
    realm.win.showSummaryActions = (fromCache) => shown.push(fromCache);
    realm.win.settings = { bookmarkService: service };
    realm.set("_aiSummaryRange", state.range);
    realm.set("_aiSummaryValue", state.value);
    realm.set("_aiSummaryOwnershipChecked", state.checked);
  };

  const unmountFrom = (realm) => {
    state.range = realm.get("_aiSummaryRange");
    state.value = realm.get("_aiSummaryValue");
    state.checked = realm.get("_aiSummaryOwnershipChecked");
  };

  const runSyncOnIdleSlot = (fn) => {
    let slot = _pbpPopupSummaryPool.find((s) => s.busy === 0 && s.realm);
    if (!slot) throw new Error("no idle popup summary realm slot available; pre-warm pool before synchronous call");
    mountOn(slot.realm);
    try {
      return fn(slot.realm);
    } finally {
      unmountFrom(slot.realm);
    }
  };

  // Pre-warm a second slot whenever another slot is already present so an
  // in-flight restore() on popup A always leaves an idle slot for synchronous
  // snapshot()/regenerate()/remove() on popup B.
  if (_pbpPopupSummaryPool.filter((s) => s.realm).length < 2) {
    await _pbpCreatePopupSummarySlot();
  }

  return {
    field: fields["description-input"],
    shown,
    restore: async () => {
      const slot = await _pbpAcquireIdlePopupSummarySlot();
      slot.busy++;
      mountOn(slot.realm);
      try {
        return await slot.realm.win._aiRestoreSummaryOwnership(account, url, null);
      } finally {
        unmountFrom(slot.realm);
        slot.busy--;
      }
    },
    regenerate: (summary) => runSyncOnIdleSlot((r) => r.win.upsertSummary(summary)),
    remove: () => runSyncOnIdleSlot((r) => r.win.removeSummary()),
    // What this popup's save would hand the worker for the notes on screen.
    snapshot: () => runSyncOnIdleSlot((r) => r.win.pbpAiSummaryOwnershipSnapshot(fields["description-input"].value)),
    dispose: (opts = {}) => {
      const keep = opts && opts.removeIframe ? 0 : 2;
      for (let i = _pbpPopupSummaryPool.length - 1; i >= 0; i--) {
        const s = _pbpPopupSummaryPool[i];
        if (s.busy === 0 && s.realm && _pbpPopupSummaryPool.length > keep) {
          s.realm.dispose({ removeIframe: true });
          _pbpPopupSummaryPool.splice(i, 1);
        }
      }
    },
  };
}

// Every receipt and offline hold, by their literal key prefixes.
async function pbpFixtureSummaryOwnershipEntries() {
  const db = await _pbpAiOpenDB();
  const entries = await new Promise((resolve, reject) => {
    const request = db.transaction(_PBP_AI_STORE, "readonly").objectStore(_PBP_AI_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  return entries.filter((entry) => typeof entry.key === "string" &&
    (entry.key.startsWith("summary_owner_") || entry.key.startsWith("summary_hold_")));
}

async function pbpFixtureClearSummaryOwnership() {
  for (const entry of await pbpFixtureSummaryOwnershipEntries()) await pbpAiCacheDelete(entry.key);
  if ((await pbpFixtureSummaryOwnershipEntries()).length) throw new Error("summary ownership records survived a clear");
}
