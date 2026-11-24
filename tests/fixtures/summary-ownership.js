// Shared by the worker-side suites that follow an AI summary block from a
// worker save to what the popup does with it on the next open. The page must
// load ../shared.js, ../ai-cache.js, fixtures/chrome-mock.js and
// fixtures/sw-realm.js first: receipts live in the page's real IndexedDB and
// are read back with ai-cache.js's own functions, the ones the popup and the
// worker call.

async function pbpFixturePopupSummary({ service = "pinboard", account, url, notes, existingBookmark = null }) {
  const realm = await pbpSwRealm.loadRealmScripts([
    "shared.js",
    "ai-cache.js",
    "popup-ai.js",
  ]);
  const fields = {
    "description-input": { value: notes },
    "url-input": { value: url },
    "linkding-description-input": { value: "" },
  };
  const shown = [];
  realm.win.$id = (id) => fields[id] || null;
  realm.win.pbpPopupAiAccountIsCurrent = (candidate) => candidate === account;
  realm.win.pageInfo = { url };
  realm.win.existingBookmark = existingBookmark;
  realm.win.showSummaryActions = (fromCache) => shown.push(fromCache);
  realm.win.settings = { bookmarkService: service };
  realm.win.updateCharCount = () => {};
  realm.win.autoResizeTextarea = () => {};
  realm.win.pbpAiGetSummaryOwnership = (...args) => pbpAiGetSummaryOwnership(...args);

  return {
    field: fields["description-input"],
    shown,
    restore: () => realm.win._aiRestoreSummaryOwnership(account, url, null),
    regenerate: (summary) => realm.win.upsertSummary(summary),
    remove: () => realm.win.removeSummary(),
    // What this popup's save would hand the worker for the notes on screen.
    snapshot: () => realm.win.pbpAiSummaryOwnershipSnapshot(fields["description-input"].value),
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
