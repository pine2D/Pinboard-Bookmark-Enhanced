// ============================================================
// Pinboard Bookmark Enhanced - options-vocab.js
// Settings-side Google Drive sync (General), vocabulary export/Anki/Eudic
// sends (Vocabulary), and the two offline dictionary
// packs. The word LIST itself (search / filter / sort / selection / batch
// bar) lives on the standalone library page, in library-vocab.js.
// Every action here is scoped to ALL of the current Pinboard owner's rows,
// never to a UI selection, so nothing on this page needs the list's state.
// ============================================================

// var, not let: library-vocab.js declares these two names as well (its
// generation guard and the same status-flash timer). The pages never
// co-load, but tests/options-vocab-tests.html loads BOTH files, and a
// second top-level `let` of the same name is a SyntaxError that kills the
// whole script.
var _vocabRenderGen = 0; // guards stale async renders (account switch mid-fetch)
var _vocabFlashTimer = 0; // guards two flashes racing to clear each other's text early
const _vocabLocalFlashTimers = new Map();
let _vocabDriveBusy = false;
let _driveRenderGen = 0;
let _driveVisibleOwner = null;
let _vocabDriveActionSeq = 0;
// Sentences currently painted in #vocab-drive-error, so a response can add
// its own failure over the status render without repeating a line.
let _driveErrorLines = [];
// The pending Connect's authorization phase (spec §5.4), or null.
let _driveAuthorizing = null;
const PBP_VOCAB_GOOGLE_API_ORIGIN = "https://www.googleapis.com/*";
const PBP_VOCAB_DRIVE_AUTH_SLOW_MS = 15000;
// Connection-layer codes (spec §3.2). vocab-gdrive.js holds the worker's copy
// (PBP_DRIVE_CONNECTION_ERRORS); this page never loads that file, so it keeps
// its own -- a deliberate twin across isolated script contexts.
const _PBP_DRIVE_UI_CONNECTION_CODES = new Set(["auth", "permission", "network", "rate_limited", "server"]);
// Control-flow answers that mean "nothing ran", never "something failed".
const _PBP_DRIVE_UI_SILENT_CODES = new Set(["not_connected", "waiting_for_retry"]);

// Verbatim twin: options-vocab.js and library-vocab.js each carry this
// helper (the pages never co-load, and since the phase-A test split neither
// does the test suite -- tests/ui-contract-tests.mjs statically asserts the
// two definitions stay byte-identical, so an edit to one without the other
// fails that check instead of silently drifting).
function _pbpVocabFlashStatus(ok, text) {
  const el = $id("vocab-status");
  if (!el) return;
  delete el.dataset.vocabLoading;
  setStatusIcon(el, ok, text);
  // Two flashes in quick succession (e.g. export then Anki) must not race:
  // the earlier call's clear-timer would otherwise wipe the later message.
  // A failure is a recovery instruction, often two sentences: it stays until
  // the next message replaces it instead of timing out mid-read.
  clearTimeout(_vocabFlashTimer);
  if (ok) _vocabFlashTimer = setTimeout(() => { el.textContent = ""; }, 3000);
}



// Eudic is a Chinese-market product behind a token the user has to fetch by
// hand, but "en" is one of its supported languages, so the language test alone
// showed the button to anyone who had ever saved an English word -- and it
// then failed on dictEudicTokenRequired. Reading the token here would need an
// await in a render path, so presence is cached and refreshed on the same
// signals that already invalidate this panel. The token FIELD in settings
// stays visible either way; that is where the feature is meant to be found.
let _vocabEudicConfigured = false;

async function _pbpVocabRefreshEudicConfigured() {
  try {
    const s = await pbpReadSettingsWithSecrets({ dictEudicToken: SETTINGS_DEFAULTS.dictEudicToken });
    _vocabEudicConfigured = !!(s && s.dictEudicToken);
  } catch (_) { _vocabEudicConfigured = false; }
}

// Reads the owner's rows itself now that the rendered list lives on another
// page. Fail-closed: any read failure leaves the button hidden rather than
// offering a send that would have nothing to send.
async function _pbpVocabUpdateExternalActions() {
  const eudicBtn = $id("vocab-eudic-btn");
  if (!eudicBtn) return;
  let rows = [];
  try {
    rows = await pbpVocabAll(await pbpVocabCurrentOwner());
  } catch (_) {
    eudicBtn.hidden = true;
    return;
  }
  // External sends intentionally stay scoped to ALL current-owner rows,
  // never a UI selection or a search result.
  eudicBtn.hidden = !_vocabEudicConfigured
    || typeof pbpEudicPartition !== "function"
    || pbpEudicPartition(rows).byLang.size === 0;
}


function _pbpVocabDriveClear() {
  const clearNotices = $id("vocab-drive-clear-notices");
  const noticeRow = clearNotices?.closest(".vocab-drive-notice-row");
  if (noticeRow) noticeRow.hidden = true;
  for (const id of [
    "vocab-drive-state", "vocab-drive-account", "vocab-drive-owner",
    "vocab-drive-last-success", "vocab-drive-error", "vocab-drive-notices",
    "vocab-drive-action-status"
  ]) {
    const el = $id(id);
    if (el) {
      el.replaceChildren();
      el.classList.remove("ok", "bad");
    }
  }
  _driveErrorLines = [];
  const fields = $id("vocab-drive-fields");
  if (fields) fields.hidden = true;
  for (const id of ["vocab-drive-connect", "vocab-drive-sync", "vocab-drive-disconnect"]) {
    const button = $id(id);
    if (button) button.hidden = true;
  }
}

function _pbpVocabDriveDate(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  try {
    const locale = typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : undefined;
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium", timeStyle: "short"
    }).format(new Date(value));
  } catch (_) {
    return new Date(value).toLocaleString();
  }
}

// Counts sit inside sentences that come from t(), i.e. the extension UI
// language, so their digit grouping follows the same locale the date above
// does -- a bare toLocaleString() would take the browser's instead and put
// two typographic systems in one line. uiLangToBCP47() ends in split("-")[0]
// over an arbitrary stored tag, so a malformed one can reach Intl and throw:
// fall back to the browser default rather than losing the whole panel render.
function _pbpVocabNum(value) {
  const n = Number.isFinite(value) ? value : 0;
  try {
    const locale = typeof uiLangToBCP47 === "function" ? uiLangToBCP47() : undefined;
    return n.toLocaleString(locale);
  } catch (_) {
    return n.toLocaleString();
  }
}

function _pbpVocabDriveErrorKey(code) {
  return ({
    auth: "vocabDriveErrorAuth",
    pinboard_auth: "vocabDriveErrorPinboardAuth",
    permission: "vocabDriveErrorPermission",
    corrupt: "vocabDriveErrorCorrupt",
    local_store: "vocabDriveErrorLocalStore",
    network: "vocabDriveErrorNetwork",
    rate_limited: "vocabDriveErrorBusy",
    server: "vocabDriveErrorBusy",
    account_changed: "vocabDriveErrorAccountChanged",
    entry_too_large: "vocabDriveErrorEntryTooLarge",
    // An uncaught exception in this device's run, not a Drive failure (spec §10.9).
    unexpected: "vocabDriveErrorUnexpected",
    status_unavailable: "vocabDriveStatusFailed"
  })[code] || "vocabDriveErrorRemote";
}

function _pbpVocabDriveAvailable() {
  try {
    return pbpVocabDriveOAuthActive(chrome.runtime.getManifest());
  } catch (_) {
    return false;
  }
}

function _pbpVocabDriveRenderUnavailable() {
  _pbpVocabDriveClear();
  const actions = $id("vocab-drive-actions");
  if (actions) actions.hidden = true;
  const state = $id("vocab-drive-state");
  if (state) state.textContent = t("vocabDriveUnavailable");
  _pbpVocabDriveSetBusy(false);
}

