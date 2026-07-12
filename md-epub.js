// md-epub.js — single-article EPUB builder (spec 2026-07-12 §3).
// ── PURE SECTION (no DOM/chrome/fetch/Date; loaded by tests) ──
const _PBP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function pbpCrc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = _PBP_CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
// 固定 DOS 时间戳（2026-01-01 00:00，确定性输出；EPUB 阅读器不消费该字段）
const _PBP_ZIP_DOSTIME = 0, _PBP_ZIP_DOSDATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function pbpZipStore(entries) {
  const enc = new TextEncoder();
  const locals = [], centrals = []; let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), crc = pbpCrc32(e.data), n = e.data.length;
    const lh = new Uint8Array(30 + name.length + n);
    const dv = new DataView(lh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0, true);
    dv.setUint16(8, 0, true);  // stored
    dv.setUint16(10, _PBP_ZIP_DOSTIME, true); dv.setUint16(12, _PBP_ZIP_DOSDATE, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, n, true); dv.setUint32(22, n, true);
    dv.setUint16(26, name.length, true); dv.setUint16(28, 0, true);
    lh.set(name, 30); lh.set(e.data, 30 + name.length);
    locals.push(lh);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, _PBP_ZIP_DOSTIME, true); cv.setUint16(14, _PBP_ZIP_DOSDATE, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, n, true); cv.setUint32(24, n, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    centrals.push(ch);
    offset += lh.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
  const total = offset + cdSize + 22;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of [...locals, ...centrals, eocd]) { out.set(b, p); p += b.length; }
  return out;
}

function pbpEpubXmlEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function pbpEpubContainerXml() {
  return '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n';
}

function pbpEpubContentOpf(meta, items) {
  const esc = pbpEpubXmlEscape;
  const ident = "urn:pbp:" + pbpCrc32(new TextEncoder().encode(meta.url || "")).toString(16).padStart(8, "0");
  const manifest = items.map(i =>
    `<item id="${esc(i.id)}" href="${esc(i.href)}" media-type="${esc(i.mediaType)}"${i.properties ? ` properties="${esc(i.properties)}"` : ""}/>`).join("\n    ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${esc(ident)}</dc:identifier>
    <dc:title>${esc(meta.title || "Untitled")}</dc:title>
    ${meta.author ? `<dc:creator>${esc(meta.author)}</dc:creator>` : ""}
    <dc:source>${esc(meta.url || "")}</dc:source>
    <dc:date>${esc(meta.date || meta.clipped || "")}</dc:date>
    <dc:language>${esc(meta.lang || "und")}</dc:language>
    <meta property="dcterms:modified">${esc((meta.clipped || "1970-01-01") + "T00:00:00Z")}</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>
`;
}

function pbpEpubNavXhtml(headings, fallbackTitle) {
  const esc = pbpEpubXmlEscape;
  const lis = (headings && headings.length ? headings : [{ id: "", text: fallbackTitle || "Content" }])
    .map(h => `<li><a href="content.xhtml${h.id ? "#" + esc(h.id) : ""}">${esc(h.text)}</a></li>`).join("\n        ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${esc(fallbackTitle || "Contents")}</title></head>
  <body>
    <nav epub:type="toc">
      <ol>
        ${lis}
      </ol>
    </nav>
  </body>
</html>
`;
}
// ── end PURE SECTION ──
// ── RUNTIME (DOM) ──
// pbpBuildEpub({ md, meta, images }) -> Blob. Caller contract (md-preview.js):
// `md` is the FINAL canonical markdown -- frontmatter/highlightsInline already
// forced off by the caller's own composeExport call (dc:* metadata covers title/
// author/date/etc, and marked doesn't parse "==...==" so an inline mark would
// leak as literal text into the XHTML body, same reasoning as composeStyledHtml).
// `images`: the fetched Map from resolveEmbed(..., {keepUrls:true}) (absUrl ->
// {mime, bytes}), or empty/undefined when the export image policy isn't "embed".
function pbpBuildEpub({ md, meta, images }) {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(md);            // 单点 sanitize：唯一入口
  // nav 数据源 = 渲染后 DOM 的真实 id（含 marked 的 -1/-2 去重），不是 buildToc slug。
  // 选全部 h2-h4；缺 id / 空 id（纯标点标题 slugify 为空、raw HTML 标题无 id）
  // 补写确定性 id 并写回 DOM——先写回再序列化，nav 锚点才真实存在。
  const seenIds = new Set([...host.querySelectorAll("[id]")].map(el => el.id).filter(Boolean));
  const headings = [...host.querySelectorAll("h2, h3, h4")].map((h, i) => {
    if (!h.id) {
      let id = "pbp-h-" + i;
      while (seenIds.has(id)) id += "x";
      h.id = id; seenIds.add(id);
    }
    return { id: h.id, text: h.textContent.trim() || h.id };
  });
  const enc = new TextEncoder();
  const items = [
    { id: "nav", href: "nav.xhtml", mediaType: "application/xhtml+xml", properties: "nav" },
    { id: "content", href: "content.xhtml", mediaType: "application/xhtml+xml" },
  ];
  const imgEntries = [];
  if (images && images.size) {
    let n = 0;
    for (const [absUrl, img] of images) {
      const name = `images/img-${n}.${PBP_EMBED_MIME_EXT[img.mime] || "bin"}`;
      host.querySelectorAll(`img[src="${CSS.escape(absUrl)}"]`)
        .forEach(el => el.setAttribute("src", name));
      items.push({ id: "img" + n, href: name, mediaType: img.mime });
      imgEntries.push({ name: "OEBPS/" + name, data: img.bytes });
      n++;
    }
  }
  // host is an HTML-namespace <div> -- XMLSerializer stamps xmlns="…xhtml" on the
  // root element; the strip regex tolerates that (and any other) attribute text.
  const bodyXhtml = new XMLSerializer().serializeToString(host)
    .replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
  const esc = pbpEpubXmlEscape;
  const contentXhtml = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${esc(meta.title || "Untitled")}</title></head><body>\n<h1>${esc(meta.title || "Untitled")}</h1>\n${bodyXhtml}\n</body></html>\n`;
  const zip = pbpZipStore([
    { name: "mimetype", data: enc.encode("application/epub+zip") },   // 必须第一且 stored
    { name: "META-INF/container.xml", data: enc.encode(pbpEpubContainerXml()) },
    { name: "OEBPS/content.opf", data: enc.encode(pbpEpubContentOpf(meta, items)) },
    { name: "OEBPS/nav.xhtml", data: enc.encode(pbpEpubNavXhtml(headings, meta.title)) },
    { name: "OEBPS/content.xhtml", data: enc.encode(contentXhtml) },
    ...imgEntries,
  ]);
  return new Blob([zip], { type: "application/epub+zip" });
}
// ── end RUNTIME ──
