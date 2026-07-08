// ============================================================
// Markdown Preview Page
// ============================================================

// Render the styled empty state and hide the rail so the page reads as
// intentional (not a half-rendered document). textContent only — no innerHTML.
function renderEmptyState(message) {
  const view = document.getElementById("rendered-view");
  if (view) {
    view.removeAttribute("aria-busy");
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    const p = document.createElement("p");
    p.textContent = message;
    wrap.appendChild(p);
    view.replaceChildren(wrap);
  }
  document.body.classList.add("md-empty");
}

// Same visual shell as renderEmptyState, but for a recoverable extraction failure: keeps
// the rail (incl. the Defuddle/Jina engine-switch badge) visible/usable instead of hiding
// it, and offers a retry button that re-runs retryFn (the same reextractMarkdown flow the
// engine-switch control already uses — see the pending-extraction branch below). Bare
// renderEmptyState stays reserved for genuinely nothing-to-do states (no preview data /
// no content at all), where there is nothing to retry or switch.
function renderErrorState(message, retryFn) {
  const view = document.getElementById("rendered-view");
  if (view) {
    view.removeAttribute("aria-busy");
    const wrap = document.createElement("div");
    wrap.className = "empty-state";
    const p = document.createElement("p");
    p.textContent = message;
    wrap.appendChild(p);
    if (typeof retryFn === "function") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-btn";
      btn.textContent = t("askErrRetry"); // reuse the existing "Retry" i18n key (used by md-ask.js's own error/retry buttons on this same page)
      btn.addEventListener("click", retryFn, { once: true });
      wrap.appendChild(btn);
    }
    view.replaceChildren(wrap);
  }
  document.body.classList.remove("md-empty"); // undo renderLoadingState's rail-hide so the engine-switch badge stays reachable
}

function renderLoadingState(message, note) {
  const view = document.getElementById("rendered-view");
  if (view) {
    const wrap = document.createElement("div");
    wrap.className = "preview-loading";
    const sp = document.createElement("div");
    sp.className = "preview-spinner";
    sp.setAttribute("aria-hidden", "true");
    const p = document.createElement("p");
    p.textContent = message;
    wrap.appendChild(sp);
    wrap.appendChild(p);
    if (note) {
      const n = document.createElement("p");
      n.className = "note";
      n.textContent = note;
      wrap.appendChild(n);
    }
    view.replaceChildren(wrap);
    view.setAttribute("aria-busy", "true");
  }
  document.body.classList.add("md-empty");
}

// Map the active UI locale (manual-override mirror, else the browser UI language) to a
// BCP-47 tag for <html lang>, so the rail/UI chrome renders in the locale's font via :lang().
function uiLangToBCP47() {
  let l = null;
  try { l = (typeof localStorage !== "undefined") ? localStorage.getItem("pp-i18n-lang") : null; } catch (_) {}
  if (!l || l === "auto") {
    try { l = chrome.i18n.getUILanguage(); } catch (_) { l = "en"; }
  }
  l = (l || "en").replace(/_/g, "-").toLowerCase();
  if (l === "zh-hk" || l === "zh-tw" || l.startsWith("zh-hant")) return "zh-Hant";
  if (l === "zh-cn" || l === "zh-sg" || l === "zh" || l.startsWith("zh-hans")) return "zh-Hans";
  if (l.startsWith("ja")) return "ja";
  if (l.startsWith("ko")) return "ko";
  return l.split("-")[0]; // en / de / fr / pl / ru
}

// Heuristic detection of the ARTICLE's script from its text, so #rendered-view gets a
// lang attribute and :lang() picks the correct CJK font (a Simplified-only stack draws
// Traditional text with wrong glyph forms). Zero-dependency; samples the head of the text.
function detectArticleLang(text) {
  if (!text) return "";
  const s = text.slice(0, 4000);
  if (/[぀-ゟ゠-ヿ]/.test(s)) return "ja"; // Hiragana / Katakana
  if (/[가-힣]/.test(s)) return "ko";              // Hangul syllables
  if (/[一-鿿]/.test(s)) {                          // Han → Simplified vs Traditional
    const simp = (s.match(/[国对见图书龙东车马门话语说题际还买卖产权观难应当么这样实现单关闭过]/g) || []).length;
    const trad = (s.match(/[國對見圖書龍東車馬門話語說題際還買賣產權觀難應當麼這樣實現單關閉過]/g) || []).length;
    if (trad > simp) return "zh-Hant";
    if (simp > trad) return "zh-Hans";
    return ""; // ambiguous → default (TC-first) stack handles it
  }
  // D9-3: Arabic / Hebrew script blocks (escaped code points, not literal RTL
  // characters, to avoid embedding bidi source in this file). Codes double as
  // the RTL signal below (renderedView.dir), unlike the LTR branches above.
  if (/[\u0600-\u06FF]/.test(s)) return "ar"; // Arabic
  if (/[\u0590-\u05FF]/.test(s)) return "he"; // Hebrew
  return ""; // Latin / Cyrillic → default stack's Latin head
}

// Lazy-load the vendored highlight.js (~122KB) on demand: only articles that actually
// contain code blocks pay its parse/compile cost, and never on the blocking first-paint
// path. Cached so concurrent callers share one load; degrades to no-highlight on error.
let _hljsPromise = null;
function ensureHljs() {
  if (typeof hljs !== "undefined") return Promise.resolve();
  if (_hljsPromise) return _hljsPromise;
  _hljsPromise = new Promise((resolve) => {
    const s = document.createElement("script");
    s.src = "vendor/highlight.min.js";
    s.onload = () => resolve();
    s.onerror = () => resolve(); // degrade gracefully: page works without highlighting
    document.head.appendChild(s);
  });
  return _hljsPromise;
}

// Lazy-load KaTeX (JS + auto-render + CSS) only for math-bearing content (e.g. arXiv),
// so non-math previews never pay the ~270KB cost and currency "$" on other pages is
// never touched. CSS is injected here too so the lean first-paint isn't burdened.
let _katexPromise = null;
function ensureKatex() {
  if (typeof renderMathInElement !== "undefined") return Promise.resolve();
  if (_katexPromise) return _katexPromise;
  _katexPromise = new Promise((resolve) => {
    const css = document.createElement("link");
    css.rel = "stylesheet"; css.href = "vendor/katex/katex.min.css";
    document.head.appendChild(css);
    const s = document.createElement("script");
    s.src = "vendor/katex/katex.min.js";
    s.onload = () => {
      const a = document.createElement("script");
      a.src = "vendor/katex/auto-render.min.js";
      a.onload = () => resolve();
      a.onerror = () => resolve();
      document.head.appendChild(a);
    };
    s.onerror = () => resolve(); // degrade gracefully: math stays as $...$ source
    document.head.appendChild(s);
  });
  return _katexPromise;
}

// X2: bookmarked badge padlock icon (no PBP_ICONS entry for this yet — kept
// local to md-preview.js rather than growing shared.js's icon bank for one
// consumer). Same style budget as PBP_ICONS entries in shared.js: viewBox
// 0 0 16 16, stroke currentColor, aria-hidden (a11y label lives on the
// wrapping span in renderBookmarkBadge, not the SVG itself).
const PBP_BOOKMARK_LOCK_SVG = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3.5" y="7" width="9" height="6.5" rx="1.3"/><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7"/></svg>';

// Pure: turns the background.js mdPreviewBookmarkInfo response into the
// badge's render model. No DOM/chrome access — kept side-effect-free even
// though md-preview.js has no test harness to exercise it directly (the
// file's top-level IIFE below depends on chrome.storage/real DOM ids, so
// it isn't loaded by tests/md-ai-tests.html; see the task note).
function pbpBuildBookmarkBadgeModel(resp) {
  if (!resp || resp.bookmarked !== true) return { show: false, tagsShown: [], tagsFull: "", isPrivate: false };
  const tagsFull = typeof resp.tags === "string" ? resp.tags.trim() : "";
  const tagsShown = tagsFull ? tagsFull.split(/\s+/).slice(0, 3) : [];
  return { show: true, tagsShown, tagsFull, isPrivate: resp.shared === "no" };
}

// Builds the bookmarked-badge DOM from a mdPreviewBookmarkInfo response and
// inserts it right after #preview-url. No-op when the model says not to
// show (unbookmarked / offline / no token / any exception — all collapse
// to {bookmarked:false} in background.js, so this silently does nothing).
// Tags are remote data (Pinboard-stored, not this extension's own strings)
// so they're only ever set via textContent/title, never innerHTML.
function renderBookmarkBadge(resp, url) {
  const model = pbpBuildBookmarkBadgeModel(resp);
  if (!model.show) return;
  const urlEl = document.getElementById("preview-url");
  if (!urlEl || !urlEl.parentNode) return;

  const a = document.createElement("a");
  a.className = "bookmark-badge";
  a.href = "https://pinboard.in/add?url=" + encodeURIComponent(url);
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  // Spec X2 i18n key group: an explicit aria-label on the anchor becomes the
  // ENTIRE accessible name (descendants are not traversed), so the private
  // state must be folded in here — the lock span's own aria-label below is
  // never announced through the anchor (it keeps its title tooltip only).
  a.setAttribute("aria-label",
    t("mdBookmarkedBadge") + (model.isPrivate ? ", " + t("mdBookmarkedPrivate") : ""));

  const icon = document.createElement("span");
  icon.className = "bb-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = PBP_ICONS.pin; // shared.js icon bank — fixed literal, no interpolation
  a.appendChild(icon);

  const label = document.createElement("span");
  label.textContent = t("mdBookmarkedBadge");
  a.appendChild(label);

  if (model.tagsShown.length) {
    const tagsEl = document.createElement("span");
    tagsEl.className = "bb-tags";
    tagsEl.textContent = model.tagsShown.join(" "); // remote data -> textContent only
    tagsEl.title = model.tagsFull;                  // full tag string, remote data -> title attr only
    a.appendChild(tagsEl);
  }

  if (model.isPrivate) {
    const lock = document.createElement("span");
    lock.className = "bb-lock";
    lock.setAttribute("role", "img");
    lock.setAttribute("aria-label", t("mdBookmarkedPrivate"));
    lock.title = t("mdBookmarkedPrivate");
    lock.innerHTML = PBP_BOOKMARK_LOCK_SVG; // fixed literal, no interpolation
    a.appendChild(lock);
  }

  urlEl.insertAdjacentElement("afterend", a);
}

