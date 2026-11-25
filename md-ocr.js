// ============================================================
// Stateless DeepSeek OCR API (`POST https://api.deepseek.com/v1/tools/ocr`)
// ============================================================
// Pure validation/parsing helpers live at the top so `tests/md-ocr-tests.html`
// can exercise the real wire contract without booting the Reader UI.
//
// Invariants (locked in `.claude/decisions.md`):
//   1. Stateless upload only (`multipart/form-data` with strictly two fields:
//      `purpose` and named `file`). Never call DeepSeek's Files API.
//   2. Paid action confirmation required before uploading (1.5 RMB / 1,000 pages;
//      disconnecting after upload does not cancel server-side billing).
//   3. Local storage (`pbp-ocr-docs` in `shared.js`) persists cleaned Markdown
//      and non-secret metadata only, never raw PDF/image bytes.

const PBP_OCR_ENDPOINT = "https://api.deepseek.com/v1/tools/ocr";
const PBP_OCR_ORIGIN_PATTERN = "https://api.deepseek.com/*";
const PBP_OCR_TIMEOUT_MS = 180000;
const PBP_OCR_MAX_FILE_BYTES = 100 * 1024 * 1024;
const PBP_OCR_MAX_PDF_PAGES = 1000;
const PBP_OCR_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp";
const PBP_OCR_EXT_TO_MIME = Object.freeze({
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
});

function pbpOcrNormalizePurpose(purpose) {
  return purpose === "rich_layout_recognition" ? "rich_layout_recognition" : "text_recognition";
}

function _pbpOcrSafeFileName(rawName, fallbackExt) {
  const cleaned = String(rawName == null ? "" : rawName)
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  const base = cleaned || "document";
  const ext = fallbackExt ? String(fallbackExt).replace(/^\./, "").toLowerCase() : "";
  if (!ext) return base.slice(0, 200);
  if (/\.(?:pdf|png|jpe?g|webp)$/i.test(base)) return base.slice(0, 200);
  return (base.slice(0, 190) + "." + ext);
}

function pbpOcrDetectMagicFormat(bytes) {
  const u8 = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
  if (!u8 || u8.byteLength < 4) return null;
  // %PDF- (25 50 44 46 2D)
  if (u8.byteLength >= 5 && u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 && u8[4] === 0x2d) {
    return { ext: "pdf", mime: "application/pdf" };
  }
  // PNG (89 50 4E 47 0D 0A 1A 0A)
  if (u8.byteLength >= 8 &&
      u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47 &&
      u8[4] === 0x0d && u8[5] === 0x0a && u8[6] === 0x1a && u8[7] === 0x0a) {
    return { ext: "png", mime: "image/png" };
  }
  // JPEG (FF D8 FF)
  if (u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) {
    return { ext: "jpg", mime: "image/jpeg" };
  }
  // WebP (RIFF .... WEBP)
  if (u8.byteLength >= 12 &&
      u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 &&
      u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) {
    return { ext: "webp", mime: "image/webp" };
  }
  return null;
}

function pbpOcrDetectMetaFormat(fileName, mimeType) {
  const mime = String(mimeType || "").split(";")[0].trim().toLowerCase();
  if (mime === "application/pdf") return { ext: "pdf", mime: "application/pdf" };
  if (mime === "image/png") return { ext: "png", mime: "image/png" };
  if (mime === "image/jpeg" || mime === "image/jpg") return { ext: "jpg", mime: "image/jpeg" };
  if (mime === "image/webp") return { ext: "webp", mime: "image/webp" };
  const name = String(fileName || "").trim();
  const m = /\.([a-z0-9]+)$/i.exec(name);
  if (m) {
    const ext = m[1].toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PBP_OCR_EXT_TO_MIME, ext)) {
      return { ext: ext === "jpeg" ? "jpg" : ext, mime: PBP_OCR_EXT_TO_MIME[ext] };
    }
  }
  return null;
}

// Lightweight client-side heuristic to catch obvious >1,000-page PDFs before
// uploading 100 MB over the wire. Compressed object streams may report 0 here;
// the server's own 400 validation remains the authoritative backstop.
function pbpOcrEstimatePdfPages(bytes) {
  const u8 = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
  if (!u8 || u8.byteLength < 16) return 0;
  // Scan bytes directly instead of decoding overlapping windows. A name may
  // straddle any 64 KiB boundary, and whitespace between names is unbounded.
  // PDF whitespace and delimiters terminate names; /Pages and /PageExtra do
  // not identify a page. Each slash is visited once, with no chunk duplicates.
  const whitespace = b => b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
  const delimiter = b => b === undefined || whitespace(b) || b === 40 || b === 41 ||
    b === 60 || b === 62 || b === 91 || b === 93 || b === 123 || b === 125 || b === 47 || b === 37;
  let count = 0;
  for (let i = 0; i < u8.length - 9; i++) {
    if (u8[i] !== 47 || u8[i + 1] !== 84 || u8[i + 2] !== 121 || u8[i + 3] !== 112 || u8[i + 4] !== 101) continue;
    let j = i + 5;
    while (whitespace(u8[j])) j++;
    if (u8[j] === 47 && u8[j + 1] === 80 && u8[j + 2] === 97 && u8[j + 3] === 103 &&
        u8[j + 4] === 101 && delimiter(u8[j + 5])) count++;
    i = j - 1;
  }
  return count;
}

function pbpOcrValidateInput({ bytes, byteLength, fileName, mimeType } = {}) {
  const u8 = bytes instanceof Uint8Array
    ? bytes
    : (bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : null);
  const size = u8 ? u8.byteLength : (Number.isFinite(Number(byteLength)) ? Number(byteLength) : 0);
  if (size <= 0) return { ok: false, code: "empty_file" };
  if (size > PBP_OCR_MAX_FILE_BYTES) return { ok: false, code: "file_too_large" };
  let fmt = null;
  if (u8) {
    // When actual file bytes are present, magic bytes are authoritative so an
    // HTML login/404 page served from a `.pdf` URL is rejected before paid upload.
    fmt = pbpOcrDetectMagicFormat(u8);
    if (!fmt) return { ok: false, code: "unsupported_type" };
  } else {
    fmt = pbpOcrDetectMetaFormat(fileName, mimeType);
    if (!fmt) return { ok: false, code: "unsupported_type" };
  }
  let estimatedPages = 0;
  if (fmt.ext === "pdf" && u8) {
    estimatedPages = pbpOcrEstimatePdfPages(u8);
    if (estimatedPages > PBP_OCR_MAX_PDF_PAGES) {
      return { ok: false, code: "too_many_pages", estimatedPages };
    }
  }
  return {
    ok: true,
    ext: fmt.ext,
    mime: fmt.mime,
    byteLength: size,
    estimatedPages,
    fileName: _pbpOcrSafeFileName(fileName, fmt.ext),
  };
}

