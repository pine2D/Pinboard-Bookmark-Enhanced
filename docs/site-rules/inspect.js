// site-rules inspector — paste into DevTools Console on a target page (logged in),
// then read the printed summary to author/verify a rule in ../../site-rules.js.
// It prints: candidate content containers, embedded-JSON blobs, lazy-image attrs,
// and collapse/login markers. The summary is also copied to your clipboard.
//
// Reminder (isolated-world constraint): site-rules.js can read DOM, <script>-JSON
// (__NEXT_DATA__ / js-initialData / RENDER_DATA / application/ld+json), <meta>, and
// data-* attributes — but NOT page window.* globals. Anchor rules on what's listed
// under "json" or the DOM containers below; ignore anything only in window.*.
(() => {
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return "";
    let s = el.tagName.toLowerCase();
    if (el.id) s += "#" + el.id;
    if (el.classList && el.classList.length) s += "." + Array.from(el.classList).slice(0, 2).join(".");
    return s;
  };

  // 1. Candidate content containers: biggest text blocks (drop ancestors of a bigger one).
  const cand = Array.from(document.querySelectorAll("article, main, section, div"))
    .map((el) => ({ el, len: (el.innerText || "").trim().length }))
    .filter((x) => x.len > 300)
    .sort((a, b) => b.len - a.len);
  const containers = [];
  for (const c of cand) {
    if (containers.some((k) => k.el.contains(c.el))) continue; // skip descendants of a chosen block
    containers.push(c);
    if (containers.length >= 8) break;
  }

  // 2. Embedded JSON blobs (DOM-reachable from the isolated world).
  const json = {};
  ["__NEXT_DATA__", "js-initialData", "RENDER_DATA"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) json[id] = (el.textContent || "").length + " chars";
  });
  const ld = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map((s) => {
    try { const d = JSON.parse(s.textContent); const arr = Array.isArray(d) ? d : (d["@graph"] || [d]); return arr.map((x) => x && x["@type"]).filter(Boolean); }
    catch (_) { return ["PARSE_ERR"]; }
  });
  if (ld.length) json["ld+json @types"] = [].concat.apply([], ld);
  ["data-props", "data-field", "data-zop"].forEach((a) => {
    const n = document.querySelectorAll("[" + a + "]").length;
    if (n) json[a] = n + " node(s)";
  });

  // 3. Lazy-image attributes present.
  const lazy = {};
  ["data-src", "data-original", "data-actualsrc"].forEach((a) => {
    const n = document.querySelectorAll("img[" + a + "]").length;
    if (n) lazy[a] = n;
  });

  // 4. Collapse / login / paywall markers worth handling.
  const markerSels = [
    ".hide-article-box", ".btn-readmore", ".article-show-more", ".readall_box",   // CSDN-style fold
    "[class*=login]", "[class*=signin]", "[class*=paywall]", "[class*=mask]",
    "[class*=collapse]", "[class*=read-more]", "[class*=expand]"
  ];
  const markers = markerSels.filter((m) => { try { return document.querySelector(m); } catch (_) { return false; } });

  const summary = {
    url: location.href,
    title_candidates: ["h1", '[property="og:title"]'].map((q) => {
      const e = document.querySelector(q); return e ? (sel(q === "h1" ? e : e) + " = " + (e.getAttribute("content") || e.textContent || "").trim().slice(0, 60)) : null;
    }).filter(Boolean),
    content_containers: containers.map((c) => ({ selector: sel(c.el), textLen: c.len })),
    json,
    lazyImages: lazy,
    markers
  };

  const out = JSON.stringify(summary, null, 2);
  console.log(out);
  try { copy(out); console.log("(copied to clipboard)"); } catch (_) {}
  return summary;
})();
