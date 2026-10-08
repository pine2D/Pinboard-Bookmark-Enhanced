// Highlights remain authoritative in chrome.storage.local. Version metadata
// and pending IDs live INSIDE the same article record, so one set persists a
// user edit and its durable sync intent together. All producers share pbp-hl:.
const PBP_NOTES_SYNC_PREFIX = "pbp_notes_sync_";
const PBP_NOTES_DEVICE_KEY = "pbpNotesSyncDeviceId";
const PBP_NOTES_SYNC_RECORD_LOCK_PREFIX = "pbp-hl:";

function pbpNotesArticleKey(url) {
  // Same FNV-1a identity as the reader's pbpAiHash; no reader dependency in SW.
  const text = String(url || "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return "pbp_hl_" + hash.toString(16).padStart(8, "0");
}

function _pbpNotesIdentity(recordKey) {
  if (typeof recordKey !== "string") return null;
  const at = recordKey.indexOf("|");
  const key = recordKey.slice(0, at);
  if (!/^pbp_hl_[0-9a-f]{8}$/.test(key)) return null;
  try {
    const id = decodeURIComponent(recordKey.slice(at + 1));
    return id && id.length <= 512 && id === id.normalize("NFC") &&
      recordKey === key + "|" + encodeURIComponent(id) ? {key,id} : null;
  } catch (_) { return null; }
}

function _pbpNotesItemValue(item) {
  const out = {};
  for (const key of ["id","n","quote","prefix","suffix","color","note","ts","fp","side","lang","noteVariants"]) {
    if (Object.hasOwn(item,key)) out[key] = item[key];
  }
  out.prefix = typeof out.prefix === "string" ? out.prefix : "";
  out.suffix = typeof out.suffix === "string" ? out.suffix : "";
  out.note = typeof out.note === "string" ? out.note : "";
  return out;
}

function pbpNotesValidateEvent(event, expectedRecordKey, leaf = false) {
  if (!_pbpVocabOnlyKeys(event,["recordKey","vector","dot","deleted","value","versions"]) ||
      Object.keys(event).length !== (event.deleted === true ? 4 : 5) + (event.versions === undefined ? 0 : 1) ||
      !_pbpNotesIdentity(event.recordKey) ||
      (expectedRecordKey !== undefined && event.recordKey !== expectedRecordKey) ||
      !_pbpVocabValidVector(event.vector) ||
      !_pbpVocabOnlyKeys(event.dot,["deviceId","counter"]) || Object.keys(event.dot).length !== 2 ||
      typeof event.deleted !== "boolean") return false;
  try {
    if (pbpVocabDotCompare(event.dot,event.dot) !== 0 ||
        _pbpVocabOwnValue(event.vector,event.dot.deviceId) < event.dot.counter) return false;
  } catch (_) { return false; }
  if (event.versions !== undefined) {
    if (leaf || !_pbpVocabDenseArray(event.versions) || event.versions.length < 2 ||
        !event.versions.every(version=>pbpNotesValidateEvent(version,event.recordKey,true)) ||
        !_pbpNotesFrontierValid(event.versions,event.vector)) return false;
    const projected=_pbpNotesProject(event.recordKey,event.vector,event.versions);
    const actual={...event};delete actual.versions;
    if (!pbpVocabEventContentEqual(actual,projected.event)) return false;
  }
  if (event.deleted) return !Object.hasOwn(event,"value");
  const value = event.value, item = value?.item;
  const identity = _pbpNotesIdentity(event.recordKey);
  if (!_pbpVocabOnlyKeys(value,["url","title","item"]) || Object.keys(value).length !== 3 ||
      typeof value.url !== "string" || !value.url || pbpDictSafeUrl(value.url) !== value.url ||
      pbpNotesArticleKey(value.url) !== identity.key || typeof value.title !== "string" ||
      !_pbpVocabOnlyKeys(item,["id","n","quote","prefix","suffix","color","note","ts","fp","side","lang","noteVariants"]) ||
      item.id !== identity.id || !Number.isSafeInteger(item.n) || item.n < 0 ||
      typeof item.quote !== "string" || !item.quote || typeof item.prefix !== "string" ||
      typeof item.suffix !== "string" || typeof item.note !== "string" ||
      !Number.isInteger(item.color) || item.color < 1 || item.color > 5 ||
      !Number.isFinite(item.ts) || item.ts < 0 ||
      (item.fp !== undefined && typeof item.fp !== "string") ||
      (item.side !== undefined && item.side !== "orig" && item.side !== "tr") ||
      (item.lang !== undefined && typeof item.lang !== "string")) return false;
  if (item.noteVariants !== undefined) {
    if (!_pbpVocabDenseArray(item.noteVariants) || item.noteVariants.length < 2 ||
        !item.noteVariants.every(note=>typeof note === "string") ||
        new Set(item.noteVariants).size !== item.noteVariants.length ||
        item.noteVariants.slice().sort(_pbpVocabCodePointCompare).join("\n\n") !== item.note) return false;
  }
  return true;
}

function pbpNotesValidBatchBody(body, ownerHash) {
  return _pbpVocabOnlyKeys(body,["schema","ownerHash","deviceId","createdAt","entries"]) &&
    Object.keys(body).length === 5 && body.schema === 1 && /^[0-9a-f]{64}$/.test(ownerHash) &&
    body.ownerHash === ownerHash && _pbpVocabDeviceId(body.deviceId) &&
    Number.isFinite(body.createdAt) && _pbpVocabDenseArray(body.entries) &&
    body.entries.every(event=>pbpNotesValidateEvent(event));
}

// Concurrent leaves retain their own causal history. Flattening their note
// text into a single version would resurrect a superseded edit when batches
// arrive in a different order (A1, concurrent B1, then A2).
function _pbpNotesLeafCompare(a,b) {
  return pbpVocabDotCompare(a.dot,b.dot) ||
    _pbpVocabCodePointCompare(_pbpVocabCanonicalJson(a),_pbpVocabCanonicalJson(b));
}
function _pbpNotesFrontierValid(versions,vector) {
  const joined=versions.reduce((merged,version)=>_pbpVocabMergedVector(merged,version.vector),{});
  if (pbpVocabVectorRelation(joined,vector)!=="equal") return false;
  for (let i=0;i<versions.length;i++) {
    if (i && _pbpNotesLeafCompare(versions[i-1],versions[i]) >= 0) return false;
    if (!["equal","left"].includes(pbpVocabVectorRelation(vector,versions[i].vector))) return false;
    for (let j=0;j<i;j++) if (pbpVocabVectorRelation(versions[i].vector,versions[j].vector)!=="concurrent") return false;
  }
  return true;
}
function _pbpNotesProject(recordKey,vector,versions) {
  const live=versions.filter(version=>!version.deleted);
  const provenance=(live.length ? live : versions).reduce((a,b)=>pbpVocabDotCompare(a.dot,b.dot)>=0 ? a : b);
  const event={recordKey,vector,dot:{...provenance.dot},deleted:!live.length};
  let notice=live.length && live.length!==versions.length ? "delete-live-conflict" : null;
  if (live.length) {
    const item={...provenance.value.item};delete item.noteVariants;
    const notes=[...new Set(live.flatMap(version=>version.value.item.noteVariants || [version.value.item.note]))].sort(_pbpVocabCodePointCompare);
    item.note=notes.join("\n\n");
    if (notes.length>1) {item.noteVariants=notes;notice="note-conflict";}
    event.value={...provenance.value,item};
  }
  return {event,notice};
}
function pbpNotesMergeEvents(left, right) {
  const invalid = {kind:"invalid",event:null,requeue:false,notice:null};
  if (!pbpNotesValidateEvent(left) || !pbpNotesValidateEvent(right,left.recordKey)) return invalid;
  const relation = pbpVocabVectorRelation(left.vector,right.vector);
  if (relation === "equal") return {kind:pbpVocabEventContentEqual(left,right) ? "noop" : "corrupt",event:left,requeue:false,notice:null};
  if (relation === "left") return {kind:"noop",event:left,requeue:false,notice:null};
  if (relation === "right") return {kind:"apply",event:right,requeue:false,notice:null};
  const candidates=[...(left.versions || [left]),...(right.versions || [right])];
  const versions=[];
  for (const candidate of candidates) {
    let dominated=false;
    for (const other of candidates) {
      if (candidate===other) continue;
      const leafRelation=pbpVocabVectorRelation(candidate.vector,other.vector);
      if (leafRelation==="equal" && !pbpVocabEventContentEqual(candidate,other)) return {kind:"corrupt",event:left,requeue:false,notice:null};
      if (leafRelation==="right") {dominated=true;break;}
    }
    if (!dominated && !versions.some(version=>pbpVocabEventContentEqual(candidate,version))) versions.push(candidate);
  }
  versions.sort(_pbpNotesLeafCompare);
  const result=_pbpNotesProject(left.recordKey,_pbpVocabMergedVector(left.vector,right.vector),versions);
  if (versions.length>1) result.event.versions=versions;
  return {kind:"merged",event:result.event,requeue:true,notice:result.notice};
}

function _pbpNotesSyncError(code) {
  const error = new Error(code); error.code = code; return error;
}

async function _pbpNotesOwnerHash(owner) {
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(owner));
  return Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
}

