// Paid dictionary output is an archive, not an evictable cache. Each generation
// is immutable and content-addressed; independent additions therefore converge
// by set union without overwriting another device's paid work.
const PBP_DICT_ARCHIVE_DB = "pbp-dict-archive";
// Every category ever written stays readable: this list only grows. What the
// UI may still generate is maintained separately in dict-entry.js.
const PBP_DICT_ARCHIVE_CATEGORIES = Object.freeze([
  "collocations", "confusables", "register", "grammar", "scenarios", "culture", "literature", "etymology",
  "patterns"
]);

function _pbpDictArchiveError(code) { return Object.assign(new Error(code), { code }); }
function _pbpDictArchiveObject(value, keys) {
  return _pbpVocabOnlyKeys(value, keys) && Object.keys(value).length === keys.length;
}
function _pbpDictArchiveText(value, max, empty = false) {
  return typeof value === "string" && value.length <= max && (empty || !!value.trim()) &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}
function _pbpDictArchiveLang(value) {
  try { return typeof value === "string" && value.length <= 80 && Intl.getCanonicalLocales(value)[0] === value; }
  catch (_) { return false; }
}
function _pbpDictArchiveOwner(owner) { return owner === "ownerless" ? "" : owner; }
function _pbpDictArchiveScope(owner) {
  return typeof owner === "string" && owner.length <= 256 && (owner === "" || /^acct_.+/.test(owner));
}
function _pbpDictArchiveLookup(value) {
  // A localized label is not a distinct language. Custom targets whose code
  // is und retain their name because it is their only distinguishing value.
  return JSON.stringify([value.term, value.sourceLanguage, value.target.lang,
    value.target.lang === "und" ? value.target.name : ""]);
}
function _pbpDictArchiveEntry(entry, value) {
  const keys = ["word", "language", "pronunciation", "meanings", "etymology", "relatedWords"];
  const enriched = Object.hasOwn(entry || {}, "learning");
  if (enriched) keys.push("learning");
  return _pbpDictArchiveObject(entry, keys) &&
    entry.word === value.term && entry.language === value.sourceLanguage &&
    _pbpDictArchiveText(entry.pronunciation, 256, true) && _pbpDictArchiveText(entry.etymology, 1200, true) &&
    Array.isArray(entry.meanings) && entry.meanings.length <= 4 && entry.meanings.every(meaning =>
      _pbpDictArchiveObject(meaning, ["partOfSpeech", "definition", "examples"]) &&
      _pbpDictArchiveText(meaning.partOfSpeech, 128, true) && _pbpDictArchiveText(meaning.definition, 1200) &&
      Array.isArray(meaning.examples) && meaning.examples.length <= 2 && meaning.examples.every(example =>
        _pbpDictArchiveObject(example, ["text", "translation"]) &&
        _pbpDictArchiveText(example.text, 600) && _pbpDictArchiveText(example.translation, 600, true))) &&
    Array.isArray(entry.relatedWords) && entry.relatedWords.length <= 8 &&
    entry.relatedWords.every(word => _pbpDictArchiveText(word, 128) && !/[\r\n\t]/.test(word)) &&
    (entry.meanings.length > 0 || (!entry.pronunciation && !entry.etymology && !entry.relatedWords.length)) &&
    (!enriched || _pbpDictArchiveEntryLearning(entry.learning, entry));
}
function _pbpDictArchiveSource(source) {
  const keys = ["title", "url", "excerpt"];
  const enriched = Object.hasOwn(source || {}, "retrievedAt");
  if (enriched) keys.push("author", "work", "location", "language", "genre", "revision", "retrievedAt");
  if (!_pbpDictArchiveObject(source, keys) ||
      !_pbpDictArchiveText(source.title, 200) || !_pbpDictArchiveText(source.url, 2048) ||
      !_pbpDictArchiveText(source.excerpt, enriched ? 600 : 1200, !enriched)) return false;
  if (enriched && (!["author", "work", "location"].every(key => _pbpDictArchiveText(source[key], 200, true)) ||
      !_pbpDictArchiveLang(source.language) || !_pbpDictArchiveText(source.genre, 200) ||
      !_pbpDictArchiveText(source.revision, 80) || !Number.isSafeInteger(source.retrievedAt) || source.retrievedAt <= 0)) return false;
  try { const url = new URL(source.url); return url.protocol === "https:" && !url.username && !url.password; }
  catch (_) { return false; }
}
function _pbpDictArchiveEntryLearning(learning, entry) {
  const keys = ["version", "formation", "history", "related", "sources"];
  const replaces = Object.hasOwn(learning || {}, "replacesId");
  if (replaces) keys.push("replacesId");
  return _pbpDictArchiveObject(learning, keys) &&
    (!replaces || (typeof learning.replacesId === "string" && /^[0-9a-f]{64}$/.test(learning.replacesId))) &&
    learning.version === 2 && _pbpDictArchiveText(learning.formation, 1200, true) &&
    _pbpDictArchiveText(learning.history, 1200, true) &&
    Array.isArray(learning.related) && learning.related.length <= 5 && learning.related.every(item =>
      _pbpDictArchiveObject(item, ["word", "relation", "note"]) &&
      _pbpDictArchiveText(item.word, 128) && !/[\r\n\t]/.test(item.word) &&
      ["family", "cognate", "synonym", "topic"].includes(item.relation) && _pbpDictArchiveText(item.note, 400)) &&
    Array.isArray(learning.sources) && learning.sources.length <= 5 && learning.sources.every(source =>
      _pbpDictArchiveSource(source) && Object.hasOwn(source, "retrievedAt") && source.genre === "etymology") &&
    (!learning.history || learning.sources.length > 0) &&
    (entry.meanings.length > 0 || (!learning.formation && !learning.history && !learning.related.length && !learning.sources.length));
}
function _pbpDictArchiveSupplementLearning(learning, value) {
  const keys = ["version", "language", "summary", "items", "replacesId"];
  const partial = Object.hasOwn(learning || {}, "omittedItems");
  if (partial) keys.push("omittedItems");
  if (!_pbpDictArchiveObject(learning, keys) ||
      learning.version !== 2 || !_pbpDictArchiveObject(learning.language, ["name", "lang"]) ||
      !_pbpDictArchiveText(learning.language.name, 80) || !_pbpDictArchiveLang(learning.language.lang) ||
      !_pbpDictArchiveText(learning.summary, 800, true) ||
      typeof learning.replacesId !== "string" || (learning.replacesId !== "" && !/^[0-9a-f]{64}$/.test(learning.replacesId)) ||
      !Array.isArray(learning.items) || !learning.items.length || learning.items.length > 5 ||
      (partial && (!Number.isSafeInteger(learning.omittedItems) || learning.omittedItems <= 0 ||
        learning.items.length + learning.omittedItems > (value.category === "literature" ? 2 : 5)))) return false;
  return learning.items.every(item => {
    const keys = ["sense", "title", "explanation", "example", "translation", "sourceIndex"];
    if (value.category === "etymology") keys.push("kind");
    if (!_pbpDictArchiveObject(item, keys) ||
        !Number.isSafeInteger(item.sense) || item.sense < 0 || item.sense > 4 ||
        !_pbpDictArchiveText(item.title, 240) || !_pbpDictArchiveText(item.explanation, 1400) ||
        !_pbpDictArchiveText(item.example, 600, true) || !_pbpDictArchiveText(item.translation, 600, true) ||
        !Number.isSafeInteger(item.sourceIndex) || item.sourceIndex < -1 || item.sourceIndex >= value.sources.length) return false;
    const source = value.sources[item.sourceIndex];
    if (value.category === "etymology" &&
        (!["formation", "history", "family", "cognate", "synonym", "topic"].includes(item.kind) ||
        (source && source.genre !== "etymology") || (["history", "cognate"].includes(item.kind) && !source))) return false;
    if (["culture", "literature"].includes(value.category) &&
        (!source || !Object.hasOwn(source, "retrievedAt"))) return false;
    if (value.category !== "literature") return true;
    return source && Object.hasOwn(source, "retrievedAt") &&
      ["novel", "short-story", "poetry", "drama", "literary-essay"].includes(source.genre) &&
      ["author", "work", "location"].every(key => _pbpDictArchiveText(source[key], 200)) &&
      source.language !== "und" && item.example === source.excerpt && !!item.translation.trim();
  });
}
function _pbpDictArchiveValue(value) {
  const common = ["kind", "term", "sourceLanguage", "target", "provider", "model", "generatedAt"];
  const keys = value?.kind === "entry" ? [...common, "entry"] :
    [...common, "archiveId", "category", "profile", "content", "sources"];
  const enriched = value?.kind === "supplement" && Object.hasOwn(value, "learning");
  if (enriched) keys.push("learning");
  if (!_pbpDictArchiveObject(value, keys) || !_pbpDictArchiveText(value.term, 256) ||
      pbpDictNormalizeTerm(value.term) !== value.term || !_pbpDictArchiveLang(value.sourceLanguage) ||
      !_pbpDictArchiveObject(value.target, ["name", "lang"]) || !_pbpDictArchiveText(value.target.name, 80) ||
      !_pbpDictArchiveLang(value.target.lang) || !_pbpDictArchiveText(value.provider, 80) ||
      !_pbpDictArchiveText(value.model, 256) || !Number.isSafeInteger(value.generatedAt) || value.generatedAt <= 0) return false;
  if (value.kind === "entry") return _pbpDictArchiveEntry(value.entry, value);
  return value.kind === "supplement" && /^[0-9a-f]{64}$/.test(value.archiveId) &&
    PBP_DICT_ARCHIVE_CATEGORIES.includes(value.category) &&
    _pbpDictArchiveObject(value.profile, ["nativeLanguage", "level", "topic"]) &&
    _pbpDictArchiveText(value.profile.nativeLanguage, 80, true) &&
    ["", "beginner", "intermediate", "advanced"].includes(value.profile.level) &&
    _pbpDictArchiveText(value.profile.topic, 120, true) && _pbpDictArchiveText(value.content, 12000) &&
    Array.isArray(value.sources) && value.sources.length <= 5 && value.sources.every(_pbpDictArchiveSource) &&
    (!enriched || _pbpDictArchiveSupplementLearning(value.learning, value));
}
function pbpDictArchiveValidateEvent(event) {
  return _pbpDictArchiveObject(event, ["recordKey", "value"]) &&
    /^[0-9a-f]{64}$/.test(event.recordKey) && _pbpDictArchiveValue(event.value);
}
function pbpDictArchiveValidBatchBody(body, ownerHash) {
  return _pbpDictArchiveObject(body, ["schema", "ownerHash", "deviceId", "createdAt", "entries"]) &&
    [1, 2, 3, 4].includes(body.schema) && /^[0-9a-f]{64}$/.test(ownerHash) && body.ownerHash === ownerHash &&
    _pbpVocabDeviceId(body.deviceId) && Number.isFinite(body.createdAt) &&
    Array.isArray(body.entries) && body.entries.every(event => pbpDictArchiveValidateEvent(event) &&
      // Each schema's additions stay legal in every later schema: independent
      // etymology and partial counts from 3, patterns cards from 4.
      (body.schema >= 3 || (event.value.category !== "etymology" && !Object.hasOwn(event.value.learning || {}, "omittedItems"))) &&
      (body.schema >= 4 || event.value.category !== "patterns") &&
      (body.schema >= 2 || (!Object.hasOwn(event.value, "learning") &&
        !Object.hasOwn(event.value.entry || {}, "learning") &&
        (event.value.sources || []).every(source => !Object.hasOwn(source, "retrievedAt")))));
}
async function _pbpDictArchiveHash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(_pbpVocabCanonicalJson(value)));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function _pbpDictArchiveRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
/** @returns {Promise<void>} */
function _pbpDictArchiveDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || _pbpDictArchiveError("local_store"));
  });
}
function _pbpDictArchiveDirty(owner) {
  if (!owner) return;
  try { globalThis.chrome?.runtime?.sendMessage?.({ type: "PBP_DICT_ARCHIVE_DIRTY", owner })?.catch?.(() => {}); }
  catch (_) {}
}

