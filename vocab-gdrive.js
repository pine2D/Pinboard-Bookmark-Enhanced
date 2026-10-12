const PBP_VOCAB_BATCH_SCHEMA = 1;
const PBP_VOCAB_BATCH_MAX_BYTES = 4 * 1024 * 1024;
// The transport is shared; each dataset owns its wire validation and identity.
const PBP_VOCAB_DRIVE_PROTOCOL = Object.freeze({
  kind: "vocab-batch", schema: PBP_VOCAB_BATCH_SCHEMA, filePrefix: "pbp-vocab",
  validateEvent: (event) => pbpVocabValidateEvent(event),
  validBatchBody: (body, ownerHash) => _pbpVocabValidBatchBody(body, ownerHash)
});

function _pbpVocabDriveBytes(value) {
  return new TextEncoder().encode(value).length;
}

function _pbpVocabDriveValidProperty(key, value) {
  return typeof key === "string" && typeof value === "string" &&
    _pbpVocabDriveBytes(key) + _pbpVocabDriveBytes(value) <= 124;
}

function _pbpVocabDriveBody(entries, envelope, protocol = PBP_VOCAB_DRIVE_PROTOCOL) {
  return JSON.stringify({
    schema: protocol.schema,
    ownerHash: envelope.ownerHash,
    deviceId: envelope.deviceId,
    createdAt: envelope.createdAt,
    entries
  });
}

function _pbpVocabDriveValidMetadata(metadata, protocol = PBP_VOCAB_DRIVE_PROTOCOL) {
  const properties = metadata && metadata.appProperties;
  return _pbpVocabOnlyKeys(metadata, ["id", "name", "parents", "mimeType", "appProperties"]) &&
    Object.keys(metadata).length === 5 &&
    typeof metadata.id === "string" && !!metadata.id &&
    metadata.name === `${protocol.filePrefix}-${metadata.id}.json` &&
    Array.isArray(metadata.parents) && metadata.parents.length === 1 &&
    typeof metadata.parents[0] === "string" && !!metadata.parents[0] &&
    metadata.mimeType === "application/json" &&
    _pbpVocabOnlyKeys(properties, ["pbpKind", "schema", "owner", "device"]) &&
    Object.keys(properties).length === 4 && properties.pbpKind === protocol.kind &&
    properties.schema === String(protocol.schema) &&
    _pbpVocabValidOwnerHash(properties.owner) && _pbpVocabDeviceId(properties.device) &&
    Object.entries(properties).every(([key, value]) => _pbpVocabDriveValidProperty(key, value));
}

async function pbpVocabOwnerHash(owner) {
  if (typeof owner !== "string" || !owner) throw new TypeError("invalid owner");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(owner));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function pbpVocabDriveMetadata(fileId, ownerHash, deviceId, protocol = PBP_VOCAB_DRIVE_PROTOCOL) {
  const appProperties = {
    pbpKind: protocol.kind,
    schema: String(protocol.schema),
    owner: ownerHash,
    device: deviceId
  };
  if (typeof fileId !== "string" || !fileId || !_pbpVocabValidOwnerHash(ownerHash) ||
      !_pbpVocabDeviceId(deviceId) ||
      !Object.entries(appProperties).every(([key, value]) => _pbpVocabDriveValidProperty(key, value))) {
    throw new TypeError("invalid Drive batch identity");
  }
  return {
    id: fileId,
    name: `${protocol.filePrefix}-${fileId}.json`,
    parents: ["appDataFolder"],
    mimeType: "application/json",
    appProperties
  };
}

function pbpVocabValidateDriveBatch(metadata, body, expectedOwnerHash, protocol = PBP_VOCAB_DRIVE_PROTOCOL) {
  if (!_pbpVocabValidOwnerHash(expectedOwnerHash) || !_pbpVocabDriveValidMetadata(metadata, protocol) ||
      metadata.appProperties.owner !== expectedOwnerHash || typeof body !== "string" ||
      _pbpVocabDriveBytes(body) > PBP_VOCAB_BATCH_MAX_BYTES) return false;
  let parsed;
  try { parsed = JSON.parse(body); } catch (_) { return false; }
  if (!protocol.validBatchBody(parsed, expectedOwnerHash) ||
      metadata.appProperties.device !== parsed.deviceId ||
      body !== _pbpVocabDriveBody(parsed.entries, parsed, protocol)) return false;
  return true;
}

function pbpVocabSplitDriveEntries(entries, envelope, protocol = PBP_VOCAB_DRIVE_PROTOCOL) {
  if (!Array.isArray(entries) ||
      !_pbpVocabOnlyKeys(envelope, ["ownerHash", "deviceId", "createdAt"]) ||
      Object.keys(envelope).length !== 3 || !_pbpVocabValidOwnerHash(envelope.ownerHash) ||
      !_pbpVocabDeviceId(envelope.deviceId) ||
      !_pbpVocabDriveValidProperty("owner", envelope.ownerHash) ||
      !_pbpVocabDriveValidProperty("device", envelope.deviceId) ||
      !Number.isFinite(envelope.createdAt)) {
    console.warn("[vocab-drive] outbox rejected by local validator: envelope");
    return { ok: false, error: "invalid_envelope" };
  }
  for (const entry of entries) {
    if (!protocol.validateEvent(entry)) {
      console.warn("[vocab-drive] outbox rejected by local validator: entry");
      return { ok: false, error: "invalid_entry" };
    }
  }

  const emptyBody = _pbpVocabDriveBody([], envelope, protocol);
  const prefix = emptyBody.slice(0, -2);
  const suffix = "]}";
  const baseBytes = _pbpVocabDriveBytes(prefix) + _pbpVocabDriveBytes(suffix);
  const batches = [];
  let current = [];
  let currentBytes = baseBytes;

  for (const entry of entries) {
    const entryJson = JSON.stringify(entry);
    const entryBytes = _pbpVocabDriveBytes(entryJson);
    const singleBytes = baseBytes + entryBytes;
    if (singleBytes > PBP_VOCAB_BATCH_MAX_BYTES) {
      return { ok: false, error: "entry_too_large", recordKey: entry.recordKey, bytes: singleBytes };
    }
    const nextBytes = currentBytes + (current.length ? 1 : 0) + entryBytes;
    if (nextBytes > PBP_VOCAB_BATCH_MAX_BYTES) {
      batches.push({ body: prefix + current.join(",") + suffix, bytes: currentBytes });
      current = [entryJson];
      currentBytes = singleBytes;
    } else {
      current.push(entryJson);
      currentBytes = nextBytes;
    }
  }
  if (current.length) batches.push({ body: prefix + current.join(",") + suffix, bytes: currentBytes });
  return { ok: true, batches };
}

function pbpVocabBuildMultipart(metadata, body, protocol = PBP_VOCAB_DRIVE_PROTOCOL) {
  const expectedOwnerHash = metadata && metadata.appProperties && metadata.appProperties.owner;
  if (!pbpVocabValidateDriveBatch(metadata, body, expectedOwnerHash, protocol)) {
    throw new TypeError("invalid Drive batch");
  }
  const metadataJson = JSON.stringify(metadata);
  let boundary = "";
  for (let i = 0; i < 8; i++) {
    const candidate = `pbp-${crypto.randomUUID()}`;
    if (!metadataJson.includes(candidate) && !body.includes(candidate)) {
      boundary = candidate;
      break;
    }
  }
  if (!boundary) throw new Error("multipart boundary collision");
  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}` +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`
  };
}