async function pbpOcrSha256Hex(bytes) {
  const buf = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    : bytes;
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const view = new Uint8Array(digest);
  let hex = "";
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// Strict 2-field multipart builder: DeepSeek `/v1/tools/ocr` rejects any extra
// form field with HTTP 400. Callers must NEVER set a manual Content-Type header.
function pbpOcrBuildFormData(blob, fileName, purpose) {
  const fd = new FormData();
  fd.append("purpose", pbpOcrNormalizePurpose(purpose));
  fd.append("file", blob, _pbpOcrSafeFileName(fileName, ""));
  return fd;
}

const PBP_OCR_LAYOUT_LABELS = new Set([
  "title", "sub_title", "subtitle", "text", "paragraph", "table", "table_caption",
  "table_footnote", "image", "image_caption", "figure", "figure_caption", "formula",
  "equation", "list", "list_item", "header", "footer", "page_number", "code",
  "footnote", "reference", "abstract", "author", "seal", "handwriting", "caption",
]);
const PBP_OCR_EMPTY_LAYOUT_LABELS = new Set(["image", "figure", "seal"]);

// Strip DeepSeek OCR grounding spans (`<｜ref｜>label<｜/ref｜><｜box｜>[[...]]<｜/box｜>`
// or `<|ref|>label<|/ref|><|det|>[[...]]<|/det|>`, using either fullwidth U+FF5C `｜`
// or ASCII `|`). Layout class headers before recognized lines are dropped; inline
// grounded text inside `<ref>...</ref>` is preserved without its bounding box.
function pbpOcrStripGroundingTags(rawText) {
  if (typeof rawText !== "string" || !rawText) return "";
  let text = rawText.replace(/\r\n?/g, "\n");
  if (!/<[|｜](?:ref|box|det|grounding|end▁of▁sentence)[|｜]>/.test(text)) {
    return text.replace(/\n{3,}/g, "\n\n").trim();
  }
  const spanRe = /<[|｜]ref[|｜]>([\s\S]*?)<[|｜]\/ref[|｜]>\s*<[|｜](?:box|det)[|｜]>\s*\[\[[\s\S]*?\]\]\s*<[|｜]\/(?:box|det)[|｜]>([ \t]*\n?)/g;
  // Probe whether removing layout-class spans leaves non-empty body content.
  const strippedIfClass = text
    .replace(spanRe, (_m, inner, tail) => {
      const trimmed = String(inner || "").trim();
      const lower = trimmed.toLowerCase();
      if (PBP_OCR_EMPTY_LAYOUT_LABELS.has(lower) || PBP_OCR_LAYOUT_LABELS.has(lower)) return "";
      return trimmed ? trimmed + (tail || "") : "";
    })
    .replace(/<[|｜](?:box|det)[|｜]>\s*\[\[[\s\S]*?\]\]\s*<[|｜]\/(?:box|det)[|｜]>/g, "")
    .replace(/<[|｜]\/?(?:ref|box|grounding|det|end▁of▁sentence)[|｜]>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (strippedIfClass) return strippedIfClass;
  // Fallback when the entire page consisted of a single grounded token whose text
  // happened to match a non-image word (e.g. a slide containing only "Abstract").
  return text
    .replace(spanRe, (_m, inner, tail) => {
      const trimmed = String(inner || "").trim();
      if (!trimmed || PBP_OCR_EMPTY_LAYOUT_LABELS.has(trimmed.toLowerCase())) return "";
      return trimmed + (tail || "");
    })
    .replace(/<[|｜](?:box|det)[|｜]>\s*\[\[[\s\S]*?\]\]\s*<[|｜]\/(?:box|det)[|｜]>/g, "")
    .replace(/<[|｜]\/?(?:ref|box|grounding|det|end▁of▁sentence)[|｜]>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pbpOcrTruncationLine(pageNum) {
  const label = String(pageNum);
  if (typeof t === "function") {
    const localized = t("mdOcrTruncatedPage", label);
    if (localized && localized !== "mdOcrTruncatedPage") return localized;
  }
  return `[Note: Page ${label} exceeded the single-page OCR output limit and was truncated.]`;
}

// Parse `/v1/tools/ocr` HTTP status + body text (which may begin with `\n`
// keep-alive heartbeats and may carry `{"error": ...}` even on HTTP 200).
function pbpOcrParseResponse(status, rawBodyText, opts = {}) {
  const text = typeof rawBodyText === "string" ? rawBodyText.trim() : "";
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_) {
      // swallow-ok: non-JSON gateway/keepalive failure handled by status checks below
      parsed = null;
    }
  }
  const errObj = parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object"
    ? parsed.error
    : null;
  const errMsg = errObj && typeof errObj.message === "string"
    ? errObj.message.replace(/\s+/g, " ").trim().slice(0, 240)
    : (parsed && typeof parsed.message === "string" ? parsed.message.replace(/\s+/g, " ").trim().slice(0, 240) : "");
  const errCode = errObj && typeof errObj.code === "string" ? errObj.code.toLowerCase() : "";

  if (status === 401 || status === 403 || errCode === "authentication_error" || errCode === "invalid_api_key") {
    return { ok: false, code: "deepseek_auth", detail: errMsg };
  }
  if (status === 413 || errCode === "file_too_large" || /100\s*mb|too\s+large/i.test(errMsg)) {
    return { ok: false, code: "file_too_large", detail: errMsg };
  }
  if (status === 429 || errCode === "rate_limit_exceeded") {
    return { ok: false, code: "rate_limited", detail: errMsg };
  }
  if ((status === 400 || errObj) && /1[_,]?000\s*page|page\s*limit|too\s+many\s+pages/i.test(errMsg)) {
    return { ok: false, code: "too_many_pages", detail: errMsg };
  }
  if (status === 400) {
    return { ok: false, code: "bad_request", detail: errMsg };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, code: "server_error", status, detail: errMsg };
  }
  if (errObj) {
    return { ok: false, code: status === 200 && errCode ? "bad_request" : "server_error", detail: errMsg };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.pages)) {
    return { ok: false, code: "bad_response", detail: errMsg };
  }

  const ordered = parsed.pages
    .map((p, idx) => ({
      index: p && Number.isInteger(p.index) && p.index >= 0 ? p.index : idx,
      text: p && typeof p.text === "string" ? p.text : "",
      finishReason: p && typeof p.finish_reason === "string" ? p.finish_reason : "",
    }))
    .sort((a, b) => a.index - b.index);

  const truncatedPages = [];
  const blocks = [];
  for (const page of ordered) {
    let cleaned = pbpOcrStripGroundingTags(page.text);
    const pageNum = page.index + 1;
    if (page.finishReason === "length") {
      truncatedPages.push(pageNum);
      const note = "> " + pbpOcrTruncationLine(pageNum);
      cleaned = cleaned ? cleaned + "\n\n" + note : note;
    }
    if (cleaned) blocks.push(cleaned);
  }

  const markdown = blocks.join("\n\n---\n\n").trim();
  if (!markdown) return { ok: false, code: "empty" };

  const rawPageCount = Number(parsed.page_count);
  const pageCount = Number.isFinite(rawPageCount) && rawPageCount > 0 ? Math.floor(rawPageCount) : ordered.length;
  return {
    ok: true,
    id: typeof parsed.id === "string" ? parsed.id : "",
    purpose: pbpOcrNormalizePurpose(parsed.purpose || opts.purpose),
    pageCount,
    truncatedPages,
    markdown,
  };
}