// One error-area sentence (spec §6.1 display matrix). `scope` null means the
// shared connection layer, a control-flow answer or an unattributed failure:
// no dataset subject (A27).
function _pbpVocabDriveErrorText(code, { retryAt = null, blocked = false, connected = false, scope = null } = {}) {
  let key = _pbpVocabDriveErrorKey(code);
  if (scope === "notes" && code === "entry_too_large") key = "driveNotesErrorEntryTooLarge";
  // Connected, Connect is hidden and Sync now is the way on; the disconnected
  // sentence ("…then connect again") stays for the state that shows Connect.
  if (code === "pinboard_auth" && connected) key = "vocabDriveErrorPinboardAuthSync";
  const parts = [t(key)];
  // A blocked state never retries on its own, so a retryAt next to it is
  // leftover backoff history, not a promise.
  const retry = blocked ? "" : _pbpVocabDriveDate(retryAt);
  if (retry) parts.push(t("vocabDriveRetryAt", retry));
  // Every state that cannot proceed on its own names a button that is on
  // screen. A refused Google grant -- a missing permission at any time, auth
  // past the retry budget -- is repaired by Connect, which the render shows
  // beside Sync now while connected (spec §5.3); Disconnect is never the
  // exit. Other blocks clear only through a forced run: Sync now while
  // connected, Connect (which force-syncs) while disconnected. Anything
  // still retrying already shows its next-retry time and needs no order.
  if (code === "permission" || (blocked && code === "auth")) {
    parts.push(t("vocabDriveConnectRequired"));
  } else if (blocked && code !== "entry_too_large") {
    parts.push(t(connected ? "vocabDriveSyncNowRequired" : "vocabDriveConnectRequired"));
  }
  const message = parts.join(" ");
  if (!scope) return message;
  return t(scope === "notes" ? "driveNotesStatus" : "driveVocabularyStatus", message);
}

// The only writer of #vocab-drive-error. Identical sentences collapse to one,
// each line keeps its own status icon, and the unsent-changes note closes the
// area only when there is an error or backoff to explain it -- no exact
// count, because frozen batches leave the outbox (spec §6.1, F10/UX-8).
function _pbpVocabDrivePaintErrors(lines, status) {
  _driveErrorLines = [...new Set(lines.filter(Boolean))];
  const el = $id("vocab-drive-error");
  if (!el) return;
  el.replaceChildren();
  el.classList.remove("ok", "bad");
  if (!_driveErrorLines.length) return;
  setStatusIcon(el, false, _driveErrorLines[0]);
  for (const line of _driveErrorLines.slice(1)) {
    const next = document.createElement("span");
    setStatusIcon(next, false, line);
    el.append(document.createElement("br"), ...next.childNodes);
  }
  if (status?.hasPending === true) {
    el.append(document.createElement("br"), document.createTextNode(t("drivePendingChanges")));
  }
}

function _pbpVocabDriveShowError(code, retryAt, blocked, connected, scope) {
  _pbpVocabDrivePaintErrors([_pbpVocabDriveErrorText(code, {
    retryAt, blocked: blocked === true, connected: connected === true, scope: scope || null
  })], null);
}

// Status lines while connected: the shared connection record without a
// subject, then each dataset's own data-layer failure with its subject. A
// connection code inside a dataset row is legacy preflight state the worker
// must not report (spec §3.3 contract 5); it is ignored, never re-labelled.
function _pbpVocabDriveStatusLines(status) {
  if (status?.connected !== true) return [];
  const lines = [];
  const connection = status.connection || {};
  if (connection.lastError) {
    lines.push(_pbpVocabDriveErrorText(connection.lastError, {
      retryAt: connection.retryAt, blocked: connection.blocked === true, connected: true
    }));
  }
  for (const scope of ["vocabulary", "notes"]) {
    const row = status[scope];
    if (!row?.lastError || _PBP_DRIVE_UI_CONNECTION_CODES.has(row.lastError)) continue;
    lines.push(_pbpVocabDriveErrorText(row.lastError, {
      retryAt: row.retryAt, blocked: row.blocked === true, connected: true, scope
    }));
  }
  return lines;
}

// One sentence for both datasets (the dismiss button already clears both).
// noticeTerms only ever holds vocabulary terms (UX-7), so it is named only
// when vocabulary itself has a conflict.
function _pbpVocabDriveNoticeText(status) {
  const vocabulary = Math.max(0, Number(status?.vocabulary?.notices) || 0);
  const notes = Math.max(0, Number(status?.notes?.notices) || 0);
  if (!vocabulary && !notes) return "";
  let text = t("driveNotices", _pbpVocabNum(vocabulary + notes));
  const terms = vocabulary && Array.isArray(status.noticeTerms)
    ? status.noticeTerms.filter((term) => typeof term === "string" && term) : [];
  if (terms.length) text += " " + t("driveNoticeTerms", _pbpVocabTermList(terms));
  return text;
}

function _pbpVocabDriveSetBusy(busy, focusOwner, phaseKey) {
  _vocabDriveBusy = !!busy;
  const body = $id("vocab-drive-body");
  if (body) body.setAttribute("aria-busy", String(_vocabDriveBusy));
  // A first sync can page through Drive for minutes. Without this the state
  // line keeps whatever it said before -- usually "not connected" -- for the
  // whole run, so the panel reads as if the click did nothing. Only written
  // while busy; _pbpVocabDriveRender owns the line the rest of the time.
  // The authorization phase needs its own line: getAuthToken({interactive})
  // opens a Chrome sign-in or consent window and waits indefinitely, so the
  // panel sits busy until the user acts in a DIFFERENT window. Saying "syncing"
  // there reads as a hang and hides the fact that it is their move.
  const state = $id("vocab-drive-state");
  if (state && _vocabDriveBusy) {
    state.classList.remove("ok", "bad");
    state.textContent = t(phaseKey || "vocabDriveWorking");
  }
  for (const id of ["vocab-drive-connect", "vocab-drive-sync", "vocab-drive-disconnect"]) {
    const button = $id(id);
    if (!button) continue;
    const keepFocused = _vocabDriveBusy && button === focusOwner;
    button.disabled = _vocabDriveBusy && !keepFocused;
    if (keepFocused) button.setAttribute("aria-disabled", "true");
    else button.removeAttribute("aria-disabled");
  }
}

function _pbpVocabDriveRender(status) {
  if (!_pbpVocabDriveAvailable()) {
    _pbpVocabDriveRenderUnavailable();
    return;
  }
  _pbpVocabDriveClear();
  _driveVisibleOwner = typeof status?.owner === "string"
    ? pbpDictOwnerScope(status.owner) : null;
  const actions = $id("vocab-drive-actions");
  if (actions) actions.hidden = false;
  const connected = status?.connected === true;
  const connection = status?.connection || {};
  // A grant Google itself refused -- a missing permission at any time, or
  // auth past the retry budget -- is repaired by Connect, so Connect joins
  // Sync now and Disconnect while connected (spec §5.3) instead of the old
  // "disconnect, then reconnect" detour.
  const authNeeded = connected && (connection.lastError === "permission"
    || (connection.lastError === "auth" && connection.blocked === true));
  const state = $id("vocab-drive-state");
  const connect = $id("vocab-drive-connect");
  const sync = $id("vocab-drive-sync");
  const disconnect = $id("vocab-drive-disconnect");
  if (connect) connect.hidden = connected && !authNeeded;
  if (sync) sync.hidden = !connected;
  if (disconnect) disconnect.hidden = !connected;
  // The line describes the connection, not a combined sync result. Errors
  // below stay visible, and a partial run never paints overall success.
  if (state) state.textContent = t(!connected ? "vocabDriveDisconnected"
    : authNeeded ? "vocabDriveAuthNeeded" : "vocabDriveConnected");
  if (!connected) {
    _pbpVocabDriveSetBusy(false);
    return;
  }

  const fields = $id("vocab-drive-fields");
  if (fields) fields.hidden = false;
  const email = String(status.emailAddress || "");
  const displayName = String(status.displayName || "");
  const account = $id("vocab-drive-account");
  if (account) account.textContent = displayName && email
    ? `${displayName} (${email})` : (displayName || email);
  const owner = $id("vocab-drive-owner");
  if (owner) owner.textContent = String(status.owner || "") || t("vocabOwnerNoAccount");
  // One row for both datasets: the worker reports the EARLIER of the two
  // lastSuccessAt values, null while either has never synced -- "both were in
  // sync as of this time".
  const lastSuccess = $id("vocab-drive-last-success");
  if (lastSuccess) lastSuccess.textContent = _pbpVocabDriveDate(status.lastSuccessAt) || t("vocabDriveNever");
  const noticeText = _pbpVocabDriveNoticeText(status);
  const notices = $id("vocab-drive-notices");
  if (notices) {
    notices.textContent = noticeText;
    notices.classList.toggle("bad", !!noticeText);
  }
  const noticeRow = $id("vocab-drive-clear-notices")?.closest(".vocab-drive-notice-row");
  if (noticeRow) noticeRow.hidden = !noticeText;
  _pbpVocabDrivePaintErrors(_pbpVocabDriveStatusLines(status), status);
  _pbpVocabDriveSetBusy(false);
}

// A connection-layer failure the worker answered but the status does not
// carry (yet) still decides the buttons: "permission" names Connect, so the
// render must show Connect even while connected.
function _pbpVocabDriveWithResponseConnection(status, response) {
  const code = response?.ok === false ? response.error : null;
  if (!status || !_PBP_DRIVE_UI_CONNECTION_CODES.has(code) || status.connection?.lastError) return status;
  return { ...status, connection: { lastError: code, retryAt: null, blocked: false } };
}