// Classify a chrome.identity.getAuthToken rejection by Chrome's own wording.
// The literals are Chromium's: identity_constants.h (kAuthFailure, kNoGrant,
// kUserNotSignedIn, kBrowserSigninNotAllowed, kUserRejected) and
// GoogleServiceAuthError::ToString() (ConnectionFailed, ServiceUnavailable),
// joined as kAuthFailure + ToString(). "Service responded with error" is the
// persistent ServiceError (4xx invalid_client & co.), NOT a transient 5xx --
// Chrome maps 5xx/403/407 to ServiceUnavailable -- so it keeps the legacy
// classification. Anything unrecognised keeps the legacy behaviour too: a
// silent failure stays retryable, an interactive one does not.
function pbpVocabDriveClassifyMintError(error, interactive) {
  const message = typeof error === "string" ? error
    : (error && typeof error.message === "string" ? error.message : "");
  if (/^OAuth2 request failed: Connection failed \(-?\d+\)/.test(message)) {
    return { error: "network", retryable: true };
  }
  if (message.startsWith("OAuth2 request failed: Service unavailable; try again later")) {
    return { error: "server", retryable: true };
  }
  if (message.startsWith("OAuth2 not granted or revoked.") ||
      message.startsWith("The user is not signed in.") ||
      message.startsWith("The user turned off browser signin")) {
    return { error: "auth", retryable: false };
  }
  if (interactive === true && message.startsWith("The user did not approve access.")) {
    return { error: "permission", retryable: false };
  }
  // Interactive flows only: Google's sign-in page itself never loaded
  // (identity_constants.h kPageLoadFailure / kPageLoadTimedOut). That is the
  // network, not a refusal (spec §10.7): an offline, connected device must not
  // end up disconnected because Connect reported a non-retryable auth.
  if (/^(?:OAuth2 request failed: )?Authorization page (?:could not be loaded|load timed out)\./.test(message)) {
    return { error: "network", retryable: true };
  }
  return { error: "auth", retryable: interactive !== true };
}

// Verified Drive identity per OAuth token, shared by every client in this
// JavaScript context (the vocabulary, notes and connect clients in the service
// worker). A different Google account always yields a different token, so a
// hit for the token Chrome hands out right now names the same account the
// last about.get proved. Worker eviction empties it; 401, disconnect,
// permission removal and re-authorisation drop entries explicitly. Values are
// non-secret; the token is only a Map key and is never logged or returned.
const PBP_VOCAB_DRIVE_IDENTITY_LIMIT = 2;
const _pbpVocabDriveIdentities = new Map();

function pbpVocabDriveForgetIdentity(token) {
  if (token === undefined) _pbpVocabDriveIdentities.clear();
  else _pbpVocabDriveIdentities.delete(token);
}

function _pbpVocabDriveRememberIdentity(token, identity) {
  if (typeof token !== "string" || !token) return;
  _pbpVocabDriveIdentities.delete(token);
  _pbpVocabDriveIdentities.set(token, {
    permissionId: identity.permissionId,
    emailAddress: identity.emailAddress,
    displayName: identity.displayName
  });
  while (_pbpVocabDriveIdentities.size > PBP_VOCAB_DRIVE_IDENTITY_LIMIT) {
    _pbpVocabDriveIdentities.delete(_pbpVocabDriveIdentities.keys().next().value);
  }
}