function pbpOcrErrorMessage(res) {
  const code = res && res.code;
  if (code === "deepseek_key_missing") return t("deepseekFetchKeyMissing");
  if (code === "deepseek_auth") return t("deepseekFetchAuthFailed");
  if (code === "host_permission") return t("aiErrorHostPermission", (res && res.origin) || "https://api.deepseek.com");
  if (code === "unsupported_type") return t("mdOcrErrUnsupported");
  if (code === "empty_file") return t("mdOcrErrEmptyFile");
  if (code === "file_too_large") return t("mdOcrErrTooLarge");
  if (code === "too_many_pages") return t("mdOcrErrTooManyPages");
  if (code === "empty") return t("mdPreviewNoContent");
  if (code === "rate_limited") return t("pinboardErrorRateLimit");
  if (code === "timeout") return t("pinboardErrorTimeout");
  if (code === "network") return t("pinboardErrorOffline");
  if (code === "bad_request" && res && res.detail) return t("mdOcrErrBadRequest", res.detail);
  return t("mdOcrErrFailed");
}

function _pbpOcrFileNameFromResponse(url, contentDisposition) {
  if (typeof contentDisposition === "string" && contentDisposition) {
    const utf8Match = /filename\*\s*=\s*UTF-8''([^;\r\n]+)/i.exec(contentDisposition);
    if (utf8Match) {
      try { return decodeURIComponent(utf8Match[1].trim()); } catch (_) { /* swallow-ok: malformed RFC5987 encoding falls back */ }
    }
    const plainMatch = /filename\s*=\s*"?([^";\r\n]+)"?/i.exec(contentDisposition);
    if (plainMatch && plainMatch[1].trim()) return plainMatch[1].trim();
  }
  try {
    const u = new URL(url);
    const seg = (u.pathname || "").split("/").filter(Boolean).pop() || "";
    if (seg) return decodeURIComponent(seg);
  } catch (_) { /* swallow-ok: fallback to generic document name */ }
  return "document";
}

async function pbpOcrFetchRemoteBytes(targetUrl, signal, maxBytes = PBP_OCR_MAX_FILE_BYTES, timeoutMs = PBP_OCR_TIMEOUT_MS) {
  const pattern = typeof pbpEndpointOriginPattern === "function" ? pbpEndpointOriginPattern(targetUrl) : "";
  if (!pattern || (typeof pbpIsLocalDocUrl === "function" && pbpIsLocalDocUrl(targetUrl))) {
    return { ok: false, code: "unsupported_type" };
  }
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort("timeout");
  }, Math.max(1000, Number(timeoutMs) || PBP_OCR_TIMEOUT_MS));
  const onCallerAbort = () => ac.abort(signal && signal.reason ? signal.reason : "caller");
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { ok: false, code: signal.reason === "timeout" ? "timeout" : "aborted" };
    }
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
  };
  let resp;
  try {
    resp = await fetch(targetUrl, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal: ac.signal,
    });
  } catch (e) {
    cleanup();
    if (timedOut || (signal && signal.reason === "timeout")) return { ok: false, code: "timeout" };
    if (e && e.name === "AbortError") return { ok: false, code: "aborted" };
    return { ok: false, code: "network" };
  }
  if (!resp.ok) {
    cleanup();
    if (resp.status === 413) return { ok: false, code: "file_too_large" };
    if (resp.status === 429) return { ok: false, code: "rate_limited" };
    return { ok: false, code: "server_error", status: resp.status };
  }
  const declaredLen = Number(resp.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
    try { await resp.body?.cancel?.(); } catch (_) { /* swallow-ok: stream cancel best-effort */ }
    cleanup();
    return { ok: false, code: "file_too_large" };
  }

  let bytes = null;
  if (resp.body && typeof resp.body.getReader === "function") {
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const u8 = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += u8.byteLength;
        if (total > maxBytes) {
          try { await reader.cancel(); } catch (_) { /* swallow-ok: cancel best-effort */ }
          cleanup();
          return { ok: false, code: "file_too_large" };
        }
        chunks.push(u8);
      }
    } catch (e) {
      cleanup();
      if (timedOut || (signal && signal.reason === "timeout")) return { ok: false, code: "timeout" };
      if (e && e.name === "AbortError") return { ok: false, code: "aborted" };
      return { ok: false, code: "network" };
    }
    cleanup();
    bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      bytes.set(c, offset);
      offset += c.byteLength;
    }
  } else {
    try {
      const ab = await resp.arrayBuffer();
      cleanup();
      if (ab.byteLength > maxBytes) return { ok: false, code: "file_too_large" };
      bytes = new Uint8Array(ab);
    } catch (e) {
      cleanup();
      if (timedOut || (signal && signal.reason === "timeout")) return { ok: false, code: "timeout" };
      if (e && e.name === "AbortError") return { ok: false, code: "aborted" };
      return { ok: false, code: "network" };
    }
  }

  const fileName = _pbpOcrFileNameFromResponse(targetUrl, resp.headers?.get?.("content-disposition") || "");
  const mimeType = resp.headers?.get?.("content-type") || "";
  return { ok: true, bytes, fileName, mimeType };
}

async function _pbpOcrReadDeepseekKey() {
  if (typeof pbpReadSettingsWithSecrets !== "function") return "";
  try {
    const raw = await pbpReadSettingsWithSecrets({ deepseekApiKey: "" });
    const s = typeof deobfuscateSettings === "function" ? deobfuscateSettings(raw) : raw;
    return typeof s.deepseekApiKey === "string" ? s.deepseekApiKey.trim() : "";
  } catch (e) {
    console.warn("[ocr] settings read failed:", e?.name, e?.message);
    return "";
  }
}

