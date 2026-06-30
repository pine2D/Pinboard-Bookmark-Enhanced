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
    // Token-API path: used when the target supports it AND the user configured a token.
    if (row.buildRequest && cfg.token) {
      const token = (typeof deobfuscateKey === "function") ? deobfuscateKey(cfg.token) : cfg.token;
      // Ensure host permission (this runs inside the user's click gesture).
      try {
        const has = await chrome.permissions.contains({ origins: [row.origin] });
        if (!has) {
          const granted = await chrome.permissions.request({ origins: [row.origin] });
          if (!granted) return { ok: false, fellBack: false, error: "logseq-down" };
        }
      } catch (_) {}
      // Helper: on API failure, copy full body to clipboard so content is never lost.
      const apiFail = async (errCode) => {
        try { await navigator.clipboard.writeText(pbpBuildFileBody(id, meta, rawBody)); } catch (_) {}
        return { ok: false, fellBack: false, error: errCode };
      };
      // Liveness/token precheck.
      if (row.precheckRequest) {
        try {
          const pr = row.precheckRequest(cfg, token);
          const presp = await fetch(pr.url, { method: pr.method, headers: pr.headers, body: pr.body });
          if (presp.status === 401) return apiFail("logseq-token");
          if (!presp.ok) return apiFail("logseq-down");
        } catch (_) { return apiFail("logseq-down"); }
      }
      // Best-effort: create the per-article page and navigate Logseq to it.
      // If this fails, appendBlockInPage below still auto-creates the page (no navigation).
      if (row.preRequest) {
        try {
          const prq = row.preRequest(meta, cfg, token);
          await fetch(prq.url, { method: prq.method, headers: prq.headers, body: prq.body });
        } catch (_) {}
      }
      // Send.
      try {
        const req = row.buildRequest(meta, rawBody, cfg, token);
        const resp = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
        if (resp.status === 401) return apiFail("logseq-token");
        if (!resp.ok) return apiFail("logseq-api");
        const json = await resp.json().catch(() => null);
        if (json && json.uuid) return { ok: true, fellBack: false, error: null };
        return apiFail("logseq-api");
      } catch (_) { return apiFail("logseq-down"); }
    }

    if (row.mechanism === "url-scheme") {
      if (row.viaClipboard) {
        // Body rides the clipboard; the URI references it (never too long).
        const fileBody = pbpBuildFileBody(id, meta, rawBody);
        try { await navigator.clipboard.writeText(fileBody); } catch (_) {}
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