// Lines a response adds over its status (spec §6.2). Data-layer results carry
// their dataset's subject; the top-level code is the connection layer, a
// control-flow answer or an unattributed failure and never borrows a dataset
// subject. A top-level code a dataset result already reported is that same
// failure and is not repeated.
function _pbpVocabDriveResponseLines(response, status) {
  const connected = status?.connected === true;
  const lines = [];
  const reported = new Set();
  for (const scope of ["vocabulary", "notes"]) {
    const result = response?.results?.[scope];
    const code = result && result.ok !== true ? result.error : null;
    if (!code || _PBP_DRIVE_UI_SILENT_CODES.has(code) || _PBP_DRIVE_UI_CONNECTION_CODES.has(code)) continue;
    reported.add(code);
    const row = status?.[scope]?.lastError === code ? status[scope] : null;
    lines.push(_pbpVocabDriveErrorText(code, {
      retryAt: row?.retryAt, blocked: row?.blocked === true, connected, scope
    }));
  }
  const code = response?.error;
  if (code && !_PBP_DRIVE_UI_SILENT_CODES.has(code) && !reported.has(code)) {
    const connection = status?.connection?.lastError === code ? status.connection : null;
    lines.push(_pbpVocabDriveErrorText(code, {
      retryAt: connection?.retryAt, blocked: connection?.blocked === true, connected
    }));
  }
  return lines;
}

function _pbpVocabDriveApplyResponse(response, fallbackStatus) {
  const status = _pbpVocabDriveWithResponseConnection(response?.status || fallbackStatus || null, response);
  if (status) _pbpVocabDriveRender(status);
  if (!response || response.ok) return status;
  const lines = _pbpVocabDriveResponseLines(response, status);
  if (lines.length) _pbpVocabDrivePaintErrors([..._driveErrorLines, ...lines], status);
  return status;
}

// Every awaited response rechecks the non-secret owner as well as the local
// render/action generations. Storage notifications alone can arrive after a
// message response and cannot guard that final UI commit.
async function _pbpVocabDriveCurrent(gen, actionSeq, owner, status) {
  if (gen !== _driveRenderGen || (actionSeq && actionSeq !== _vocabDriveActionSeq)) return false;
  try {
    const currentOwner = await pbpVocabCurrentOwner();
    if (gen !== _driveRenderGen || (actionSeq && actionSeq !== _vocabDriveActionSeq)) return false;
    if (owner !== currentOwner) {
      invalidateDriveSyncPanel();
      return false;
    }
    return !status?.owner || pbpDictOwnerScope(status.owner) === currentOwner;
  } catch (error) {
    console.warn("[drive] account check failed:", error?.name, error?.message);
    return false;
  }
}

// Normalizes one action answer and paints it. A worker-side catch answers
// {ok:false,error:"remote"} with no status, and a thrown sendMessage answers
// nothing at all; either way the panel re-reads status under the same
// generation/action/owner guards and lays this failure over the fresh render
// (UX-6) instead of leaving the pre-action render with one generic line.
// When that re-read fails too, the pre-action render must still go: a
// finished Disconnect is known to have left the device disconnected, and any
// other action falls back to the failed-status view with a retry, never the
// busy "syncing…" line nothing would rewrite.
async function _pbpVocabDriveSettle(response, gen, actionSeq, owner, type) {
  if (!response || typeof response !== "object") response = { ok: false, error: "remote" };
  if (!(await _pbpVocabDriveCurrent(gen, actionSeq, owner, response.status))) return null;
  let fresh = null;
  if (!response.status) {
    try {
      const read = await chrome.runtime.sendMessage({ type: "vocabDriveStatus" });
      if (!(await _pbpVocabDriveCurrent(gen, actionSeq, owner, read?.status))) return null;
      if (read?.ok && read.status) fresh = read.status;
    } catch (error) {
      console.warn("[drive] status re-read failed:", error?.name, error?.message);
      if (gen !== _driveRenderGen || (actionSeq && actionSeq !== _vocabDriveActionSeq)) return null;
    }
  }
  if (!response.status && !fresh) {
    if (type === "vocabDriveDisconnect" && response.ok === true) {
      _pbpVocabDriveRender({ connected: false });
      // The render scopes a raw status owner; this one is already scoped.
      _driveVisibleOwner = typeof owner === "string" ? owner : null;
    } else {
      _pbpVocabDriveClear();
      const state = $id("vocab-drive-state");
      if (state) state.textContent = t("vocabDriveStatusFailed");
      _pbpVocabDrivePaintErrors(response.ok ? [] : _pbpVocabDriveResponseLines(response, null), null);
      _pbpVocabDriveOfferRetry();
    }
    return response;
  }
  _pbpVocabDriveApplyResponse(response, fresh);
  return response;
}

// The status read is the only thing that un-hides the action row, so when it
// fails the panel is left with an error and no button at all -- the container
// ships hidden and _pbpVocabDriveClear re-hides all three on every render.
// Offer Connect: with the grant already in place it resolves immediately and
// force-syncs, so it doubles as the retry this panel otherwise lacks.
function _pbpVocabDriveOfferRetry() {
  const actions = $id("vocab-drive-actions");
  if (actions) actions.hidden = false;
  const connect = $id("vocab-drive-connect");
  if (connect) connect.hidden = false;
  _pbpVocabDriveSetBusy(false);
}

async function _pbpVocabDriveRefresh(gen) {
  if (!_pbpVocabDriveAvailable()) {
    _pbpVocabDriveRenderUnavailable();
    return;
  }
  const loading = $id("vocab-drive-state");
  if (loading) loading.textContent = t("vocabDriveLoading");
  try {
    const owner = await pbpVocabCurrentOwner();
    if (gen !== _driveRenderGen) return;
    const response = await chrome.runtime.sendMessage({ type: "vocabDriveStatus" });
    if (!(await _pbpVocabDriveCurrent(gen, 0, await owner, response?.status))) return;
    if (!response?.ok) {
      const state = $id("vocab-drive-state");
      if (state) state.textContent = t("vocabDriveStatusFailed");
      _pbpVocabDriveShowError(response?.error);
      _pbpVocabDriveOfferRetry();
      return;
    }
    _pbpVocabDriveRender(response.status);
  } catch (error) {
    if (gen !== _driveRenderGen) return;
    console.warn("[drive] status read failed:", error?.name, error?.message);
    const state = $id("vocab-drive-state");
    if (state) state.textContent = t("vocabDriveStatusFailed");
    _pbpVocabDriveShowError("remote");
    _pbpVocabDriveOfferRetry();
  }
}

// §5.4 / §10.10 authorization phase: from the moment Chrome's permission
// prompt is granted and the worker starts Google's interactive sign-in, until
// PBP_DRIVE_CONNECT_AUTHORIZED for this owner or the action's answer, whichever
// comes first. Time spent in the permission prompt itself is not counted.
// Only this phase can show the slow hint; a Google that authorizes at once and
// then syncs for minutes never does.
function _pbpVocabDriveBeginAuthorizing(actionSeq, owner, button) {
  _pbpVocabDriveEndAuthorizing();
  const entry = { actionSeq, owner: null, button, timer: 0 };
  Promise.resolve(owner).then((value) => {
    if (_driveAuthorizing === entry && typeof value === "string") entry.owner = value;
  }, () => {});
  entry.timer = setTimeout(() => {
    if (_driveAuthorizing !== entry || actionSeq !== _vocabDriveActionSeq || !_vocabDriveBusy) return;
    const state = $id("vocab-drive-state");
    if (state) state.textContent = t("vocabDriveAuthorizing") + " " + t("vocabDriveAuthorizingSlow");
  }, PBP_VOCAB_DRIVE_AUTH_SLOW_MS);
  _driveAuthorizing = entry;
}

function _pbpVocabDriveEndAuthorizing(actionSeq) {
  const entry = _driveAuthorizing;
  if (!entry || (actionSeq !== undefined && entry.actionSeq !== actionSeq)) return null;
  clearTimeout(entry.timer);
  _driveAuthorizing = null;
  return entry;
}

// The broadcast carries pbpDictOwnerScope(account), the same shape as
// pbpVocabCurrentOwner(); a signal for any other owner (or before this
// page knows its own) is ignored rather than trusted.
function _pbpVocabDriveAuthorized(message) {
  const entry = _driveAuthorizing;
  if (!entry || entry.actionSeq !== _vocabDriveActionSeq || entry.owner === null) return;
  if (typeof message?.owner !== "string" || message.owner !== entry.owner) return;
  _pbpVocabDriveEndAuthorizing(entry.actionSeq);
  if (_vocabDriveBusy) _pbpVocabDriveSetBusy(true, entry.button, "vocabDriveWorking");
}