async function pbpOcrRunUpload({ bytes, fileName, mimeType, purpose, sourceUrl = "", force = false, signal, timeoutMs = PBP_OCR_TIMEOUT_MS } = {}) {
  if (signal && signal.aborted) return { ok: false, code: "aborted" };
  const normalizedPurpose = pbpOcrNormalizePurpose(purpose);
  const check = pbpOcrValidateInput({ bytes, fileName, mimeType });
  if (!check.ok) return check;

  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sha256 = await pbpOcrSha256Hex(u8);
  if (signal && signal.aborted) return { ok: false, code: "aborted" };
  const isOnlineSource = Boolean(sourceUrl && typeof pbpIsLocalDocUrl === "function" && !pbpIsLocalDocUrl(sourceUrl));
  const docUrl = isOnlineSource ? sourceUrl : pbpLocalDocUrlFromSha256(sha256);
  if (!docUrl) return { ok: false, code: "bad_request" };

  if (!force && typeof pbpOcrDocsFindBySha256 === "function") {
    const hit = await pbpOcrDocsFindBySha256(sha256, normalizedPurpose);
    if (signal && signal.aborted) return { ok: false, code: "aborted" };
    if (hit && hit.markdown) {
      const reused = {
        url: docUrl,
        sha256,
        sourceUrl: isOnlineSource ? sourceUrl : "",
        fileName: check.fileName,
        mimeType: check.mime,
        purpose: normalizedPurpose,
        pageCount: hit.pageCount,
        truncatedPages: hit.truncatedPages,
        markdown: hit.markdown,
      };
      const saved = typeof pbpOcrDocsPut === "function" ? await pbpOcrDocsPut(reused) : null;
      if (signal && signal.aborted) return { ok: false, code: "aborted" };
      const cacheSaved = Boolean(saved);
      return { ok: true, cached: true, cacheSaved, doc: { ...(saved || { ...hit, ...reused }), cacheSaved } };
    }
  }

  const apiKey = await _pbpOcrReadDeepseekKey();
  if (signal && signal.aborted) return { ok: false, code: "aborted" };
  if (!apiKey) return { ok: false, code: "deepseek_key_missing" };

  if (typeof chrome !== "undefined" && chrome.permissions?.contains) {
    let granted = false;
    try { granted = await chrome.permissions.contains({ origins: [PBP_OCR_ORIGIN_PATTERN] }); }
    catch (e) { console.warn("[ocr] permission check failed:", e?.name, e?.message); granted = false; }
    if (signal && signal.aborted) return { ok: false, code: "aborted" };
    if (!granted) return { ok: false, code: "host_permission", origin: "https://api.deepseek.com" };
  }

  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort("timeout");
  }, Math.max(1000, Number(timeoutMs) || PBP_OCR_TIMEOUT_MS));
  const onCallerAbort = () => ac.abort("caller");
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return { ok: false, code: "aborted" };
    }
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  let resp;
  try {
    const blob = new Blob([u8], { type: check.mime });
    const formData = pbpOcrBuildFormData(blob, check.fileName, normalizedPurpose);
    resp = await fetch(PBP_OCR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey },
      body: formData,
      credentials: "omit",
      redirect: "error",
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
    if (timedOut) return { ok: false, code: "timeout" };
    if (e && e.name === "AbortError") return { ok: false, code: "aborted" };
    return { ok: false, code: "network" };
  }

  let rawText = "";
  try {
    rawText = await resp.text();
  } catch (e) {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
    if (timedOut) return { ok: false, code: "timeout" };
    if (e && e.name === "AbortError") return { ok: false, code: "aborted" };
    return { ok: false, code: "network" };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onCallerAbort);
  }

  if (signal && signal.aborted) return { ok: false, code: "aborted" };
  const parsed = pbpOcrParseResponse(resp.status, rawText, { purpose: normalizedPurpose });
  if (!parsed.ok) return parsed;

  const recordInput = {
    url: docUrl,
    sha256,
    sourceUrl: isOnlineSource ? sourceUrl : "",
    fileName: check.fileName,
    mimeType: check.mime,
    purpose: parsed.purpose,
    pageCount: parsed.pageCount,
    truncatedPages: parsed.truncatedPages,
    markdown: parsed.markdown,
  };
  const stored = typeof pbpOcrDocsPut === "function" ? await pbpOcrDocsPut(recordInput) : null;
  if (signal && signal.aborted) return { ok: false, code: "aborted" };
  const cacheSaved = Boolean(stored);
  const fallbackDoc = { ...recordInput, byteSize: parsed.markdown.length, createdAt: Date.now(), accessedAt: Date.now() };
  return {
    ok: true,
    cached: false,
    cacheSaved,
    doc: { ...(stored || fallbackDoc), cacheSaved },
  };
}

// ============================================================
// Reader UI Integration (`md-preview.html`)
// ============================================================
let _pbpOcrHiddenInput = null;
let _pbpOcrDropPop = null;
let _pbpOcrPanelActiveAbort = null;
let _pbpOcrDropActiveAbort = null;
let _pbpOcrKeyReady = false;
let _pbpOcrKeyLoaded = false;
let _pbpOcrConfigGen = 0;
let _pbpOcrLatestRefreshPromise = Promise.resolve(false);
let _pbpOcrMountedPanelOpts = null;

function pbpOcrIsAvailable() {
  return _pbpOcrKeyReady;
}

function _pbpOcrSyncAvailabilityDom() {
  if (typeof document === "undefined") return;
  const railImportBtn = document.getElementById("rail-ocr-btn");
  if (railImportBtn) {
    railImportBtn.hidden = !_pbpOcrKeyReady;
    const ident = typeof railImportBtn.closest === "function" ? railImportBtn.closest(".rail-ident") : null;
    if (ident) {
      if (_pbpOcrKeyReady) ident.dataset.hasOcr = "1";
      else delete ident.dataset.hasOcr;
    }
  }
  const srcImportBtn = document.getElementById("btn-import-ocr");
  if (srcImportBtn) srcImportBtn.hidden = !_pbpOcrKeyReady;
  if (!_pbpOcrKeyReady && _pbpOcrDropPop && !_pbpOcrDropActiveAbort) {
    try {
      if (_pbpOcrDropPop.matches(":popover-open")) _pbpOcrDropPop.hidePopover();
    } catch (_) { /* swallow-ok: popover state check */ }
  }
  if (_pbpOcrMountedPanelOpts && !_pbpOcrPanelActiveAbort) {
    const mounted = document.querySelector("#rendered-view > .empty-state.es-ocr");
    if (mounted) {
      const showingMissingKey = mounted.dataset.ocrMissingKey === "1";
      if (showingMissingKey !== !_pbpOcrKeyReady) {
        pbpOcrRenderPanel(_pbpOcrMountedPanelOpts);
      }
    } else {
      _pbpOcrMountedPanelOpts = null;
    }
  }
}

function pbpOcrSetKeyAvailable(ready) {
  ++_pbpOcrConfigGen;
  _pbpOcrKeyLoaded = true;
  _pbpOcrKeyReady = Boolean(ready);
  _pbpOcrSyncAvailabilityDom();
}

function pbpOcrRefreshConfig() {
  const gen = ++_pbpOcrConfigGen;
  const run = (async () => {
    let ready = false;
    try {
      let settings = null;
      if (typeof pbpReadSettingsWithSecrets === "function") {
        settings = await pbpReadSettingsWithSecrets({ deepseekApiKey: "" });
      } else if (typeof chrome !== "undefined" && chrome.storage?.local?.get) {
        settings = await chrome.storage.local.get({ deepseekApiKey: "" });
      }
      if (settings) {
        ready = typeof pbpHasDeepseekKey === "function"
          ? pbpHasDeepseekKey(settings)
          : Boolean(String(
            typeof deobfuscateKey === "function" && settings.deepseekApiKey
              ? deobfuscateKey(settings.deepseekApiKey)
              : (settings.deepseekApiKey || "")
          ).trim());
      }
    } catch (_) {
      // swallow-ok: transient storage read failure defaults OCR key availability to false
      ready = false;
    }
    if (gen === _pbpOcrConfigGen) {
      _pbpOcrKeyLoaded = true;
      _pbpOcrKeyReady = Boolean(ready);
      _pbpOcrSyncAvailabilityDom();
      return _pbpOcrKeyReady;
    }
    return _pbpOcrLatestRefreshPromise;
  })();
  _pbpOcrLatestRefreshPromise = run;
  return run;
}