// ============================================================
// Rail accordion (spec: docs/superpowers/specs/2026-07-04-md-preview-hl-
// notebook-rail-design.md). pbpRailCollapseState is PURE (no DOM/chrome).
// pbpRailCollapsible touches DOM + chrome.storage.local, but (like
// renderBookmarkBadge above) only inside functions invoked at call time --
// defining it here has no side effect. tests/md-ai-tests.html loads this
// whole file on file:// (the boot IIFE above early-returns without chrome),
// so both are directly unit-testable.
// ============================================================
const PBP_RAIL_STORAGE_KEY = "pbp_rail_collapse";

// Merge stored collapse-state against a defaults map: only defaults' own
// keys are read (unknown keys in stored are dropped), a missing/non-boolean
// value for a key falls back to defaults, and a non-object/null stored
// value yields defaults untouched. `defaults` may carry 1 key (a single
// section's own call) or all 5 (tests, or a hypothetical bulk read).
function pbpRailCollapseState(stored, defaults) {
  const out = {};
  const src = (stored && typeof stored === "object") ? stored : {};
  for (const k of Object.keys(defaults || {})) {
    out[k] = typeof src[k] === "boolean" ? src[k] : !!defaults[k];
  }
  return out;
}

// Read-modify-write a single key into the shared storage object so one
// section's toggle never clobbers another's remembered state. Best-effort:
// any failure (including no chrome.storage at all) degrades silently.
function _pbpRailPersist(key, collapsed) {
  if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return;
  chrome.storage.local.get(PBP_RAIL_STORAGE_KEY).then((r) => {
    const cur = (r && typeof r[PBP_RAIL_STORAGE_KEY] === "object" && r[PBP_RAIL_STORAGE_KEY]) || {};
    const next = Object.assign({}, cur, { [key]: collapsed });
    return chrome.storage.local.set({ [PBP_RAIL_STORAGE_KEY]: next });
  }).catch(() => {});
}

// Installs a collapsible header on sectionEl. opts: {label: string|Element,
// count?: () => string|null, defaultCollapsed: boolean}.
//
// opts.count is read ONCE here to seed the header badge span (class
// .rail-sec-count). It is NOT re-polled by this engine -- a section whose
// count changes over its lifetime (the hl notebook) keeps the badge live by
// writing .rail-sec-count.textContent itself on each re-render (Task 3),
// exactly as md-translate.js writes .rail-sec-progress for the tr mini-count.
//
// HEADLESS MODE: when opts.label is an Element that is sectionEl's ONLY
// child, there is no separate content to hide (ask-section's sole content
// IS its entry button, whose aria-expanded/aria-controls already correctly
// describe "is the thing I control -- #ask-panel -- visible", which for a
// one-row section already means exactly the same thing as "is this section
// expanded"). In that case pbpRailCollapsible does NOT touch the element's
// classes/attributes at all -- any DOM change here would either duplicate
// or fight that pre-existing, already-correct wiring. It only returns the
// storage-backed expand/collapse/isCollapsed trio (collapse()/persisted
// expand() DO write pbp_rail_collapse for interface conformance, but have
// no visible effect since there is nothing to show/hide).
//
// NORMAL MODE (Export/TOC/tr/hl): opts.label is a plain string or a plain
// non-interactive label element. A new <button class="rail-sec-head">
// replaces it in place (same text, optional data-i18n carried over so live
// language switches keep working, optional count badge, a CSS-triangle
// indicator, an always-present-but-empty mini-progress slot, and
// aria-expanded/aria-controls pointing at sectionEl's own id -- assigned
// one if it doesn't have one). Collapsing toggles sectionEl.classList
// "rail-collapsed"; CSS (`.rail-collapsed > *:not(.rail-sec-head)`) hides
// every OTHER direct child, so anything appended to sectionEl LATER (a
// progress span, the view-toggle wrap, a usage line) is automatically
// covered without pbpRailCollapsible tracking a separate content-wrapper
// reference.
function pbpRailCollapsible(sectionEl, key, opts) {
  opts = opts || {};
  const headless = opts.label instanceof Element
    && sectionEl.children.length === 1
    && sectionEl.children[0] === opts.label;
  let collapsed = !!opts.defaultCollapsed;
  let headBtn = null;
  // Set true by a user click or an explicit expand()/collapse() call (e.g. Task 2's
  // cache-restore auto-expand). Once true, the async storage catch-up below never
  // applies its correction -- otherwise a toggle landing between install and the
  // chrome.storage.local.get() resolving gets silently reverted by a stale read.
  let overridden = false;

  function applyDom(next) {
    sectionEl.classList.toggle("rail-collapsed", next);
    if (headBtn) headBtn.setAttribute("aria-expanded", next ? "false" : "true");
  }

  function setState(next, persist) {
    collapsed = next;
    if (!headless) applyDom(next);
    if (persist) _pbpRailPersist(key, next);
  }

  if (!headless) {
    const existingLabelEl = (opts.label instanceof Element) ? opts.label : null;
    const labelText = existingLabelEl ? existingLabelEl.textContent : String(opts.label || "");
    const dataI18n = (existingLabelEl && existingLabelEl.getAttribute)
      ? existingLabelEl.getAttribute("data-i18n") : null;

    headBtn = document.createElement("button");
    headBtn.type = "button";
    headBtn.className = "rail-sec-head";

    const tri = document.createElement("span");
    tri.className = "rail-sec-tri";
    tri.setAttribute("aria-hidden", "true");
    headBtn.appendChild(tri);

    const labelSpan = document.createElement("span");
    labelSpan.className = "rail-sec-label";
    labelSpan.textContent = labelText;
    if (dataI18n) labelSpan.setAttribute("data-i18n", dataI18n);
    headBtn.appendChild(labelSpan);

    if (typeof opts.count === "function") {
      const c = opts.count();
      if (c != null) {
        const countSpan = document.createElement("span");
        countSpan.className = "rail-sec-count";
        countSpan.textContent = c;
        headBtn.appendChild(countSpan);
      }
    }

    const prog = document.createElement("span");
    prog.className = "rail-sec-progress";
    headBtn.appendChild(prog);

    if (!sectionEl.id) sectionEl.id = "rail-sec-" + key;
    headBtn.setAttribute("aria-controls", sectionEl.id);

    if (existingLabelEl) existingLabelEl.replaceWith(headBtn);
    else sectionEl.insertBefore(headBtn, sectionEl.firstChild);

    headBtn.addEventListener("click", () => { overridden = true; setState(!collapsed, true); });

    // Apply the default SYNCHRONOUSLY, before the async storage read below.
    // chrome.storage.local.get() is a real IPC round-trip in the extension
    // (not a same-tick resolved promise) -- without this, every collapsed-
    // by-default section (Export, tr) would render fully expanded for at
    // least one frame then visibly snap shut once the promise resolves.
    // `collapsed` already equals `!!opts.defaultCollapsed` at this point
    // (see its declaration above), so this paints the common case (no
    // stored override, or an override that matches the default) with zero
    // flash; only a genuinely different stored value causes the async
    // branch below to fix it up with one visible re-toggle.
    applyDom(collapsed);
  }

  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(PBP_RAIL_STORAGE_KEY).then((r) => {
      if (overridden) return; // a click or expand()/collapse() already set the authoritative state -- don't fight it
      const merged = pbpRailCollapseState(r && r[PBP_RAIL_STORAGE_KEY], { [key]: !!opts.defaultCollapsed });
      if (merged[key] !== collapsed) setState(merged[key], false);
    }).catch(() => {});
  }

  return {
    expand(temp) { overridden = true; setState(false, !temp); },
    collapse() { overridden = true; setState(true, true); },
    isCollapsed() { return collapsed; },
  };
}

// ============================================================
// Color scheme (spec: docs/superpowers/specs/2026-07-04-md-preview-color-
// scheme-design.md). optTheme ("dark"|"light"|"auto") forces the preview
// page's color-scheme, overriding the CSS default of following the
// system (:root { color-scheme: light dark } + light-dark() tokens in
// md-preview.css). The two hljs <link>s' media attribute is the one
// thing light-dark() cannot drive (their media query targets the OS's
// prefers-color-scheme, not the page's color-scheme property) -- a
// forced mode rewrites it directly: the "off" sheet gets media="not all"
// (never matches, but the stylesheet stays in the DOM so nothing else
// has to change) and the wanted one gets media="all". "auto" restores
// the literal media strings md-preview.html ships with.
// pbpResolveColorScheme is PURE (no DOM/chrome) -- unit-tested in
// tests/md-ai-tests.html. md-preview-theme-early.js carries its own tiny
// copy of this same pair (it must run standalone, before this deferred
// file loads) -- see that file's header comment.
// ============================================================
// Must mirror the literal media attributes on the two hljs <link>s in
// md-preview.html (lines 8-9) -- "auto" mode restores exactly these.
const PBP_HLJS_AUTO_LIGHT_MEDIA = "(prefers-color-scheme: light)";
const PBP_HLJS_AUTO_DARK_MEDIA = "(prefers-color-scheme: dark)";

function pbpResolveColorScheme(mode) {
  if (mode === "dark") return { colorScheme: "dark", lightMedia: "not all", darkMedia: "all" };
  if (mode === "light") return { colorScheme: "light", lightMedia: "all", darkMedia: "not all" };
  return { colorScheme: "", lightMedia: PBP_HLJS_AUTO_LIGHT_MEDIA, darkMedia: PBP_HLJS_AUTO_DARK_MEDIA };
}