function pbpCreateVocabDriveClient({
  fetchImpl = fetch,
  identity = null,
  protocol = PBP_VOCAB_DRIVE_PROTOCOL,
  beforeRequest = null,
  now = Date.now,
  random = Math.random,
  timeoutMs = 30000
} = {}) {
  // chrome.identity is an OPTIONAL permission, so the namespace does not exist
  // until the user grants it. background.js builds this client with a top-level
  // statement, i.e. while the service worker evaluates its script -- on a fresh
  // install that happens before the grant. Capturing the namespace there pinned
  // undefined for the whole worker generation, every mint threw into
  // openSession's catch, and the first connect reported a permanent auth
  // failure while chrome.identity was perfectly usable a moment later. Resolve
  // it per call; an injected fixture still wins.
  const identityApi = () =>
    identity || (typeof chrome !== "undefined" ? chrome.identity : undefined);
  const apiBase = "https://www.googleapis.com/drive/v3";
  const uploadBase = "https://www.googleapis.com/upload/drive/v3/files";
  const metadataFields = "id,name,appProperties,parents,mimeType";
  const requestedTimeoutMs = Math.floor(timeoutMs);
  const requestTimeoutMs = Number.isFinite(timeoutMs) && requestedTimeoutMs >= 1
    ? Math.min(2147483647, requestedTimeoutMs) : 30000;
  // Body transfers get a longer deadline than metadata calls. The signal is a
  // wall clock over the whole payload, and a batch may reach
  // PBP_VOCAB_BATCH_MAX_BYTES -- 4 MiB inside the metadata budget demands
  // >140 KB/s, which a tethered or metered link does not deliver.
  const transferTimeoutMs = Math.min(2147483647, requestTimeoutMs * 8);
  const responseSignals = new WeakMap();
  const filePrefix = (fileId) => typeof fileId === "string" ? fileId.slice(0, 8) : undefined;
  const failure = (error, retryable, status, fileId) => {
    const result = { ok: false, error, retryable };
    if (Number.isInteger(status)) result.status = status;
    const prefix = filePrefix(fileId);
    if (prefix) result.fileId = prefix;
    return result;
  };
  const tokenValue = (value) => typeof value === "string" ? value : value && value.token;

  async function requestWithToken(token, url, init = {}, fileId, deadlineMs = requestTimeoutMs, guards = null) {
    let response;
    if (beforeRequest && !await beforeRequest()) return failure("account_changed", false, undefined, fileId);
    // Run the session owner check AFTER the client's asynchronous scope gate.
    // No asynchronous operation follows the final synchronous epoch check.
    if (guards?.beforeRequest && !await guards.beforeRequest()) return failure("account_changed", false, undefined, fileId);
    if (guards?.isCurrent && guards.isCurrent() !== true) return failure("account_changed", false, undefined, fileId);
    const timeoutSignal = AbortSignal.timeout(deadlineMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` }
      });
    } catch (_) {
      return failure("network", true, undefined, fileId);
    }
    if (response && typeof response === "object") responseSignals.set(response, signal);
    return { ok: true, response, token };
  }

  // Chrome's own wording decides the class (pbpVocabDriveClassifyMintError):
  // a connection timeout is "network", a revoked grant is a permanent "auth".
  // Unrecognised wording keeps the legacy rule -- a silent mint failure is
  // transient (offline, or the Chrome profile's Google session lapsed), so it
  // stays retryable instead of blocking until someone presses Sync now.
  const mintFailure = (error, interactive, fileId) => {
    const classified = pbpVocabDriveClassifyMintError(error, interactive);
    return failure(classified.error, classified.retryable, undefined, fileId);
  };

  async function mint(interactive, fileId) {
    let token;
    try {
      token = tokenValue(await identityApi().getAuthToken({ interactive }));
    } catch (error) {
      console.warn("[vocab-drive] token mint failed:", error?.name, error?.message);
      return mintFailure(error, interactive, fileId);
    }
    if (typeof token !== "string" || !token) return mintFailure(undefined, interactive, fileId);
    return { ok: true, token };
  }

  // `minted` lets about()'s cached path reuse the token it already looked up.
  // Success carries the token actually used -- the renewed one after a 401 --
  // so the identity cache is keyed by the token the response proved.
  async function request(url, init = {}, interactive = false, fileId, deadlineMs, minted) {
    let token = minted;
    if (typeof token !== "string" || !token) {
      const first = await mint(interactive, fileId);
      if (!first.ok) return first;
      token = first.token;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const sent = await requestWithToken(token, url, init, fileId, deadlineMs);
      if (!sent.ok) return sent;
      const response = sent.response;
      if (response.status !== 401) return { ok: true, response, token };
      pbpVocabDriveForgetIdentity(token);
      if (attempt === 1) return failure("auth", false, 401, fileId);
      try {
        await identityApi().removeCachedAuthToken({ token });
        // An explicit Connect renews interactively too: a silent renewal
        // cannot show the consent a lapsed grant needs (A15).
        token = tokenValue(await identityApi().getAuthToken({ interactive }));
      } catch (error) {
        console.warn("[vocab-drive] token renew failed:", error?.name, error?.message);
        return mintFailure(error, interactive, fileId);
      }
      if (typeof token !== "string" || !token) return mintFailure(undefined, interactive, fileId);
    }
    return failure("auth", false, 401, fileId);
  }

  async function responseFailure(response, fileId) {
    const status = response.status;
    if (status === 429) return failure("rate_limited", true, status, fileId);
    if (status >= 500 && status <= 599) return failure("server", true, status, fileId);
    if (status === 403) {
      let reason = "";
      try {
        const payload = await response.json();
        const errors = payload && payload.error && payload.error.errors;
        if (Array.isArray(errors)) {
          reason = errors.map((entry) => entry && entry.reason).find((value) =>
            value === "rateLimitExceeded" || value === "userRateLimitExceeded" ||
            value === "insufficientPermissions" || value === "accessNotConfigured"
          ) || "";
        }
      } catch (_) {}
      if (responseSignals.get(response)?.aborted) {
        return failure("network", true, undefined, fileId);
      }
      if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") {
        return failure("rate_limited", true, status, fileId);
      }
      if (reason === "insufficientPermissions") {
        return failure("permission", false, status, fileId);
      }
      return failure("remote", false, status, fileId);
    }
    if (status === 404) return failure("remote", false, status, fileId);
    return failure("remote", false, status, fileId);
  }

  async function json(response, fileId) {
    try {
      return { ok: true, value: await response.json() };
    } catch (_) {
      if (responseSignals.get(response)?.aborted) {
        return failure("network", true, undefined, fileId);
      }
      return failure("invalid_response", false, response.status, fileId);
    }
  }

  // useCache: only the top-level silent client.about() reads the cache. The
  // session's opening and closing about, the post-401 probe and Connect always
  // go to Drive, so every run still proves the account at least twice.
  async function about(interactive = false, requestFn = request, useCache = false) {
    const url = new URL(`${apiBase}/about`);
    url.searchParams.set("fields", "user(permissionId,emailAddress,displayName)");
    let minted;
    if (useCache) {
      const current = await mint(interactive);
      if (!current.ok) return current;
      const known = _pbpVocabDriveIdentities.get(current.token);
      if (known) {
        // Keep the client's scope gate: a cache hit must not answer for a
        // device that was disconnected since the entry was written.
        if (beforeRequest && !await beforeRequest()) return failure("account_changed", false);
        return { ok: true, ...known };
      }
      minted = current.token;
    }
    const requested = await requestFn(url, { method: "GET" }, interactive, undefined, undefined, minted);
    if (!requested.ok) return requested;
    if (!requested.response.ok) return responseFailure(requested.response);
    const parsed = await json(requested.response);
    const user = parsed.ok && parsed.value && parsed.value.user;
    if (!parsed.ok) return parsed;
    if (!user || typeof user.permissionId !== "string" || !user.permissionId) {
      return failure("invalid_response", false, requested.response.status);
    }
    const identity = {
      permissionId: user.permissionId,
      emailAddress: typeof user.emailAddress === "string" ? user.emailAddress : "",
      displayName: typeof user.displayName === "string" ? user.displayName : ""
    };
    _pbpVocabDriveRememberIdentity(requested.token, identity);
    return { ok: true, ...identity };
  }

  async function generateId(requestFn = request) {
    const url = new URL(`${apiBase}/files/generateIds`);
    url.searchParams.set("count", "1");
    url.searchParams.set("space", "appDataFolder");
    const requested = await requestFn(url, { method: "GET" });
    if (!requested.ok) return requested;
    if (!requested.response.ok) return responseFailure(requested.response);
    const parsed = await json(requested.response);
    if (!parsed.ok) return parsed;
    const ids = parsed.value && parsed.value.ids;
    if (!Array.isArray(ids) || ids.length !== 1 || typeof ids[0] !== "string" || !ids[0]) {
      return failure("invalid_response", false, requested.response.status);
    }
    return { ok: true, fileId: ids[0] };
  }

  async function getMetadata(fileId, requestFn = request) {
    if (typeof fileId !== "string" || !fileId) return failure("invalid_input", false);
    const url = new URL(`${apiBase}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("fields", metadataFields);
    const requested = await requestFn(url, { method: "GET" }, false, fileId);
    if (!requested.ok) return requested;
    if (!requested.response.ok) return responseFailure(requested.response, fileId);
    const parsed = await json(requested.response, fileId);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
      return parsed.ok
        ? failure("invalid_response", false, requested.response.status, fileId)
        : parsed;
    }
    return { ok: true, metadata: parsed.value };
  }

  function metadataMatches(actual, expected) {
    if (!_pbpVocabDriveValidMetadata(actual, protocol)) return false;
    return actual.id === expected.id && actual.name === expected.name &&
      actual.mimeType === expected.mimeType &&
      Object.keys(expected.appProperties).every((key) =>
        actual.appProperties[key] === expected.appProperties[key]);
  }

  async function upload(metadata, body, requestFn = request) {
    let multipart;
    try {
      multipart = pbpVocabBuildMultipart(metadata, body, protocol);
    } catch (_) {
      return failure("invalid_input", false);
    }
    const url = new URL(uploadBase);
    url.searchParams.set("uploadType", "multipart");
    const requested = await requestFn(url, {
      method: "POST",
      headers: { "Content-Type": multipart.contentType },
      body: multipart.body
    }, false, metadata.id, transferTimeoutMs);
    if (!requested.ok) return requested;
    if (requested.response.status === 200 || requested.response.status === 201) {
      return { ok: true, fileId: metadata.id };
    }
    if (requested.response.status !== 409) {
      return responseFailure(requested.response, metadata.id);
    }
    const existing = await getMetadata(metadata.id, requestFn);
    if (!existing.ok) return existing;
    if (metadataMatches(existing.metadata, metadata)) {
      return { ok: true, fileId: metadata.id, idempotent: true };
    }
    return failure("id_collision", false, 409, metadata.id);
  }

  async function download(fileId, requestFn = request) {
    if (typeof fileId !== "string" || !fileId) return failure("invalid_input", false);
    const url = new URL(`${apiBase}/files/${encodeURIComponent(fileId)}`);
    url.searchParams.set("alt", "media");
    const requested = await requestFn(url, { method: "GET" }, false, fileId, transferTimeoutMs);
    if (!requested.ok) return requested;
    const response = requested.response;
    if (!response.ok) return responseFailure(response, fileId);

    const contentLength = response.headers && response.headers.get("Content-Length");
    if (typeof contentLength === "string" && /^\d+$/.test(contentLength) &&
        Number(contentLength) > PBP_VOCAB_BATCH_MAX_BYTES) {
      try { await response.body?.cancel?.(); } catch (_) {}
      return failure("remote_batch_too_large", false, response.status, fileId);
    }
    const reader = response.body && response.body.getReader && response.body.getReader();
    if (!reader) return failure("invalid_response", false, response.status, fileId);
    const cancel = async () => { try { await reader.cancel(); } catch (_) {} };

    const decoder = new TextDecoder("utf-8", { fatal: true });
    const parts = [];
    let size = 0;
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (_) {
        await cancel();
        return failure("network", true, undefined, fileId);
      }
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) {
        await cancel();
        return failure("invalid_response", false, response.status, fileId);
      }
      size += chunk.value.byteLength;
      if (size > PBP_VOCAB_BATCH_MAX_BYTES) {
        await cancel();
        return failure("remote_batch_too_large", false, response.status, fileId);
      }
      try {
        parts.push(decoder.decode(chunk.value, { stream: true }));
      } catch (_) {
        await cancel();
        return failure("invalid_response", false, response.status, fileId);
      }
    }
    try {
      parts.push(decoder.decode());
      return { ok: true, body: parts.join("") };
    } catch (_) {
      await cancel();
      return failure("invalid_response", false, response.status, fileId);
    }
  }

  async function listFiles(ownerHash, pageToken, requestFn = request) {
    if (!_pbpVocabValidOwnerHash(ownerHash) ||
        (pageToken !== undefined && (typeof pageToken !== "string" || !pageToken))) {
      return failure("invalid_input", false);
    }
    const url = new URL(`${apiBase}/files`);
    url.searchParams.set("spaces", "appDataFolder");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("q",
      "'appDataFolder' in parents and trashed = false and " +
      `appProperties has { key='pbpKind' and value='${protocol.kind}' } and ` +
      `appProperties has { key='schema' and value='${protocol.schema}' } and ` +
      `appProperties has { key='owner' and value='${ownerHash}' }`);
    url.searchParams.set("fields", `nextPageToken,files(${metadataFields})`);
    if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
    const requested = await requestFn(url, { method: "GET" });
    if (!requested.ok) return requested;
    if (!requested.response.ok) return responseFailure(requested.response);
    const parsed = await json(requested.response);
    if (!parsed.ok) return parsed;
    const value = parsed.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failure("invalid_response", false, requested.response.status);
    }
    const files = value.files === undefined ? [] : value.files;
    const nextPageToken = value.nextPageToken;
    if (!Array.isArray(files) ||
        (nextPageToken !== undefined &&
          (typeof nextPageToken !== "string" || !nextPageToken))) {
      return failure("invalid_response", false, requested.response.status);
    }
    return {
      ok: true,
      files,
      nextPageToken: nextPageToken === undefined ? null : nextPageToken
    };
  }

  async function getStartPageToken(requestFn = request) {
    const url = new URL(`${apiBase}/changes/startPageToken`);
    url.searchParams.set("spaces", "appDataFolder");
    const requested = await requestFn(url, { method: "GET" });
    if (!requested.ok) return requested;
    if (!requested.response.ok) return responseFailure(requested.response);
    const parsed = await json(requested.response);
    const pageToken = parsed.ok && parsed.value && parsed.value.startPageToken;
    if (!parsed.ok) return parsed;
    if (typeof pageToken !== "string" || !pageToken) {
      return failure("invalid_response", false, requested.response.status);
    }
    return { ok: true, pageToken };
  }

  async function listChanges(pageToken, requestFn = request) {
    if (typeof pageToken !== "string" || !pageToken) return failure("invalid_input", false);
    const url = new URL(`${apiBase}/changes`);
    url.searchParams.set("pageToken", pageToken);
    url.searchParams.set("spaces", "appDataFolder");
    url.searchParams.set("includeRemoved", "true");
    url.searchParams.set("pageSize", "1000");
    url.searchParams.set("fields",
      `nextPageToken,newStartPageToken,changes(removed,fileId,file(${metadataFields}))`);
    const requested = await requestFn(url, { method: "GET" });
    if (!requested.ok) return requested;
    if (!requested.response.ok) return responseFailure(requested.response);
    const parsed = await json(requested.response);
    if (!parsed.ok) return parsed;
    const value = parsed.value;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failure("invalid_response", false, requested.response.status);
    }
    const changes = value.changes === undefined ? [] : value.changes;
    const nextPageToken = value.nextPageToken;
    const newStartPageToken = value.newStartPageToken;
    const hasNext = nextPageToken !== undefined;
    const hasNew = newStartPageToken !== undefined;
    if (!Array.isArray(changes) || hasNext === hasNew ||
        (hasNext && (typeof nextPageToken !== "string" || !nextPageToken)) ||
        (hasNew && (typeof newStartPageToken !== "string" || !newStartPageToken))) {
      return failure("invalid_response", false, requested.response.status);
    }
    return {
      ok: true,
      changes,
      nextPageToken: hasNext ? nextPageToken : null,
      newStartPageToken: hasNew ? newStartPageToken : null
    };
  }

  async function openSession(interactive = false, {
    beforeRequest: sessionGuard = null, isCurrent: sessionIsCurrent = null
  } = {}) {
    const first = await mint(interactive);
    if (!first.ok) return first;
    let token = first.token;

    let permissionId = "";
    const guards = { beforeRequest: sessionGuard, isCurrent: sessionIsCurrent };
    const sessionRequest = async (url, init = {}, _interactive = false, fileId, deadlineMs) => {
      const sent = await requestWithToken(token, url, init, fileId, deadlineMs, guards);
      if (!sent.ok || sent.response.status !== 401) return sent;

      pbpVocabDriveForgetIdentity(token);
      let renewed;
      try {
        await identityApi().removeCachedAuthToken({ token });
        renewed = tokenValue(await identityApi().getAuthToken({ interactive: false }));
      } catch (error) {
        console.warn("[vocab-drive] token renew failed:", error?.name, error?.message);
        return mintFailure(error, false, fileId);
      }
      if (typeof renewed !== "string" || !renewed) {
        return mintFailure(undefined, false, fileId);
      }

      if (permissionId) {
        const probe = await about(false, async (probeUrl, probeInit, _probeInteractive, probeFileId) => {
          const checked = await requestWithToken(
            renewed, probeUrl, probeInit, probeFileId, requestTimeoutMs, guards
          );
          if (checked.ok && checked.response.status === 401) {
            pbpVocabDriveForgetIdentity(renewed);
            return failure("auth", false, 401, probeFileId);
          }
          return checked;
        });
        if (!probe.ok) return probe;
        if (probe.permissionId !== permissionId) {
          return failure("account_changed", false, undefined, fileId);
        }
      }

      token = renewed;
      const retried = await requestWithToken(token, url, init, fileId, deadlineMs, guards);
      if (retried.ok && retried.response.status === 401) {
        pbpVocabDriveForgetIdentity(token);
        return failure("auth", false, 401, fileId);
      }
      return retried;
    };

    const opened = await about(false, sessionRequest);
    if (!opened.ok) return opened;
    permissionId = opened.permissionId;
    return {
      ok: true,
      permissionId,
      emailAddress: opened.emailAddress,
      displayName: opened.displayName,
      about: () => about(false, sessionRequest),
      generateId: () => generateId(sessionRequest),
      upload: (metadata, body) => upload(metadata, body, sessionRequest),
      getMetadata: (fileId) => getMetadata(fileId, sessionRequest),
      download: (fileId) => download(fileId, sessionRequest),
      listFiles: (ownerHash, pageToken) => listFiles(ownerHash, pageToken, sessionRequest),
      getStartPageToken: () => getStartPageToken(sessionRequest),
      listChanges: (pageToken) => listChanges(pageToken, sessionRequest)
    };
  }

  void now;
  void random;
  return {
    connect: () => about(true),
    about: () => about(false, request, true),
    openSession,
    generateId,
    upload,
    getMetadata,
    download,
    listFiles,
    getStartPageToken,
    listChanges
  };
}

