// ============================================================
// Pinboard Bookmark Enhanced — Export send runtime (md-preview only)
// Executes a send for a registry target: clipboard + window.open for
// url-scheme rows, with a Download-.md fallback when an inline-content URI
// exceeds the length budget. Degrades, never throws to the caller.
// (P2 adds the token-api branch here.)
// ============================================================

const _PBP_LAST_TARGET_KEY = "lastExportTarget";

async function pbpGetLastTarget() {
  try {
    const o = await chrome.storage.local.get(_PBP_LAST_TARGET_KEY);
    return (o && o[_PBP_LAST_TARGET_KEY]) || null;
  } catch (_) { return null; }
}

async function pbpSetLastTarget(id) {
  try { await chrome.storage.local.set({ [_PBP_LAST_TARGET_KEY]: id }); } catch (_) {}
}

// Send one clip to a target. Returns { ok, fellBack, error }. Never throws.
async function pbpSendToTarget(id, ctx) {
  ctx = ctx || {};
  const row = PBP_EXPORT_TARGETS[id];
  if (!row) return { ok: false, fellBack: false, error: "unknown target" };
  const meta = ctx.meta || {};
  const rawBody = ctx.rawBody || "";
  const cfg = ctx.cfg || {};

  // Required-config guard (e.g. Capacities spaceId): block with a clear error
  // rather than firing a broken URI.
  const missing = (row.settings || []).find((s) => s.required && !String(cfg[s.key] || "").trim());
  if (missing) return { ok: false, fellBack: false, error: "missing:" + missing.key };

  try {
    // Token-API path: permission -> precheck -> optional preRequest -> request,
    // with a clipboard-safe failure fallback. GitHub Gist ships on this branch
    // today; it is also the generic template for further token-api targets.
    // A row's token may be REQUIRED (github) or OPTIONAL (webhook) — the
    // required-config guard above gates entry, so keying off buildRequest alone
    // is correct.
    if (row.buildRequest) {
      const token = (cfg.token && typeof deobfuscateKey === "function") ? deobfuscateKey(cfg.token) : (cfg.token || "");
      // Helper: on ANY failure, copy the full body to the clipboard so the
      // article is never lost (degrade-never-lose). Defined before the
      // permission gate so a denial also lands the clip on the clipboard.
      const apiFail = async (errCode) => {
        try { await navigator.clipboard.writeText(pbpBuildFileBody(id, meta, rawBody)); } catch (_) {}
        return { ok: false, fellBack: false, error: errCode };
      };
      // Resolve the host origin — a fixed string, or a fn of cfg for user-URL
      // targets (webhook) — and ensure permission inside the click gesture.
      const origin = (typeof row.origin === "function") ? row.origin(cfg) : row.origin;
      if (origin) {
        try {
          const has = await chrome.permissions.contains({ origins: [origin] });
          if (!has) {
            const granted = await chrome.permissions.request({ origins: [origin] });
            if (!granted) return apiFail("api-perm");   // copy + accurate "denied" cause
          }
        } catch (_) {}
      }
      // Liveness/token precheck.
      if (row.precheckRequest) {
        try {
          const pr = row.precheckRequest(cfg, token);
          const presp = await fetch(pr.url, { method: pr.method, headers: pr.headers, body: pr.body });
          if (presp.status === 401) return apiFail("api-token");
          if (!presp.ok) return apiFail("api-down");
        } catch (_) { return apiFail("api-down"); }
      }
      // Best-effort pre-request (e.g. create the target container/page).
      // Failures are swallowed — the main request below is the source of truth.
      if (row.preRequest) {
        try {
          const prq = row.preRequest(meta, cfg, token);
          await fetch(prq.url, { method: prq.method, headers: prq.headers, body: prq.body });
        } catch (_) {}
      }
      // Send. buildRequest gets the body with the row's frontmatter policy
      // applied (inline keeps YAML, strip drops it) — same shaping as the
      // clipboard/fallback paths, so each target controls its own body.
      try {
        const req = row.buildRequest(meta, pbpBuildFileBody(id, meta, rawBody), cfg, token);
        const resp = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
        if (resp.status === 401) return apiFail("api-token");
        if (!resp.ok) return apiFail("api-failed");
        const json = await resp.json().catch(() => null);
        // Success: row-defined (webhook = any 2xx, since it returns no id) else
        // the id/uuid heuristic (gist returns id). url = the created resource's
        // web link when the API returns one (gist: html_url).
        const ok = row.parseSuccess ? row.parseSuccess(resp, json) : !!(json && (json.uuid || json.id));
        if (ok) {
          return { ok: true, fellBack: false, error: null, url: (json && (json.html_url || json.url)) || null };
        }
        return apiFail("api-failed");
      } catch (_) { return apiFail("api-down"); }
    }

    if (row.mechanism === "url-scheme") {
      if (row.viaClipboard) {
        // Body rides the clipboard; the URI references it (never too long).
        const fileBody = pbpBuildFileBody(id, meta, rawBody);
        let copied = true;
        try { await navigator.clipboard.writeText(fileBody); } catch (_) { copied = false; }
        // If the clipboard write failed, opening the app would create an EMPTY
        // note while claiming success — report failure instead (no data loss).
        if (!copied) return { ok: false, fellBack: false, error: "" };
        const uri = row.buildUri(meta, rawBody, cfg);
        window.open(uri, "_blank");
        return { ok: true, fellBack: false, error: null };
      }
      // Inline-content scheme: build the URI, fall back if it's too long.
      const uri = row.buildUri(meta, rawBody, cfg);
      if (pbpUriTooLong(uri)) {
        // A+ : article too long for the URL channel (Windows external-protocol wall).
        // Copy the full body to the clipboard and open the app with EMPTY content
        // (a short, valid URI) so the user lands paste-ready and finishes with one Ctrl+V.
        const fileBody = pbpBuildFileBody(id, meta, rawBody);
        try { await navigator.clipboard.writeText(fileBody); } catch (_) {}
        const openUri = row.buildUri(meta, "", cfg); // empty content -> short URI -> opens app
        window.open(openUri, "_blank");
        return { ok: true, fellBack: true, error: null };
      }
      window.open(uri, "_blank");
      return { ok: true, fellBack: false, error: null };
    }
    return { ok: false, fellBack: false, error: "unsupported mechanism" };
  } catch (e) {
    return { ok: false, fellBack: false, error: (e && e.message) || "send failed" };
  }
}
