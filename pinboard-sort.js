// ============================================================
// Pinboard Bookmark Enhanced - Tag-page "sort by popularity"
// Content script for pinboard.in tag list pages (run_at: document_idle)
//
// Adds a client-side "pop" control that reorders the CURRENT page's
// bookmarks by how many people saved each link (the `a.url_link`
// "N others" badge). Click once = most popular first; click again =
// restore original DOM order. No persistence, no network, visible page
// only.
//
// Placement:
//   - own tag pages  : append " ‧ pop" into pinboard's native
//                      #sort_order_picker (next to date · title)
//   - public / other : build a matching control reusing pinboard's
//                      .pagination_select / .sort_arrow classes and
//                      drop it in the tag header (left of RSS, above
//                      the pager) — no collision with RSS or « earlier.
//
// Theme: reuses pinboard's native sort-control classes so the 13
// shipped themes style it for free; active state uses our own class
// with currentColor (bold + underline), never the native #ffa.
// pinboard-themes.js / the theme factory are NOT touched.
// ============================================================

(() => {
  "use strict";

  // ---------- pure helpers (exposed for unit tests) ----------

  // "9 others" / "1 other" / "  3 others " -> 9 / 1 / 3 ; anything else -> 0
  function parsePopCount(text) {
    if (!text) return 0;
    const m = String(text).match(/^\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  // Popularity of one bookmark element (0 when there is no url_link).
  function extractPop(bookmarkEl) {
    if (!bookmarkEl) return 0;
    const link = bookmarkEl.querySelector("a.url_link");
    return link ? parsePopCount(link.textContent) : 0;
  }

  // Stable descending order by pop. Ties keep original document order.
  // Returns a NEW array of the same elements; does not mutate the input.
  function computeSortedOrder(bookmarkEls) {
    return bookmarkEls
      .map((el, i) => ({ el, pop: extractPop(el), i }))
      .sort((a, b) => (b.pop - a.pop) || (a.i - b.i))
      .map((x) => x.el);
  }

  // Expose for the test harness (harmless in the isolated content world).
  if (typeof window !== "undefined") {
    window.__PBP_POPSORT__ = { parsePopCount, extractPop, computeSortedOrder };
  }

  // ---------- everything below only runs on a real tag page ----------

  // Only tag list pages: /t:..., /u:x/t:..., incl. multi-tag.
  function isTagListPage() {
    if (!/(^|\/)(u:[^/]+\/)?t:/.test(location.pathname)) return false;
    const mc = document.getElementById("main_column");
    return !!(mc && mc.querySelector("div.bookmark"));
  }

  // Inline storage selector (shared.js is unavailable to content scripts;
  // mirrors pinboard-style.js). Default ON.
  async function readEnabled() {
    try {
      const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
      const storage = optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
      const { tagSortByPopEnabled } = await storage.get({ tagSortByPopEnabled: true });
      return tagSortByPopEnabled;
    } catch (_) {
      return true;
    }
  }

  const CONTROL_ID = "pbp-pop-sort";
  let originalOrder = null; // bookmark nodes in document order, snapshot at inject
  let sorted = false;

  function getBookmarks(mc) {
    return Array.from(mc.querySelectorAll(":scope > div.bookmark"));
  }

  // Move the given ordered bookmark nodes to where the first bookmark sits,
  // preserving any non-bookmark siblings (pager <p>, scripts) around the block.
  function reorder(mc, order) {
    // Anchor = the live first bookmark (re-queried, so it is always still attached
    // even if the page mutated since inject). Removing all bookmarks collapses them
    // to this one point, so the reordered block lands exactly where the list is.
    const first = getBookmarks(mc)[0];
    if (!first) return;
    const marker = document.createComment("pbp-pop");
    mc.insertBefore(marker, first);
    const frag = document.createDocumentFragment();
    for (const el of order) frag.appendChild(el); // moves el into frag, in order
    mc.insertBefore(frag, marker);
    marker.remove();
  }

  function onToggle(mc, link) {
    sorted = !sorted;
    // reorder() only reads `order` (it moves nodes, not array slots), so passing the
    // originalOrder snapshot directly is safe — the snapshot array is never mutated.
    reorder(mc, sorted ? computeSortedOrder(originalOrder) : originalOrder);
    link.classList.toggle("pbp-pop-active", sorted);
  }

  function injectStyle() {
    if (document.getElementById("pbp-pop-style")) return;
    const st = document.createElement("style");
    st.id = "pbp-pop-style";
    st.textContent =
      "#" + CONTROL_ID + "{cursor:pointer}" +
      "#" + CONTROL_ID + ".pbp-pop-active{font-weight:700;text-decoration:underline}";
    (document.head || document.documentElement).appendChild(st);
  }

  function makePopLink() {
    const a = document.createElement("a");
    a.id = CONTROL_ID;
    a.href = "#";
    a.textContent = "pop";
    a.title = "Sort this page by popularity";
    return a;
  }

  // Public/other pages: place the fallback picker in the tag header,
  // left of the float:right RSS, above the bookmark/pager block.
  function placeFallback(mc, node) {
    const rssbox = mc.querySelector(".rss_linkbox");
    const header = (rssbox && rssbox.closest("#main_column > div")) || mc.firstElementChild;
    // No real header (or it resolved to a bookmark) → drop the control above the list,
    // never inside a bookmark.
    if (!header || header.classList.contains("bookmark")) {
      mc.insertBefore(node, mc.querySelector(":scope > div.bookmark"));
      return;
    }
    const clear = header.querySelector(':scope > div[style*="clear"]');
    if (clear) header.insertBefore(node, clear);
    else header.appendChild(node);
  }

  function inject(mc) {
    if (document.getElementById(CONTROL_ID)) return; // no double-inject
    const link = makePopLink();
    const picker = document.getElementById("sort_order_picker");
    if (picker) {
      picker.appendChild(document.createTextNode(" ‧ "));
      picker.appendChild(link);
    } else {
      const span = document.createElement("span");
      span.className = "pagination_select";
      span.id = "pbp-pop-picker";
      const arrow = document.createElement("span");
      arrow.className = "sort_arrow";
      arrow.textContent = "⇳";
      span.appendChild(document.createTextNode("\u00A0")); // nbsp before arrow (matches native picker)
      span.appendChild(arrow);
      span.appendChild(document.createTextNode(" "));
      span.appendChild(link);
      placeFallback(mc, span);
    }
    injectStyle();
    originalOrder = getBookmarks(mc);
    link.addEventListener("click", (e) => {
      e.preventDefault();
      try { onToggle(mc, link); } catch (_) { /* never break the host page */ }
    });
  }

  async function main() {
    try {
      if (!isTagListPage()) return;
      if (!(await readEnabled())) return;
      const mc = document.getElementById("main_column");
      if (mc) inject(mc);
    } catch (_) { /* never break the host page */ }
  }

  main();
})();
