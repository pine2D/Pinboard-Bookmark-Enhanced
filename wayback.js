// ============================================================
// Pinboard Bookmark Enhanced - Wayback Machine Integration
// ============================================================

// Constants
const WAYBACK_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const WAYBACK_LOG_CAP = 20;
const WAYBACK_ANON_TIMEOUT_MS = 30000;
const WAYBACK_AUTH_TIMEOUT_MS = 10000;

// ---- Pure functions (no chrome.*, no document) ----

function pbpWaybackShouldAttempt(attemptsMap, url, now) {
  if (!attemptsMap || !url) return true;
  const lastAttempt = attemptsMap[url];
  if (!lastAttempt) return true;
  return (now - lastAttempt) >= WAYBACK_DEDUP_WINDOW_MS;
}

function pbpWaybackPruneAttempts(attemptsMap, now) {
  if (!attemptsMap) return {};
  const pruned = {};
  for (const [url, ts] of Object.entries(attemptsMap)) {
    if ((now - ts) < WAYBACK_DEDUP_WINDOW_MS) {
      pruned[url] = ts;
    }
  }
  return pruned;
}

function pbpWaybackAppendLog(logArr, entry, cap) {
  const actualCap = cap !== undefined ? cap : WAYBACK_LOG_CAP;
  if (!logArr) logArr = [];
  const newLog = [...logArr, entry];
  if (newLog.length > actualCap) {
    return newLog.slice(newLog.length - actualCap);
  }
  return newLog;
}

function pbpWaybackBuildRequest(url, s3Key, s3Secret) {
  const hasKey = s3Key && typeof s3Key === "string" && s3Key.trim().length > 0;
  const hasSecret = s3Secret && typeof s3Secret === "string" && s3Secret.trim().length > 0;

  if (!hasKey || !hasSecret) {
    // Anonymous request: use encodeURI (preserves :// structure)
    return {
      url: "https://web.archive.org/save/" + encodeURI(url),
      method: "GET",
      headers: {},
      body: null,
      timeoutMs: WAYBACK_ANON_TIMEOUT_MS
    };
  }

  // Authenticated request: POST with urlencoded body (encodeURIComponent for body fields)
  return {
    url: "https://web.archive.org/save",
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Authorization": "LOW " + s3Key + ":" + s3Secret,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    // js_behavior_timeout=0 + skip_first_archive=1 = faster capture; if_not_archived_within=1d = server-side dedup.
    body: "url=" + encodeURIComponent(url) + "&skip_first_archive=1&js_behavior_timeout=0&if_not_archived_within=1d",
    timeoutMs: WAYBACK_AUTH_TIMEOUT_MS
  };
}

// ---- Internal logging helper (chrome.* inside function body) ----

// Best-effort, non-atomic read-modify-write: concurrent callers may drop one entry. Acceptable for an advisory log.
async function _pbpWaybackLog(url, outcome) {
  try {
    const stored = await chrome.storage.local.get({ _waybackLog: [] });
    let log = stored._waybackLog || [];
    if (!Array.isArray(log)) log = [];
    const entry = { url, ts: Date.now(), outcome };
    log = pbpWaybackAppendLog(log, entry, WAYBACK_LOG_CAP);
    await chrome.storage.local.set({ _waybackLog: log });
  } catch (e) {
    console.debug("[wayback] log write failed:", e?.message || e);
  }
}

// ---- Orchestrator (chrome.* usage allowed inside function body) ----

async function pbpWaybackArchive(url, settings) {
  try {
    // Step 1: Check if feature is enabled
    if (!settings || settings.waybackArchiveEnabled !== true) {
      return;
    }

    // Step 2: Check permission
    try {
      const hasPermission = await chrome.permissions.contains({ origins: ["https://web.archive.org/*"] });
      if (!hasPermission) {
        await _pbpWaybackLog(url, "permDenied");
        return;
      }
    } catch (_) {
      return;
    }

    // Step 3: Read dedup map and check if we should attempt
    const stored = await chrome.storage.local.get({ _waybackAttempts: {} });
    const attempts = stored._waybackAttempts || {};
    const now = Date.now();
    if (!pbpWaybackShouldAttempt(attempts, url, now)) {
      await _pbpWaybackLog(url, "skipped");
      return;
    }

    // Step 4: Prune old attempts and record this one
    // Best-effort dedup: the read-modify-write below is not atomic; a rare concurrent save may double-fire. Acceptable — the server also dedups (30min default / if_not_archived_within).
    const pruned = pbpWaybackPruneAttempts(attempts, now);
    pruned[url] = now;
    await chrome.storage.local.set({ _waybackAttempts: pruned });

    // Step 5: Build and send request
    const req = pbpWaybackBuildRequest(url, settings.waybackS3Key || "", settings.waybackS3Secret || "");
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      credentials: "omit",
      signal: AbortSignal.timeout(req.timeoutMs)
    });

    // Step 6: Classify outcome
    let outcome;
    if (response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        try {
          const json = await response.json();
          if (json.job_id) {
            outcome = "job:" + json.job_id;
          } else {
            outcome = "requested";
          }
        } catch (_) {
          outcome = "requested";
        }
      } else {
        outcome = "requested";
      }
    } else if (response.status === 429) {
      outcome = "rate-limited";
    } else {
      outcome = "error:" + response.status;
    }

    // Step 7: Log the result
    await _pbpWaybackLog(url, outcome);
  } catch (e) {
    // Catch AbortError and other exceptions — never throw
    if (e && (e.name === "AbortError" || e.name === "TimeoutError")) {
      await _pbpWaybackLog(url, "timeout");
    } else {
      const msg = e?.message || String(e) || "unknown";
      await _pbpWaybackLog(url, "error:" + msg);
    }
  }
}