async function _pbpVocabDriveSend(type, force, gen, actionSeq, sourceButton, focusTargetId, owner) {
  if (!_pbpVocabDriveAvailable()) {
    _pbpVocabDriveRenderUnavailable();
    return;
  }
  try {
    const message = { type };
    if (force === true) message.force = true;
    owner = await owner;
    if (!(await _pbpVocabDriveCurrent(gen, actionSeq, owner))) return;
    let response;
    try {
      response = await chrome.runtime.sendMessage(message);
    } catch (error) {
      // No answer at all (worker restarting, channel closed): recovered the
      // same way as a worker-side failure without status.
      console.warn("[drive] action failed:", error?.name, error?.message);
      response = { ok: false, error: "remote" };
    }
    const moveFocus = document.activeElement === sourceButton;
    const settled = await _pbpVocabDriveSettle(response, gen, actionSeq, owner, type);
    if (!settled) return;
    const preferred = moveFocus && focusTargetId ? $id(focusTargetId) : null;
    const target = preferred && !preferred.hidden
      ? preferred : (moveFocus && sourceButton && !sourceButton.hidden ? sourceButton : null);
    if (target && !target.hidden) {
      try { target.focus({ preventScroll: true }); }
      catch (_) { target.focus(); }
    }
    // Connect and Sync now both run a full sync; Disconnect touches no words.
    // Last successful sync is minute-precise, so without this flash two
    // clicks inside one minute change nothing on screen. A run that only
    // waited out a backoff is not a sync (A28: the flag is top-level).
    if (settled.ok && !settled.waitingForRetry && type !== "vocabDriveDisconnect") {
      _pbpVocabFlashLocalStatus("vocab-drive-action-status", true, t("vocabDriveSynced"));
    }
  } catch (error) {
    console.warn("[drive] action failed:", error?.name, error?.message);
    if (gen === _driveRenderGen && actionSeq === _vocabDriveActionSeq) {
      _pbpVocabDriveShowError("remote");
    }
  } finally {
    _pbpVocabDriveEndAuthorizing(actionSeq);
    if (actionSeq === _vocabDriveActionSeq) _pbpVocabDriveSetBusy(false);
  }
}

async function _pbpVocabDriveConnect() {
  if (_vocabDriveBusy || !_pbpVocabDriveAvailable()) return;
  const gen = _driveRenderGen;
  const actionSeq = ++_vocabDriveActionSeq;
  const sourceButton = $id("vocab-drive-connect");
  const owner = _driveVisibleOwner === null ? pbpVocabCurrentOwner() : _driveVisibleOwner;
  let granted = false;
  try {
    const permission = chrome.permissions.request({
      permissions: ["identity"],
      origins: [PBP_VOCAB_GOOGLE_API_ORIGIN]
    });
    _pbpVocabDriveSetBusy(true, sourceButton, "vocabDriveAuthorizing");
    granted = await permission;
  } catch (_) {}
  if (gen !== _driveRenderGen || actionSeq !== _vocabDriveActionSeq) {
    if (actionSeq === _vocabDriveActionSeq) _pbpVocabDriveSetBusy(false);
    return;
  }
  if (!granted) {
    _pbpVocabDriveSetBusy(false);
    _pbpVocabDrivePaintErrors([t("vocabDrivePermissionDenied")], null);
    return;
  }
  // Spec §10.10: Chrome's permission prompt is a visible window and needs no
  // network, so the 15-second clock starts here, once it is granted and the
  // worker begins Google's interactive sign-in / consent step.
  _pbpVocabDriveBeginAuthorizing(actionSeq, owner, sourceButton);
  return _pbpVocabDriveSend(
    "vocabDriveConnect", false, gen, actionSeq, sourceButton, "vocab-drive-sync", owner
  );
}

async function _pbpVocabDriveAction(type, force, focusTargetId) {
  if (_vocabDriveBusy || !_pbpVocabDriveAvailable()) return;
  const gen = _driveRenderGen;
  const owner = _driveVisibleOwner === null ? pbpVocabCurrentOwner() : _driveVisibleOwner;
  const actionSeq = ++_vocabDriveActionSeq;
  const sourceButton = type === "vocabDriveDisconnect"
    ? $id("vocab-drive-disconnect") : $id("vocab-drive-sync");
  _pbpVocabDriveSetBusy(true, sourceButton);
  return _pbpVocabDriveSend(
    type, force, gen, actionSeq, sourceButton, focusTargetId, owner
  );
}

// General only reads status. Opening settings must not authorize or sync.
function invalidateDriveSyncPanel() {
  ++_driveRenderGen;
  ++_vocabDriveActionSeq;
  _driveVisibleOwner = null;
  _pbpVocabDriveEndAuthorizing();
  _pbpVocabDriveClear();
  _pbpVocabDriveSetBusy(false);
}

// Connecting is the whole data-scope choice now (spec §2.1): there is no
// local preference to read before the status request.
async function renderDriveSyncPanel() {
  if (!$id("vocab-drive-body")) return;
  invalidateDriveSyncPanel();
  const gen = _driveRenderGen;
  try {
    if (typeof pbpI18nReady === "function") await pbpI18nReady();
  } catch (error) {
    console.warn("[drive] i18n wait failed:", error?.name, error?.message);
  }
  if (gen !== _driveRenderGen) return;
  if (_pbpVocabDriveAvailable()) await _pbpVocabDriveRefresh(gen);
  else _pbpVocabDriveRenderUnavailable();
}

async function renderVocabPanel() {
  ++_vocabRenderGen;
  _pbpVocabRefreshEudicConfigured().then(_pbpVocabUpdateExternalActions);
  _pbpPackRefreshStatus();
}


// Fail-closed on account switch: owner is re-derived AFTER the rows fetch
// resolves and compared against the owner the rows were fetched for. If they
// differ (token rotated, or sync/keys-routing toggled mid-fetch), the export
// aborts BEFORE the Blob is built -- never download the previous account's
// words under the new account's export click. The whole chain is wrapped so
// any rejection (owner read, IDB read) surfaces feedback instead of dying
// silently (this runs as a click handler; an unhandled rejection there is
// invisible to the user).
async function _pbpVocabExport() {
  const btn = $id("vocab-export-btn");
  if (!btn || btn.disabled) return; // double-click guard, same as the Anki/Eudic buttons
  btn.disabled = true;
  try {
    // A just-edited setting may still sit in the options page's debounced
    // auto-save; flush it first, same ordering as the Anki/Eudic sends
    // (Codex final-review MEDIUM precedent), and abort if the flush fails.
    if (typeof window.pbpOptionsFlushAutoSave === "function") {
      let flushed = null;
      try { flushed = await window.pbpOptionsFlushAutoSave(); } catch (_) {}
      if (!flushed || !flushed.ok) { _pbpVocabFlashStatus(false, t("vocabSettingsSaveFailed")); return; }
    }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    const ownerNow = await pbpVocabCurrentOwner();
    if (ownerNow !== owner) {
      _pbpVocabFlashStatus(false, t("vocabAccountChanged"));
      return;
    }
    // Nothing to write: pbpDictTsv([]) still emits the three Anki header lines,
    // so without this the click downloads a wordless file and says nothing.
    // Answered the same way as the two sibling buttons in this toolbar --
    // dictAnkiNothing names no target ("No words to send yet."), so it is
    // reused here instead of duplicated under an export-specific key. Placed
    // before the enrichment awaits: an empty set has nothing to enrich.
    if (!rows.length) { _pbpVocabFlashStatus(false, t("dictAnkiNothing")); return; }
    // Enrichment is another await, so the owner is rechecked AFTER it and before
    // a Blob exists: the file must never be built from a previous account's rows.
    const zhMap = await _pbpVocabZhMap(rows);
    const zhTag = await _pbpVocabEcdictTag();
    const ownerBeforeBlob = await pbpVocabCurrentOwner();
    if (ownerBeforeBlob !== owner) {
      _pbpVocabFlashStatus(false, t("vocabAccountChanged"));
      return;
    }
    const tsv = pbpDictTsv(rows.map((w) => _pbpVocabCanonicalRow(w, zhMap, zhTag)));
    const blob = new Blob([tsv], { type: "text/tab-separated-values" });
    const a = document.createElement("a");
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    a.href = URL.createObjectURL(blob);
    a.download = "vocab-" + stamp + ".tsv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (_) {
    _pbpVocabFlashStatus(false, t("vocabExportFailed"));
  } finally {
    btn.disabled = false;
  }
}