// Silent token-mint (auth) failures that back off before the connection is
// blocked: five backoffs (1+2+4+8+16 min, +/-20%, about 31 minutes), then the
// sixth auth failure blocks. Long enough to ride out a short outage, short
// enough that a real revocation gets named.
const PBP_VOCAB_AUTH_RETRY_LIMIT = 5;

// One schedule for both datasets: every run syncs vocabulary, then notes.
const PBP_DRIVE_DIRTY_ALARM = "drive-sync-dirty";
const PBP_DRIVE_PERIODIC_ALARM = "drive-sync-periodic";
const PBP_DRIVE_RETRY_ALARM = "drive-sync-retry";
const PBP_DRIVE_LEGACY_ALARMS = Object.freeze([
  "vocab-sync-dirty", "vocab-sync-periodic", "vocab-sync-retry",
  "notes-sync-dirty", "notes-sync-periodic", "notes-sync-retry"
]);
// Failures of the Google connection itself, not of either dataset. They live
// in one per-owner record shared by both runners and never reach a dataset's
// preflight or account row.
const PBP_DRIVE_CONNECTION_ERRORS = new Set(["auth", "permission", "network", "rate_limited", "server"]);

function _pbpDriveConnectionRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.lastError != null && !PBP_DRIVE_CONNECTION_ERRORS.has(value.lastError)) return null;
  return value;
}

