// Completed Ask answers are durable, immutable records. Sessions group answers;
// explicit deletion adds a permanent session tombstone so late/offline answers
// cannot resurrect a conversation. A new conversation always uses a new ID.
const PBP_ASK_ARCHIVE_DB = "pbp-ask-archive";
function _pbpAskArchiveError(code) { return Object.assign(new Error(code), { code }); }
function _pbpAskArchiveObject(value, keys) {
  return _pbpVocabOnlyKeys(value, keys) && Object.keys(value).length === keys.length;
}
function _pbpAskArchiveText(value, max, empty = false) {
  return typeof value === "string" && value.length <= max && (empty || !!value.trim()) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function _pbpAskArchiveOwner(owner) { return owner === "ownerless" ? "" : owner; }
function _pbpAskArchiveScope(owner) {
  return typeof owner === "string" && owner.length <= 256 && (owner === "" || /^acct_.+/.test(owner));
}
function _pbpAskArchiveId(value) { return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value); }
function _pbpAskArchiveUrl(value, empty = false) {
  if (empty && value === "") return true;
  if (!_pbpAskArchiveText(value, 8192)) return false;
  try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password; }
  catch (_) { return false; }
}
function _pbpAskArchiveUrlNorm(value) {
  if (!_pbpAskArchiveUrl(value)) throw _pbpAskArchiveError("invalid_request");
  // Match reader cache identity also in the worker/library, where md-ai-core
  // is not loaded. Hash routes identify distinct articles and must survive.
  const url = new URL(value);
  if (!/^#[!/]/.test(url.hash)) url.hash = "";
  return typeof stripTrackingParams === "function" ? stripTrackingParams(url.href).cleaned || url.href : url.href;
}
function _pbpAskArchiveRecord(record) {
  return _pbpAskArchiveObject(record, ["q", "a", "cites", "ts", "model", "blocksHash", "evidence"]) &&
    _pbpAskArchiveText(record.q, 32000) && _pbpAskArchiveText(record.a, 512000) &&
    Number.isSafeInteger(record.ts) && record.ts > 0 &&
    _pbpAskArchiveText(record.model, 512, true) && _pbpAskArchiveText(record.blocksHash, 256, true) &&
    Array.isArray(record.cites) && record.cites.length <= 512 && record.cites.every(cite =>
      _pbpAskArchiveObject(cite, ["p", "quote"]) && Number.isSafeInteger(cite.p) && cite.p > 0 &&
      _pbpAskArchiveText(cite.quote, 8000, true)) &&
    Array.isArray(record.evidence) && record.evidence.length <= 512 && record.evidence.every(evidence =>
      _pbpAskArchiveObject(evidence, evidence.time === undefined ? ["p", "quote", "state", "sourceUrl"] :
        ["p", "quote", "state", "sourceUrl", "time", "deepUrl"]) &&
      Number.isSafeInteger(evidence.p) && evidence.p > 0 && _pbpAskArchiveText(evidence.quote, 8000, true) &&
      ["matched", "unverified", "source-changed"].includes(evidence.state) && _pbpAskArchiveUrl(evidence.sourceUrl, true) &&
      (evidence.time === undefined || (Number.isFinite(evidence.time) && evidence.time >= 0 && _pbpAskArchiveUrl(evidence.deepUrl))));
}
// Reader-side cleaning to the exact shape the validator above accepts. A model
// answer can carry a P0 cite, a huge P number or a stray control character;
// without this the completed answer could never be written and Retry would
// fail forever. The reader keeps this cleaned copy in memory too, so what the
// session shows is what the archive stores.
function _pbpAskArchiveClean(value, max) {
  return String(value == null ? "" : value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").slice(0, max);
}
function pbpAskArchiveSafeTitle(title) { return _pbpAskArchiveClean(title, 2048); }
function pbpAskArchiveSafeRecord(record) {
  const keep = (p) => Number.isSafeInteger(p) && p > 0;
  const out = { ...record };
  out.q = _pbpAskArchiveClean(record.q, 32000);
  out.a = _pbpAskArchiveClean(record.a, 512000);
  out.model = _pbpAskArchiveClean(record.model, 512);
  out.cites = (Array.isArray(record.cites) ? record.cites : []).filter((c) => c && keep(c.p)).slice(0, 512)
    .map((c) => ({ p: c.p, quote: _pbpAskArchiveClean(c.quote, 8000) }));
  out.evidence = (Array.isArray(record.evidence) ? record.evidence : []).filter((e) => e && keep(e.p)).slice(0, 512)
    .map((e) => ({ ...e, quote: _pbpAskArchiveClean(e.quote, 8000) }));
  return out;
}
function _pbpAskArchiveValue(value) {
  if (value?.kind === "delete") return _pbpAskArchiveObject(value, ["kind", "sessionId", "deletedAt"]) &&
    _pbpAskArchiveId(value.sessionId) && Number.isSafeInteger(value.deletedAt) && value.deletedAt > 0;
  return _pbpAskArchiveObject(value, ["kind", "sessionId", "url", "title", "replacesId", "record"]) &&
    value.kind === "round" && _pbpAskArchiveId(value.sessionId) && _pbpAskArchiveUrl(value.url) &&
    _pbpAskArchiveText(value.title, 2048, true) && (value.replacesId === "" || /^[0-9a-f]{64}$/.test(value.replacesId)) &&
    _pbpAskArchiveRecord(value.record);
}
function pbpAskArchiveValidateEvent(event) {
  return _pbpAskArchiveObject(event, ["recordKey", "value"]) &&
    /^[0-9a-f]{64}$/.test(event.recordKey) && _pbpAskArchiveValue(event.value);
}
function pbpAskArchiveValidBatchBody(body, ownerHash) {
  return _pbpAskArchiveObject(body, ["schema", "ownerHash", "deviceId", "createdAt", "entries"]) &&
    body.schema === 1 && /^[0-9a-f]{64}$/.test(ownerHash) && body.ownerHash === ownerHash &&
    _pbpVocabDeviceId(body.deviceId) && Number.isFinite(body.createdAt) &&
    Array.isArray(body.entries) && body.entries.every(pbpAskArchiveValidateEvent);
}
// Owner hashing is also needed by reader/library to inspect pending batches.
// Keep this client-side helper independent of the worker-only Drive transport.
// The wire owner is SHA-256 of raw UTF-8, not canonical JSON (which adds quotes).
async function _pbpAskArchiveOwnerHash(owner) {
  if (typeof owner !== "string" || !owner) throw new TypeError("invalid owner");
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function _pbpAskArchiveHash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(_pbpVocabCanonicalJson(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function _pbpAskArchiveRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
/** @returns {Promise<void>} */
function _pbpAskArchiveDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || _pbpAskArchiveError("local_store"));
  });
}
function _pbpAskArchiveDirty(owner) {
  if (!owner) return;
  try { globalThis.chrome?.runtime?.sendMessage?.({ type: "PBP_ASK_ARCHIVE_DIRTY", owner })?.catch?.(() => {}); }
  catch (_) {}
}

function pbpCreateAskArchiveStore({
  database = globalThis.indexedDB, dbName = PBP_ASK_ARCHIVE_DB,
  getCurrentOwner = async (_options) => {
    const owner = typeof pbpVocabCurrentOwner === "function" ? await pbpVocabCurrentOwner() : null;
    return owner ? _pbpAskArchiveOwner(owner) : null;
  },
  // The worker captures its auth/connection epoch here. Checking a synchronous
  // snapshot inside IDB avoids keeping transactions alive for network requests.
  getWriteGuard = () => () => true
} = {}) {
  let opened = null;
  const open = () => {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = database.open(dbName, 1);
      request.onupgradeneeded = () => {
        const records = request.result.createObjectStore("records", { keyPath: "key" });
        records.createIndex("owner", "owner");
        records.createIndex("session", ["owner", "sessionId"]);
        records.createIndex("url", ["owner", "url"]);
        request.result.createObjectStore("sync", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opened = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => console.warn("[ask-archive] database open blocked");
    });
    opened.catch(() => { opened = null; });
    return opened;
  };
  const checkOwner = async (owner, options) => {
    if (!_pbpAskArchiveScope(owner) || await getCurrentOwner(options) !== owner) throw _pbpAskArchiveError("account_changed");
  };
  const checkHash = async (ownerHash, options) => {
    const owner = await getCurrentOwner(options);
    if (!/^acct_.+/.test(owner || "") || await _pbpAskArchiveOwnerHash(owner) !== ownerHash) throw _pbpAskArchiveError("account_changed");
    await checkOwner(owner, options);
    return owner;
  };
  const keyOf = (owner, id) => owner + "|" + id;
  const outboxKey = (owner, id) => "outbox:" + owner + ":" + id;
  const batchKey = (permissionId, ownerHash, fileId) => "batch:" + permissionId + ":" + ownerHash + ":" + fileId;
  const readState = async key => _pbpAskArchiveRequest((await open()).transaction("sync", "readonly").objectStore("sync").get(key));
  const stateRows = async prefix => _pbpAskArchiveRequest((await open()).transaction("sync", "readonly").objectStore("sync")
    .getAll(IDBKeyRange.bound(prefix, prefix + "\uffff")));
  const transaction = async (owner, work, options) => {
    const current = getWriteGuard();
    const guard = () => {
      if (current() !== true || (options?.isCurrent && options.isCurrent() !== true)) throw _pbpAskArchiveError("account_changed");
    };
    const db = await open();
    await checkOwner(owner, options);
    guard();
    const tx = db.transaction(["records", "sync"], "readwrite"), done = _pbpAskArchiveDone(tx);
    try {
      const result = await work(tx.objectStore("records"), tx.objectStore("sync"));
      // The final request's microtask runs before IDB can auto-commit. Abort
      // every record and cursor write if the captured account moved meanwhile.
      guard();
      await done;
      return result;
    }
    catch (error) {
      try { tx.abort(); } catch (_) {}
      await done.catch(() => {});
      if (typeof error?.code === "string") throw error;
      console.warn("[ask-archive] transaction failed:", error?.name);
      throw _pbpAskArchiveError("local_store");
    }
  };
  const rowOf = (owner, event) => ({ key: keyOf(owner, event.recordKey), owner,
    sessionId: event.value.sessionId, url: event.value.url || "", event });
  const insert = async (owner, event, notify = true, options) => {
    if (!pbpAskArchiveValidateEvent(event) || await _pbpAskArchiveHash(event.value) !== event.recordKey) throw _pbpAskArchiveError("invalid_response");
    const changed = await transaction(owner, async (records, sync) => {
      if (event.value.kind === "round") {
        const siblings = await _pbpAskArchiveRequest(records.index("session").getAll([owner, event.value.sessionId]));
        if (siblings.some(row => row.event.value.kind === "delete")) throw _pbpAskArchiveError("session_deleted");
        if (siblings.some(row => row.event.value.url !== event.value.url)) throw _pbpAskArchiveError("invalid_request");
        if (event.value.replacesId && !siblings.some(row => row.event.recordKey === event.value.replacesId)) {
          throw _pbpAskArchiveError("invalid_request");
        }
      }
      const key = keyOf(owner, event.recordKey), existing = await _pbpAskArchiveRequest(records.get(key));
      if (existing) {
        if (existing.owner !== owner || !pbpVocabEventContentEqual(existing.event, event)) throw _pbpAskArchiveError("local_store");
        return false;
      }
      records.put(rowOf(owner, event));
      if (owner) sync.put({ key: outboxKey(owner, event.recordKey), owner, recordKey: event.recordKey, event });
      return true;
    }, options);
    if (changed && notify) _pbpAskArchiveDirty(owner);
    return event;
  };
  async function append(input) {
    const owner = _pbpAskArchiveOwner(input.owner);
    const value = { kind: "round", sessionId: input.sessionId, url: _pbpAskArchiveUrlNorm(input.url),
      title: input.title || "", replacesId: input.replacesId || "", record: structuredClone(input.record) };
    await checkOwner(owner);
    const event = { recordKey: await _pbpAskArchiveHash(value), value };
    await insert(owner, event, true, { isCurrent: input.isCurrent });
    await checkOwner(owner);
    return { ...value.record, id: event.recordKey, replacesId: value.replacesId, archiveSaved: true };
  }
  async function remove(input) {
    const owner = _pbpAskArchiveOwner(input.owner);
    await checkOwner(owner);
    const value = { kind: "delete", sessionId: input.sessionId, deletedAt: Date.now() };
    await insert(owner, { recordKey: await _pbpAskArchiveHash(value), value }, true, { isCurrent: input.isCurrent });
    await checkOwner(owner);
    return { ok: true };
  }
  async function migrate(input) {
    const owner = _pbpAskArchiveOwner(input.owner), url = _pbpAskArchiveUrlNorm(input.url);
    await checkOwner(owner);
    const sessionId = "legacy_" + await _pbpAskArchiveHash(url), key = "legacy:" + owner + ":" + sessionId;
    if (await readState(key)) return { ok: true, processed: 0, sessionId };
    const records = Array.isArray(input.records) ? input.records : [];
    let processed = 0;
    // Import only complete, already owner-scoped rows. A malformed cache row
    // cannot turn a partial answer into a durable completed answer.
    for (const cached of records) {
      if (!cached || cached.partial || cached.aborted || cached.deleted || (cached.status && cached.status !== "completed")) continue;
      const record = { q: cached.q, a: cached.a, ts: cached.ts, model: cached.model || "",
        blocksHash: cached.blocksHash || "", cites: cached.cites || [], evidence: cached.evidence || [] };
      if (!_pbpAskArchiveRecord(record)) continue;
      try { await append({ ...input, owner, url, sessionId, record }); processed++; }
      catch (error) { if (error?.code !== "session_deleted") throw error; }
    }
    await transaction(owner, async (_records, sync) => { sync.put({ key, complete: true }); }, { isCurrent: input.isCurrent });
    await checkOwner(owner);
    return { ok: true, processed, sessionId };
  }
  async function read(input) {
    const owner = _pbpAskArchiveOwner(input.owner), url = input.url ? _pbpAskArchiveUrlNorm(input.url) : "";
    const db = await open(); await checkOwner(owner);
    const records = db.transaction("records", "readonly").objectStore("records");
    let rows, deleted;
    if (url && !input.sessionId) {
      // The reader asks for one article on every focus; read only its rounds.
      // Delete tombstones carry no URL, so check each session found here.
      rows = await _pbpAskArchiveRequest(records.index("url").getAll([owner, url]));
      const ids = [...new Set(rows.map(row => row.sessionId))];
      const siblings = await Promise.all(ids.map(id => _pbpAskArchiveRequest(records.index("session").getAll([owner, id]))));
      deleted = new Set(siblings.flat().filter(row => row.owner === owner && row.event.value.kind === "delete").map(row => row.sessionId));
    } else {
      rows = await _pbpAskArchiveRequest(records.index(input.sessionId ? "session" : "owner")
        .getAll(input.sessionId ? [owner, input.sessionId] : owner));
      deleted = new Set(rows.filter(row => row.owner === owner && row.event.value.kind === "delete").map(row => row.sessionId));
    }
    const sessions = new Map();
    for (const row of rows) {
      if (row.owner !== owner || row.event.value.kind !== "round" || deleted.has(row.sessionId) ||
          (url && row.url !== url) || !pbpAskArchiveValidateEvent(row.event)) continue;
      const value = row.event.value;
      let session = sessions.get(value.sessionId);
      if (!session) { session = { id: value.sessionId, url: value.url, title: value.title,
        createdAt: value.record.ts, updatedAt: value.record.ts, records: [], hasPending: false }; sessions.set(value.sessionId, session); }
      // Session IDs are opaque and generated by a device. A malicious peer
      // reusing one ID for another URL cannot change its article silently.
      if (session.url !== value.url) continue;
      session.records.push({ ...value.record, id: row.event.recordKey, replacesId: value.replacesId });
      session.createdAt = Math.min(session.createdAt, value.record.ts);
      session.updatedAt = Math.max(session.updatedAt, value.record.ts);
    }
    const pending = await stateRows("outbox:" + owner + ":");
    const frozen = await stateRows("batch:");
    const pendingSessions = new Set(pending.map(row => row.event?.value?.sessionId));
    const ownerHash = owner ? await _pbpAskArchiveOwnerHash(owner) : "";
    for (const row of frozen) if (ownerHash && row.ownerHash === ownerHash) {
      try { for (const event of JSON.parse(row.body).entries) pendingSessions.add(event.value.sessionId); }
      catch (error) { console.warn("[ask-archive] pending upload unreadable:", error?.name); throw _pbpAskArchiveError("local_store"); }
    }
    for (const session of sessions.values()) {
      session.records.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
      session.hasPending = pendingSessions.has(session.id);
    }
    await checkOwner(owner);
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  async function getMeta() {
    const db = await open(), tx = db.transaction("sync", "readwrite"), done = _pbpAskArchiveDone(tx);
    try {
      const sync = tx.objectStore("sync");
      let meta = await _pbpAskArchiveRequest(sync.get("meta"));
      if (!meta) { meta = { key: "meta", deviceId: crypto.randomUUID() }; sync.put(meta); }
      await done;
      if (!_pbpVocabDeviceId(meta.deviceId)) throw _pbpAskArchiveError("local_store");
      return meta;
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      await done.catch(() => {});
      console.warn("[ask-archive] device metadata unavailable:", error?.name);
      throw _pbpAskArchiveError("local_store");
    }
  }
  const getAccountState = (permissionId, ownerHash) => readState("account:" + permissionId + ":" + ownerHash);
  const getPreflightState = ownerHash => readState("preflight:" + ownerHash);
  const validState = (state, ownerHash) => _pbpVocabPlainObject(state) && state.ownerHash === ownerHash &&
    typeof state.drivePermissionId === "string" && !!state.drivePermissionId &&
    state.key === "account:" + state.drivePermissionId + ":" + ownerHash;
  async function putAccountState(state) {
    if (!validState(state, state?.ownerHash)) return false;
    const owner = await checkHash(state.ownerHash);
    await transaction(owner, async (_records, sync) => { sync.put(state); }); return true;
  }
  async function putPreflightState(state) {
    if (state?.key !== "preflight:" + state?.ownerHash) return false;
    const options = { requireDriveAccount: false }, owner = await checkHash(state.ownerHash, options);
    await transaction(owner, async (_records, sync) => { sync.put(state); }, options); return true;
  }
  async function deletePreflightState(ownerHash) {
    const options = { requireDriveAccount: false }, owner = await checkHash(ownerHash, options);
    await transaction(owner, async (_records, sync) => { sync.delete("preflight:" + ownerHash); }, options); return true;
  }
  async function activateAccount(permissionId, ownerHash) {
    const owner = await checkHash(ownerHash);
    return transaction(owner, async (_records, sync) => {
      const key = "active:" + ownerHash, previous = await _pbpAskArchiveRequest(sync.get(key));
      if (previous?.permissionId === permissionId) return true;
      const stateKey = "account:" + permissionId + ":" + ownerHash;
      const state = await _pbpAskArchiveRequest(sync.get(stateKey));
      if (state) sync.put({ ...state, needsCheckpoint: true });
      sync.put({ key, permissionId }); return true;
    });
  }
  async function checkpointOwner(owner) {
    return transaction(owner, async (records, sync) => {
      const rows = await _pbpAskArchiveRequest(records.index("owner").getAll(owner));
      for (const row of rows) sync.put({ key: outboxKey(owner, row.event.recordKey), owner,
        recordKey: row.event.recordKey, event: row.event });
      return rows.length;
    });
  }
  async function applyRemotePage(owner, ownerHash, batches, cursorCommit) {
    if (!Array.isArray(batches) || !batches.every(body => pbpAskArchiveValidBatchBody(body, ownerHash)) ||
        (cursorCommit != null && !validState(cursorCommit, ownerHash))) return { ok: false, error: "invalid_remote_page" };
    const events = batches.flatMap(body => body.entries);
    for (const event of events) if (await _pbpAskArchiveHash(event.value) !== event.recordKey) return { ok: false, error: "invalid_remote_page" };
    if (await checkHash(ownerHash) !== owner) return { ok: false, error: "account_changed" };
    return transaction(owner, async (records, sync) => {
      let applied = 0, ignored = 0;
      for (const event of events) {
        const row = rowOf(owner, event), existing = await _pbpAskArchiveRequest(records.get(row.key));
        if (existing) {
          if (existing.owner !== owner || !pbpVocabEventContentEqual(existing.event, event)) throw _pbpAskArchiveError("invalid_remote_page");
          ignored++; continue;
        }
        records.put(row); applied++;
      }
      if (cursorCommit) sync.put(cursorCommit);
      return { ok: true, applied, ignored, merged: 0 };
    });
  }
  const listOutbox = owner => stateRows("outbox:" + owner + ":");
  const listPendingBatches = (permissionId, ownerHash) => stateRows(batchKey(permissionId, ownerHash, ""));
  async function freezeOutbox(owner, permissionId, ownerHash, fileId, batch) {
    let body; try { body = JSON.parse(batch.body); } catch (_) { return false; }
    if (!permissionId || !fileId || !pbpAskArchiveValidBatchBody(body, ownerHash) || !body.entries.length) return false;
    if (await checkHash(ownerHash) !== owner) return false;
    return transaction(owner, async (records, sync) => {
      const key = batchKey(permissionId, ownerHash, fileId), old = await _pbpAskArchiveRequest(sync.get(key));
      if (old && old.body !== batch.body) throw _pbpAskArchiveError("local_store");
      for (const event of body.entries) {
        const row = await _pbpAskArchiveRequest(records.get(keyOf(owner, event.recordKey)));
        if (!row || !pbpVocabEventContentEqual(row.event, event)) throw _pbpAskArchiveError("local_store");
        sync.delete(outboxKey(owner, event.recordKey));
      }
      const frozen = { key, drivePermissionId: permissionId, ownerHash, driveFileId: fileId, body: batch.body, bytes: batch.bytes };
      sync.put(frozen); return frozen;
    });
  }
  async function deletePendingBatch(permissionId, ownerHash, fileId) {
    const owner = await checkHash(ownerHash);
    await transaction(owner, async (_records, sync) => { sync.delete(batchKey(permissionId, ownerHash, fileId)); }); return true;
  }
  async function snapshot(owner, ownerHash) {
    const db = await open(), sync = db.transaction("sync", "readonly").objectStore("sync");
    const [states, outbox, keys] = await Promise.all([
      _pbpAskArchiveRequest(sync.getAll(IDBKeyRange.bound("account:", "account:\uffff"))),
      _pbpAskArchiveRequest(sync.getAllKeys(IDBKeyRange.bound("outbox:" + owner + ":", "outbox:" + owner + ":\uffff"))),
      _pbpAskArchiveRequest(sync.getAllKeys(IDBKeyRange.bound("batch:", "batch:\uffff")))
    ]);
    return { states: states.filter(row => row.ownerHash === ownerHash), outbox,
      batches: keys.flatMap(key => {
        const parts = key.split(":");
        return parts[2] === ownerHash ? [{ key, drivePermissionId: parts[1], ownerHash }] : [];
      }), notices: [] };
  }
  return { append, read, remove, migrate, getMeta, getAccountState, getPreflightState, putAccountState,
    putPreflightState, deletePreflightState, activateAccount, checkpointOwner, applyRemotePage, listOutbox,
    listPendingBatches, freezeOutbox, deletePendingBatch, snapshot,
    seedLegacy: async () => ({ ok: true, processed: 0 }), close: async () => { if (opened) (await opened).close(); opened = null; } };
}

let _pbpAskArchiveStore = null;
function _pbpAskArchiveDefaultStore() { return _pbpAskArchiveStore ||= pbpCreateAskArchiveStore(); }
const pbpAskArchiveRead = input => _pbpAskArchiveDefaultStore().read(input);
const pbpAskArchiveAppend = input => _pbpAskArchiveDefaultStore().append(input);
const pbpAskArchiveMigrate = input => _pbpAskArchiveDefaultStore().migrate(input);
const pbpAskArchiveDelete = input => _pbpAskArchiveDefaultStore().remove(input);