// First few names only: the status line is one line, and five terms are
// enough to spot the pattern (the counts still carry the full totals).
function _pbpVocabTermList(terms) {
  const list = terms.slice(0, 5).join(", ");
  return terms.length > 5 ? list + "…" : list;
}

// Send-to-Anki click chain. Ordering is the spec (anki spec rev2 §3):
// (1) FIRST await = chrome.permissions.request (user gesture; already-granted
// resolves true without UI), (2) requestPermission as the first AnkiConnect
// action, (3..n) owner derived AFTER the permission awaits and re-checked
// via ownerCheck before every later dispatch -- the permission dialogs can
// sit open long enough for an account switch (fail-closed invariant).
// Canonical row shared by the TSV export and the Anki send (spec: both
// derive from the SAME canonical shape; the Anki side escapes its own copy).
// Derived on this device from the local ECDICT pack, for the export paths only.
// COMPUTE-ONLY: nothing here writes pbp-vocab or reaches Drive. vocab-store.js
// stays the sole writer, the 13 stored fields are untouched, and "the current
// owner's whole vocabulary" keeps meaning exactly what it meant before.
// One batched transaction for the whole export, never one per row.
async function _pbpVocabZhMap(words) {
  if (typeof pbpEcdictLookupMany !== "function") return new Map();
  const keys = [];
  for (const w of words) {
    // English only, and the saved lemma is a second chance for an inflected form.
    // Compared through the same primary-language helper vocab-store uses for
    // record identity: a stored tag may carry a region, and a bare === "en"
    // would then match nothing and silently enrich no row at all.
    if (_pbpVocabPrimary(w.language) !== "en") continue;
    if (w.term) keys.push(w.term);
    if (w.lemma) keys.push(w.lemma);
  }
  if (!keys.length) return new Map();
  try { return await pbpEcdictLookupMany(keys); } catch (_) { return new Map(); }
}

// vocab-store.js defines pbpDictPrimaryLang and options.html loads it; the
// fallback only keeps this from throwing if the load order ever changes.
function _pbpVocabPrimary(code) {
  if (typeof pbpDictPrimaryLang === "function") return pbpDictPrimaryLang(code);
  return String(code || "").trim().toLowerCase().split(/[-_]/)[0];
}

function _pbpVocabZhFor(w, zhMap) {
  if (!zhMap || !zhMap.size || _pbpVocabPrimary(w.language) !== "en") return "";
  const hit = (w.term && zhMap.get(pbpEcdictKey(w.term))) ||
              (w.lemma && zhMap.get(pbpEcdictKey(w.lemma)));
  if (!hit || !hit.length) return "";
  // Every matching record, not just the first. Case folding collapses distinct
  // headwords onto one key ("US" and "us"), so hit[0] would export whichever the
  // imported file listed first and lose the other sense entirely.
  const seen = new Set();
  const out = [];
  for (const r of hit) {
    for (const sense of pbpEcdictSenses(r.translation)) {
      if (seen.has(sense)) continue;
      seen.add(sense);
      out.push(sense);
    }
  }
  return out.join("; ");
}

// zh and zhNote stay SEPARATE from definition/license: the Anki path has to
// escape each piece on its own before joining them with its own trusted <br>,
// and pre-joining here would either double-escape or smuggle markup through.
function _pbpVocabCanonicalRow(w, zhMap, tag) {
  const zh = _pbpVocabZhFor(w, zhMap);
  return {
    term: w.term,
    // Only pbpAnkiNoteFromRow reads these two (they become note tags);
    // pbpDictTsv ignores unknown keys, so the TSV shape is untouched.
    language: w.language || "",
    groups: pbpVocabGroups(w),
    reading: w.ipa || "",
    definition: (w.gloss || "").replace(/\s*\n\s*/g, " "),
    contexts: (Array.isArray(w.contexts) ? w.contexts : []).map((c) => c && c.quote).filter(Boolean),
    source: (w.contexts && w.contexts[0] && w.contexts[0].articleUrl) || "",
    license: [w.license, w.sourceUrl].filter(Boolean).join(" "),
    zh,
    // Labelled so the local Chinese never looks like it came from the online
    // entry, and carrying the diagnostic pack identity. Never presented as a
    // confirmed data licence.
    zhNote: zh ? t("vocabZhFromPack") + (tag ? " (" + tag + ")" : "") : ""
  };
}

// Diagnostic identity of the imported pack: rung plus a short slice of the
// CRC32. Not an identity or licence claim -- 32 bits collide.
// Read AFTER the lookup and passed per export, never held in a module variable:
// reading it first let a pack swapped in mid-export label content that came from
// a different pack, and one variable let a TSV and an Anki send overwrite each
// other's label.
async function _pbpVocabEcdictTag() {
  try {
    const meta = (typeof pbpEcdictMeta === "function") ? await pbpEcdictMeta() : null;
    return meta && meta.state === "ready"
      ? "ECDICT " + (meta.rung || "") + " " + String(meta.decodedCrc32 || "").slice(0, 8)
      : "";
  } catch (_) { return ""; }
}