function pbpVocabRetryDelayMinutes(attempt, random = Math.random) {
  const index = Math.max(0, Number.isFinite(attempt) ? Math.floor(attempt) : 0);
  const sample = Math.max(0, Math.min(1, Number(random()) || 0));
  return Math.min(60, 2 ** index) * (0.8 + sample * 0.4);
}

async function pbpDriveScheduleDirty(alarms = chrome.alarms, now = Date.now) {
  const when = now() + 30000;
  const existing = await alarms.get(PBP_DRIVE_DIRTY_ALARM);
  if (existing && Number.isFinite(existing.scheduledTime) && existing.scheduledTime <= when) {
    return false;
  }
  await alarms.create(PBP_DRIVE_DIRTY_ALARM, { when });
  return true;
}

// Re-creating a periodic alarm restarts its clock, so a worker that wakes
// every few minutes would keep pushing the next run away. Create it once.
async function pbpDriveEnsurePeriodic(alarms = chrome.alarms) {
  if (await alarms.get(PBP_DRIVE_PERIODIC_ALARM)) return false;
  await alarms.create(PBP_DRIVE_PERIODIC_ALARM, { periodInMinutes: 15 });
  return true;
}

function _pbpVocabDriveDefaultStore() {
  return {
    getMeta: pbpVocabGetSyncMeta,
    getPreflightState: pbpVocabGetPreflightState,
    putPreflightState: pbpVocabPutPreflightState,
    deletePreflightState: pbpVocabDeletePreflightState,
    getAccountState: pbpVocabGetAccountState,
    putAccountState: pbpVocabPutAccountState,
    seedLegacy: pbpVocabSeedLegacy,
    applyRemotePage: pbpVocabApplyRemotePage,
    checkpointOwner: pbpVocabCheckpointOwner,
    listPendingBatches: pbpVocabListPendingBatches,
    deletePendingBatch: pbpVocabDeletePendingBatch,
    listOutbox: pbpVocabListOutbox,
    freezeOutbox: pbpVocabFreezeOutbox
  };
}