function pbpApplyColorScheme(mode) {
  try {
    const r = pbpResolveColorScheme(mode);
    document.documentElement.style.colorScheme = r.colorScheme;
    const lightLink = document.getElementById("hljs-light-link");
    const darkLink = document.getElementById("hljs-dark-link");
    if (lightLink) lightLink.media = r.lightMedia;
    if (darkLink) darkLink.media = r.darkMedia;
  } catch (_) { /* degrade: leave the system-following CSS default in place */ }
}

(async function () {
  initI18n();
  applyI18n();
  document.documentElement.lang = uiLangToBCP47(); // UI-locale font for the rail/UI chrome
  // file://-safe bailout: tests/md-ai-tests.html loads this whole file (deferred
  // scripts, no extension context) to reach pbpRailCollapseState/pbpRailCollapsible
  // below -- neither needs anything past this point. Mirrors the same typeof-chrome
  // guard already used for md-highlight.js's top-level chrome.storage.onChanged wiring.
  if (typeof chrome === "undefined" || !chrome.storage) return;

  // optTheme: authoritative confirmation pass. md-preview-theme-early.js already
  // applied a best-effort guess (localStorage mirror) before first paint; this read
  // is the real chrome.storage source of truth, run as early as possible (before
  // extraction/render below) so it never lags behind on a slow page. Own try/catch
  // (must never block the render path on a settings hiccup) -- degrades to whatever
  // the early script (or the CSS default) already set. storage.onChanged keeps an
  // already-open preview in sync when optTheme changes in Options (same dynamic
  // sync/local area handling as md-translate.js's translateTargetLang listener).
  try {
    const settingsArea = await getSettingsStorage();
    const { optTheme } = await settingsArea.get({ optTheme: "auto" });
    pbpApplyColorScheme(optTheme);
  } catch (_) { /* degrade: leave whatever md-preview-theme-early.js (or the CSS default) set */ }
  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if ((area !== "sync" && area !== "local") || !changes.optTheme) return;
      pbpApplyColorScheme(changes.optTheme.newValue);
    });
  }

  // Per-tab token key: the opener (popup / shortcut) minted ?k=<uuid> and wrote the
  // payload to md_preview_data_<uuid>, so this tab reads ONLY its own slot and can't
  // be clobbered by a concurrent preview. No k = a pre-update tab → fall back to the
  // legacy global key so it still opens.
  const k = new URLSearchParams(location.search).get("k");
  const MP_KEY = k ? "md_preview_data_" + k : "md_preview_data";
  // Read preview data from storage
  const data = await chrome.storage.local.get(MP_KEY);
  const info = data[MP_KEY];
  if (!info) {
    renderEmptyState(t("mdPreviewEmpty"));
    return;
  }
  // Clear temporary data — but KEEP a pending/restore placeholder so a manual reload
  // during extraction (or before it retriggers, on F5 / Memory Saver discard) re-drives
  // it instead of hitting the empty state (the reextract success path overwrites
  // md_preview_data with the full payload, which that load then clears).
  if (!info.pending && !info.restore) {
    await chrome.storage.local.remove(MP_KEY);
  }

  const { contentHtml, title, url, tokens, source } = info;
  const srcTabId = info.tabId;
  const baseUrl = info.baseUrl || url || "";
  const tags = Array.isArray(info.tags) ? info.tags : [];
  const description = info.description || "";
  // X4: raw metadata transported by popup.js/background.js's widened
  // extraction payload. Gated by buildMeta()'s exportSettings.mdExportExtendedMeta
  // check (design spec 4.2) -- this file only reads them here; T4's buildMeta()
  // consumes these consts by closure (same scope as `description` above).
  const author = info.author || "";
  const published = info.published || "";
  const site = info.site || "";
  const image = info.image || "";

  // Engine-switch plumbing, hoisted above the pending-extraction branch so a failed
  // shortcut/reload attempt can offer a working Defuddle<->Jina escape hatch (below)
  // instead of only the later "switch engine on an already-rendered article" control
  // that reuses these same functions/elements further down.
  const sourceEl = document.getElementById("source-badge");
  const engineStatusEl = document.getElementById("engine-status");
  const srcUrlForSwitch = url || "";
  function setEngineStatus(text, isError) {
    if (!engineStatusEl) return;
    engineStatusEl.textContent = text || "";
    engineStatusEl.classList.toggle("error", !!isError);
  }
  function engineLabel(e) { return e === "jina" ? "Jina Reader" : "Defuddle"; }
  function engineUnavailable(e) {
    if (e === "jina") return !/^https?:\/\//i.test(srcUrlForSwitch);
    return !srcTabId; // local needs the source tab
  }
  function friendlyEngineErr(r) {
    const code = r && r.error;
    if (code === "tab_unavailable" || code === "tab_navigated") return t("mdEngineTabGone");
    if (code === "empty") return t("mdPreviewNoContent");
    // "network" covers both this file's own sendMessage-throw catches (below,
    // and the engine-switch handler further down) and jina.js's fetch-TypeError
    // classification relayed unchanged through background.js — otherwise every
    // offline failure fell into the generic mdEngineExtractFailed bucket,
    // indistinguishable from a bad API key or a dead Jina service (D4-2).
    if (code === "network") return t("pinboardErrorOffline");
    return t("mdEngineExtractFailed");
  }
  function applyAvailability(curEngine) {
    if (!sourceEl) return;
    sourceEl.querySelectorAll(".src-seg").forEach((seg) => {
      const e = seg.getAttribute("data-engine");
      const active = e === curEngine;
      const unavail = engineUnavailable(e) && !active;
      seg.classList.toggle("active", active);
      seg.setAttribute("aria-pressed", active ? "true" : "false");
      seg.disabled = unavail;
      if (unavail) seg.setAttribute("aria-disabled", "true");
      else seg.removeAttribute("aria-disabled");
      if (!active && !unavail) seg.title = t("mdEngineSwitchTo", engineLabel(e));
      else if (unavail && e === "local") seg.title = t("mdEngineTabGone");
      else seg.removeAttribute("title");
    });
  }

  // Shortcut opens the preview INSTANTLY with a pending placeholder, then the
  // preview drives extraction via the reextract path (so the tab appears immediately
  // even when Jina needs a network round-trip). On success the SW has written the
  // full md_preview_data, so we reload into the normal render path.
  if (info.pending || info.restore) {
    const titleEl0 = document.getElementById("preview-title");
    if (titleEl0) { titleEl0.textContent = title || t("mdPreviewUntitled"); titleEl0.title = title || ""; }
    document.title = (title || "Markdown") + " — " + t("mdStripPreview");

    // One function drives the initial attempt, the error state's retry button, and the
    // rail's engine-switch badge clicks — all funnel back through the same
    // reextractMarkdown message, never a separate channel.
    let attemptedEngine = info.engine;
    let inFlight = false;
    async function attemptExtract(engine) {
      inFlight = true;
      attemptedEngine = engine;
      applyAvailability(engine);
      renderLoadingState(
        t("mdEngineExtracting", engineLabel(engine)),
        engine === "jina" ? t("mdEngineExtractingNoteJina") : ""
      );
      let pr;
      try {
        pr = await chrome.runtime.sendMessage({
          type: "reextractMarkdown", tabId: srcTabId, url, engine, tags, description: "", k
        });
      } catch (_) { pr = { ok: false, error: "network" }; }
      inFlight = false;
      if (pr && pr.ok) { location.reload(); return; }
      renderErrorState(friendlyEngineErr(pr), () => attemptExtract(attemptedEngine));
      applyAvailability(attemptedEngine);
    }
    if (sourceEl) {
      sourceEl.querySelectorAll(".src-seg").forEach((seg) => {
        seg.addEventListener("click", () => {
          const e = seg.getAttribute("data-engine");
          if (inFlight || e === attemptedEngine || seg.disabled) return;
          attemptExtract(e);
        });
      });
    }
    await attemptExtract(info.engine); // awaited so a synchronous throw here still reaches the IIFE's top-level .catch()
    return;
  }
  // Canonical Markdown: Defuddle HTML -> Turndown; Jina already gives MD.
  // Single source of truth for Raw view, Copy MD, Download .md, and Rendered.
  const canonicalMarkdown = info.markdown || (contentHtml ? htmlToMarkdown(contentHtml, { baseUrl }) : "");
  function getMarkdown() { return canonicalMarkdown; }
  if (!canonicalMarkdown.trim()) {
    renderEmptyState(t("mdPreviewNoContent"));
    return;
  }

  // Reload/Memory-Saver recovery: replace the (now redundant) full payload with a
  // lightweight restore record — url/tabId/engine/tags, NO markdown/contentHtml (avoids
  // storage.local quota on huge articles) — so a later reload rebuilds the article via
  // the SAME reextractMarkdown path the engine-switch control uses (below), instead of
  // landing on the "no preview data" empty state. Best-effort: a write failure just
  // degrades to the pre-existing behavior (empty state on the next reload).
  try {
    await chrome.storage.local.set({
      [MP_KEY]: { restore: true, url, tabId: srcTabId, engine: source === "jina" ? "jina" : "local", tags, ts: Date.now() }
    });
  } catch (_) { /* degrade to current behavior: next reload hits the empty state */ }

  // Export-options defaults from settings (per-export overridable via the header row).
  // Read from the SAME storage area options.js writes to: sync when the user enabled
  // sync, else local (the default). md-preview.html loads shared.js for
  // SETTINGS_DEFAULTS/deobfuscate helpers, but md-preview.* and md-*.js still use
  // native document.getElementById by convention. Reading chrome.storage.sync directly
  // would miss every customization for the default (sync-off) user — including the
  // obsidianEnabled gate, the vault/folder, and the frontmatter/image/TOC defaults.
  const EXPORT_SETTINGS_DEFAULTS = {
    mdExportFrontmatter: true,
    mdExportImagePolicy: "keep",
    mdExportIncludeToc: false,
    mdExportIncludeHighlights: true,
    mdExportExtendedMeta: true,
    obsidianEnabled: false,
    obsidianVault: "",
    obsidianFolder: "",
    exportTargets: {}
  };
  // Own try/catch: a storage read failure here (sync quota hiccup, corrupt area, etc.)
  // must degrade to defaults rather than propagate and blank the whole article — the
  // extraction above already succeeded and there's real content ready to render.
  let exportSettings = EXPORT_SETTINGS_DEFAULTS;
  try {
    const { optSyncEnabled } = await chrome.storage.local.get({ optSyncEnabled: false });
    const settingsArea = optSyncEnabled ? chrome.storage.sync : chrome.storage.local;
    window.pbpSettingsArea = settingsArea;
    exportSettings = await settingsArea.get(EXPORT_SETTINGS_DEFAULTS);
    exportSettings = await pbpApplySecretOverlay(exportSettings); // shared.js IS loaded here -- see html script tags
  } catch (_) {
    window.pbpSettingsArea = chrome.storage.local; // degrade: default area + defaults
  }
  const expFrontmatter = document.getElementById("exp-frontmatter");
  const expImagePolicy = document.getElementById("exp-image-policy");
  const expIncludeToc = document.getElementById("exp-include-toc");
  const expIncludeHl = document.getElementById("exp-include-hl");
  if (expFrontmatter) expFrontmatter.checked = !!exportSettings.mdExportFrontmatter;
  if (expImagePolicy) expImagePolicy.value = exportSettings.mdExportImagePolicy || "keep";
  if (expIncludeToc) expIncludeToc.checked = !!exportSettings.mdExportIncludeToc;
  if (expIncludeHl) expIncludeHl.checked = !!exportSettings.mdExportIncludeHighlights;

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function todayIso() {
    const d = new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  const clippedDate = todayIso();
  // Shared export metadata + per-export option resolution (used by Copy/Download MD and Download .html).
  function buildMeta() {
    const meta = {
      title: title || "",
      url: url || "",
      date: clippedDate,
      tags,
      source: source === "jina" ? "jina" : "defuddle"
    };
    if (description) meta.description = description;
    // X4: extended metadata (author/published/site/image/words), gated by the
    // mdExportExtendedMeta setting (default on). Off -> meta stays exactly the
    // six keys above, byte-identical to pre-X4 exports (spec invariant 1).
    // author/published/site/image below are the outer-scope consts Task 3
    // declared off `info` (same closure as `description` above) -- reused here,
    // not re-read from `info.*` a second time.
    if (exportSettings.mdExportExtendedMeta !== false) {
      const trimmedAuthor = author.trim();
      if (trimmedAuthor) meta.author = trimmedAuthor.slice(0, 200);
      let resolvedSite = site.trim();
      if (!resolvedSite) {
        try { resolvedSite = new URL(url).hostname; } catch (_) { resolvedSite = ""; }
      }
      if (resolvedSite) meta.site = resolvedSite.slice(0, 200);
      const publishedDate = publishedIso(published);
      meta.date = publishedDate || "";
      if (publishedDate) meta.published = publishedDate;
      meta.clipped = clippedDate;
      if (image) meta.image = image;
      const stats = readingStats(getViewMarkdown());
      meta.words = stats.words + stats.cjkChars;
    }
    return meta;
  }
  function buildExportOpts() {
    return {
      frontmatter: expFrontmatter ? expFrontmatter.checked : !!exportSettings.mdExportFrontmatter,
      imagePolicy: expImagePolicy ? expImagePolicy.value : (exportSettings.mdExportImagePolicy || "keep"),
      includeToc: expIncludeToc ? expIncludeToc.checked : !!exportSettings.mdExportIncludeToc,
      // Same gate as the live-preview KaTeX pass below (info.math) — composeStyledHtml
      // only attempts renderMathInElement when this is true (audit E3 gap).
      math: !!info.math,
      // H2 export (md-highlight.js, loaded after this file — guarded because
      // buildExportOpts() only runs from click handlers, long after every deferred
      // script has executed; the typeof check just protects against md-highlight.js
      // failing to load at all). Unchecking exp-include-hl drops BOTH the inline
      // ==marks== and the "## Highlights" section (composeExport already skips
      // both for an empty array).
      highlights: (expIncludeHl ? expIncludeHl.checked : !!exportSettings.mdExportIncludeHighlights)
        ? ((typeof pbpHlCurrentItems === "function") ? pbpHlCurrentItems() : [])
        : [],
      // H5 (spec 1.6): which translation view the highlights are exported for,
      // read off the body class _pbpTrSetMode toggles (tr-only / tr-bilingual).
      hlView: document.body.classList.contains("tr-only") ? "tr"
        : (document.body.classList.contains("tr-bilingual") ? "bilingual" : "orig")
    };
  }
  // Raw view markdown, following the translation view: md-translate.js sets
  // window.pbpViewMarkdown when the view is bilingual/translated-only; it
  // returns null (or is undefined) for the original view. No frontmatter/
  // imagePolicy/TOC applied yet — composeExport/composeStyledHtml do that.
  function getViewMarkdown() {
    const viewMd = (typeof window.pbpViewMarkdown === "function") ? window.pbpViewMarkdown() : null;
    return viewMd || getMarkdown();
  }
  function buildExportMarkdown() {
    return composeExport(getViewMarkdown(), buildMeta(), buildExportOpts());
  }

  // Fill header
  const previewTitleEl = document.getElementById("preview-title");
  previewTitleEl.textContent = title || t("mdPreviewUntitled");
  previewTitleEl.title = title || t("mdPreviewUntitled");
  const urlEl = document.getElementById("preview-url");
  urlEl.textContent = url || "";
  urlEl.href = url || "#";

  // X2: bookmarked badge. Fire-and-forget against the same checkBookmarked/
  // statusCache the toolbar icon uses (background.js) — never blocks first
  // paint. Skipped entirely when there's no URL to look up; every failure
  // path (offline/no token/exception) resolves to {bookmarked:false} in the
  // handler, so renderBookmarkBadge's model.show stays false and nothing
  // renders — no console noise, no visible error state.
  if (url) {
    chrome.runtime.sendMessage({ type: "mdPreviewBookmarkInfo", url })
      .then((resp) => renderBookmarkBadge(resp, url))
      .catch(() => {});
  }

  const tokenEl = document.getElementById("token-count");
  if (source === "jina" && tokens && info.hasApiKey) {
    tokenEl.textContent = t("mdStatTokens", String(tokens));
  } else {
    tokenEl.style.display = "none";
  }
  const curEngine = source === "jina" ? "jina" : "local";
  let switching = false;

  if (sourceEl) {
    applyAvailability(curEngine);
    sourceEl.querySelectorAll(".src-seg").forEach((seg) => {
      seg.addEventListener("click", async () => {
        const e = seg.getAttribute("data-engine");
        if (switching || e === curEngine || seg.disabled) return;
        switching = true;
        sourceEl.setAttribute("aria-busy", "true");
        sourceEl.querySelectorAll(".src-seg").forEach((s) => { s.disabled = true; });
        seg.classList.add("loading");
        setEngineStatus(t("mdEngineExtracting", engineLabel(e)), false);
        let r;
        try {
          r = await chrome.runtime.sendMessage({
            type: "reextractMarkdown",
            tabId: srcTabId, url: srcUrlForSwitch, engine: e,
            tags, description, k
          });
        } catch (_) { r = { ok: false, error: "network" }; }
        if (r && r.ok) { location.reload(); return; }
        // failure: keep current content, restore the control
        switching = false;
        sourceEl.removeAttribute("aria-busy");
        seg.classList.remove("loading");
        applyAvailability(curEngine);
        setEngineStatus(friendlyEngineErr(r), true);
        if (e === "local" && r && (r.error === "tab_unavailable" || r.error === "tab_navigated")) {
          const localSeg = sourceEl.querySelector('.src-seg[data-engine="local"]');
          if (localSeg) {
            localSeg.disabled = true;
            localSeg.setAttribute("aria-disabled", "true");
            localSeg.title = t("mdEngineTabGone");
          }
        }
      });
    });
  }
  document.title = `${title || "Markdown"} — ${t("mdStripPreview")}`;

  // Reading stats (header) — computed from canonical Markdown
  const statsEl = document.getElementById("reading-stats");
  if (statsEl) {
    const stats = readingStats(getMarkdown());
    const wordLabel = stats.cjkChars > 0
      ? `${t("mdStatWords", stats.words.toLocaleString())} · ${t("mdStatCjk", stats.cjkChars.toLocaleString())}`
      : t("mdStatWords", stats.words.toLocaleString());
    const statBase = `${wordLabel} · ${t("mdStatMin", String(stats.minutes))}`;
    let statTick = false;
    const renderStats = () => {
      statTick = false;
      const doc = document.documentElement;
      const pct = readingProgressPercent(window.scrollY, window.innerHeight, doc.scrollHeight);
      statsEl.textContent = `${statBase} · ${pct}%`;
    };
    const queueStats = () => {
      if (statTick) return;
      statTick = true;
      requestAnimationFrame(renderStats);
    };
    renderStats();
    window.addEventListener("scroll", queueStats, { passive: true });
    window.addEventListener("resize", queueStats);
  }

  // Single render path: canonical Markdown -> marked() -> DOMPurify -> innerHTML.
  // renderMarkdown() is now the lone sanitize point (XSS closed here).
  const renderedView = document.getElementById("rendered-view");
  let renderedHtml = renderMarkdown(canonicalMarkdown);
  // Lazy-load images / async decode (sanitizer keeps these attributes).
  renderedHtml = renderedHtml.replace(/<img(?=\s)/gi, '<img loading="lazy" decoding="async"');
  renderedView.innerHTML = renderedHtml;
  // Forum pages + any page with a nested blockquote: split into per-comment blocks
  // BEFORE the AI layer indexes (pbp:rendered). Structural detection (blockquote blockquote)
  // means Reddit and similar pages benefit without a per-site rule. Single-level quotes
  // are untouched. canonicalMarkdown (export/Copy/Raw) is unaffected — DOM-only.
  if (typeof pbpForumShouldMark === "function" && pbpForumShouldMark(info, renderedView) && typeof pbpForumMarkComments === "function") pbpForumMarkComments(renderedView);
  const _articleLang = detectArticleLang(canonicalMarkdown);
  if (_articleLang) renderedView.lang = _articleLang; // article-script font for the reading content
  // D9-3: RTL article -> container-level dir so blockquote/list/TOC physical
  // direction CSS mirrors along with the text (renderedView is fresh DOM per
  // page load — no stale dir from a prior render to clear on the LTR path).
  if (_articleLang === "ar" || _articleLang === "he") renderedView.dir = "rtl";
  // Syntax highlighting is OFF the critical first-paint path: the article paints
  // immediately, then — only if it actually contains code — highlight.js is lazy-loaded
  // and applied after paint (rAF). Avoids blocking the page on a 122KB compile + a
  // synchronous whole-document highlight pass (the cold-load spinner).
  if (renderedView.querySelector("pre > code")) {
    requestAnimationFrame(() => { ensureHljs().then(() => highlightCodeBlocksChunked(renderedView)); });
  }
  // Math rendering — ONLY for LaTeX-bearing content (info.math, e.g. arXiv). Gating on
  // the flag (not just a "$") keeps KaTeX off every other page so currency like "$5"
  // is never mangled. Off the first-paint path (rAF), degrades to $...$ source on error.
  if (info.math && /\$/.test(renderedView.textContent)) {
    requestAnimationFrame(() => ensureKatex().then(() => {
      if (typeof renderMathInElement === "function") {
        try {
          renderMathInElement(renderedView, {
            delimiters: [{ left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false }],
            throwOnError: false
          });
        } catch (_) { /* leave $...$ source visible on failure */ }
      }
    }));
  }

  // ---- Build TOC sidebar from the canonical markdown ----
  const tocNav = document.getElementById("toc");
  const tocList = document.getElementById("toc-list");
  // Rail accordion (spec 2026-07-04): install regardless of whether headings
  // exist below -- #toc's own [hidden] gate (unset only inside the
  // headings.length branch) stays the orthogonal "does a TOC exist at all"
  // control; this is "is its content collapsed" and coexists with it.
  pbpRailCollapsible(tocNav, "toc", { label: tocNav.querySelector(".rail-label"), defaultCollapsed: false });
  const expSec = document.getElementById("export-section");
  if (expSec) pbpRailCollapsible(expSec, "export", { label: expSec.querySelector(".rail-label"), defaultCollapsed: true });
  // Walk the already-rendered (and sanitized) headings so each TOC anchor
  // equals a real element id (buildToc's markdown-derived slugs can diverge from
  // marked's rendered ids for headings with inline links/images or duplicates).
  const headings = Array.from(renderedView.querySelectorAll("h2[id], h3[id], h4[id]"))
    .map((el) => ({ level: +el.tagName[1], text: el.textContent, slug: el.id }))
    .filter((h) => h.slug);

  if (headings && headings.length) {
    const frag = document.createDocumentFragment();
    headings.forEach((h) => {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = "#" + h.slug;
      a.textContent = h.text;
      a.dataset.level = String(h.level);
      a.dataset.slug = h.slug;
      li.appendChild(a);
      frag.appendChild(li);
    });
    tocList.appendChild(frag);
    // tr-only view hides the ORIGINAL heading and shows its .pb-tr translation
    // sibling instead (see trOnlyScrollTarget) — the anchor's native #slug jump
    // targets the (display:none) original, which never scrolls (0-size rect).
    // Intercept and redirect to the visible sibling; the id stays owned by the
    // original heading (untouched invariant), only the SCROLL target changes.
    tocList.addEventListener("click", (e) => {
      const a = e.target.closest("a[data-slug]");
      if (!a) return;
      const headEl = renderedView.querySelector("#" + cssEscape(a.dataset.slug));
      if (!headEl) return;
      const target = trOnlyScrollTarget(headEl);
      if (target !== headEl) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
    tocNav.hidden = false;
    setupScrollSpy(renderedView, tocList);
  }
  setupDrawer();

  // Notify the md-ai layer (md-ai-core / md-translate / md-ask) that the
  // article DOM is final. Fires even when the TOC is absent. detail.url is
  // the cache-key source for tr_/ask_/trview_ entries (md_preview_data is
  // already removed from storage at this point; the page holds the markdown
  // in closure and md-ai reads text via the DOM blocks).
  document.dispatchEvent(new CustomEvent("pbp:rendered", { detail: { url, title } }));

  // Raw view populated lazily on first switch

  // View toggle
  const btnRaw = document.getElementById("btn-raw");
  const btnRendered = document.getElementById("btn-rendered");
  const rawView = document.getElementById("raw-view");

  // Reading-position mapping across the switch: Raw (13px <pre>) and Rendered
  // (clamp 17-22px article typography) are the same content at very different
  // heights, so keeping window.scrollY strands the reader. Map by content-block
  // index instead (approximate is fine): find the topmost visible block in the
  // view being LEFT, convert to a fraction of total blocks, land on the same
  // fraction in the view being ENTERED. Indexed lazily via md-ai-core.js's
  // pbpAiIndexBlocks — translate/ask only index when AI is configured, so this
  // can't assume it already ran.
  function pbpScrollMapBlocks() {
    if (typeof pbpAiBlocks !== "function") return [];
    if (!pbpAiBlocks().length && typeof pbpAiIndexBlocks === "function") pbpAiIndexBlocks(renderedView);
    return pbpAiBlocks();
  }

  btnRaw.addEventListener("click", () => {
    const blocks = pbpScrollMapBlocks();
    let frac = null;
    if (blocks.length && !renderedView.classList.contains("hidden")) {
      const idx = blocks.findIndex((b) => trOnlyScrollTarget(b.el).getBoundingClientRect().bottom > 0);
      frac = (idx === -1 ? blocks.length - 1 : idx) / blocks.length;
    }
    if (!rawView.textContent) rawView.textContent = getMarkdown();
    rawView.classList.remove("hidden");
    renderedView.classList.add("hidden");
    btnRaw.classList.add("active");
    btnRendered.classList.remove("active");
    btnRaw.setAttribute("aria-pressed", "true");
    btnRendered.setAttribute("aria-pressed", "false");
    document.body.classList.add("raw-active");
    if (frac !== null) {
      const top = rawView.getBoundingClientRect().top + window.scrollY;
      window.scrollTo(0, top + frac * rawView.scrollHeight);
    }
  });
  btnRendered.addEventListener("click", () => {
    let frac = null;
    if (!rawView.classList.contains("hidden")) {
      const top = rawView.getBoundingClientRect().top + window.scrollY;
      const h = rawView.scrollHeight || 1; // guard: div-by-zero if not yet laid out
      frac = Math.min(Math.max((window.scrollY - top) / h, 0), 0.999);
    }
    renderedView.classList.remove("hidden");
    rawView.classList.add("hidden");
    btnRendered.classList.add("active");
    btnRaw.classList.remove("active");
    btnRendered.setAttribute("aria-pressed", "true");
    btnRaw.setAttribute("aria-pressed", "false");
    document.body.classList.remove("raw-active");
    if (frac !== null) {
      const blocks = pbpScrollMapBlocks();
      if (blocks.length) {
        const idx = Math.min(Math.floor(frac * blocks.length), blocks.length - 1);
        trOnlyScrollTarget(blocks[idx].el).scrollIntoView({ block: "start" });
      }
    }
  });

  // ---- R9: silent scroll-position restore (spec 2) ----
  // Records where the reader was (block index n + fraction scrolled into
  // that block) so a later reopen of the SAME article (exact tab.url string
  // match, same limitation tr_/ask_ caches already accept) lands back there
  // with zero UI. Storage: the generic IDB KV in ai-cache.js, keyed
  // "scroll_" + pbpAiHash(url) -- pbpAiHash/pbpAiBlockEl are defined in
  // md-ai-core.js, which loads AFTER this file (script tag order), hence the
  // typeof guards; pbpAiCacheGet/Set/Delete are in ai-cache.js, which loads
  // BEFORE this file, so those are called ungated (same as md-ai-core.js
  // itself does).
  let _pbpScrollSaveTimer = null;
  // Timestamp (ms, Date.now()) until which the save-side 'scroll' listener
  // below ignores every event entirely (doesn't even arm the debounce).
  // Restore's own scrollIntoView/scrollBy calls fire native 'scroll' events
  // on window exactly like a real user scroll would; without this guard, one
  // of those restore-triggered events can arm the 600ms debounce, which then
  // reads a scrollY that -- because hljs/KaTeX/lazy-image layout can differ
  // slightly between the original save and this reopen -- lands just on the
  // OTHER side of the one-viewport boundary from where it was originally
  // saved, so _pbpReaderSaveScroll silently deletes the very record that was
  // just used to restore. Sole writer: applyRestore() in the rAF block below.
  let _pbpScrollRestoreUntil = 0;

  function _pbpReaderSaveScroll() {
    if (renderedView.classList.contains("hidden")) return; // raw view active: rects would read 0x0
    if (typeof pbpAiHash !== "function") return;
    const key = "scroll_" + pbpAiHash(url);
    if (window.scrollY <= window.innerHeight) {
      // Back inside the first screen: nothing worth restoring, and any
      // earlier deeper-scroll record is now stale -- drop it.
      pbpAiCacheDelete(key).catch(() => {});
      return;
    }
    const blocks = pbpScrollMapBlocks(); // force-index if empty, same defensive call the Raw/Rendered toggle above already makes
    if (!blocks.length) return;
    const rects = blocks.map((b) => trOnlyScrollTarget(b.el).getBoundingClientRect());
    const anchor = typeof pbpReaderPickScrollAnchor === "function" ? pbpReaderPickScrollAnchor(rects) : null;
    if (!anchor) return;
    const ts = Date.now();
    pbpAiCacheSet(key, { n: anchor.n, frac: anchor.frac, ts }, ts).catch(() => {});
  }

  window.addEventListener("scroll", () => {
    if (Date.now() < _pbpScrollRestoreUntil) return; // ignore our own restore's programmatic scroll -- see _pbpScrollRestoreUntil above
    clearTimeout(_pbpScrollSaveTimer);
    _pbpScrollSaveTimer = setTimeout(_pbpReaderSaveScroll, 600);
  }, { passive: true });
  // Best-effort extra flush: pagehide can race an in-flight IDB write (no
  // working precedent anywhere in this codebase for a reliable async write
  // from pagehide -- md-ask.js/md-translate.js's own pagehide handlers only
  // do synchronous ctrl.abort()), so this is a bonus on top of the debounce
  // above, not the primary save path.
  window.addEventListener("pagehide", () => {
    clearTimeout(_pbpScrollSaveTimer);
    _pbpReaderSaveScroll();
  });

  // Restore: after render + two animation frames (one layout pass in) --
  // hljs/KaTeX/lazy images may still shift things later, but the block
  // anchor keeps any resulting error inside one block, not the whole page.
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      if (typeof pbpAiHash !== "function") return;
      const key = "scroll_" + pbpAiHash(url);
      let entry;
      try {
        entry = await pbpAiCacheGet(key);
      } catch (_) {
        return;
      }
      const rec = entry && entry.result;
      if (!rec || !Number.isFinite(rec.n) || rec.n < 1) return;
      if (window.scrollY > 200) return; // reader already scrolled on their own -- don't fight them
      const blocks = pbpScrollMapBlocks();
      if (!blocks.length) return;

      // Resolves rec against the CURRENT view (trOnlyScrollTarget reads
      // document.body's tr-only class live each call) and performs the jump.
      // Factored into a function so it can be re-run once below if the view
      // mode flips shortly after this first call -- see the MutationObserver.
      // Returns false (no-op) if the block no longer exists.
      let restoredAtY = null;
      const applyRestore = () => {
        const blockEl = typeof pbpAiBlockEl === "function" ? pbpAiBlockEl(rec.n) : null;
        if (!blockEl) return false;
        const target = trOnlyScrollTarget(blockEl);
        _pbpScrollRestoreUntil = Date.now() + 1000; // suppress the save listener for this programmatic scroll (both calls below fire native 'scroll' events)
        target.scrollIntoView({ block: "start", behavior: "instant" });
        const frac = Math.min(Math.max(Number(rec.frac) || 0, 0), 1);
        if (frac > 0) {
          const h = target.getBoundingClientRect().height;
          if (h > 0) window.scrollBy(0, frac * h);
        }
        restoredAtY = window.scrollY;
        return true;
      };
      if (!applyRestore()) return;

      // Race guard: md-translate.js's pbpTrInit runs its OWN auto view-restore
      // (rAF-chunked st.work build, THEN an IDB cache probe, THEN -- only on a
      // full cache hit with a persisted tr-only/bilingual view -- _pbpTrSetMode,
      // which is what actually flips document.body's tr-only/tr-bilingual
      // classes) fully asynchronously, on a timeline this double-rAF window is
      // too short to observe. trOnlyScrollTarget above only redirects to the
      // .pb-tr sibling when document.body already carries "tr-only" AT THE
      // MOMENT IT'S CALLED -- so if translate's mode flip lands moments after
      // this restore, the reader was just silently placed on the original
      // block that's about to become display:none. Watch body's class
      // attribute for that flip; if it fires while the reader is still
      // sitting exactly where this restore put them (no manual scroll in
      // between), re-resolve trOnlyScrollTarget against the now-current view
      // and land again -- still silent, still block-anchored, only ever fires
      // once. A real scroll away in the meantime means they're reading; back
      // off and leave them alone.
      let resettled = false;
      // Body's class attribute also flips for unrelated reasons during this
      // window (rail-open, ask-open, ...) -- snapshot the two view-mode
      // classes up front so an unrelated mutation doesn't consume the
      // one-shot re-settle before the real tr-only/tr-bilingual flip shows up.
      const hadTrOnly = document.body.classList.contains("tr-only");
      const hadTrBilingual = document.body.classList.contains("tr-bilingual");
      const mo = new MutationObserver(() => {
        if (resettled) return;
        const nowTrOnly = document.body.classList.contains("tr-only");
        const nowTrBilingual = document.body.classList.contains("tr-bilingual");
        if (nowTrOnly === hadTrOnly && nowTrBilingual === hadTrBilingual) return; // not the flip we're waiting for -- keep observing
        if (restoredAtY === null || Math.abs(window.scrollY - restoredAtY) > 4) { resettled = true; mo.disconnect(); return; }
        resettled = true;
        mo.disconnect();
        applyRestore();
      });
      mo.observe(document.body, { attributes: true, attributeFilter: ["class"] });
      // pbpTrInit's cache probe is a one-shot pass near page boot -- 5s is a
      // generous upper bound even for a very long article, so stop watching
      // well after it could plausibly still be running.
      setTimeout(() => mo.disconnect(), 5000);
    });
  });

  // Copy buttons
  document.getElementById("btn-copy-md").addEventListener("click", async (e) => {
    await copyToClipboard(buildExportMarkdown(), e.currentTarget);
  });
  document.getElementById("btn-copy-html").addEventListener("click", async (e) => {
    // Capture the target BEFORE any await — per DOM spec, currentTarget is nulled
    // once the event dispatch that invoked this listener finishes, and this handler
    // crosses real async boundaries (ensureHljs's script load, loadHljsCss's fetches)
    // before ever touching it. Same fix already applied to btn-copy-md.
    const btn = e.currentTarget;
    // Same content as the HTML download: a complete styled doc that follows the
    // original/bilingual/translation-only view (getViewMarkdown), copied as
    // text — symmetric with Copy MD == Download MD. (Was renderedView.innerHTML,
    // which always carried every .pb-tr block regardless of the selected view.)
    // Pass RAW view markdown (no YAML frontmatter) — composeStyledHtml renders
    // the frontmatter as a styled <header>, so feeding it the YAML-prefixed
    // buildExportMarkdown() would double it into the body as plain text.
    if (renderedView.querySelector("pre > code")) await ensureHljs(); // so composeStyledHtml highlights
    const hljsCss = await loadHljsCss();
    if (info.math) await ensureKatex(); // so composeStyledHtml renders math (mirrors hljs above)
    const katexCss = info.math ? await loadKatexCss() : "";
    const doc = composeStyledHtml(getViewMarkdown(), buildMeta(), { ...buildExportOpts(), hljsCss, katexCss });
    await copyToClipboard(doc, btn);
  });

  // Download buttons
  const safeTitle = safeFilename(title);
  document.getElementById("btn-dl-md").addEventListener("click", () => {
    downloadFile(safeTitle + ".md", buildExportMarkdown(), "text/markdown;charset=utf-8");
  });
  document.getElementById("btn-dl-html").addEventListener("click", async () => {
    if (renderedView.querySelector("pre > code")) await ensureHljs(); // so composeStyledHtml highlights the export
    const hljsCss = await loadHljsCss();
    if (info.math) await ensureKatex(); // so composeStyledHtml renders math (mirrors hljs above)
    const katexCss = info.math ? await loadKatexCss() : "";
    // Follow the original/bilingual/translation-only view like the Markdown export
    // does, but pass RAW view markdown (getViewMarkdown, no YAML frontmatter):
    // composeStyledHtml turns frontmatter into a styled <header>. Passing the
    // YAML-prefixed buildExportMarkdown() rendered the YAML into the body as text.
    const doc = composeStyledHtml(getViewMarkdown(), buildMeta(), { ...buildExportOpts(), hljsCss, katexCss });
    downloadFile(safeTitle + ".html", doc, "text/html;charset=utf-8");
  });

  let _sendMenuCtl = null;
  async function setupSendMenu() {
    const split = document.getElementById("send-split");
    if (!split || typeof PBP_EXPORT_TARGETS === "undefined") return;

    // Live-update: tear down the previous render's persistent (non-menu-item) listeners
    // so a re-render on a settings change doesn't stack duplicate handlers.
    if (_sendMenuCtl) _sendMenuCtl.abort();
    _sendMenuCtl = new AbortController();
    const _sig = _sendMenuCtl.signal;
    // Re-read the send-related settings fresh so an options change (fixed token,
    // enabled/disabled target, changed vault/folder) is reflected WITHOUT reopening the preview.
    try {
      let _fresh = await settingsArea.get({ exportTargets: {}, obsidianEnabled: false, obsidianVault: "", obsidianFolder: "" });
      _fresh = await pbpApplySecretOverlay(_fresh);
      Object.assign(exportSettings, _fresh);
    } catch (_) {}

    // Resolve enabled targets. Back-compat: if exportTargets is empty but the
    // legacy obsidian* settings exist, synthesize the obsidian row so existing
    // users keep one-click Obsidian before they re-open the options page.
    const et = Object.assign({}, exportSettings.exportTargets || {});
    if (!et.obsidian && (exportSettings.obsidianEnabled || exportSettings.obsidianVault || exportSettings.obsidianFolder)) {
      et.obsidian = {
        enabled: !!exportSettings.obsidianEnabled,
        vault: exportSettings.obsidianVault || "",
        folder: exportSettings.obsidianFolder || ""
      };
    }
    const enabledIds = pbpExportTargetIds().filter((id) => et[id] && et[id].enabled);

    const primary = document.getElementById("send-primary");
    const primaryIc = document.getElementById("send-primary-ic");
    const primaryLabel = document.getElementById("send-primary-label");
    const caret = document.getElementById("send-caret");
    const menu = document.getElementById("send-menu");
    const sendStatus = document.getElementById("send-status");
    let sendStatusTimer;
    function showSendStatus(msg, isError, url) {
      if (!sendStatus) return;
      clearTimeout(sendStatusTimer);
      sendStatus.classList.toggle("error", !!isError);
      sendStatus.hidden = false;          // unhide before setting text so aria-live announces it
      sendStatus.textContent = msg;
      let hasLink = false;
      if (url) {
        // href comes from a network JSON response and lands in a privileged
        // extension page — only allow https: (blocks a javascript:/data: sink).
        let safe = "";
        try { if (new URL(url).protocol === "https:") safe = url; } catch (_) {}
        if (safe) {
          hasLink = true;
          if (msg) sendStatus.appendChild(document.createTextNode(" "));
          const a = document.createElement("a");
          a.href = safe;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = t("mdSendViewGist");
          // Let the link open without the parent's dismiss-on-click swallowing it.
          a.addEventListener("click", (e) => e.stopPropagation());
          sendStatus.appendChild(a);
        }
      }
      // Plain messages auto-hide; a status carrying the gist link stays until the
      // next send or a manual click-dismiss — so the sole URL isn't lost on a
      // timer (and a focused link isn't yanked out from under the user).
      if (!hasLink) sendStatusTimer = setTimeout(() => { sendStatus.hidden = true; sendStatus.textContent = ""; }, 6000);
    }
    if (sendStatus) sendStatus.addEventListener("click", () => {
      clearTimeout(sendStatusTimer); sendStatus.hidden = true; sendStatus.textContent = "";
    }, { signal: _sig });

    split.classList.remove("send-empty");
    primary.title = "";
    caret.removeAttribute("hidden");
    menu.setAttribute("hidden", "");
    caret.setAttribute("aria-expanded", "false");

    if (!enabledIds.length) {
      split.classList.add("send-empty");
      primaryIc.innerHTML = "";
      primaryLabel.textContent = t("mdSendToEllipsis");
      caret.setAttribute("hidden", "");
      primary.title = t("mdSendNoneConfigured");
      primary.addEventListener("click", () => chrome.runtime.openOptionsPage(), { signal: _sig });
      return;
    }

    let lastId = await pbpGetLastTarget();
    if (!enabledIds.includes(lastId)) lastId = enabledIds[0];

    function setPrimary(id) {
      const row = PBP_EXPORT_TARGETS[id];
      primary.dataset.targetId = id;
      primaryIc.innerHTML = row.icon;
      primaryLabel.textContent = t("mdSendTo").replace("{name}", row.label);
    }
    setPrimary(lastId);

    let _sending = false;
    async function doSend(id) {
      if (_sending) return;                 // re-entrancy guard: a double-click on a
      _sending = true;                      // slow gist POST must not create two gists
      try {                                 // (the "mdSending" label is the affordance;
        const row = PBP_EXPORT_TARGETS[id]; // not disabling keeps the restored focus, F8)
        setPrimary(id);
        await pbpSetLastTarget(id);
        const _exp = buildExportOpts();
        const _sendBody = composeExport(getViewMarkdown(), buildMeta(), { frontmatter: false, imagePolicy: _exp.imagePolicy, includeToc: _exp.includeToc, highlights: _exp.highlights, hlView: _exp.hlView }); // H5 (spec 1.6): send-to honors the exported view's tri-state too
        primary.classList.add("sending");
        primaryLabel.textContent = t("mdSending");
        let res;
        try {
          res = await pbpSendToTarget(id, { meta: buildMeta(), rawBody: _sendBody, cfg: et[id] });
        } catch (_) {
          res = { ok: false, fellBack: false, error: "" };
        }
        primary.classList.remove("sending");
        setPrimary(id);
        // Non-local http webhook: the Authorization header rides in plaintext
        // (audit #31). Advisory only — never blocks the send (self-hosted/LAN
        // receivers are a legitimate opt-in target).
        const httpWarn = id === "webhook" && typeof pbpWebhookHttpWarn === "function"
          && pbpWebhookHttpWarn((et[id] && et[id].url) || "");
        if (res.ok && !res.fellBack) {
          // token-api (gist/webhook) has a real HTTP receipt -- text unchanged.
          // url-scheme (obsidian) has no receipt: the OS may have silently
          // dropped the open, so the claim is scoped to what's verifiably
          // true ("opened" + "copied"), not "sent".
          if (row.mechanism === "url-scheme") {
            flashButtonLabel(primary, t("mdOpenedApp").replace("{name}", row.label));
            showSendStatus(t("mdSentUrlScheme").replace("{name}", row.label), false);
          } else {
            flashButtonLabel(primary, t("mdSentTo").replace("{name}", row.label));        // short -> button
            if (httpWarn) showSendStatus(t("mdTargetWebhookHttpWarn"), false);
            else if (res.url) showSendStatus(t("mdSentTo").replace("{name}", row.label), false, res.url); // + clickable link
          }
        } else if (res.error === "open-blocked") {
          showSendStatus(t("mdSendOpenBlocked"), true);
        } else if (res.ok) {
          showSendStatus(t("mdSendTooLongFellBack").replace("{name}", row.label), false); // long -> roomy block
        } else if (typeof res.error === "string" && res.error.startsWith("missing:")) {
          showSendStatus(t("mdSendNeedsSetup"), false);
        } else if (res.error === "api-perm") {
          showSendStatus(t("mdSendApiPerm"), true);
        } else if (res.error === "api-down") {
          showSendStatus(t("mdSendApiDown"), true);
        } else if (res.error === "api-token") {
          showSendStatus(t("mdSendApiBadToken"), true);
        } else if (res.error === "api-failed") {
          showSendStatus(t("mdSendApiFailed"), true);
        } else {
          showSendStatus(t("mdSendFailed"), true);
        }
      } finally {
        _sending = false;
      }
    }

    primary.addEventListener("click", () => { if (primary.dataset.targetId) doSend(primary.dataset.targetId); }, { signal: _sig });

    function closeMenu() { menu.setAttribute("hidden", ""); caret.setAttribute("aria-expanded", "false"); }
    function openMenu() {
      menu.removeAttribute("hidden");
      caret.setAttribute("aria-expanded", "true");
      const f = menu.querySelector(".send-mi");
      if (f) f.focus();
    }
    caret.addEventListener("click", (e) => { e.stopPropagation(); menu.hasAttribute("hidden") ? openMenu() : closeMenu(); }, { signal: _sig });
    document.addEventListener("click", (e) => { if (!split.contains(e.target)) closeMenu(); }, { signal: _sig });
    // Keyboard-only close: Tab-ing off the last/first menu item has no click event, so
    // without this the menu stays visually open until the next click-outside or Escape
    // (audit D5-3). relatedTarget is reliable for focus()/Tab moves within the same
    // document; it can be null when focus leaves the document entirely, so fall back to
    // an immediate re-check of document.activeElement once the change has settled.
    menu.addEventListener("focusout", (e) => {
      const next = e.relatedTarget;
      if (next !== null && next !== undefined) {
        if (!split.contains(next)) closeMenu();
        return;
      }
      setTimeout(() => { if (!split.contains(document.activeElement)) closeMenu(); }, 0);
    }, { signal: _sig });
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll(".send-mi")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "Escape") { closeMenu(); caret.focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); (items[i + 1] || items[0]).focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); (items[i - 1] || items[items.length - 1]).focus(); }
    }, { signal: _sig });

    menu.innerHTML = "";
    const ordered = [lastId].concat(enabledIds.filter((id) => id !== lastId)); // last-used pinned on top
    ordered.forEach((id) => {
      const row = PBP_EXPORT_TARGETS[id];
      const item = document.createElement("button");
      item.type = "button";
      item.className = "send-mi";
      item.setAttribute("role", "menuitem");
      item.dataset.targetId = id;
      const ic = document.createElement("span");
      ic.className = "send-mi-ic"; ic.setAttribute("aria-hidden", "true"); ic.innerHTML = row.icon;
      const lb = document.createElement("span");
      lb.textContent = row.label;
      item.appendChild(ic); item.appendChild(lb);
      if (id === lastId) {
        const tag = document.createElement("span");
        tag.className = "send-mi-tag"; tag.textContent = t("mdSendLastUsed");
        item.appendChild(tag);
      }
      // Restore focus to the primary button before the menu collapses, so a
      // keyboard user isn't dropped to <body> (WCAG 2.4.3).
      item.addEventListener("click", () => { closeMenu(); primary.focus(); doSend(id); });
      menu.appendChild(item);
    });

    const foot = document.createElement("button");
    foot.type = "button"; foot.className = "send-mi send-mi-foot"; foot.setAttribute("role", "menuitem");
    foot.textContent = t("mdManageDestinations");
    foot.addEventListener("click", () => { closeMenu(); chrome.runtime.openOptionsPage(); });
    menu.appendChild(foot);
  }

  await setupSendMenu();
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.exportTargets || changes.obsidianEnabled || changes.obsidianVault || changes.obsidianFolder) {
      setupSendMenu();
    }
  });
})().catch((e) => {
  // Top-level backstop: any unhandled throw in the init flow above (malformed HTML into
  // Turndown, a rejected storage read, marked.parse choking on the extracted markdown,
  // etc.) previously left the page mid-render — title/rail filled in, #rendered-view
  // blank, no error text, no aria-busy cleared. Fall back to the empty state instead of
  // a silent half-rendered page.
  console.error("md-preview init failed:", e);
  renderEmptyState(t("mdEngineExtractFailed"));
});