async function _pbpVocabSendAnki() {
  const btn = $id("vocab-anki-btn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  try {
    btn.textContent = t("dictAnkiSending");
    // The permission pattern depends on the configurable port, so one fast
    // settings read precedes permissions.request. Transient activation is a
    // TIME window (~5s), not a microtask budget; a single storage read stays
    // well inside it. A port typed within the 500ms auto-save debounce may
    // read stale once -- worst case is a connection error and a retry.
    const preRead = await pbpReadSettingsWithSecrets({ dictAnkiPort: SETTINGS_DEFAULTS.dictAnkiPort });
    const port = preRead.dictAnkiPort;
    const pattern = pbpEndpointOriginPattern(pbpAnkiEndpointFor(port));
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); }
    catch (e) {
      console.warn("[vocab] Anki host permission request failed:", e?.name, e?.message);
      _pbpVocabFlashStatus(false, t("dictAnkiHostPermissionDenied"));
      return;
    }
    if (!granted) { _pbpVocabFlashStatus(false, t("dictAnkiHostPermissionDenied")); return; }
    // requestPermission FIRST (spec §3): the long human-approval wait happens
    // BEFORE owner derivation, so the owner snapshot below stays fresh.
    const perm = await pbpAnkiCall("requestPermission", {}, "", 120000, port);
    if (!perm.ok || !perm.result) { _pbpVocabFlashStatus(false, t("dictAnkiConnectPermissionFailed")); return; }
    if (perm.result.permission !== "granted") { _pbpVocabFlashStatus(false, t("dictAnkiConnectPermissionDenied")); return; }
    const apiVersion = Number(perm.result.version);
    if (!Number.isFinite(apiVersion) || apiVersion < 6) {
      _pbpVocabFlashStatus(false, t("dictAnkiVersionUnsupported"));
      return;
    }
    const keyRequired = perm.result.requireApiKey === true || perm.result.requireApikey === true;
    // A just-edited deck/key may still sit in the options page's 500ms
    // debounced auto-save; flush it so the read below sees what the user
    // sees, and abort if the save fails (Codex final-review MEDIUM).
    if (typeof window.pbpOptionsFlushAutoSave === "function") {
      let flushed = null;
      try { flushed = await window.pbpOptionsFlushAutoSave(); } catch (_) {}
      if (!flushed || !flushed.ok) { _pbpVocabFlashStatus(false, t("vocabSettingsSaveFailed")); return; }
    }
    const raw = await pbpReadSettingsWithSecrets({
      dictAnkiDeck: SETTINGS_DEFAULTS.dictAnkiDeck,
      dictAnkiKey: SETTINGS_DEFAULTS.dictAnkiKey
    });
    const s = deobfuscateSettings(raw);
    if (keyRequired && !s.dictAnkiKey) { _pbpVocabFlashStatus(false, t("dictAnkiKeyRequired")); return; }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    if ((await pbpVocabCurrentOwner()) !== owner) { _pbpVocabFlashStatus(false, t("vocabAccountChanged")); return; }
    if (!rows.length) { _pbpVocabFlashStatus(false, t("dictAnkiNothing")); return; }
    const zhMap = await _pbpVocabZhMap(rows);
    const zhTag = await _pbpVocabEcdictTag();
    const ownerBeforeSend = await pbpVocabCurrentOwner();
    if (ownerBeforeSend !== owner) {
      _pbpVocabFlashStatus(false, t("vocabAccountChanged"));
      return;
    }
    const canonical = rows.map((w) => _pbpVocabCanonicalRow(w, zhMap, zhTag));
    const res = await pbpAnkiSendRows(canonical, {
      deck: s.dictAnkiDeck || "Pinboard Vocab",
      key: s.dictAnkiKey || "",
      port,
      ownerCheck: async () => (await pbpVocabCurrentOwner()) === owner
    });
    if (res.stage === "done") {
      let msg = t("dictAnkiResult", String(res.added), String(res.skipped), String(res.failed));
      // Name the casualties: a bare count leaves "re-send the whole library
      // and hope" as the only recovery move.
      if (res.failed > 0 && Array.isArray(res.failedTerms) && res.failedTerms.length) {
        msg += " · " + t("vocabFailedTerms", _pbpVocabTermList(res.failedTerms));
      }
      _pbpVocabFlashStatus(res.failed === 0, msg);
    } else if (res.stage === "modelMismatch") {
      _pbpVocabFlashStatus(false, t("dictAnkiModelMismatch"));
    } else if (res.stage === "modelFields") {
      _pbpVocabFlashStatus(false, t("dictAnkiFieldCheckFailed"));
    } else if (res.stage === "owner") {
      _pbpVocabFlashStatus(false, t("vocabAccountChanged"));
    } else {
      // Pipeline stages (deck/model/precheck/add) carry AnkiConnect's own
      // error text; use the generic send failure only when no detail exists.
      _pbpVocabFlashStatus(false, res.error || t("dictAnkiFailed"));
    }
  } catch (_) {
    _pbpVocabFlashStatus(false, t("dictAnkiFailed"));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

async function _pbpVocabSendEudic() {
  const btn = $id("vocab-eudic-btn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  try {
    btn.textContent = t("dictEudicSending");
    const pattern = pbpEndpointOriginPattern(PBP_EUDIC_ENDPOINT);
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); } catch (_) {}
    if (!granted) { _pbpVocabFlashStatus(false, t("dictEudicHostPermissionDenied")); return; }
    if (typeof window.pbpOptionsFlushAutoSave === "function") {
      let flushed = null;
      try { flushed = await window.pbpOptionsFlushAutoSave(); } catch (_) {}
      if (!flushed || !flushed.ok) { _pbpVocabFlashStatus(false, t("vocabSettingsSaveFailed")); return; }
    }
    const raw = await pbpReadSettingsWithSecrets({ dictEudicToken: SETTINGS_DEFAULTS.dictEudicToken });
    const s = deobfuscateSettings(raw);
    if (!s.dictEudicToken) { _pbpVocabFlashStatus(false, t("dictEudicTokenRequired")); return; }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    if ((await pbpVocabCurrentOwner()) !== owner) { _pbpVocabFlashStatus(false, t("vocabAccountChanged")); return; }
    // pbpEudicSendRows sends nothing for an empty set and still returns
    // stage "done" with all-zero counters, which the branch below would flash
    // as a successful send. Same guard, same order and same key as the Anki
    // twin above (dictAnkiNothing names no target, so it is reused, not
    // duplicated); the button can outlive the words that revealed it, since
    // its visibility is only re-evaluated on panel render and token changes.
    if (!rows.length) { _pbpVocabFlashStatus(false, t("dictAnkiNothing")); return; }
    const res = await pbpEudicSendRows(rows, {
      token: s.dictEudicToken,
      ownerCheck: async () => (await pbpVocabCurrentOwner()) === owner
    });
    if (res.stage === "owner") {
      _pbpVocabFlashStatus(false, t("vocabAccountChanged"));
    } else if (res.stage === "auth") {
      _pbpVocabFlashStatus(false, t("dictEudicTokenRequired"));
    } else if (res.forbidden) {
      _pbpVocabFlashStatus(false, t("dictEudicRejected"));
    } else if (res.failed) {
      // Parameter errors surface the server's own message (spec §2).
      let msg = res.error || t("dictEudicFailed");
      if (Array.isArray(res.failedTerms) && res.failedTerms.length) {
        msg += " · " + t("vocabFailedTerms", _pbpVocabTermList(res.failedTerms));
      }
      _pbpVocabFlashStatus(false, msg);
    } else if (res.generic) {
      // ANY generic batch poisons the totals -- never show a partial count
      // as if it were the whole story.
      _pbpVocabFlashStatus(true, t("dictEudicGenericOk"));
    } else {
      let msg = t("dictEudicResult", String(res.added), String(res.skipped), String(res.unsupported));
      if (res.unsupported > 0 && Array.isArray(res.unsupportedTerms) && res.unsupportedTerms.length) {
        msg += " · " + t("vocabUnsupportedTerms", _pbpVocabTermList(res.unsupportedTerms));
      }
      // Words existed but none were in a language Eudic takes: nothing was
      // accepted or deduplicated away, so the counts must not read as a
      // successful send just because no request failed.
      _pbpVocabFlashStatus(res.added > 0 || res.skipped > 0, msg);
    }
  } catch (_) {
    _pbpVocabFlashStatus(false, t("dictEudicFailed"));
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

// Left a real <a href> so middle-click / "open in new tab" still work, but a
// plain click reuses the library tab instead of stacking one per visit --
// same helper every other entry point to that page now goes through.
const _vocabOpenLibrary = $id("vocab-open-library");
if (_vocabOpenLibrary && typeof pbpOpenExtensionTab === "function") {
  _vocabOpenLibrary.addEventListener("click", (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    pbpOpenExtensionTab("library.html", "vocab");
  });
}

const _vocabAnkiBtn = $id("vocab-anki-btn");
if (_vocabAnkiBtn) _vocabAnkiBtn.addEventListener("click", _pbpVocabSendAnki);

const _vocabEudicBtn = $id("vocab-eudic-btn");
if (_vocabEudicBtn) _vocabEudicBtn.addEventListener("click", _pbpVocabSendEudic);

// ---- Connection testers (roadmap #31): every AI provider has a one-click
// connectivity check; the two vocab exporters previously only surfaced a
// config error after the user had collected words and hit send. Same
// permission discipline as the send paths: request the exact loopback /
// HTTPS origin from this direct click, never in the background. Results go
// through the vocab panel's own status line. Errors reuse the send paths'
// established keys so wording stays identical.
function _pbpVocabFlashLocalStatus(targetId, ok, text) {
  const el = $id(targetId);
  if (el) {
    setStatusIcon(el, ok, text);
    clearTimeout(_vocabLocalFlashTimers.get(targetId));
    _vocabLocalFlashTimers.delete(targetId);
    // Failures stay until the next result, as in _pbpVocabFlashStatus.
    if (!ok) return;
    _vocabLocalFlashTimers.set(targetId, setTimeout(() => {
      _vocabLocalFlashTimers.delete(targetId);
      el.textContent = "";
      el.classList.remove("ok", "bad");
    }, 3000));
  }
}

function _pbpVocabConnectionResult(id, ok, text, code) {
  _pbpVocabFlashLocalStatus(`vocab-${id}-test-status`, ok, text);
  if (typeof pbpRecordConnectionHealth !== "function") return;
  pbpRecordConnectionHealth(id, ok, code).catch((e) => {
    console.warn(`[vocab] ${id} health record failed:`, e?.name, e?.message);
  });
}

async function _pbpVocabTestAnki() {
  const btn = $id("vocab-anki-test-btn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  try {
    btn.textContent = t("testTesting");
    const preRead = await pbpReadSettingsWithSecrets({
      dictAnkiPort: SETTINGS_DEFAULTS.dictAnkiPort,
    });
    const port = preRead.dictAnkiPort;
    const pattern = pbpEndpointOriginPattern(pbpAnkiEndpointFor(port));
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); } catch (_) {}
    if (!granted) { _pbpVocabConnectionResult("anki", false, t("dictAnkiHostPermissionDenied"), "permission_denied"); return; }
    const perm = await pbpAnkiCall("requestPermission", {}, "", 120000, port);
    if (!perm.ok || !perm.result) { _pbpVocabConnectionResult("anki", false, t("dictAnkiConnectPermissionFailed"), "unreachable"); return; }
    if (perm.result.permission !== "granted") { _pbpVocabConnectionResult("anki", false, t("dictAnkiConnectPermissionDenied"), "addon_denied"); return; }
    const apiVersion = Number(perm.result.version);
    if (!Number.isFinite(apiVersion) || apiVersion < 6) { _pbpVocabConnectionResult("anki", false, t("dictAnkiVersionUnsupported"), "unsupported"); return; }
    // A test must exercise the CONFIGURED credentials, not stop at the
    // handshake (Codex review): when the server demands a key, flush the
    // 500ms auto-save first (same as the send path) so a just-pasted key is
    // what gets tested, then run a side-effect-free keyed call — a wrong key
    // surfaces here instead of at the first real send.
    if (perm.result.requireApiKey === true || perm.result.requireApikey === true) {
      // Send-path parity incl. the RESULT check (Codex final review): a failed
      // flush means the stored key may not be the one just pasted — testing
      // the stale key could even report success for credentials the user has
      // already replaced. Abort rather than test the wrong value.
      if (typeof window.pbpOptionsFlushAutoSave === "function") {
        let flushed = null;
        try { flushed = await window.pbpOptionsFlushAutoSave(); }
        catch (e) { console.warn("[vocab] Anki settings flush failed:", e?.name, e?.message); }
        if (!flushed || !flushed.ok) { _pbpVocabConnectionResult("anki", false, t("vocabSettingsSaveFailed"), "settings_save"); return; }
      }
      const rawKey = await pbpReadSettingsWithSecrets({ dictAnkiKey: SETTINGS_DEFAULTS.dictAnkiKey });
      const key = deobfuscateSettings(rawKey).dictAnkiKey || "";
      if (!key) { _pbpVocabConnectionResult("anki", false, t("dictAnkiKeyRequired"), "missing_key"); return; }
      const keyed = await pbpAnkiCall("version", {}, key, 10000, port);
      // pbpAnkiCall reports only transport failures as unreachable/timeout;
      // any other error is AnkiConnect answering, i.e. refusing this key.
      if (!keyed.ok && (keyed.error === "unreachable" || keyed.error === "timeout")) {
        _pbpVocabConnectionResult("anki", false, t("dictAnkiConnectPermissionFailed"), "unreachable");
        return;
      }
      if (!keyed.ok) { _pbpVocabConnectionResult("anki", false, t("dictAnkiKeyRejected"), "auth"); return; }
    }
    _pbpVocabConnectionResult("anki", true, t("testConnected", "AnkiConnect v" + apiVersion), "connected");
  } catch (e) {
    console.warn("[vocab] Anki connection test failed:", e?.name, e?.message);
    _pbpVocabConnectionResult("anki", false, t("dictAnkiFailed"), "failed");
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

async function _pbpVocabTestEudic() {
  const btn = $id("vocab-eudic-test-btn");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const orig = btn.textContent;
  try {
    btn.textContent = t("testTesting");
    // Flush the 500ms auto-save debounce first (send-path parity incl. the
    // RESULT check, Codex final review): a token pasted moments before the
    // click must be the one tested — and a failed flush means it is not.
    if (typeof window.pbpOptionsFlushAutoSave === "function") {
      let flushed = null;
      try { flushed = await window.pbpOptionsFlushAutoSave(); }
      catch (e) { console.warn("[vocab] Eudic settings flush failed:", e?.name, e?.message); }
      if (!flushed || !flushed.ok) { _pbpVocabConnectionResult("eudic", false, t("vocabSettingsSaveFailed"), "settings_save"); return; }
    }
    const raw = await pbpReadSettingsWithSecrets({ dictEudicToken: SETTINGS_DEFAULTS.dictEudicToken });
    const s = deobfuscateSettings(raw);
    if (!s.dictEudicToken) { _pbpVocabConnectionResult("eudic", false, t("dictEudicTokenRequired"), "missing_token"); return; }
    const pattern = pbpEndpointOriginPattern(PBP_EUDIC_ENDPOINT);
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); }
    catch (e) {
      console.warn("[vocab] Eudic host permission request failed:", e?.name, e?.message);
      _pbpVocabConnectionResult("eudic", false, t("dictEudicHostPermissionDenied"), "permission_error");
      return;
    }
    if (!granted) { _pbpVocabConnectionResult("eudic", false, t("dictEudicHostPermissionDenied"), "permission_denied"); return; }
    const r = await pbpEudicPing(s.dictEudicToken, 10000);
    if (r.ok) _pbpVocabConnectionResult("eudic", true, t("testConnected", "OK"), "connected");
    // Same mapping as the send path: 401 asks for the token, 403 is a refusal.
    else if (r.error === "auth") _pbpVocabConnectionResult("eudic", false, t("dictEudicTokenRequired"), "auth");
    else if (r.error === "forbidden") _pbpVocabConnectionResult("eudic", false, t("dictEudicRejected"), "forbidden");
    else _pbpVocabConnectionResult("eudic", false, t("dictEudicFailed"), "failed");
  } catch (e) {
    console.warn("[vocab] Eudic connection test failed:", e?.name, e?.message);
    _pbpVocabConnectionResult("eudic", false, t("dictEudicFailed"), "failed");
  } finally {
    btn.textContent = orig;
    btn.disabled = false;
  }
}