function pbpCreateNotesSyncStore({
  storage = typeof chrome !== "undefined" ? chrome.storage.local : null,
  locks = typeof navigator !== "undefined" ? navigator.locks : null,
  getCurrentOwner = async()=>{
    const owner = typeof pbpVocabCurrentOwner === "function" ? await pbpVocabCurrentOwner() : "";
    return owner === "ownerless" ? "" : owner;
  }
} = {}) {
  const withLock = (name,run) => {
    // Chrome extension contexts support Web Locks. Sync must fail closed if
    // unavailable, rather than race the existing reader/library writers.
    if (!locks?.request) throw _pbpNotesSyncError("local_store");
    return locks.request(name,run);
  };
  const checkOwner = async(owner, options) => {
    if (await getCurrentOwner(options) !== owner) throw _pbpNotesSyncError("account_changed");
  };
  const checkHash = async(owner,ownerHash,options) => {
    if (!/^acct_.+/.test(owner) || await _pbpNotesOwnerHash(owner) !== ownerHash) throw _pbpNotesSyncError("account_changed");
    await checkOwner(owner,options);
  };
  const read = async(key) => (await storage.get(key))[key];
  const stateKey = (kind,id) => PBP_NOTES_SYNC_PREFIX + kind + "_" + encodeURIComponent(id);
  const accountId = (permissionId,ownerHash) => permissionId + ":" + ownerHash;
  const batchId = (permissionId,ownerHash,fileId) => accountId(permissionId,ownerHash) + ":" + fileId;
  const keys = async() => storage.getKeys ? storage.getKeys() : Object.keys(await storage.get(null));
  const articleKeys = async() => (await keys()).filter(key=>/^pbp_hl_[0-9a-f]{8}$/.test(key));
  const ownerState = (rec,owner) => {
    const old = _pbpVocabOwnValue(rec?.notesSync?.owners || {},owner);
    return {events:Object.assign(Object.create(null),old?.events),pending:Object.assign(Object.create(null),old?.pending),notices:Object.assign(Object.create(null),old?.notices)};
  };
  const saveOwnerState = (rec,owner,state) => ({...rec,notesSync:{v:1,owners:{...rec?.notesSync?.owners,[owner]:state}}});
  const eventOf = (rec,owner,id,meta) => {
    if (!meta) return null;
    const event = {recordKey:pbpNotesArticleKey(rec.url) + "|" + encodeURIComponent(id),vector:meta.vector,dot:meta.dot,deleted:meta.deleted};
    // Tombstones can arrive before the article exists. Keep their original
    // storage key instead of deriving an identity from the empty URL.
    if (meta.recordKey) event.recordKey = meta.recordKey;
    if (meta.versions) event.versions = meta.versions;
    if (!meta.deleted) {
      const matches = (rec.items || []).filter(item=>item.owner === owner && item.id === id);
      if (matches.length !== 1) throw _pbpNotesSyncError("local_store");
      event.value = {url:meta.url || rec.url,title:meta.title === undefined ? (typeof rec.title === "string" ? rec.title : "") : meta.title,item:_pbpNotesItemValue(matches[0])};
    }
    if (!pbpNotesValidateEvent(event)) throw _pbpNotesSyncError("local_store");
    return event;
  };
  const metadataOf = event => ({recordKey:event.recordKey,vector:event.vector,dot:event.dot,deleted:event.deleted,
    ...(event.deleted ? {} : {url:event.value.url,title:event.value.title}),
    ...(event.versions ? {versions:event.versions} : {})});
  const getMeta = async() => withLock("pbp-notes-device",async()=>{
    let deviceId=await read(PBP_NOTES_DEVICE_KEY);
    if (!_pbpVocabDeviceId(deviceId)) {
      deviceId=crypto.randomUUID(); await storage.set({[PBP_NOTES_DEVICE_KEY]:deviceId});
    }
    return {deviceId};
  });
  const normalizeLegacy = async(rec,owner) => {
    const occurrences=new Map();
    const items=[];
    for (const item of rec.items || []) {
      if (item.owner !== owner || item.id) { items.push(item); continue; }
      const identity=_pbpVocabCanonicalJson([rec.url,item.quote,item.prefix || "",item.suffix || "",item.ts,item.side || "orig",item.lang || ""]);
      const index=occurrences.get(identity) || 0; occurrences.set(identity,index+1);
      const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(identity));
      const hash=Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,"0")).join("");
      items.push({...item,id:"legacy-"+hash+"-"+index});
    }
    return {...rec,items};
  };
  async function writeRecord(key,next,owner,{locked=false}={}) {
    const work=async()=>{
      await checkOwner(owner);
      const previous=(await read(key)) || {v:1,url:next?.url || "",title:next?.title || "",items:[]};
      await checkOwner(owner);
      next=next || {...previous,items:[]};
      const hidden=rec=>(rec.items || []).filter(item=>item.owner && item.owner !== owner);
      if (!pbpVocabEventContentEqual(hidden(previous),hidden(next))) throw _pbpNotesSyncError("account_changed");
      let updated={...next};
      if (previous.notesSync) updated.notesSync=previous.notesSync;
      const enrol=/^acct_.+/.test(owner) && /^pbp_hl_[0-9a-f]{8}$/.test(key) &&
        typeof updated.url === "string" && pbpDictSafeUrl(updated.url) === updated.url && pbpNotesArticleKey(updated.url) === key;
      if (enrol) {
        const old=await normalizeLegacy(previous,owner);
        updated=await normalizeLegacy(updated,owner);
        const state=ownerState(previous,owner);
        const deviceId=(await getMeta()).deviceId;
        const before=new Map(old.items.filter(it=>it.owner===owner).map(it=>[it.id,it]));
        const after=new Map(updated.items.filter(it=>it.owner===owner).map(it=>[it.id,it]));
        if (after.size !== updated.items.filter(it=>it.owner===owner).length) throw _pbpNotesSyncError("local_store");
        for (const id of new Set([...before.keys(),...after.keys(),...Object.keys(state.events)])) {
          const prior=state.events[id], a=before.get(id), b=after.get(id);
          if (!b && !a && prior?.deleted) continue;
          if (!b && !a) throw _pbpNotesSyncError("local_store");
          if (b?.noteVariants && a && b.note !== a.note) {
            const clean={...b}; delete clean.noteVariants; after.set(id,clean);
            updated.items=updated.items.map(it=>it===b ? clean : it);
          }
          const current=after.get(id);
          if (prior && (prior.deleted || (prior.url===updated.url && prior.title===(updated.title || ""))) &&
              pbpVocabEventContentEqual(a && _pbpNotesItemValue(a),current && _pbpNotesItemValue(current))) continue;
          const vector=Object.assign(Object.create(null),prior?.vector);
          const counter=(_pbpVocabOwnValue(vector,deviceId) || 0)+1;
          if (!Number.isSafeInteger(counter)) throw _pbpNotesSyncError("local_store");
          vector[deviceId]=counter;
          const event={recordKey:key+"|"+encodeURIComponent(id),vector,dot:{deviceId,counter},deleted:!current};
          if (current) event.value={url:updated.url,title:typeof updated.title === "string" ? updated.title : "",item:_pbpNotesItemValue(current)};
          if (!pbpNotesValidateEvent(event)) throw _pbpNotesSyncError("local_store");
          state.events[id]=metadataOf(event); state.pending[id]=true;
          if (!current || current.note !== a?.note) delete state.notices[id];
        }
        updated=saveOwnerState(updated,owner,state);
      }
      await checkOwner(owner);
      if (!(updated.items || []).length && !updated.notesSync) await storage.remove(key);
      else await storage.set({[key]:updated});
      return updated;
    };
    return locked ? work() : withLock(PBP_NOTES_SYNC_RECORD_LOCK_PREFIX+key,work);
  }
  async function listOutbox(owner) {
    const rows=[];
    for (const key of await articleKeys()) {
      const rec=await read(key),state=ownerState(rec,owner);
      for (const id of Object.keys(state.pending)) {
        if (state.pending[id] !== true) continue;
        const event=eventOf(rec,owner,id,state.events[id]);
        if (event) rows.push({owner,recordKey:event.recordKey,event});
      }
    }
    return rows;
  }
  async function seedLegacy(owner,limit=100) {
    let processed=0;
    try {
      for (const key of await articleKeys()) {
        if (processed>=limit) break;
        const rec=await read(key),state=ownerState(rec,owner);
        if (typeof rec?.url !== "string" || !rec.url || pbpDictSafeUrl(rec.url)!==rec.url || pbpNotesArticleKey(rec.url)!==key ||
            !(rec.items || []).some(it=>it.owner===owner && (!it.id || !state.events[it.id]))) continue;
        await withLock(PBP_NOTES_SYNC_RECORD_LOCK_PREFIX+key,async()=>{
          const fresh=await read(key);
          if (fresh) await writeRecord(key,fresh,owner,{locked:true});
        });
        processed++;
      }
      return {ok:true,processed};
    } catch (error) {
      console.warn("[notes-sync] seed failed:",error.name,typeof error.code === "string" ? error.code : "local_store");
      return {ok:false,error:typeof error.code === "string" ? error.code : "local_store",retryable:error.retryable === true,processed};
    }
  }
  const validateCursor = (cursor,ownerHash) => cursor == null ||
    (_pbpVocabPlainObject(cursor) && cursor.ownerHash===ownerHash && typeof cursor.drivePermissionId==="string" &&
     cursor.key==="account:"+accountId(cursor.drivePermissionId,ownerHash));
  async function applyRemotePage(owner,ownerHash,batches,cursorCommit) {
    if (!Array.isArray(batches) || !batches.every(body=>pbpNotesValidBatchBody(body,ownerHash)) || !validateCursor(cursorCommit,ownerHash)) {
      return {ok:false,error:"invalid_remote_page"};
    }
    const grouped=new Map();
    for (const body of batches) for (const event of body.entries) {
      const key=_pbpNotesIdentity(event.recordKey).key;
      if (!grouped.has(key)) grouped.set(key,[]);
      grouped.get(key).push(event);
    }
    let applied=0,merged=0,ignored=0;
    try {
      await checkHash(owner,ownerHash);
      for (const [key,events] of grouped) await withLock(PBP_NOTES_SYNC_RECORD_LOCK_PREFIX+key,async()=>{
        await checkOwner(owner);
        let rec=(await read(key)) || {v:1,url:"",title:"",items:[]};
        await checkOwner(owner);
        const state=ownerState(rec,owner);
        for (const remote of events) {
          const id=_pbpNotesIdentity(remote.recordKey).id;
          const local=eventOf(rec,owner,id,state.events[id]);
          if (!local && rec.items.some(it=>it.owner===owner && it.id===id)) throw _pbpNotesSyncError("local_store");
          const result=local ? pbpNotesMergeEvents(local,remote) : {kind:"apply",event:remote,requeue:false};
          if (result.kind==="invalid" || result.kind==="corrupt") throw _pbpNotesSyncError("invalid_remote_page");
          if (result.kind==="noop") { ignored++; continue; }
          const event=result.event;
          const items=rec.items.filter(it=>it.owner!==owner || it.id!==id);
          if (!event.deleted) {
            if (rec.url && rec.url!==event.value.url) throw _pbpNotesSyncError("invalid_remote_page");
            rec={...rec,url:event.value.url,title:event.value.title};
            items.push({...event.value.item,owner});
          }
          rec={...rec,items};state.events[id]=metadataOf(event);
          if (result.requeue) state.pending[id]=true;
          else delete state.pending[id];
          if (result.notice) state.notices[id]=result.notice;
          else if (result.kind==="apply") delete state.notices[id];
          if (result.kind==="merged") merged++; else applied++;
        }
        rec=saveOwnerState(rec,owner,state);
        await checkOwner(owner);
        await storage.set({[key]:rec});
      });
      if (cursorCommit && !await putAccountState(cursorCommit)) throw _pbpNotesSyncError("local_store");
      return {ok:true,applied,merged,ignored};
    } catch (error) {
      const code=typeof error.code === "string" ? error.code : "local_store";
      console.warn("[notes-sync] page apply failed:",error.name,code);
      return {ok:false,error:code,retryable:error.retryable === true};
    }
  }
  async function checkpointOwner(owner) {
    let count=0;
    for (const key of await articleKeys()) await withLock(PBP_NOTES_SYNC_RECORD_LOCK_PREFIX+key,async()=>{
      await checkOwner(owner);
      const rec=await read(key); if (!rec) return;
      const state=ownerState(rec,owner);
      for (const id of Object.keys(state.events)) { eventOf(rec,owner,id,state.events[id]);state.pending[id]=true;count++; }
      if (!Object.keys(state.events).length) return;
      await checkOwner(owner);await storage.set({[key]:saveOwnerState(rec,owner,state)});
    });
    return count;
  }
  const getAccountState = (permissionId,ownerHash) => read(stateKey("account",accountId(permissionId,ownerHash)));
  const getPreflightState = ownerHash => read(stateKey("preflight",ownerHash));
  async function checkedStateWrite(key,value,options) {
    const owner=await getCurrentOwner(options);
    if (!/^acct_.+/.test(owner)) throw _pbpNotesSyncError("account_changed");
    await checkHash(owner,value.ownerHash,options); await storage.set({[key]:value}); return true;
  }
  const stateFailure = error => {
    if (["network","auth","permission","account_changed"].includes(error.code)) throw error;
    console.warn("[notes-sync] state write failed:",error.name,typeof error.code === "string" ? error.code : "local_store");
    return false;
  };
  async function putAccountState(state) {
    try {
      if (!validateCursor(state,state?.ownerHash)) return false;
      return await checkedStateWrite(stateKey("account",accountId(state.drivePermissionId,state.ownerHash)),state);
    } catch (error) { return stateFailure(error); }
  }
  async function putPreflightState(state) {
    try {
      if (!/^[0-9a-f]{64}$/.test(state?.ownerHash) || state.key!=="preflight:"+state.ownerHash) return false;
      return await checkedStateWrite(stateKey("preflight",state.ownerHash),state,{requireDriveAccount:false});
    } catch (error) { return stateFailure(error); }
  }
  async function deletePreflightState(ownerHash) {
    try {
      const options={requireDriveAccount:false};
      const owner=await getCurrentOwner(options);await checkHash(owner,ownerHash,options);
      await storage.remove(stateKey("preflight",ownerHash));return true;
    } catch (error) { return stateFailure(error); }
  }
  async function listPendingBatches(permissionId,ownerHash) {
    const prefix=stateKey("batch",accountId(permissionId,ownerHash)+":");
    const selected=(await keys()).filter(key=>key.startsWith(prefix));
    const values=selected.length ? await storage.get(selected) : {};
    return Object.values(values).filter(row=>row.drivePermissionId===permissionId && row.ownerHash===ownerHash);
  }
  async function freezeOutbox(owner,permissionId,ownerHash,fileId,batch) {
    let body;
    try { body=JSON.parse(batch.body); } catch (_) { return false; }
    if (!pbpNotesValidBatchBody(body,ownerHash) || !fileId || !permissionId || !body.entries.length) return false;
    return withLock("pbp-notes-batches",async()=>{
      await checkHash(owner,ownerHash);
      const key=stateKey("batch",batchId(permissionId,ownerHash,fileId));
      const frozen={key,drivePermissionId:permissionId,ownerHash,driveFileId:fileId,body:batch.body,bytes:batch.bytes};
      const old=await read(key);
      if (old && old.body!==frozen.body) throw _pbpNotesSyncError("local_store");
      await checkOwner(owner); await storage.set({[key]:frozen});
      for (const event of body.entries) {
        const {key:articleKey,id}=_pbpNotesIdentity(event.recordKey);
        await withLock(PBP_NOTES_SYNC_RECORD_LOCK_PREFIX+articleKey,async()=>{
          await checkOwner(owner);
          const rec=await read(articleKey); if (!rec) return;
          const state=ownerState(rec,owner);
          const current=eventOf(rec,owner,id,state.events[id]);
          if (!current || !pbpVocabEventContentEqual(current,event)) return;
          delete state.pending[id];
          await checkOwner(owner);await storage.set({[articleKey]:saveOwnerState(rec,owner,state)});
        });
      }
      return frozen;
    });
  }
  async function deletePendingBatch(permissionId,ownerHash,fileId) {
    try {
      const owner=await getCurrentOwner();await checkHash(owner,ownerHash);
      await storage.remove(stateKey("batch",batchId(permissionId,ownerHash,fileId)));return true;
    } catch (error) { return stateFailure(error); }
  }
  async function snapshot(owner,ownerHash) {
    const outbox=await listOutbox(owner),notices=[];
    for (const key of await articleKeys()) {
      const rec=await read(key),state=ownerState(rec,owner);
      for (const [id,kind] of Object.entries(state.notices)) notices.push({owner,recordKey:key+"|"+encodeURIComponent(id),kind});
    }
    const allKeys=await keys();
    const accountKeys=allKeys.filter(key=>key.startsWith(PBP_NOTES_SYNC_PREFIX+"account_"));
    const values=accountKeys.length ? await storage.get(accountKeys) : {};
    const states=Object.values(values).filter(state=>state.ownerHash===ownerHash);
    const batches=allKeys.filter(key=>key.startsWith(PBP_NOTES_SYNC_PREFIX+"batch_")).flatMap(key=>{
      try {
        const decoded=decodeURIComponent(key.slice((PBP_NOTES_SYNC_PREFIX+"batch_").length));
        const parts=decoded.split(":");
        return parts[1]===ownerHash ? [{key,drivePermissionId:parts[0],ownerHash,driveFileId:parts.slice(2).join(":")}] : [];
      } catch (_) { return []; }
    });
    return {states,outbox,batches,notices};
  }
  async function clearNotices(owner) {
    try {
      for (const key of await articleKeys()) await withLock(PBP_NOTES_SYNC_RECORD_LOCK_PREFIX+key,async()=>{
        await checkOwner(owner); const rec=await read(key); if (!rec) return;
        const state=ownerState(rec,owner); if (!Object.keys(state.notices).length) return;
        state.notices=Object.create(null);await checkOwner(owner);await storage.set({[key]:saveOwnerState(rec,owner,state)});
      });
      return true;
    } catch (_) { return false; }
  }
  return {getMeta,getPreflightState,putPreflightState,deletePreflightState,getAccountState,putAccountState,
    seedLegacy,applyRemotePage,checkpointOwner,listPendingBatches,deletePendingBatch,listOutbox,freezeOutbox,
    writeRecord,snapshot,clearNotices};
}

async function pbpNotesWriteRecord(key,record,owner,options={}) {
  const result=await pbpCreateNotesSyncStore(options).writeRecord(key,record,owner,options);
  // No network or permission request here. A disconnected/off device retains
  // its pending intent until sync is explicitly enabled and connected.
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const pending=chrome.runtime.sendMessage({type:"PBP_NOTES_DIRTY"});
      if (pending?.catch) pending.catch(()=>{});
    }
  } catch (_) {}
  return result;
}
function pbpNotesSyncSnapshot(owner,ownerHash) { return pbpCreateNotesSyncStore().snapshot(owner,ownerHash); }
function pbpNotesClearNotices(owner) { return pbpCreateNotesSyncStore().clearNotices(owner); }