function pbpOcrAbortActive(reason = "aborted") {
  if (_pbpOcrPanelActiveAbort) {
    _pbpOcrPanelActiveAbort.abort(reason);
    _pbpOcrPanelActiveAbort = null;
  }
  if (_pbpOcrDropActiveAbort) {
    _pbpOcrDropActiveAbort.abort(reason);
    _pbpOcrDropActiveAbort = null;
  }
}

function _pbpOcrSyncIncognitoHint() {
  if (typeof window !== "undefined" && window._pbpReaderSourceIncognito === true) return true;
  try {
    if (typeof location !== "undefined" && new URLSearchParams(location.search).get("incognito") === "1") return true;
  } catch (_) { /* swallow-ok: location search unavailable */ }
  if (typeof chrome !== "undefined" && chrome.extension?.inIncognitoContext === true) return true;
  return false;
}

async function _pbpOcrDetectIncognito(explicitFlag) {
  if (explicitFlag === true || _pbpOcrSyncIncognitoHint()) return true;
  if (typeof chrome !== "undefined" && chrome.tabs?.getCurrent) {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab && tab.incognito === true) return true;
    } catch (_) { /* swallow-ok: tabs.getCurrent unsupported in some contexts */ }
  }
  if (typeof chrome !== "undefined" && chrome.windows?.getCurrent) {
    try {
      const win = await chrome.windows.getCurrent();
      if (win && win.incognito === true) return true;
    } catch (_) { /* swallow-ok: windows.getCurrent unsupported */ }
  }
  return false;
}

function _pbpOcrTitleFromFileName(fileName) {
  const base = String(fileName || "").replace(/\.(?:pdf|png|jpe?g|webp)$/i, "").trim();
  return base || String(fileName || "").trim();
}

function _pbpOcrEnsureFileInput(onPicked) {
  if (!_pbpOcrHiddenInput) {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.id = "ocr-file-input";
    inp.accept = PBP_OCR_FILE_ACCEPT;
    inp.hidden = true;
    document.body.appendChild(inp);
    _pbpOcrHiddenInput = inp;
  }
  _pbpOcrHiddenInput.value = "";
  _pbpOcrHiddenInput.onchange = () => {
    const file = _pbpOcrHiddenInput.files && _pbpOcrHiddenInput.files[0];
    if (file && typeof onPicked === "function") onPicked(file);
  };
  _pbpOcrHiddenInput.click();
}

async function _pbpOcrRequestOriginsOnGesture(origins) {
  if (typeof chrome === "undefined" || !chrome.permissions?.request) return { ok: true };
  const unique = [...new Set((origins || []).filter(Boolean))];
  if (!unique.length) return { ok: true };
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: unique });
  } catch (e) {
    console.warn("[ocr] permission request failed:", e?.name, e?.message);
    granted = false;
  }
  if (!granted) {
    const first = unique[0].replace(/\/\*$/, "");
    return { ok: false, code: "host_permission", origin: first };
  }
  return { ok: true };
}