const _vocabAnkiTestBtn = $id("vocab-anki-test-btn");
if (_vocabAnkiTestBtn) _vocabAnkiTestBtn.addEventListener("click", _pbpVocabTestAnki);

const _vocabEudicTestBtn = $id("vocab-eudic-test-btn");
if (_vocabEudicTestBtn) _vocabEudicTestBtn.addEventListener("click", _pbpVocabTestEudic);

const _vocabExportBtn = $id("vocab-export-btn");
if (_vocabExportBtn) _vocabExportBtn.addEventListener("click", _pbpVocabExport);

const _vocabDriveConnect = $id("vocab-drive-connect");
if (_vocabDriveConnect) _vocabDriveConnect.addEventListener("click", _pbpVocabDriveConnect);
const _vocabDriveSync = $id("vocab-drive-sync");
if (_vocabDriveSync) _vocabDriveSync.addEventListener("click", () =>
  _pbpVocabDriveAction("vocabDriveSyncNow", true));
const _vocabDriveClearNotices = $id("vocab-drive-clear-notices");
if (_vocabDriveClearNotices) _vocabDriveClearNotices.addEventListener("click", async () => {
  const gen = _driveRenderGen;
  const owner = _driveVisibleOwner === null ? pbpVocabCurrentOwner() : _driveVisibleOwner;
  try {
    let response;
    try {
      response = await chrome.runtime.sendMessage({ type: "vocabDriveClearNotices" });
    } catch (error) {
      console.warn("[drive] notices dismissal failed:", error?.name, error?.message);
      response = { ok: false, error: "remote" };
    }
    await _pbpVocabDriveSettle(response, gen, 0, await owner, "vocabDriveClearNotices");
  } catch (error) {
    console.warn("[drive] notices dismissal failed:", error?.name, error?.message);
    if (gen === _driveRenderGen) _pbpVocabDriveShowError("remote");
  }
});
const _vocabDriveDisconnect = $id("vocab-drive-disconnect");
if (_vocabDriveDisconnect) _vocabDriveDisconnect.addEventListener("click", () =>
  _pbpVocabDriveAction("vocabDriveDisconnect", false, "vocab-drive-connect"));

if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" && area !== "local") return;
    if (changes.dictEudicToken) {
      _pbpVocabRefreshEudicConfigured().then(_pbpVocabUpdateExternalActions);
    }
    const accountChanged = changes.pinboardToken || changes.optSyncEnabled || changes.syncApiKeys;
    const active = document.querySelector(".tab-btn.active")?.dataset.panel;
    if (accountChanged) {
      invalidateDriveSyncPanel();
      if (active === "vocab") renderVocabPanel();
    }
    if ((accountChanged || changes.optLang) && active === "general") renderDriveSyncPanel();
    // Manual actions render their own authoritative response. Reading status
    // while they run would invalidate it when Connect writes its marker.
    if (area === "local" && changes.vocabDriveConnected && !_vocabDriveBusy && active === "general") renderDriveSyncPanel();
  });
}

// The worker announces the end of the Google authorization step before the
// first round runs (spec §3.5); only this page's pending Connect consumes it.
// Nothing is answered, so the listener returns nothing (an MV3 onMessage
// listener returns true only to keep a reply channel open).
if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "PBP_DRIVE_CONNECT_AUTHORIZED") _pbpVocabDriveAuthorized(message);
  });
}