// ---- Copy to clipboard with visual feedback ----
async function copyToClipboard(text, btn) {
  const label = btn.querySelector(".btn-label");
  const setLabel = (s) => { if (label) label.textContent = s; else btn.textContent = s; };
  // Persist the original label ONCE so a re-click within the revert window can't
  // capture "Copied!" as the "original" and freeze the button on success text.
  if (btn._copyOrig == null) btn._copyOrig = label ? label.textContent : btn.textContent;
  const announce = (msg) => { const el = document.getElementById("copy-status"); if (el) el.textContent = msg; };
  clearTimeout(btn._copyTimer);
  try {
    await navigator.clipboard.writeText(text);
    setLabel(t("jinaCopied"));
    btn.classList.add("copied");
    announce(t("jinaCopied"));
  } catch (_) {
    setLabel(t("mdPreviewFailed"));
    announce(t("mdPreviewFailed"));
  }
  btn._copyTimer = setTimeout(() => {
    setLabel(btn._copyOrig);
    btn.classList.remove("copied");
    btn._copyOrig = null;
    announce("");
  }, 1500);
}

// One-shot button feedback: swap the .btn-label to msg + .copied for 1.5s, then
// revert; also announce to the #copy-status live region for screen readers. Uses
// the same re-entry guard as copyToClipboard (persist orig once, clear pending timer).
function flashButtonLabel(btn, msg) {
  const label = btn.querySelector(".btn-label");
  const setLabel = (s) => { if (label) label.textContent = s; else btn.textContent = s; };
  if (btn._copyOrig == null) btn._copyOrig = label ? label.textContent : btn.textContent;
  const el = document.getElementById("copy-status");
  if (el) el.textContent = msg;
  setLabel(msg);
  btn.classList.add("copied");
  clearTimeout(btn._copyTimer);
  btn._copyTimer = setTimeout(() => {
    setLabel(btn._copyOrig);
    btn.classList.remove("copied");
    btn._copyOrig = null;
    if (el) el.textContent = "";
  }, 1500);
}