function pbpCreateDictArchiveStore({
  database = globalThis.indexedDB, dbName = PBP_DICT_ARCHIVE_DB,
  getCurrentOwner = async (_options) => {
    const owner = typeof pbpVocabCurrentOwner === "function" ? await pbpVocabCurrentOwner() : null;
    return owner ? _pbpDictArchiveOwner(owner) : null;
  },
  // The worker captures its auth/connection epoch here. Checking a synchronous
  // snapshot inside IDB avoids keeping transactions alive for network requests.
  getWriteGuard = () => () => true,
  readLegacy = async () => {
    if (typeof _pbpAiOpenDB !== "function") throw _pbpDictArchiveError("local_store");
    const db = await _pbpAiOpenDB();
    const prefix = "dictctx2_entry_v1_";
    return _pbpDictArchiveRequest(db.transaction("entries", "readonly").objectStore("entries")
      .getAll(IDBKeyRange.bound(prefix, prefix + "\uffff")));
  }
} = {}) {
  let opened = null;
  const open = () => {
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = database.open(dbName, 1);
      request.onupgradeneeded = () => {
        const records = request.result.createObjectStore("records", { keyPath: "key" });
        records.createIndex("owner", "owner");
        records.createIndex("lookup", ["owner", "lookup"]);
        records.createIndex("parent", ["owner", "parent"]);
        request.result.createObjectStore("sync", { keyPath: "key" });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opened = null; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => console.warn("[dict-archive] database open blocked");
    });
    opened.catch(() => { opened = null; });
    return opened;
  };
  const checkOwner = async (owner, options) => {
    if (!_pbpDictArchiveScope(owner) || await getCurrentOwner(options) !== owner) throw _pbpDictArchiveError("account_changed");
  };
  const checkHash = async (ownerHash, options) => {
    const owner = await getCurrentOwner(options);
    if (!/^acct_.+/.test(owner || "") || await pbpVocabOwnerHash(owner) !== ownerHash) throw _pbpDictArchiveError("account_changed");
    await checkOwner(owner, options);
    return owner;
  };
  const keyOf = (owner, id) => owner + "|" + id;
  const outboxKey = (owner, id) => "outbox:" + owner + ":" + id;
  const batchKey = (permissionId, ownerHash, fileId) => "batch:" + permissionId + ":" + ownerHash + ":" + fileId;
  const readState = async key => _pbpDictArchiveRequest((await open()).transaction("sync", "readonly").objectStore("sync").get(key));
  const stateRows = async prefix => _pbpDictArchiveRequest((await open()).transaction("sync", "readonly").objectStore("sync")
    .getAll(IDBKeyRange.bound(prefix, prefix + "\uffff")));
  const transaction = async (owner, work, options) => {
    const current = getWriteGuard();
    const guard = () => {
      if (current() !== true || (options?.isCurrent && options.isCurrent() !== true)) throw _pbpDictArchiveError("account_changed");
    };
    const db = await open();
    await checkOwner(owner, options);
    guard();
    const tx = db.transaction(["records", "sync"], "readwrite"), done = _pbpDictArchiveDone(tx);
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
      console.warn("[dict-archive] transaction failed:", error?.name);
      throw _pbpDictArchiveError("local_store");
    }
  };
  const rowOf = (owner, event) => ({ key: keyOf(owner, event.recordKey), owner,
    lookup: _pbpDictArchiveLookup(event.value), parent: event.value.kind === "supplement" ? event.value.archiveId : "",
    event });
  const insert = async (owner, event, notify = true, options) => {
    if (!pbpDictArchiveValidateEvent(event) || await _pbpDictArchiveHash(event.value) !== event.recordKey) throw _pbpDictArchiveError("invalid_response");
    const changed = await transaction(owner, async (records, sync) => {
      const key = keyOf(owner, event.recordKey), existing = await _pbpDictArchiveRequest(records.get(key));
      if (existing) {
        if (existing.owner !== owner || !pbpVocabEventContentEqual(existing.event, event)) throw _pbpDictArchiveError("local_store");
        return false;
      }
      records.put(rowOf(owner, event));
      if (owner) sync.put({ key: outboxKey(owner, event.recordKey), owner, recordKey: event.recordKey, event });
      return true;
    }, options);
    if (changed && notify) _pbpDictArchiveDirty(owner);
    return event;
  };
  const entryValue = input => ({ kind: "entry", term: input.term, sourceLanguage: input.sourceLanguage,
    target: input.target, provider: input.record.provider, model: input.record.model,
    generatedAt: input.record.generatedAt, entry: input.record.entry });
  const entryVersions = (rows, owner) => {
    const entries = rows.filter(row => row.owner === owner &&
      row.event.value.kind === "entry" && pbpDictArchiveValidateEvent(row.event));
    // Explicit user updates supersede their originals even when two devices'
    // clocks disagree. Concurrent, unrelated heads retain deterministic order.
    const replaced = new Set(entries.map(row => row.event.value.entry.learning?.replacesId).filter(Boolean));
    return entries.sort((a, b) => Number(replaced.has(a.event.recordKey)) - Number(replaced.has(b.event.recordKey)) ||
      b.event.value.generatedAt - a.event.value.generatedAt || a.event.recordKey.localeCompare(b.event.recordKey));
  };
  const supplementVersions = (rows, owner, entries) => {
    const parents = new Set(entries.map(row => row.event.recordKey));
    return rows.filter(row => row.owner === owner && row.event.value.kind === "supplement" &&
      parents.has(row.event.value.archiveId) && pbpDictArchiveValidateEvent(row.event))
      .map(row => ({ ...row.event.value, id: row.event.recordKey, archiveSaved: true }))
      .sort((a, b) => a.generatedAt - b.generatedAt || a.id.localeCompare(b.id));
  };
  const output = (event, supplements = [], previousEntries = []) => ({ entry: event.value.entry, provider: event.value.provider,
    model: event.value.model, generatedAt: event.value.generatedAt, archiveId: event.recordKey,
    cached: true, cacheSaved: true, archiveSaved: true, supplements, previousEntries });
  const checkReplacement = async (owner, value) => {
    const replacesId = value.kind === "entry" ? value.entry.learning?.replacesId : value.learning?.replacesId;
    if (!replacesId) return;
    if (typeof replacesId !== "string" || !/^[0-9a-f]{64}$/.test(replacesId)) throw _pbpDictArchiveError("invalid_request");
    const row = await _pbpDictArchiveRequest((await open()).transaction("records", "readonly").objectStore("records")
      .get(keyOf(owner, replacesId)));
    if (!row || row.owner !== owner || row.event.value.kind !== value.kind ||
        _pbpDictArchiveLookup(row.event.value) !== _pbpDictArchiveLookup(value) ||
        (value.kind === "supplement" && (row.event.value.category !== value.category ||
          _pbpVocabCanonicalJson(row.event.value.profile) !== _pbpVocabCanonicalJson(value.profile)))) {
      throw _pbpDictArchiveError("invalid_request");
    }
  };
  async function save(input) {
    const owner = _pbpDictArchiveOwner(input.owner), value = structuredClone(entryValue(input));
    await checkOwner(owner);
    await checkReplacement(owner, value);
    const event = { recordKey: await _pbpDictArchiveHash(value), value };
    await insert(owner, event, true, { isCurrent: input.isCurrent });
    const rows = await _pbpDictArchiveRequest((await open()).transaction("records", "readonly").objectStore("records")
      .index("lookup").getAll([owner, _pbpDictArchiveLookup(value)]));
    await checkOwner(owner);
    const entries = entryVersions(rows, owner);
    return output(event, supplementVersions(rows, owner, entries), entries.filter(row => row.event.recordKey !== event.recordKey)
      .map(row => output(row.event)));
  }
  async function append(input) {
    const owner = _pbpDictArchiveOwner(input.owner);
    await checkOwner(owner);
    const parent = await _pbpDictArchiveRequest((await open()).transaction("records", "readonly")
      .objectStore("records").get(keyOf(owner, input.archiveId)));
    if (!parent || parent.owner !== owner || parent.event.value.kind !== "entry") throw _pbpDictArchiveError("invalid_request");
    const base = parent.event.value;
    const value = { kind: "supplement", term: base.term, sourceLanguage: base.sourceLanguage, target: base.target,
      provider: input.provider, model: input.model, generatedAt: input.generatedAt,
      archiveId: input.archiveId, category: input.category, profile: structuredClone(input.profile),
      content: input.content, sources: structuredClone(input.sources || []) };
    if (Object.hasOwn(input, "learning")) value.learning = structuredClone(input.learning);
    await checkReplacement(owner, value);
    const event = { recordKey: await _pbpDictArchiveHash(value), value };
    await insert(owner, event, true, { isCurrent: input.isCurrent }); await checkOwner(owner);
    return { ...value, id: event.recordKey, archiveSaved: true };
  }
  async function migrate(owner) {
    await checkOwner(owner);
    const key = "legacy:" + owner;
    if (await readState(key)) return { ok: true, processed: 0 };
    const rows = await readLegacy();
    await checkOwner(owner);
    let processed = 0;
    for (const row of rows) {
      const cached = row?.result;
      if (cached?.version !== 1 || _pbpDictArchiveOwner(cached.owner) !== owner) continue;
      const value = entryValue({ ...cached, record: cached });
      if (!_pbpDictArchiveValue(value)) continue;
      await insert(owner, { recordKey: await _pbpDictArchiveHash(value), value }, false);
      processed++;
    }
    await transaction(owner, async (_records, sync) => { sync.put({ key, complete: true }); });
    await checkOwner(owner);
    if (processed) _pbpDictArchiveDirty(owner);
    return { ok: true, processed };
  }
  async function read(input) {
    const owner = _pbpDictArchiveOwner(input.owner);
    await migrate(owner);
    const db = await open(); await checkOwner(owner);
    const rows = await _pbpDictArchiveRequest(db.transaction("records", "readonly").objectStore("records")
      .index("lookup").getAll([owner, _pbpDictArchiveLookup(input)]));
    const entries = entryVersions(rows, owner);
    if (!entries.length) { await checkOwner(owner); return null; }
    const event = entries[0].event;
    const additions = supplementVersions(rows, owner, entries);
    await checkOwner(owner);
    return output(event, additions, entries.slice(1).map(row => output(row.event)));
  }
  async function getMeta() {
    const db = await open(), tx = db.transaction("sync", "readwrite"), done = _pbpDictArchiveDone(tx);
    try {
      const sync = tx.objectStore("sync");
      let meta = await _pbpDictArchiveRequest(sync.get("meta"));
      if (!meta) { meta = { key: "meta", deviceId: crypto.randomUUID() }; sync.put(meta); }
      await done;
      if (!_pbpVocabDeviceId(meta.deviceId)) throw _pbpDictArchiveError("local_store");
      return meta;
    } catch (error) {
      try { tx.abort(); } catch (_) {}
      await done.catch(() => {});
      console.warn("[dict-archive] device metadata unavailable:", error?.name);
      throw _pbpDictArchiveError("local_store");
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
      const key = "active:" + ownerHash, previous = await _pbpDictArchiveRequest(sync.get(key));
      if (previous?.permissionId === permissionId) return true;
      const stateKey = "account:" + permissionId + ":" + ownerHash;
      const state = await _pbpDictArchiveRequest(sync.get(stateKey));
      if (state) sync.put({ ...state, needsCheckpoint: true });
      sync.put({ key, permissionId }); return true;
    });
  }
  async function checkpointOwner(owner) {
    return transaction(owner, async (records, sync) => {
      const rows = await _pbpDictArchiveRequest(records.index("owner").getAll(owner));
      for (const row of rows) sync.put({ key: outboxKey(owner, row.event.recordKey), owner,
        recordKey: row.event.recordKey, event: row.event });
      return rows.length;
    });
  }
  async function applyRemotePage(owner, ownerHash, batches, cursorCommit) {
    if (!Array.isArray(batches) || !batches.every(body => pbpDictArchiveValidBatchBody(body, ownerHash)) ||
        (cursorCommit != null && !validState(cursorCommit, ownerHash))) return { ok: false, error: "invalid_remote_page" };
    const events = batches.flatMap(body => body.entries);
    for (const event of events) if (await _pbpDictArchiveHash(event.value) !== event.recordKey) return { ok: false, error: "invalid_remote_page" };
    if (await checkHash(ownerHash) !== owner) return { ok: false, error: "account_changed" };
    return transaction(owner, async (records, sync) => {
      let applied = 0, ignored = 0;
      for (const event of events) {
        const row = rowOf(owner, event), existing = await _pbpDictArchiveRequest(records.get(row.key));
        if (existing) {
          if (existing.owner !== owner || !pbpVocabEventContentEqual(existing.event, event)) throw _pbpDictArchiveError("invalid_remote_page");
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
    if (!permissionId || !fileId || !pbpDictArchiveValidBatchBody(body, ownerHash) || !body.entries.length) return false;
    if (await checkHash(ownerHash) !== owner) return false;
    return transaction(owner, async (records, sync) => {
      const key = batchKey(permissionId, ownerHash, fileId), old = await _pbpDictArchiveRequest(sync.get(key));
      if (old && old.body !== batch.body) throw _pbpDictArchiveError("local_store");
      for (const event of body.entries) {
        const row = await _pbpDictArchiveRequest(records.get(keyOf(owner, event.recordKey)));
        if (!row || !pbpVocabEventContentEqual(row.event, event)) throw _pbpDictArchiveError("local_store");
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
      _pbpDictArchiveRequest(sync.getAll(IDBKeyRange.bound("account:", "account:\uffff"))),
      _pbpDictArchiveRequest(sync.getAllKeys(IDBKeyRange.bound("outbox:" + owner + ":", "outbox:" + owner + ":\uffff"))),
      _pbpDictArchiveRequest(sync.getAllKeys(IDBKeyRange.bound("batch:", "batch:\uffff")))
    ]);
    return { states: states.filter(row => row.ownerHash === ownerHash), outbox,
      batches: keys.flatMap(key => {
        const parts = key.split(":");
        return parts[2] === ownerHash ? [{ key, drivePermissionId: parts[1], ownerHash }] : [];
      }), notices: [] };
  }
  return { save, append, read, migrate, getMeta, getAccountState, getPreflightState, putAccountState,
    putPreflightState, deletePreflightState, activateAccount, checkpointOwner, applyRemotePage, listOutbox,
    listPendingBatches, freezeOutbox, deletePendingBatch, snapshot,
    seedLegacy: owner => migrate(owner), close: async () => { if (opened) (await opened).close(); opened = null; } };
}

let _pbpDictArchiveStore = null;
function _pbpDictArchiveDefaultStore() { return _pbpDictArchiveStore ||= pbpCreateDictArchiveStore(); }
const pbpDictArchiveRead = input => _pbpDictArchiveDefaultStore().read(input);
const pbpDictArchiveSave = input => _pbpDictArchiveDefaultStore().save(input);
const pbpDictArchiveAppend = input => _pbpDictArchiveDefaultStore().append(input);