function pbpCreateVocabDriveSyncRunner({
  client = pbpCreateVocabDriveClient(),
  store = _pbpVocabDriveDefaultStore(),
  getCurrentPinboardAuth,
  pinboardAuthIsCurrent,
  hashOwner = pbpVocabOwnerHash,
  now = Date.now,
  random = Math.random,
  protocol = PBP_VOCAB_DRIVE_PROTOCOL,
  isEnabled = async () => true,
  getCurrentPermissionId = null,
  onSession = null,
  getScopeEpoch = null,
  // The orchestrator's per-owner record of the shared Google connection:
  // { get(ownerHash) -> state|null, put(ownerHash, state|null) -> boolean }.
  connection = null
} = {}) {
  const accountKey = (permissionId, ownerHash) =>
    `account:${permissionId}:${ownerHash}`;
  const preflightKey = (ownerHash) => `preflight:${ownerHash}`;
  const normalizedFailure = (source) => {
    if (source?.error === "account_changed") {
      return { ok: false, error: "account_changed", retryable: false };
    }
    // "auth" is checked before the generic retryable branch so a transient
    // token-mint failure keeps its accurate code instead of surfacing as a
    // network error, while still taking the backoff path rather than blocking.
    if (source?.error === "auth") {
      return { ok: false, error: "auth", retryable: source.retryable === true };
    }
    if (source?.error === "network") return { ok: false, error: "network", retryable: true };
    // Throttling and 5xx are still the connection, but they mean "busy", not
    // "offline", so they keep their own code for the panel.
    if (source?.error === "rate_limited" || source?.error === "server") {
      return { ok: false, error: source.error, retryable: true };
    }
    // A bug or a lost worker says nothing about the data: back off and retry
    // instead of blocking until the user forces a run.
    if (source?.error === "unexpected") return { ok: false, error: "unexpected", retryable: true };
    if (source?.retryable) return { ok: false, error: "network", retryable: true };
    if (source?.error === "entry_too_large") {
      return { ok: false, error: "entry_too_large", retryable: false };
    }
    // "local_store" is a failed IndexedDB write on this device: reconnecting
    // and re-downloading cannot help, and the remote copy is intact. Keep it
    // apart from "corrupt", which means the remote batch itself did not
    // validate. "invalid_remote_page" is the only code the store returns for a
    // rejected page -- without it, page-apply failures surfaced as "remote".
    if (source?.error === "permission" || source?.error === "corrupt" ||
        source?.error === "remote" || source?.error === "local_store") {
      return { ok: false, error: source.error, retryable: false };
    }
    if (source?.error === "invalid_response" || source?.error === "id_collision" ||
        source?.error === "remote_batch_too_large" ||
        source?.error === "invalid_remote_page") {
      return { ok: false, error: "corrupt", retryable: false };
    }
    return { ok: false, error: "remote", retryable: false };
  };

  return async function run({ interactive = false, force = false } = {}) {
    const scopeEpoch = getScopeEpoch ? getScopeEpoch() : null;
    const scopeIsCurrent = () => !getScopeEpoch || getScopeEpoch() === scopeEpoch;
    let state = null;
    let startAuth = null;
    let owner = "";
    let ownerHash = "";
    let preflight = null;
    let session = null;
    let connState = null;
    let changedLocal = false;
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
    const putConnection = async (next) => {
      if (!connection || !/^[0-9a-f]{64}$/.test(ownerHash)) return false;
      try {
        if (!await connection.put(ownerHash, next)) return false;
      } catch (error) {
        console.warn("[vocab-drive] connection state unavailable:", error?.name, error?.message);
        return false;
      }
      connState = next;
      return true;
    };
    // A store that throws (IndexedDB closing, a quota, a broken record) is a
    // failure of this device's storage, not of Drive. A coded error keeps
    // its own code.
    const readStore = async (read) => {
      try {
        return await read();
      } catch (error) {
        if (typeof error?.code === "string") throw error;
        console.warn("[vocab-drive] store read failed:", error?.name, error?.message);
        const failure = new Error("Sync store read failed");
        failure.code = "local_store";
        throw failure;
      }
    };
    const stateWith = (patch, remove = []) => {
      const next = { ...state, ...patch };
      for (const key of remove) delete next[key];
      return next;
    };
    // Drive answers a stale or malformed page token with 400/404, which is not
    // retryable: the account is blocked with the rejected cursor still in its
    // row, so the forced run the panel asks for would replay the same token and
    // block again. Remember the rejection instead, and let force restart.
    const noteCursorRejected = (page) => {
      if (!state || state.cursorRejected === true || page?.retryable === true) return;
      if (page?.status !== 400 && page?.status !== 404) return;
      state = stateWith({ cursorRejected: true });
    };
    const stillCurrent = async ({ checkDrive = true } = {}) => {
      if (!await isEnabled()) return false;
      if (checkDrive && session?.permissionId && getCurrentPermissionId) {
        const verified = await getCurrentPermissionId();
        if (verified && typeof verified === "object" && verified.ok !== true) {
          const error = new Error("Drive identity verification unavailable");
          error.code = verified.error || "remote";
          error.retryable = verified.retryable === true;
          throw error;
        }
        const permissionId = typeof verified === "string" ? verified : verified?.permissionId;
        if (permissionId !== session.permissionId) return false;
      }
      if (!await isEnabled()) return false;
      const current = await getCurrentPinboardAuth();
      return !!startAuth?.account && current?.account === startAuth.account &&
        pinboardAuthIsCurrent(startAuth) && pinboardAuthIsCurrent(current) && scopeIsCurrent();
    };
    // A connection failure says nothing about this dataset, so it goes to the
    // shared record only: the preflight and the account row keep whatever
    // data-layer state they had.
    const finishConnectionFailure = async (failure) => {
      let result = failure;
      const authAttempts = count(connState?.authAttempts);
      const retryAttempt = count(connState?.retryAttempt);
      // A revoked grant can never mint a token silently, so it never produces
      // the 401 that would prove revocation -- it is indistinguishable from
      // being offline. Retrying forever would leave the panel claiming the
      // device is connected and never surface the one action that helps, so
      // back off five times (about 31 minutes), block on the sixth. Only auth
      // failures count: an outage before them must not spend the budget.
      if (result.retryable && result.error === "auth" &&
          authAttempts >= PBP_VOCAB_AUTH_RETRY_LIMIT) {
        result = { ...result, retryable: false };
      }
      const at = now();
      const nextAuthAttempts = result.error === "auth" ? authAttempts + 1 : 0;
      await putConnection(result.retryable
        ? {
          lastError: result.error,
          authAttempts: nextAuthAttempts,
          retryAttempt: retryAttempt + 1,
          retryAt: at + pbpVocabRetryDelayMinutes(retryAttempt, random) * 60000,
          blocked: false,
          updatedAt: at
        }
        : {
          lastError: result.error,
          authAttempts: nextAuthAttempts,
          retryAttempt: 0,
          retryAt: null,
          blocked: true,
          updatedAt: at
        });
      return result;
    };
    const finishFailure = async (source) => {
      const result = normalizedFailure(source);
      if (result.error === "account_changed") return result;
      if (!await stillCurrent({ checkDrive: false })) {
        return normalizedFailure({ error: "account_changed" });
      }
      if (PBP_DRIVE_CONNECTION_ERRORS.has(result.error)) return finishConnectionFailure(result);
      const canPersistPreflight = /^[0-9a-f]{64}$/.test(ownerHash);
      const attempts = [state?.retryAttempt, preflight?.retryAttempt]
        .filter((value) => Number.isInteger(value) && value >= 0);
      const attempt = attempts.length ? Math.max(...attempts) : 0;
      const persistAccountFailure = async (failed) => {
        // Account verification may be unavailable because the original request
        // went offline. The owner-level preflight can still retain its backoff;
        // never let an unverified account write replace the original error.
        try { if (await store.putAccountState(failed)) state = failed; }
        catch (error) { console.warn("[vocab-drive] failure state unavailable:", error?.name, error?.code); }
      };
      if (result.retryable) {
        const retryAt = now() + pbpVocabRetryDelayMinutes(attempt, random) * 60000;
        if (state) {
          const failed = stateWith({
            lastError: result.error,
            retryAttempt: attempt + 1,
            retryAt
          });
          await persistAccountFailure(failed);
        }
        if (canPersistPreflight) {
          const failedPreflight = {
            key: preflightKey(ownerHash),
            ownerHash,
            retryAttempt: attempt + 1,
            retryAt,
            lastError: result.error,
            blocked: false
          };
          if (await store.putPreflightState(failedPreflight)) preflight = failedPreflight;
        }
      } else {
        if (canPersistPreflight) {
          const blockedPreflight = {
            key: preflightKey(ownerHash),
            ownerHash,
            retryAttempt: 0,
            retryAt: null,
            lastError: result.error,
            blocked: true
          };
          if (await store.putPreflightState(blockedPreflight)) {
            preflight = blockedPreflight;
          }
        }
        if (state) {
          // Only a forced run clears a block, so a retryAt left over from the
          // earlier backoff would surface as a "next retry" that never comes.
          const failed = stateWith({ lastError: result.error, retryAt: null });
          await persistAccountFailure(failed);
        }
      }
      return result;
    };
    const applyPage = async (metadata, cursorCommit) => {
      const batches = [];
      for (const meta of metadata) {
        if (!_pbpVocabDriveValidMetadata(meta, protocol) ||
            meta.appProperties.owner !== ownerHash) {
          return normalizedFailure({ error: "invalid_response" });
        }
        const downloaded = await session.download(meta.id);
        if (!downloaded.ok) return normalizedFailure(downloaded);
        if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
        if (!pbpVocabValidateDriveBatch(meta, downloaded.body, ownerHash, protocol)) {
          return normalizedFailure({ error: "invalid_response" });
        }
        batches.push(JSON.parse(downloaded.body));
      }
      if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
      const applied = await store.applyRemotePage(
        owner, ownerHash, batches, cursorCommit
      );
      if (!applied?.ok) return normalizedFailure(applied);
      // Report whether local records actually moved, so the caller only wakes
      // open pages when their snapshot is genuinely stale.
      if ((applied.applied || 0) + (applied.merged || 0) > 0) changedLocal = true;
      return { ok: true };
    };
    const changesMetadata = (changes, skipSelf, deviceId) => {
      const metadata = [];
      let removed = false;
      for (const change of changes) {
        if (!change || typeof change !== "object" || Array.isArray(change)) {
          return { ok: false };
        }
        if (change.removed === true) {
          removed = true;
          continue;
        }
        const properties = change.file?.appProperties;
        if (!properties || properties.pbpKind !== protocol.kind ||
            properties.schema !== String(protocol.schema) ||
            properties.owner !== ownerHash) {
          continue;
        }
        if (!_pbpVocabDriveValidMetadata(change.file, protocol) ||
            change.fileId !== change.file.id) return { ok: false };
        if (!skipSelf || properties.device !== deviceId) metadata.push(change.file);
      }
      return { ok: true, metadata, removed };
    };

    try {
      // Disconnected, or the optional permission removed, after the caller
      // checked: a control-flow exit, never an error to persist or render.
      if (!await isEnabled()) return { ok: false, error: "not_connected", retryable: false };
      startAuth = await getCurrentPinboardAuth();
      // Distinct from "auth": there is no Pinboard account to scope the
      // vocabulary to, so no Google call has been made and reconnecting Drive
      // cannot help. Reported before ownerHash exists, so it is never persisted
      // to a preflight row.
      if (!startAuth?.account || !pinboardAuthIsCurrent(startAuth)) {
        return { ok: false, error: "pinboard_auth", retryable: false };
      }
      owner = pbpDictOwnerScope(startAuth.account);
      ownerHash = await hashOwner(owner);
      preflight = await readStore(() => store.getPreflightState(ownerHash));
      // Earlier releases wrote connection failures into the dataset's own
      // preflight. The shared record owns them now; honoring the leftover as
      // a block or a backoff would resurrect a stale verdict.
      if (PBP_DRIVE_CONNECTION_ERRORS.has(preflight?.lastError)) preflight = null;
      if (!await stillCurrent()) {
        return normalizedFailure({ error: "account_changed" });
      }
      connState = connection
        ? _pbpDriveConnectionRecord(await readStore(() => connection.get(ownerHash)))
        : null;
      if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
      if (force) {
        if (!await store.deletePreflightState(ownerHash)) {
          return finishFailure({ error: "local_store" });
        }
        preflight = null;
        // A forced run is the user's way out of a block, so the shared
        // connection starts over too: its counters must not outlive it.
        if (connState) await putConnection(null);
        connState = null;
      } else if (connState?.blocked === true) {
        return { ...normalizedFailure({ error: connState.lastError || "auth" }), retryable: false };
      } else if (Number.isFinite(connState?.retryAt) && connState.retryAt > now()) {
        return {
          ok: true,
          status: { waitingForRetry: true, connectionWaiting: true, retryAt: connState.retryAt }
        };
      } else if (preflight?.blocked === true) {
        return normalizedFailure({ error: preflight.lastError || "remote" });
      } else if (Number.isFinite(preflight?.retryAt) && preflight.retryAt > now()) {
        return {
          ok: true,
          status: { ...preflight, waitingForRetry: true }
        };
      }

      session = await client.openSession(interactive, { beforeRequest: async () => {
        if (!await isEnabled()) return false;
        const current = await getCurrentPinboardAuth();
        return current?.account === startAuth.account && pinboardAuthIsCurrent(startAuth) &&
          pinboardAuthIsCurrent(current) && scopeIsCurrent();
      }, isCurrent: () => pinboardAuthIsCurrent(startAuth) && scopeIsCurrent() });
      if (!session.ok) return finishFailure(session);
      if (onSession) onSession(session.permissionId);
      if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
      // Google answered (spec §10.2): the connection error and its wait are
      // over, clear them now; retryAttempt stays until the whole run succeeds.
      if (connState && (connState.lastError != null || connState.retryAt != null || count(connState.authAttempts) > 0)) {
        await putConnection({ ...connState, lastError: null, retryAt: null, authAttempts: 0 });
      }

      state = await readStore(() => store.getAccountState(session.permissionId, ownerHash));
      if (!await stillCurrent()) {
        return normalizedFailure({ error: "account_changed" });
      }
      // The same leftover as in the preflight: a connection failure an earlier
      // release kept in the account row is not this dataset's error.
      if (PBP_DRIVE_CONNECTION_ERRORS.has(state?.lastError)) {
        state = { ...state, lastError: null, retryAttempt: 0, retryAt: null };
      }
      // seedLegacy only enrols records that still lack sync metadata, so a
      // second Google account starts with an empty outbox and would silently
      // sync one way: it downloads, but never uploads the vocabulary the first
      // account already enrolled. A checkpoint rebuilds the outbox from the
      // local records, and it runs after the download pass so the upload
      // carries the merged state.
      const freshAccount = !state;
      state = {
        ...(state || {}),
        key: accountKey(session.permissionId, ownerHash),
        drivePermissionId: session.permissionId,
        emailAddress: session.emailAddress || "",
        displayName: session.displayName || "",
        ownerHash,
        bootstrapComplete: state?.bootstrapComplete === true,
        pageToken: state?.pageToken || null,
        // Persist it with the very first account row rather than keeping it in
        // a local: bootstrap commits several rows before the changes loop
        // reaches the point that writes the flag, and a failure in between
        // would leave a row that never checkpoints -- the second account would
        // download forever and never upload this device's vocabulary.
        ...(freshAccount || state?.needsCheckpoint === true
          ? { needsCheckpoint: true } : {})
      };
      // A cursor Drive has rejected cannot be resumed, so for that one case
      // force means "start the bootstrap over"; every other force still resumes
      // where the last run stopped. The rebuilt outbox has to carry the whole
      // local library up, hence the checkpoint.
      const restartBootstrap = force && state.cursorRejected === true;
      if (force && (restartBootstrap || state.retryAttempt || state.retryAt || state.lastError)) {
        const reset = restartBootstrap
          ? stateWith({
            retryAttempt: 0,
            retryAt: null,
            lastError: null,
            bootstrapComplete: false,
            pageToken: null,
            needsCheckpoint: true
          }, ["cursorRejected", "bootstrapStartToken", "bootstrapListComplete",
            "bootstrapFilePageToken", "bootstrapChangePageToken"])
          : stateWith({ retryAttempt: 0, retryAt: null, lastError: null });
        if (!await store.putAccountState(reset)) {
          return finishFailure({ error: "local_store" });
        }
        state = reset;
      }
      if (!force && Number.isFinite(state.retryAt) && state.retryAt > now()) {
        return { ok: true, status: { ...state, waitingForRetry: true } };
      }

      const meta = await readStore(() => store.getMeta());
      if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
      if (!meta?.deviceId) return finishFailure({ error: "invalid_response" });
      const deviceId = meta.deviceId;
      let needsCheckpoint = state.needsCheckpoint === true;

      if (!state.bootstrapComplete) {
        while (true) {
          if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
          const seeded = await store.seedLegacy(owner, 100);
          if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
          if (!seeded?.ok) return finishFailure(seeded?.error ? seeded : { error: "local_store" });
          if (!seeded.processed) break;
        }

        if (!state.bootstrapStartToken) {
          const token = await session.getStartPageToken();
          if (!token.ok) return finishFailure(token);
          if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
          const next = stateWith({ bootstrapStartToken: token.pageToken });
          if (!await store.putAccountState(next)) {
            return finishFailure({ error: "local_store" });
          }
          state = next;
        }

        if (state.bootstrapListComplete !== true) {
          let pageToken = state.bootstrapFilePageToken || undefined;
          while (true) {
            const page = await session.listFiles(ownerHash, pageToken);
            if (!page.ok) {
              if (pageToken) noteCursorRejected(page);
              return finishFailure(page);
            }
            if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
            const next = page.nextPageToken
              ? stateWith({ bootstrapFilePageToken: page.nextPageToken })
              : stateWith({ bootstrapListComplete: true }, ["bootstrapFilePageToken"]);
            const applied = await applyPage(page.files, next);
            if (!applied.ok) return finishFailure(applied);
            state = next;
            if (!page.nextPageToken) break;
            pageToken = page.nextPageToken;
          }
        }

        let changeToken = state.bootstrapChangePageToken || state.bootstrapStartToken;
        while (true) {
          const page = await session.listChanges(changeToken);
          if (!page.ok) {
            noteCursorRejected(page);
            return finishFailure(page);
          }
          if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
          const selected = changesMetadata(page.changes, false, deviceId);
          if (!selected.ok) return finishFailure({ error: "invalid_response" });
          needsCheckpoint ||= selected.removed;
          const terminal = !page.nextPageToken;
          const next = terminal
            ? stateWith({
              bootstrapComplete: true,
              pageToken: page.newStartPageToken
            }, ["bootstrapStartToken", "bootstrapListComplete", "bootstrapChangePageToken"])
            : stateWith({ bootstrapChangePageToken: page.nextPageToken });
          if (needsCheckpoint) next.needsCheckpoint = true;
          const applied = await applyPage(selected.metadata, next);
          if (!applied.ok) return finishFailure(applied);
          state = next;
          if (terminal) break;
          changeToken = page.nextPageToken;
        }
      } else {
        let changeToken = state.pageToken;
        if (!changeToken) return finishFailure({ error: "invalid_response" });
        while (true) {
          const page = await session.listChanges(changeToken);
          if (!page.ok) {
            noteCursorRejected(page);
            return finishFailure(page);
          }
          if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
          const selected = changesMetadata(page.changes, true, deviceId);
          if (!selected.ok) return finishFailure({ error: "invalid_response" });
          needsCheckpoint ||= selected.removed;
          const terminal = !page.nextPageToken;
          const next = stateWith({
            pageToken: terminal ? page.newStartPageToken : page.nextPageToken
          });
          if (needsCheckpoint) next.needsCheckpoint = true;
          const applied = await applyPage(selected.metadata, next);
          if (!applied.ok) return finishFailure(applied);
          state = next;
          if (terminal) break;
          changeToken = page.nextPageToken;
        }
      }

      if (needsCheckpoint) {
        if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
        // The checkpoint rewrites one outbox row per record in a single IDB
        // transaction, so a full disk or an exhausted quota aborts it. Claim it
        // as "local_store" here: letting it reach the outer catch would file
        // a local write failure as "unexpected" and keep retrying it, failing
        // the same way on every scheduled run.
        try {
          await store.checkpointOwner(owner);
        } catch (error) {
          console.warn("[vocab-drive] checkpoint failed:", error?.name, error?.message);
          return finishFailure({
            error: typeof error?.code === "string" ? error.code : "local_store",
            retryable: error?.retryable === true
          });
        }
        if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
        const cleared = stateWith({}, ["needsCheckpoint"]);
        if (!await store.putAccountState(cleared)) {
          return finishFailure({ error: "local_store" });
        }
        state = cleared;
      }

      const uploadPending = async (pending) => {
        let parsed;
        try { parsed = JSON.parse(pending.body); } catch (_) {
          return normalizedFailure({ error: "invalid_response" });
        }
        let metadata;
        try {
          metadata = pbpVocabDriveMetadata(
            pending.driveFileId, ownerHash, parsed.deviceId, protocol
          );
        } catch (_) {
          return normalizedFailure({ error: "invalid_response" });
        }
        if (!pbpVocabValidateDriveBatch(metadata, pending.body, ownerHash, protocol)) {
          return normalizedFailure({ error: "invalid_response" });
        }
        if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
        const uploaded = await session.upload(metadata, pending.body);
        if (!uploaded.ok) return normalizedFailure(uploaded);
        if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
        if (!await store.deletePendingBatch(
          state.drivePermissionId, ownerHash, pending.driveFileId
        )) return normalizedFailure({ error: "local_store" });
        return { ok: true };
      };

      for (const pending of await readStore(() => store.listPendingBatches(
        state.drivePermissionId, ownerHash
      ))) {
        const uploaded = await uploadPending(pending);
        if (!uploaded.ok) return finishFailure(uploaded);
      }

      const outbox = await readStore(() => store.listOutbox(owner));
      const split = pbpVocabSplitDriveEntries(
        outbox.map((row) => row.event),
        { ownerHash, deviceId, createdAt: now() }, protocol
      );
      if (!split.ok) return finishFailure(split);
      for (const batch of split.batches) {
        const generated = await session.generateId();
        if (!generated.ok) return finishFailure(generated);
        if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
        let frozen;
        try {
          frozen = await store.freezeOutbox(
            owner, state.drivePermissionId, ownerHash, generated.fileId, batch
          );
        } catch (error) {
          console.warn("[vocab-drive] freeze failed:", error?.name, error?.message);
          return finishFailure({
            error: typeof error?.code === "string" ? error.code : "local_store",
            retryable: error?.retryable === true
          });
        }
        if (!frozen) return finishFailure({ error: "local_store" });
        const uploaded = await uploadPending(frozen);
        if (!uploaded.ok) return finishFailure(uploaded);
      }

      const confirmed = await session.about();
      if (!confirmed.ok) return finishFailure(confirmed);
      if (!await stillCurrent() || confirmed.permissionId !== state.drivePermissionId) {
        return normalizedFailure({ error: "account_changed" });
      }
      const success = stateWith({
        lastSuccessAt: now(),
        lastError: null,
        retryAttempt: 0,
        retryAt: null
      }, ["cursorRejected"]);
      if (!await store.putAccountState(success)) {
        return finishFailure({ error: "local_store" });
      }
      state = success;
      if (!await stillCurrent()) return normalizedFailure({ error: "account_changed" });
      if (!await store.deletePreflightState(ownerHash)) {
        return finishFailure({ error: "local_store" });
      }
      preflight = null;
      // Every request of the run went through: the shared connection has no
      // failure left to report or to wait out.
      await putConnection(null);
      if (!await isEnabled()) return normalizedFailure({ error: "account_changed" });
      return { ok: true, changed: changedLocal, status: { ...state } };
    } catch (error) {
      console.warn("[vocab-drive] sync failed:", error?.name, error?.message);
      const source = typeof error?.code === "string"
        ? { error: error.code, retryable: error.retryable === true }
        : { error: "unexpected", retryable: true };
      try {
        return await finishFailure(source);
      } catch (inner) {
        console.warn("[vocab-drive] failure state unavailable:", inner?.name, inner?.message);
        return normalizedFailure(source);
      }
    }
  };
}