// renderMarkdown + htmlToMarkdown + safeFilename + downloadFile now live in md-convert.js (single source of truth).

// Inline the vendored hljs theme so the standalone .html highlights offline.
// Light always; dark under a media query. Best-effort: "" if fetch/chrome absent.
async function loadHljsCss() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) return "";
  try {
    const light = await (await fetch(chrome.runtime.getURL("vendor/hljs-github.min.css"))).text();
    let dark = "";
    try { dark = await (await fetch(chrome.runtime.getURL("vendor/hljs-github-dark.min.css"))).text(); } catch (_) {}
    return light + (dark ? "\n@media (prefers-color-scheme:dark){\n" + dark + "\n}\n" : "");
  } catch (_) { return ""; }
}

// Same pattern as loadHljsCss: inline the vendored KaTeX stylesheet so a math
// export renders offline (audit E3 gap). Note: katex.min.css references its
// webfonts via relative "fonts/..." url()s — those don't resolve once inlined
// into a standalone exported .html (no fonts/ dir alongside it), so exported
// math falls back to the browser's default font metrics instead of KaTeX's
// web fonts. Accepted: the composed glyph layout still renders correctly,
// only the font face degrades, and we deliberately do NOT inline the font
// files themselves (would bloat every export by the whole KaTeX font set).
async function loadKatexCss() {
  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.getURL) return "";
  try {
    return await (await fetch(chrome.runtime.getURL("vendor/katex/katex.min.css"))).text();
  } catch (_) { return ""; }
}