async function _pbpOcrOpenDocInReader(doc, handoff = {}, openInNewTab = false) {
  if (!doc || !doc.markdown || typeof chrome === "undefined" || !chrome.storage?.local) return false;
  const isLocal = typeof pbpIsLocalDocUrl === "function" && pbpIsLocalDocUrl(doc.url);
  const currentKey = (() => {
    try { return new URLSearchParams(location.search).get("k") || ""; }
    catch (_) { /* swallow-ok: fallback to fresh UUID */ return ""; }
  })();
  const sameDocAsSlot = Boolean(!openInNewTab && currentKey && typeof handoff.expectedUrl === "string" && handoff.expectedUrl === doc.url);
  const k = sameDocAsSlot
    ? currentKey
    : ((typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
      ? crypto.randomUUID()
      : String(Date.now()) + "-" + String(Math.random()).slice(2));
  const slotKey = "md_preview_data_" + k;
  let account = typeof handoff.account === "string" ? handoff.account : "";
  if (!account && typeof pbpReadBookmarkConnection === "function") {
    try { account = (await pbpReadBookmarkConnection()).account || ""; }
    catch (_) { /* swallow-ok: proceed with empty bookmark account */ }
  }
  const sourceIncognito = await _pbpOcrDetectIncognito(handoff.sourceIncognito === true);
  const resolvedTitle = (typeof handoff.title === "string" && handoff.title.trim())
    ? handoff.title.trim()
    : (_pbpOcrTitleFromFileName(doc.fileName) || t("mdPreviewUntitled"));
  const ocrSlotNonce = (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function")
    ? crypto.randomUUID()
    : String(Date.now()) + "-" + String(Math.random()).slice(2);
  const writeSlot = () => chrome.storage.local.set({
    [slotKey]: {
      markdown: doc.markdown,
      title: resolvedTitle,
      url: doc.url,
      baseUrl: isLocal ? "" : doc.url,
      sourceTabUrl: isLocal ? doc.url : (handoff.sourceTabUrl || doc.url),
      bookmarkUrl: isLocal ? "" : (handoff.bookmarkUrl || doc.url),
      ocrFileName: doc.fileName || "",
      ocrCacheSaved: doc.cacheSaved !== false,
      source: "deepseek-ocr",
      engine: "local",
      site: isLocal ? (doc.fileName || "") : (handoff.site || ""),
      sourceIncognito,
      bookmarkDraft: isLocal ? null : (handoff.bookmarkDraft || null),
      account,
      tags: isLocal ? [] : (Array.isArray(handoff.tags) ? handoff.tags : []),
      description: isLocal ? "" : (typeof handoff.description === "string" ? handoff.description : ""),
      nonce: ocrSlotNonce,
      ts: Date.now(),
    },
  });
  if (typeof pbpWithPreviewSlotLock === "function") await pbpWithPreviewSlotLock(slotKey, writeSlot);
  else await writeSlot();
  const askQ = (() => {
    if (!sameDocAsSlot) return "";
    try {
      const s = new URLSearchParams(location.search).get("askSession");
      return s ? "&askSession=" + encodeURIComponent(s) : "";
    } catch (_) { /* swallow-ok: no askSession query */ return ""; }
  })();
  const incogQ = sourceIncognito ? "&incognito=1" : "";
  if (openInNewTab && chrome.tabs?.create) {
    const videoQ = (typeof pbpVideoDetect === "function" && pbpVideoDetect(doc.url)) ? "&video=1" : "";
    await chrome.tabs.create({ url: chrome.runtime.getURL("md-preview.html") + "?k=" + encodeURIComponent(k) + incogQ + videoQ });
    return true;
  }
  if (currentKey === k) {
    location.reload();
  } else {
    location.replace("?k=" + encodeURIComponent(k) + incogQ + askQ);
  }
  return true;
}

function _pbpOcrBuildRichLayoutToggle(idPrefix) {
  const field = document.createElement("label");
  field.className = "row ocr-purpose-opt";
  const mark = document.createElement("span");
  mark.className = "reader-check";
  mark.innerHTML = (typeof PBP_ICONS !== "undefined" && PBP_ICONS.check) || "";
  const input = document.createElement("input");
  input.type = "checkbox";
  input.id = idPrefix + "-rich-layout";
  mark.prepend(input);
  const caption = document.createElement("span");
  caption.textContent = t("mdOcrRichLayout");
  field.append(mark, caption);
  return { field, input };
}

function pbpOcrRenderPanel(opts = {}) {
  const view = document.getElementById("rendered-view");
  if (!view) return;
  if (_pbpOcrPanelActiveAbort) {
    _pbpOcrPanelActiveAbort.abort("replaced");
    _pbpOcrPanelActiveAbort = null;
  }
  _pbpOcrMountedPanelOpts = { ...opts };
  if (!_pbpOcrKeyLoaded && typeof chrome !== "undefined" && chrome.storage) {
    void pbpOcrRefreshConfig();
  }
  view.removeAttribute("aria-busy");
  const mode = opts.mode === "online" ? "online" : "local";
  const onlineUrl = mode === "online" && typeof opts.url === "string" ? opts.url : "";
  let stagedFile = opts.initialFile || null;
  let activeAbort = null;

  if (mode === "local") {
    document.body.classList.add("md-empty");
  } else {
    document.body.classList.remove("md-empty");
  }

  const wrap = document.createElement("div");
  wrap.className = "empty-state es-ocr";
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", t(mode === "online" ? "mdOcrPanelTitleOnline" : "mdOcrPanelTitleLocal"));

  const head = document.createElement("div");
  head.className = "panel-head";
  const h2 = document.createElement("h2");
  h2.className = "rh-title";
  h2.textContent = t(mode === "online" ? "mdOcrPanelTitleOnline" : "mdOcrPanelTitleLocal");
  head.appendChild(h2);
  wrap.appendChild(head);

  if (opts.leadText) {
    const lead = document.createElement("p");
    lead.className = "rh-empty-lead";
    lead.textContent = opts.leadText;
    wrap.appendChild(lead);
  }

  if (_pbpOcrKeyLoaded && !_pbpOcrKeyReady) {
    wrap.dataset.ocrMissingKey = "1";
    const card = document.createElement("div");
    card.className = "rh-match";
    const missingEl = document.createElement("div");
    missingEl.className = "rh-meta";
    missingEl.textContent = t("mdOcrKeyMissingLead");
    const setupActions = document.createElement("div");
    setupActions.className = "row";
    const setupBtn = document.createElement("button");
    setupBtn.type = "button";
    setupBtn.className = "action-btn es-primary";
    setupBtn.textContent = t("deepseekFetchSetupBtn");
    setupBtn.addEventListener("click", () => {
      if (typeof chrome !== "undefined" && chrome.tabs?.create && chrome.runtime?.getURL) {
        void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#deepseek-key") });
      }
    });
    setupActions.appendChild(setupBtn);
    if (mode === "online" && typeof pbpOriginalOpenHref === "function") {
      const safeHref = pbpOriginalOpenHref(onlineUrl);
      if (safeHref) {
        const openOrig = document.createElement("a");
        openOrig.className = "action-btn es-quiet";
        openOrig.href = safeHref;
        openOrig.target = "_blank";
        openOrig.rel = "noopener noreferrer";
        openOrig.innerHTML = (typeof PBP_ICONS !== "undefined" && PBP_ICONS.extOpen) || "";
        const lab = document.createElement("span");
        lab.textContent = t("libraryOpenOriginal");
        openOrig.appendChild(lab);
        setupActions.appendChild(openOrig);
      }
    }
    card.append(missingEl, setupActions);
    wrap.appendChild(card);

    const foot = document.createElement("div");
    foot.className = "row";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "action-btn es-quiet";
    closeBtn.textContent = t("mdPreviewClose");
    closeBtn.addEventListener("click", () => window.close());
    foot.appendChild(closeBtn);
    wrap.appendChild(foot);
    view.replaceChildren(wrap);
    return;
  }

  const errBar = document.createElement("div");
  errBar.className = "msg-bar error";
  errBar.setAttribute("role", "alert");
  errBar.hidden = true;
  wrap.appendChild(errBar);

  const card = document.createElement("div");
  card.className = "rh-match";
  const subjectEl = document.createElement("div");
  subjectEl.className = "rh-item-title";
  subjectEl.dir = "auto";
  const metaEl = document.createElement("div");
  metaEl.className = "rh-meta";
  const paidEl = document.createElement("div");
  paidEl.className = "rh-meta";
  paidEl.textContent = t("mdOcrPaidNotice");

  const { field: richField, input: richInput } = _pbpOcrBuildRichLayoutToggle("ocr-main");

  const actions = document.createElement("div");
  actions.className = "row";
  const primaryBtn = document.createElement("button");
  primaryBtn.type = "button";
  primaryBtn.className = "action-btn es-primary";
  const secondaryBtn = document.createElement("button");
  secondaryBtn.type = "button";
  secondaryBtn.className = "action-btn es-quiet";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "action-btn es-quiet";
  cancelBtn.textContent = t("cancel");
  cancelBtn.hidden = true;
  actions.append(primaryBtn, secondaryBtn, cancelBtn);

  if (mode === "online" && typeof pbpOriginalOpenHref === "function") {
    const safeHref = pbpOriginalOpenHref(onlineUrl);
    if (safeHref) {
      const openOrig = document.createElement("a");
      openOrig.className = "action-btn es-quiet";
      openOrig.href = safeHref;
      openOrig.target = "_blank";
      openOrig.rel = "noopener noreferrer";
      openOrig.innerHTML = (typeof PBP_ICONS !== "undefined" && PBP_ICONS.extOpen) || "";
      const lab = document.createElement("span");
      lab.textContent = t("libraryOpenOriginal");
      openOrig.appendChild(lab);
      actions.appendChild(openOrig);
    }
  }

  card.append(subjectEl, metaEl, richField, paidEl, actions);
  wrap.appendChild(card);

  const foot = document.createElement("div");
  foot.className = "row";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "action-btn es-quiet";
  closeBtn.textContent = t("mdPreviewClose");
  closeBtn.addEventListener("click", () => window.close());
  foot.appendChild(closeBtn);
  wrap.appendChild(foot);

  function showErr(res) {
    errBar.textContent = typeof res === "string" ? res : pbpOcrErrorMessage(res);
    errBar.hidden = false;
  }

  function syncCard() {
    const running = Boolean(activeAbort);
    richInput.disabled = running;
    cancelBtn.hidden = !running;
    if (mode === "online") {
      const fname = _pbpOcrFileNameFromResponse(onlineUrl, "");
      subjectEl.textContent = opts.title || fname || onlineUrl;
      metaEl.textContent = onlineUrl;
      primaryBtn.textContent = running ? t("mdOcrRunning") : t("mdOcrRunBtn");
      primaryBtn.setAttribute("aria-disabled", running ? "true" : "false");
      secondaryBtn.textContent = t("mdOcrChooseFile");
      secondaryBtn.hidden = running;
    } else if (stagedFile) {
      subjectEl.textContent = stagedFile.name || "document";
      const fmtSize = typeof pbpFormatBytes === "function" ? pbpFormatBytes(stagedFile.size || 0) : `${stagedFile.size || 0} B`;
      metaEl.textContent = fmtSize;
      primaryBtn.textContent = running ? t("mdOcrRunning") : t("mdOcrRunBtn");
      primaryBtn.setAttribute("aria-disabled", running ? "true" : "false");
      secondaryBtn.textContent = t("mdOcrChooseAnother");
      secondaryBtn.hidden = running;
    } else {
      subjectEl.textContent = t("mdOcrDropHint");
      metaEl.textContent = t("mdOcrImportMeta");
      primaryBtn.textContent = t("mdOcrChooseFile");
      primaryBtn.setAttribute("aria-disabled", "false");
      secondaryBtn.hidden = true;
    }
  }

  function stageLocalFile(file) {
    if (!file) return;
    errBar.hidden = true;
    const pre = pbpOcrValidateInput({
      byteLength: file.size,
      fileName: file.name,
      mimeType: file.type,
    });
    if (!pre.ok) {
      stagedFile = null;
      syncCard();
      showErr(pre);
      return;
    }
    stagedFile = file;
    syncCard();
  }

  cancelBtn.addEventListener("click", () => {
    if (activeAbort) {
      activeAbort.abort("user");
      if (_pbpOcrPanelActiveAbort === activeAbort) _pbpOcrPanelActiveAbort = null;
      activeAbort = null;
      syncCard();
      _pbpOcrSyncAvailabilityDom();
    }
  });

  secondaryBtn.addEventListener("click", () => {
    if (activeAbort) return;
    _pbpOcrEnsureFileInput((file) => {
      if (mode === "online") {
        pbpOcrRenderPanel({ ...opts, mode: "local", initialFile: file, leadText: "", expectedUrl: onlineUrl });
      } else {
        stageLocalFile(file);
      }
    });
  });

  primaryBtn.addEventListener("click", async () => {
    if (activeAbort || primaryBtn.getAttribute("aria-disabled") === "true") return;
    if (mode === "local" && !stagedFile) {
      _pbpOcrEnsureFileInput((file) => stageLocalFile(file));
      return;
    }
    errBar.hidden = true;
    const ac = new AbortController();
    activeAbort = ac;
    _pbpOcrPanelActiveAbort = ac;
    syncCard();
    try {
      // MV3 gesture rule: request required exact origins synchronously on click
      // before any storage/IDB/file await.
      const docPattern = mode === "online" && typeof pbpEndpointOriginPattern === "function"
        ? pbpEndpointOriginPattern(onlineUrl)
        : "";
      const permRes = await _pbpOcrRequestOriginsOnGesture(
        docPattern ? [docPattern, PBP_OCR_ORIGIN_PATTERN] : [PBP_OCR_ORIGIN_PATTERN]
      );
      if (ac.signal.aborted || !wrap.isConnected) return;
      if (!permRes.ok) {
        showErr(permRes);
        return;
      }

      const purpose = richInput.checked ? "rich_layout_recognition" : "text_recognition";
      let uploadBytes = null;
      let uploadName = "";
      let uploadMime = "";
      if (mode === "online") {
        primaryBtn.textContent = t("mdOcrFetchingFile");
        const fetched = await pbpOcrFetchRemoteBytes(onlineUrl, ac.signal);
        if (ac.signal.aborted || !wrap.isConnected) return;
        if (!fetched.ok) {
          if (fetched.code !== "aborted") showErr(fetched);
          return;
        }
        uploadBytes = fetched.bytes;
        uploadName = fetched.fileName;
        uploadMime = fetched.mimeType;
        primaryBtn.textContent = t("mdOcrRunning");
      } else {
        const ab = await stagedFile.arrayBuffer();
        if (ac.signal.aborted || !wrap.isConnected) return;
        uploadBytes = new Uint8Array(ab);
        uploadName = stagedFile.name;
        uploadMime = stagedFile.type;
      }

      const res = await pbpOcrRunUpload({
        bytes: uploadBytes,
        fileName: uploadName,
        mimeType: uploadMime,
        purpose,
        sourceUrl: mode === "online" ? onlineUrl : "",
        signal: ac.signal,
      });
      if (ac.signal.aborted || !wrap.isConnected) return;
      if (!res.ok) {
        if (res.code !== "aborted") showErr(res);
        return;
      }
      await _pbpOcrOpenDocInReader(res.doc, {
        expectedUrl: mode === "online" ? onlineUrl : (typeof opts.expectedUrl === "string" ? opts.expectedUrl : ""),
        title: mode === "online" ? (opts.title || _pbpOcrTitleFromFileName(res.doc.fileName)) : _pbpOcrTitleFromFileName(res.doc.fileName),
        sourceTabUrl: mode === "online" ? (opts.sourceTabUrl || onlineUrl) : res.doc.url,
        bookmarkUrl: mode === "online" ? (opts.bookmarkUrl || onlineUrl) : "",
        site: mode === "online" ? (opts.site || "") : (res.doc.fileName || ""),
        sourceIncognito: opts.sourceIncognito === true,
        bookmarkDraft: opts.bookmarkDraft || null,
        account: opts.account || "",
        tags: opts.tags || [],
        description: opts.description || "",
      }, false);
    } catch (e) {
      if (ac.signal.aborted || !wrap.isConnected) return;
      console.warn("[ocr] run failed:", e?.name, e?.message);
      showErr({ code: "server_error" });
    } finally {
      if (activeAbort === ac) activeAbort = null;
      if (_pbpOcrPanelActiveAbort === ac) _pbpOcrPanelActiveAbort = null;
      if (wrap.isConnected) {
        syncCard();
        _pbpOcrSyncAvailabilityDom();
      }
    }
  });

  if (stagedFile) stageLocalFile(stagedFile);
  else syncCard();
  view.replaceChildren(wrap);
}

function pbpOcrOpenImportEntry(opts = {}) {
  const inEmptyShell = document.body.classList.contains("md-empty") ||
    document.body.classList.contains("md-shell") ||
    Boolean(document.querySelector("#rendered-view > .es-ocr"));
  if (inEmptyShell || opts.forceInPlace === true) {
    pbpOcrRenderPanel({
      mode: "local",
      initialFile: opts.initialFile || null,
      sourceIncognito: _pbpOcrSyncIncognitoHint(),
      expectedUrl: typeof window !== "undefined" && typeof window._pbpCurrentReaderUrl === "string" ? window._pbpCurrentReaderUrl : "",
    });
    return;
  }
  if (typeof chrome !== "undefined" && chrome.tabs?.create && chrome.runtime?.getURL) {
    const incogQ = _pbpOcrSyncIncognitoHint() ? "&incognito=1" : "";
    const videoQ = (typeof pbpVideoDetect === "function" && pbpVideoDetect("")) ? "&video=1" : "";
    void chrome.tabs.create({ url: chrome.runtime.getURL("md-preview.html?import=ocr" + incogQ + videoQ) });
  }
}

function _pbpOcrOpenDropDialogOnArticle(file) {
  if (_pbpOcrDropActiveAbort) {
    _pbpOcrDropActiveAbort.abort("replaced");
    _pbpOcrDropActiveAbort = null;
  }
  const pre = pbpOcrValidateInput({
    byteLength: file.size,
    fileName: file.name,
    mimeType: file.type,
  });
  if (!_pbpOcrDropPop) {
    const pop = document.createElement("div");
    pop.id = "ocr-drop-pop";
    pop.className = "pop-panel";
    pop.setAttribute("popover", "auto");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", t("mdOcrPanelTitleLocal"));
    pop.addEventListener("toggle", (e) => {
      if (e.newState !== "open" && _pbpOcrDropActiveAbort) {
        _pbpOcrDropActiveAbort.abort("closed");
        _pbpOcrDropActiveAbort = null;
      }
    });
    document.body.appendChild(pop);
    _pbpOcrDropPop = pop;
  }
  const pop = _pbpOcrDropPop;
  let activeAbort = null;

  const head = document.createElement("div");
  head.className = "panel-head";
  const h2 = document.createElement("h2");
  h2.className = "rh-title";
  h2.textContent = t("mdOcrPanelTitleLocal");
  head.appendChild(h2);

  const errBar = document.createElement("div");
  errBar.className = "msg-bar error";
  errBar.setAttribute("role", "alert");
  errBar.hidden = pre.ok;
  if (!pre.ok) errBar.textContent = pbpOcrErrorMessage(pre);

  const nameEl = document.createElement("div");
  nameEl.className = "rh-item-title";
  nameEl.dir = "auto";
  nameEl.textContent = file.name || "document";

  const sizeEl = document.createElement("div");
  sizeEl.className = "rh-meta";
  sizeEl.textContent = typeof pbpFormatBytes === "function" ? pbpFormatBytes(file.size || 0) : `${file.size || 0} B`;

  const paidEl = document.createElement("div");
  paidEl.className = "rh-meta";
  paidEl.textContent = t("mdOcrPaidNotice");

  const { field: richField, input: richInput } = _pbpOcrBuildRichLayoutToggle("ocr-drop");
  richInput.disabled = !pre.ok;

  const row = document.createElement("div");
  row.className = "row";
  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "action-btn es-primary";
  runBtn.textContent = t("mdOcrRunBtn");
  runBtn.disabled = !pre.ok;

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "action-btn es-quiet";
  cancelBtn.textContent = t("cancel");
  cancelBtn.addEventListener("click", () => {
    if (activeAbort) {
      activeAbort.abort("user");
      if (_pbpOcrDropActiveAbort === activeAbort) _pbpOcrDropActiveAbort = null;
      activeAbort = null;
    }
    try { pop.hidePopover(); } catch (_) { /* swallow-ok: popover already hidden */ }
  });
  row.append(runBtn, cancelBtn);

  runBtn.addEventListener("click", async () => {
    if (activeAbort || !pre.ok) return;
    errBar.hidden = true;
    const ac = new AbortController();
    activeAbort = ac;
    _pbpOcrDropActiveAbort = ac;
    runBtn.disabled = true;
    runBtn.textContent = t("mdOcrRunning");
    richInput.disabled = true;
    try {
      const permRes = await _pbpOcrRequestOriginsOnGesture([PBP_OCR_ORIGIN_PATTERN]);
      if (ac.signal.aborted || !runBtn.isConnected) return;
      if (!permRes.ok) {
        errBar.textContent = pbpOcrErrorMessage(permRes);
        errBar.hidden = false;
        return;
      }
      const ab = await file.arrayBuffer();
      if (ac.signal.aborted || !runBtn.isConnected) return;
      const res = await pbpOcrRunUpload({
        bytes: new Uint8Array(ab),
        fileName: file.name,
        mimeType: file.type,
        purpose: richInput.checked ? "rich_layout_recognition" : "text_recognition",
        signal: ac.signal,
      });
      if (ac.signal.aborted || !runBtn.isConnected) return;
      if (!res.ok) {
        if (res.code !== "aborted") {
          errBar.textContent = pbpOcrErrorMessage(res);
          errBar.hidden = false;
        }
        return;
      }
      await _pbpOcrOpenDocInReader(res.doc, {
        title: _pbpOcrTitleFromFileName(res.doc.fileName),
        sourceIncognito: _pbpOcrSyncIncognitoHint(),
      }, true);
      try { pop.hidePopover(); } catch (_) { /* swallow-ok: popover already hidden */ }
    } catch (e) {
      if (ac.signal.aborted || !runBtn.isConnected) return;
      console.warn("[ocr] drop upload failed:", e?.name, e?.message);
      errBar.textContent = t("mdOcrErrFailed");
      errBar.hidden = false;
    } finally {
      if (activeAbort === ac) activeAbort = null;
      if (_pbpOcrDropActiveAbort === ac) _pbpOcrDropActiveAbort = null;
      if (runBtn.isConnected) {
        runBtn.disabled = false;
        runBtn.textContent = t("mdOcrRunBtn");
        richInput.disabled = false;
        _pbpOcrSyncAvailabilityDom();
      }
    }
  });

  pop.replaceChildren(head, errBar, nameEl, sizeEl, richField, paidEl, row);
  if (typeof _pbpReaderHideOtherPopovers === "function") _pbpReaderHideOtherPopovers(pop);
  try { pop.showPopover(); } catch (_) { /* swallow-ok: fallback if popover API unsupported */ }
}

function pbpOcrInstallReaderHooks() {
  if (typeof document === "undefined" || !document.body || document.body.dataset.ocrHooksBound === "1") return;
  document.body.dataset.ocrHooksBound = "1";

  for (const id of ["rail-ocr-btn", "btn-import-ocr"]) {
    const btn = document.getElementById(id);
    if (btn) {
      btn.hidden = !_pbpOcrKeyReady;
      btn.addEventListener("click", () => pbpOcrOpenImportEntry());
    }
  }
  _pbpOcrSyncAvailabilityDom();
  if (typeof chrome !== "undefined" && chrome.storage) {
    void pbpOcrRefreshConfig();
    chrome.storage.onChanged?.addListener((changes, area) => {
      if ((area === "local" || area === "sync") &&
          (changes.deepseekApiKey || changes.optSyncEnabled || changes.syncApiKeys)) {
        void pbpOcrRefreshConfig();
      }
    });
  }

  const hasFiles = (dt) => Boolean(dt && Array.from(dt.types || []).includes("Files"));
  document.addEventListener("dragover", (e) => {
    if (!_pbpOcrKeyReady || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("drop", (e) => {
    if (!_pbpOcrKeyReady || !hasFiles(e.dataTransfer)) return;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    const inEmptyShell = document.body.classList.contains("md-empty") ||
      document.body.classList.contains("md-shell") ||
      Boolean(document.querySelector("#rendered-view > .es-ocr"));
    if (inEmptyShell) {
      pbpOcrRenderPanel({
        mode: "local",
        initialFile: file,
        sourceIncognito: _pbpOcrSyncIncognitoHint(),
        expectedUrl: typeof window !== "undefined" && typeof window._pbpCurrentReaderUrl === "string" ? window._pbpCurrentReaderUrl : "",
      });
    } else {
      _pbpOcrOpenDropDialogOnArticle(file);
    }
  });
}

if (typeof document !== "undefined" && typeof chrome !== "undefined" && chrome.storage) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", pbpOcrInstallReaderHooks, { once: true });
  } else {
    pbpOcrInstallReaderHooks();
  }
}
