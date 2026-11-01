// Shared by the worker-side suites that follow an AI summary block from a
// worker save to what the popup does with it on the next open. The page must
// load ../shared.js and ../ai-cache.js first: receipts live in the page's real
// IndexedDB and are read back with ai-cache.js's own functions, the ones the
// popup and the worker call.

// The popup's real restore / Regenerate / Remove functions, sliced out of
// popup-ai.js. Only the form fields, the settings snapshot, the
// account-liveness check and UI side effects are stubbed. Opening without a
// cached summary is what an expired AI cache (or a summary made from another
// content source) looks like to the popup, so ownership can only come from
// records.
let _pbpFixturePopupAiSource = null;

async function pbpFixturePopupSummary({ service = "pinboard", account, url, notes, existingBookmark = null }) {
  _pbpFixturePopupAiSource ||= await (await fetch("../popup-ai.js")).text();
  const source = _pbpFixturePopupAiSource;
  const start = source.indexOf("function _aiUrlEquivalent");
  const end = source.indexOf('// Unified "no AI key"', start);
  if (start < 0 || end <= start) throw new Error("popup summary functions not found in popup-ai.js");
  const fields = {
    "description-input": { value: notes },
    "url-input": { value: url },
    "linkding-description-input": { value: "" },
  };
  const shown = [];
  const api = new Function(
    "$id", "pbpPopupAiAccountIsCurrent", "pageInfo", "existingBookmark",
    "showSummaryActions", "settings", "updateCharCount", "autoResizeTextarea",
    "let _linkdingDescriptionTouched = false;\n" + source.slice(start, end) +
    "\nreturn { _aiRestoreSummaryOwnership, upsertSummary, removeSummary };"
  )(
    (id) => fields[id] || null,
    (candidate) => candidate === account,
    { url },
    existingBookmark,
    (fromCache) => shown.push(fromCache),
    { bookmarkService: service },
    () => {},
    () => {}
  );
  return {
    field: fields["description-input"],
    shown,
    restore: () => api._aiRestoreSummaryOwnership(account, url, null),
    regenerate: (summary) => api.upsertSummary(summary),
    remove: () => api.removeSummary(),
  };
}

// Every record in the summary_owner_ pool (receipts and offline holds).
async function pbpFixtureSummaryOwnershipEntries() {
  const db = await _pbpAiOpenDB();
  const entries = await new Promise((resolve, reject) => {
    const request = db.transaction(_PBP_AI_STORE, "readonly").objectStore(_PBP_AI_STORE).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
  return entries.filter((entry) => _pbpAiIsSummaryOwnerKey(entry.key));
}

async function pbpFixtureClearSummaryOwnership() {
  for (const entry of await pbpFixtureSummaryOwnershipEntries()) await pbpAiCacheDelete(entry.key);
  if ((await pbpFixtureSummaryOwnershipEntries()).length) throw new Error("summary ownership records survived a clear");
}
