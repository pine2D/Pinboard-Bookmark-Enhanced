// md-embed.js — export image embedding (spec 2026-07-12 §2).
// ── PURE SECTION (no DOM/chrome/fetch; loaded by tests/md-convert-tests.html) ──
const PBP_EMBED_LIMITS = { maxImages: 50, maxOrigins: 10, perImageBytes: 3 * 1024 * 1024, totalBytes: 25 * 1024 * 1024, outputBytes: 40 * 1024 * 1024, timeoutMs: 10000, concurrency: 4 };
const PBP_EMBED_MIME_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
// Same IMG regex + fence-skip as md-convert.js applyImagePolicy — keep in sync.
const _PBP_EMBED_IMG = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;

function _pbpEmbedLines(md, onLine) {
  let inFence = false;
  return (md || "").split("\n").map((line) => {
    if (line.match(/^\s*(```|~~~)/)) { inFence = !inFence; return line; }
    return inFence ? line : _pbpEmbedMasked(line, onLine);
  }).join("\n");
}

// Codex-P3: 行内 code span 与转义 \![ 内的伪图片语法不得进入扫描/重写——
// 它们会驱动权限申请与联网抓取。掩蔽为 NUL 定界占位符（\x00M<i>\x00），处理后还原。
// NUL 在正常 markdown 行内不可能出现，与正文字面（如 " M3 "）天然无碰撞；
// 万一恶意输入携带 NUL 形似 token，restore 的 fallback 只保留原样，绝不注入 "undefined"。
function _pbpEmbedMasked(line, onLine) {
  const stash = [];
  const masked = line
    .replace(/`[^`]*`/g, (m) => { stash.push(m); return "\x00M" + (stash.length - 1) + "\x00"; })
    .replace(/\\!\[/g, (m) => { stash.push(m); return "\x00M" + (stash.length - 1) + "\x00"; });
  return onLine(masked).replace(/\x00M(\d+)\x00/g, (match, i) => stash[+i] !== undefined ? stash[+i] : match);
}

function pbpEmbedScan(md, baseUrl) {
  const seen = new Set(), candidates = [], blobs = [], kept = [], origins = [];
  _pbpEmbedLines(md, (line) => {
    line.replace(_PBP_EMBED_IMG, (whole, alt, src) => {
      let abs = src;
      if (baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//")) {
        try { abs = new URL(src, baseUrl).href; } catch (_) { return whole; }
      }
      if (seen.has(abs)) return whole;
      seen.add(abs);
      if (/^data:/i.test(abs)) return whole;                       // already inline
      if (/^blob:/i.test(abs)) { blobs.push(abs); return whole; }  // dead outside page → alt
      let origin = "";
      try { origin = new URL(abs).origin; } catch (_) { kept.push(abs); return whole; }
      if (!/^https:/i.test(abs)
          || candidates.length >= PBP_EMBED_LIMITS.maxImages
          || (!origins.includes(origin) && origins.length >= PBP_EMBED_LIMITS.maxOrigins)) {
        kept.push(abs);
        return whole;
      }
      if (!origins.includes(origin)) origins.push(origin);
      candidates.push(abs);
      return whole;
    });
    return line;
  });
  return { candidates, blobs, kept, origins };
}

// map: absUrl -> replacement src（data URI 或相对路径）；值为 null → 整图退化为 alt 文本。
// outBudget: pbpEmbedBudget(PBP_EMBED_LIMITS.outputBytes) —— 每次替换按替换串长度记账（Codex-P2），
// 预算耗尽的位置保留原样并计入 dropped。
function pbpEmbedRewrite(md, map, baseUrl, outBudget) {
  let dropped = 0;
  const out = _pbpEmbedLines(md, (line) =>
    line.replace(_PBP_EMBED_IMG, (whole, alt, src) => {
      let abs = src;
      if (baseUrl && !/^[a-z][a-z0-9+.-]*:/i.test(src) && !src.startsWith("//")) {
        try { abs = new URL(src, baseUrl).href; } catch (_) { return whole; }
      }
      if (!(abs in map)) return whole;
      if (map[abs] === null) return alt || "";                       // blob → alt（计数由调用方按 blobs.length 承担）
      const repl = "![" + alt + "](" + map[abs] + ")";
      if (outBudget && !outBudget.reserve(repl.length)) { dropped++; return whole; }
      return repl;
    }));
  return { md: out, dropped };
}

function pbpEmbedBudget(totalBytes) {
  let used = 0;
  return {
    reserve(n) { if (!Number.isFinite(n) || n < 0 || used + n > totalBytes) return false; used += n; return true; },
    used() { return used; }
  };
}
// ── end PURE SECTION — RUNTIME SECTION (fetch/permissions, Task 4) appends below this line ──