// ---- Offline dictionary pack (dict-pack.js primitives; CC-CEDICT) -------
async function _pbpPackRefreshStatus() {
  const el = $id("dict-pack-status");
  const del = $id("dict-pack-delete");
  if (!el) return;
  let meta;
  try {
    meta = (typeof pbpPackMeta === "function") ? await pbpPackMeta() : { state:"error" };
  } catch (_) {
    meta = { state:"error" };
  }
  if (meta && meta.state === "ready") {
    const d = new Date(meta.importedAt);
    el.textContent = t("dictPackStatus", String(meta.entries),
      d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
    if (del) del.hidden = false;
  } else if (meta && meta.state === "error") {
    el.textContent = t("dictPackReadFailed");
    if (del) del.hidden = true;
  } else {
    el.textContent = t("dictPackEmpty");
    if (del) del.hidden = true;
  }
}

function _pbpPackWire() {
  const open = $id("dict-pack-open");
  const imp = $id("dict-pack-import");
  const file = $id("dict-pack-file");
  const del = $id("dict-pack-delete");
  if (!open || !imp || !file) return;
  open.addEventListener("click", () => {
    try { chrome.tabs.create({ url: "https://www.mdbg.net/chinese/dictionary?page=cc-cedict" }); } catch (_) {}
  });
  imp.addEventListener("click", () => file.click());
  const runPackImport = async (f) => {
    if (imp.disabled) return;
    imp.disabled = true;
    const el = $id("dict-pack-status");
    let lastShown = 0;
    try {
      const res = await pbpPackImportFile(f, (n) => {
        // TIME-based throttle (~1s): aria-live must not machine-gun the
        // screen reader on a fast import; final state comes from refresh.
        const now = performance.now();
        if (el && now - lastShown >= 1000) { lastShown = now; el.textContent = t("dictPackImporting", String(n)); }
      });
      _pbpVocabFlashLocalStatus("dict-pack-action-status", true, t("dictPackDone", String(res.entries)));
    } catch (error) {
      // Three outcomes, and only dict-pack.js knows which one happened: the
      // probe gate refused a wrong file before the store was cleared (the
      // installed pack is intact), the import died after the clear (it is
      // gone and the status line above has already flipped to "not
      // imported"), or it failed on the way to the clear -- a zip that will
      // not parse, a read error, a database that will not open -- where the
      // installed pack is untouched but nothing specific can be said about
      // the file. Guessing here would tell a user their dictionary was
      // deleted when it was not.
      const code = error && error.code;
      _pbpVocabFlashLocalStatus("dict-pack-action-status", false,
        t(code === "implausible_pack" ? "dictPackImplausible"
          : code === "pack_cleared" ? "dictPackFailedCleared"
          : "dictPackFailed"));
    } finally {
      imp.disabled = false;
      _pbpPackRefreshStatus();
    }
  };
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f || imp.disabled) return;
    // Importing REPLACES: the import clears the store before it writes, so a
    // pack that is already installed is lost the moment this starts. Deleting
    // one asks first; replacing one loses the same data and must ask too.
    // Deliberately NOT disabling the button across the confirm: a popover can
    // be dismissed by a third party (opening the delete confirm closes this
    // one without running onCancel), which would strand the button. Re-entry
    // is handled by dropping our own pending confirm so the newest pick wins.
    // Fail SAFE, not silent. A pbpPackMeta() that throws says nothing about
    // whether a pack is installed; reading it as "none" skips the confirm and
    // the import then clears the pack the user still had. Treat an unreadable
    // store as INSTALLED and ask -- the worst case is one redundant confirm.
    // CLAUDE.md "吞异常必须留痕": name/message only, never pack contents.
    let meta = null;
    let metaUnreadable = false;
    try {
      meta = await pbpPackMeta();
    } catch (error) {
      metaUnreadable = true;
      console.warn("[dict-pack] installed-pack check failed:",
        error && error.name, error && error.message);
    }
    if (metaUnreadable || (meta && meta.state === "ready")) {
      pbpDismissActiveConfirm(imp);
      showConfirmPopover(imp, {
        msg: t("dictPackReplaceConfirm"),
        yesText: t("dictPackImport"),
        noText: t("cancel"),
        onConfirm: () => runPackImport(f)
      });
      return;
    }
    await runPackImport(f);
  });
  if (del) del.addEventListener("click", () => {
    showConfirmPopover(del, {
      msg: t("dictPackDeleteConfirm"),
      yesText: t("delete"),
      noText: t("cancel"),
      onConfirm: async () => {
        try {
          await pbpPackDelete();
          await _pbpPackRefreshStatus();
        } catch (_) {
          const status = $id("dict-pack-status");
          if (status) status.textContent = t("dictPackDeleteFailed");
        }
      }
    });
  });
  _pbpPackRefreshStatus();
}
_pbpPackWire();

// ---- Offline English->Chinese pack (ECDICT field layout) -----------------
// No download link and no "open download page" button, unlike the CC-CEDICT
// block above: that dataset's licence is explicit, this one's provenance is
// mixed, so the extension names the format and nothing else.
async function _pbpEcdictRefreshStatus() {
  const el = $id("ecdict-pack-status");
  const del = $id("ecdict-pack-delete");
  if (!el) return;
  let meta;
  try {
    meta = (typeof pbpEcdictMeta === "function") ? await pbpEcdictMeta() : { state: "error" };
  } catch (_) {
    meta = { state: "error" };
  }
  // A database newer than this page cannot be recovered from by retrying; only
  // a reload can. Say so instead of showing a generic read failure.
  if (typeof pbpPackIsStale === "function" && pbpPackIsStale()) {
    el.textContent = t("ecdictStaleReload");
    if (del) del.hidden = true;
    return;
  }
  if (meta && meta.state === "ready") {
    const d = new Date(meta.importedAt);
    el.textContent = t("ecdictReady", String(meta.entries),
      d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"));
    if (del) del.hidden = false;
  } else if (meta && meta.state === "error") {
    el.textContent = t("dictPackReadFailed");
    if (del) del.hidden = true;
  } else {
    // NOT dictPackEmpty: that string names MDBG, CC BY-SA 4.0 and .txt.gz, which
    // belong to the other pack entirely.
    el.textContent = t("ecdictEmpty");
    if (del) del.hidden = true;
  }
}

function _pbpEcdictWire() {
  const imp = $id("ecdict-pack-import");
  const file = $id("ecdict-pack-file");
  const del = $id("ecdict-pack-delete");
  if (!imp || !file) return;
  imp.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files && file.files[0];
    file.value = "";
    if (!f || imp.disabled) return;
    imp.disabled = true;
    const el = $id("ecdict-pack-status");
    let lastShown = 0;
    const tick = (n) => {
      // TIME-based throttle (~1s): aria-live must not machine-gun a screen
      // reader on a long import; the final state comes from the refresh.
      const now = performance.now();
      if (el && now - lastShown >= 1000) { lastShown = now; el.textContent = t("ecdictImporting", String(n)); }
    };
    try {
      // Widest rung, deliberately, and there is no picker: a lookup dictionary
      // earns its keep on the words you actually stopped to look up, and the two
      // narrower rungs exist to prove the predicate is cumulative, not to be
      // shipped. Measured cost of R3 over R1 on the real file: 24.8s vs 10.6s
      // import, 38 MB vs 14 MB stored. All six resource gates pass at R3
      // (scripts/ecdict-import-perf.mjs --fixture real --rung R3).
      const res = await pbpEcdictImportFile(f, { rung: "R3", onParsed: tick, onProgress: tick });
      _pbpVocabFlashLocalStatus("ecdict-pack-action-status", true, t("dictPackDone", String(res.entries)));
    } catch (e) {
      const msg = String((e && e.message) || "");
      // Distinguish "this is not the right kind of file" from "this file is too
      // big for us", because the user's next action differs.
      const key = /not an ECDICT csv|malformed/.test(msg) ? "ecdictNotEcdictFormat"
        // Payload before entry count: a file inside the entry ceiling can still
        // breach the byte ceiling, and "too many entries" would be a lie there.
        : /too large|payload above/.test(msg) ? "ecdictTooLarge"
        : /entry count above/.test(msg) ? "ecdictTooManyEntries"
        : "ecdictParseFailed";
      _pbpVocabFlashLocalStatus("ecdict-pack-action-status", false, t(key));
      // "Wrong file" is an expected outcome the user already sees in the status
      // line; logging it at warn level put it in chrome://extensions' Errors
      // panel, where it reads like the extension broke. Only unexpected faults
      // belong there.
      const expected = key !== "ecdictParseFailed";
      (expected ? console.info : console.warn)("[ecdict] import rejected:", e && e.name, msg);
    } finally {
      imp.disabled = false;
      _pbpEcdictRefreshStatus();
    }
  });
  if (del) del.addEventListener("click", () => {
    showConfirmPopover(del, {
      msg: t("dictPackDeleteConfirm"),
      yesText: t("delete"),
      noText: t("cancel"),
      onConfirm: async () => {
        try {
          await pbpEcdictDelete();
          await _pbpEcdictRefreshStatus();
        } catch (_) {
          const status = $id("ecdict-pack-status");
          if (status) status.textContent = t("dictPackDeleteFailed");
        }
      }
    });
  });
  _pbpEcdictRefreshStatus();
}
_pbpEcdictWire();