// ---- Rail drawer (narrow viewports) ----
// Off-canvas modal-style drawer: move focus in on open, trap Tab while open,
// restore focus to the opener on close. Only engaged <1000px (toggle is
// display:none above, so setOpen(true) never fires at wide widths).
function setupDrawer() {
  const toggle = document.getElementById("rail-toggle");
  const scrim = document.getElementById("rail-scrim");
  const rail = document.getElementById("rail");
  if (!toggle || !scrim || !rail) return;
  let lastFocus = null;
  const focusables = () => Array.from(
    rail.querySelectorAll('button, a[href], input, select, [tabindex]:not([tabindex="-1"])')
  ).filter((el) => el.offsetParent !== null);
  const isOpen = () => document.body.classList.contains("rail-open");
  const setOpen = (open) => {
    document.body.classList.toggle("rail-open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    scrim.hidden = !open;
    if (open) {
      lastFocus = document.activeElement;
      rail.setAttribute("role", "dialog");
      rail.setAttribute("aria-modal", "true");
      (document.getElementById("btn-rendered") || rail).focus();
    } else {
      rail.removeAttribute("role");
      rail.removeAttribute("aria-modal");
      if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
      else toggle.focus();
    }
  };
  toggle.addEventListener("click", () => setOpen(!isOpen()));
  scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (e) => {
    if (!isOpen()) return;
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "Tab") {
      const f = focusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
}

// Closes the mobile off-canvas rail drawer if it happens to be open (R2
// zen batch, spec sec.1.2 "zen also hides the drawer toggle"). Entering
// zen while the drawer is open only CSS-hides #rail/.rail-toggle/
// .rail-scrim (md-preview.css) -- it does NOT clear the drawer's OWN
// state, which lives entirely inside setupDrawer()'s closure above
// (body.rail-open, the scrim's hidden attribute, #rail's role/aria-modal).
// Left uncleared, exiting zen hands control back to the pre-existing
// `body.rail-open .rail { transform: translateX(0); visibility: visible }`
// rule and the scrim's now-stale visible state, popping the full-screen
// drawer overlay back onto the screen even though the user only asked to
// leave zen. Declared top-level (genuinely page-global, like
// trOnlyScrollTarget right below) rather than added inside setupDrawer's
// closure, so md-reader.js's zen feature can reach it via a typeof guard,
// same as every other cross-file call in this file. Mirrors setupDrawer's
// own setOpen(false) branch (rail-open class / aria-expanded /
// scrim.hidden / role+aria-modal) but deliberately does NOT restore focus
// to setupDrawer's private `lastFocus` -- that variable isn't reachable
// from outside setupDrawer's closure, and the caller (md-reader.js's
// _pbpZenEnter) already handles its own focus target for the zen-entry
// case.
function pbpRailDrawerClose() {
  if (!document.body.classList.contains("rail-open")) return;
  document.body.classList.remove("rail-open");
  const toggle = document.getElementById("rail-toggle");
  const scrim = document.getElementById("rail-scrim");
  const rail = document.getElementById("rail");
  if (toggle) toggle.setAttribute("aria-expanded", "false");
  if (scrim) scrim.hidden = true;
  if (rail) {
    rail.removeAttribute("role");
    rail.removeAttribute("aria-modal");
  }
}

// In tr-only mode, a translated ORIGINAL heading is display:none (md-preview.css:890
// hides every [data-pb-tr-done] unless .pb-show-orig is toggled back on) while its
// .pb-tr sibling (inserted by _pbpTrFill, md-translate.js) carries the visible text.
// Anything that scrolls to or measures the geometry of a heading element must resolve
// through this first, or it reads/targets a collapsed 0/0/0/0 box.
function trOnlyScrollTarget(headEl) {
  if (!document.body.classList.contains("tr-only")) return headEl;
  if (!headEl.dataset || !headEl.dataset.pbTrDone || headEl.classList.contains("pb-show-orig")) return headEl;
  const sib = headEl.nextElementSibling;
  return (sib && sib.classList && sib.classList.contains("pb-tr")) ? sib : headEl;
}

// ---- Scroll-spy: highlight the TOC entry for the heading nearest the top ----
function setupScrollSpy(renderedView, tocList) {
  const links = Array.from(tocList.querySelectorAll("a"));
  if (!links.length) return;

  // No sticky toolbar overlays the content now (rail is beside it); a small
  // top clearance keeps the heading at the very top from flickering.
  const topClear = 16;

  // Map slug -> link for O(1) activation.
  const linkBySlug = new Map(links.map((a) => [a.dataset.slug, a]));

  // Resolve each link's target heading element by id (slug === heading id).
  const targets = links
    .map((a) => renderedView.querySelector("#" + cssEscape(a.dataset.slug)))
    .filter(Boolean);
  if (!targets.length) return;

  let activeSlug = null;
  const setActive = (slug) => {
    if (slug === activeSlug) return;
    if (activeSlug && linkBySlug.has(activeSlug)) linkBySlug.get(activeSlug).classList.remove("active");
    const a = linkBySlug.get(slug);
    if (a) {
      a.classList.add("active");
      activeSlug = slug;
    }
  };

  // Track which headings are currently intersecting; the topmost wins.
  const visible = new Set();

  // Bottom-up scan for the last heading above the viewport. In tr-only mode
  // the heading itself is display:none (see trOnlyScrollTarget) and always
  // reports a degenerate 0/0/0/0 rect — measure its visible .pb-tr sibling
  // instead. Shared by the observer callback (nothing intersecting) and the
  // scroll fallback below (observer starved because all targets are
  // display:none, so it never fires again after the initial hide).
  const runFallback = () => {
    for (let i = targets.length - 1; i >= 0; i--) {
      if (trOnlyScrollTarget(targets[i]).getBoundingClientRect().top < topClear + 12) { setActive(targets[i].id); return; }
    }
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const id = entry.target.id;
      if (entry.isIntersecting) visible.add(id);
      else visible.delete(id);
    });
    // Pick the visible heading closest to the top of the doc order.
    let topId = null;
    for (const t of targets) {
      if (visible.has(t.id)) { topId = t.id; break; }
    }
    if (topId) { setActive(topId); return; }
    // If nothing is intersecting (scrolled past all into a long section),
    // keep the last heading above the viewport active.
    runFallback();
  }, {
    // top margin clears the (measured) sticky toolbar; -70% bottom keeps the
    // "current" heading active until the next one nears the top.
    rootMargin: "-" + topClear + "px 0px -70% 0px",
    threshold: 0,
  });
  targets.forEach((t) => observer.observe(t));

  // In tr-only view every target is display:none (md-preview.css
  // `body.tr-only #rendered-view [data-pb-tr-done]:not(.pb-show-orig)`), so
  // it never intersects and the observer callback fires once (the hide
  // transition) and then never again — the highlight freezes. Drive the
  // same fallback off scroll instead, throttled to one measure per frame.
  // In original/bilingual views `visible` stays populated by the observer,
  // so this bails out immediately and costs nothing.
  let spyRaf = 0;
  window.addEventListener("scroll", () => {
    if (visible.size) return;
    if (spyRaf) return;
    spyRaf = requestAnimationFrame(() => { spyRaf = 0; runFallback(); });
  }, { passive: true });
}

// CSS.escape fallback for slugs used in querySelector("#"+id).
function cssEscape(s) {
  if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9\-_ -￿]/g, (c) => "\\" + c);
}
