// Durable Ask history. Article/session navigation is separate from the
// reader's limited model context; reading history never starts an AI request.
let _libAskOwner = null;
let _libAskRevision = 0;
let _libAskSessions = [];
let _libAskSelected = "";
let _libAskLoad = 0;
let _libAskMarkdown = null;
let _libAskRestoreOwner = null;
const _libAskOpening = new Set();
let _libAskRequestedSession = new URL(location.href).searchParams.get("askSession") || "";

function pbpLibAskSafeUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch (_) { return ""; }
}
function pbpLibAskFilter(sessions, query) {
  const needle = String(query || "").trim().normalize("NFKC").toLocaleLowerCase();
  return sessions.filter(session => !needle || [session.title, session.url,
    ...session.records.flatMap(record => [record.q, record.a])]
    .some(value => String(value || "").normalize("NFKC").toLocaleLowerCase().includes(needle)));
}
function pbpLibAskEvidence(record) {
  const rows = new Map();
  for (const cite of pbpAiParseCites(record.a).cites) rows.set(cite.p, { ...cite, state: "unverified", sourceUrl: "" });
  for (const cite of record.cites || []) rows.set(cite.p, { ...cite, state: "unverified", sourceUrl: "" });
  for (const source of record.evidence || []) rows.set(source.p, source);
  return [...rows.values()];
}
function pbpLibAskExport(session) {
  const parts = ["# " + String(session.title || session.url).replace(/[\r\n]/g, " "), "<" + session.url.replace(/[<>\s]/g, encodeURIComponent) + ">"];
  const replaced = new Set(session.records.map(record => record.replacesId).filter(Boolean));
  for (const record of session.records) {
    if (replaced.has(record.id)) parts.push("### " + t("askVersions"));
    parts.push("## " + record.q.replace(/[\r\n]/g, " "),
      [record.model, new Date(record.ts).toISOString()].filter(Boolean).join(" · "), pbpAiParseCites(record.a).body);
    for (const source of pbpLibAskEvidence(record)) {
      const state = source.state === "matched" ? "askExportMatched" : source.state === "source-changed" ? "askExportSourceChanged" : "askExportUnverified";
      const url = pbpLibAskSafeUrl(source.deepUrl || source.sourceUrl || session.url);
      parts.push("P" + source.p + "\n\n> " + String(source.quote || "").replace(/\n/g, "\n> ") +
        "\n\n" + t(state) + (url ? "\n\n<" + url.replace(/[<>\s]/g, encodeURIComponent) + ">" : ""));
    }
  }
  return parts.join("\n\n");
}
async function _pbpLibAskCurrentOwner() {
  const owner = await pbpVocabCurrentOwner();
  return owner === "ownerless" ? "" : owner;
}
async function _pbpLibAskCurrent(owner, revision) {
  return revision === _libAskRevision && owner === await _pbpLibAskCurrentOwner() && revision === _libAskRevision;
}
function _pbpLibAskStatus(message, bad = false) {
  const status = $id("ask-library-status");
  if (status) { status.textContent = message; status.classList.toggle("bad", bad); }
}
function _pbpLibAskElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function _pbpLibAskButton(icon, label, action, quiet = false) {
  const button = _pbpLibAskElement("button", "btn btn-sm" + (quiet ? " ghost" : ""));
  button.type = "button"; setBtnIcon(button, icon, t(label));
  button.addEventListener("click", action);
  return button;
}
async function _pbpLibAskEnsureMarkdown() {
  if (!_libAskMarkdown) _libAskMarkdown = (async () => {
    for (const [file, ready] of [["vendor/marked.min.js", () => typeof marked !== "undefined"],
      ["vendor/purify.min.js", () => typeof DOMPurify !== "undefined"],
      ["md-convert.js", () => typeof renderMarkdown === "function"]]) {
      if (ready()) continue;
      await new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = chrome.runtime.getURL(file); script.onload = resolve;
        script.onerror = () => { script.remove(); reject(new Error("history_renderer_unavailable")); };
        document.head.appendChild(script);
      });
    }
  })().catch(error => { _libAskMarkdown = null; throw error; });
  return _libAskMarkdown;
}
function _pbpLibAskAnswer(record) {
  const answer = _pbpLibAskElement("div", "ask-library-answer"); answer.dir = "auto";
  // The shared sanitizer remains the only HTML boundary. A template keeps
  // remote images inert while replacing them with their alternative text.
  const template = document.createElement("template");
  template.innerHTML = renderMarkdown(pbpAiParseCites(record.a).body);
  for (const image of template.content.querySelectorAll("img")) image.replaceWith(document.createTextNode(image.alt || ""));
  for (const link of template.content.querySelectorAll("a")) {
    const safe = pbpLibAskSafeUrl(link.getAttribute("href"));
    if (safe) { link.href = safe; link.target = "_blank"; link.rel = "noopener noreferrer"; }
    else link.removeAttribute("href");
  }
  answer.append(template.content);
  return answer;
}
function _pbpLibAskRenderDetail() {
  const host = $id("ask-library-detail"), cover = $id("ask-library-cover");
  if (!host || !cover) return;
  const session = _libAskSessions.find(row => row.id === _libAskSelected);
  const same = host.dataset.session === session?.id;
  const pane = $id("ask-library-detail-pane"), top = same ? pane.scrollTop : 0;
  const focused = host.contains(document.activeElement) ? [...host.querySelectorAll("button, summary")].indexOf(document.activeElement) : -1;
  const opened = same ? [...host.querySelectorAll("details")].map(detail => detail.open) : [];
  host.dataset.session = session?.id || "";
  host.replaceChildren(); host.hidden = !session; cover.hidden = !!session;
  if (!session) return;
  const back = _pbpLibAskButton("arrowLeft", "libraryBack", () => {
    document.body.classList.remove("lib-narrow-ask");
    $id("ask-library-list").querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
  }, true);
  back.classList.add("ask-library-back"); host.append(back);
  const title = _pbpLibAskElement("h2", "ask-library-title", session.title || session.url); title.dir = "auto";
  const link = _pbpLibAskElement("a", "ask-library-source", session.url);
  link.href = session.url; link.target = "_blank"; link.rel = "noopener noreferrer";
  const actions = _pbpLibAskElement("div", "ask-library-actions");
  const continueButton = _pbpLibAskButton("messageSquareText", "askContinueConversation", event => _pbpLibAskContinue(session, event.currentTarget));
  continueButton.disabled = _libAskOpening.has(_libAskOwner + "\n" + session.id);
  actions.append(continueButton,
    _pbpLibAskButton("download", "askExportConversation", () => _pbpLibAskDownload(session), true),
    _pbpLibAskButton("copy", "askCopyThread", () => _pbpLibAskCopy(session), true));
  host.append(title, link, actions);
  const replaced = new Set(session.records.map(record => record.replacesId).filter(Boolean));
  const makeRound = record => {
    const round = _pbpLibAskElement("article", "ask-library-round");
    const question = _pbpLibAskElement("h3", "ask-library-question", record.q); question.dir = "auto";
    const metadata = _pbpLibAskElement("p", "ask-library-stamp", [pbpLibFormatDay(record.ts), pbpLibFormatTime(record.ts), record.model].filter(Boolean).join(" · "));
    round.append(question, metadata, _pbpLibAskAnswer(record));
    const evidence = pbpLibAskEvidence(record);
    if (evidence.length) {
      const details = _pbpLibAskElement("details", "ask-library-evidence");
      const summary = _pbpLibAskElement("summary");
      const icon = _pbpLibAskElement("span", "btn-ic"); icon.innerHTML = PBP_ICONS.chevronDown;
      summary.append(document.createTextNode(t("askExportSources")), icon); details.append(summary);
      for (const source of evidence) {
        const quote = _pbpLibAskElement("blockquote", "", source.quote); quote.dir = "auto";
        const key = source.state === "matched" ? "askExportMatched" : source.state === "source-changed" ? "askExportSourceChanged" : "askExportUnverified";
        const note = _pbpLibAskElement("p", "ask-library-stamp", "P" + source.p + " · " + t(key));
        const url = pbpLibAskSafeUrl(source.deepUrl || source.sourceUrl || session.url);
        if (url) { const a = _pbpLibAskElement("a", "", t("askOpenSource")); a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; note.append(" ", a); }
        details.append(quote, note);
      }
      round.append(details);
    }
    return round;
  };
  for (const record of session.records.filter(row => !replaced.has(row.id))) host.append(makeRound(record));
  const earlier = session.records.filter(row => replaced.has(row.id));
  if (earlier.length) {
    const versions = _pbpLibAskElement("details", "ask-library-evidence");
    const summary = _pbpLibAskElement("summary", "", t("askVersions"));
    const icon = _pbpLibAskElement("span", "btn-ic"); icon.innerHTML = PBP_ICONS.chevronDown; summary.append(icon);
    versions.append(summary, ...earlier.map(makeRound)); host.append(versions);
  }
  const remove = _pbpLibAskButton("cross", "askDeleteConversation", event => _pbpLibAskDelete(session, event.currentTarget), true);
  remove.classList.add("danger-quiet", "ask-library-delete"); host.append(remove);
  [...host.querySelectorAll("details")].forEach((detail, index) => { detail.open = !!opened[index]; });
  pane.scrollTop = top;
  if (focused >= 0) host.querySelectorAll("button, summary")[focused]?.focus({ preventScroll: true });
}
function _pbpLibAskRenderList() {
  const list = $id("ask-library-list"); if (!list) return;
  const rows = pbpLibAskFilter(_libAskSessions, $id("ask-library-search")?.value);
  const hasSelected = rows.some(row => row.id === _libAskSelected);
  const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.session : "";
  list.replaceChildren();
  const articles = new Map();
  for (const session of rows) { if (!articles.has(session.url)) articles.set(session.url, []); articles.get(session.url).push(session); }
  for (const sessions of articles.values()) {
    const heading = _pbpLibAskElement("h3", "ask-library-page", sessions[0].title || sessions[0].url); heading.dir = "auto"; list.append(heading);
    for (const session of sessions) {
      const button = _pbpLibAskElement("button", "ask-library-hit"); button.type = "button"; button.dataset.session = session.id;
      button.tabIndex = session.id === _libAskSelected || (!hasSelected && session === rows[0]) ? 0 : -1;
      if (session.id === _libAskSelected) button.setAttribute("aria-current", "true");
      const question = _pbpLibAskElement("span", "ask-library-question", session.records[0]?.q || session.title); question.dir = "auto";
      button.append(question, _pbpLibAskElement("span", "ask-library-stamp", pbpLibFormatDay(session.updatedAt) + " · " + pbpLibFormatTime(session.updatedAt)));
      button.addEventListener("click", () => {
        _libAskSelected = session.id; _pbpLibAskRenderList(); _pbpLibAskRenderDetail();
        document.body.classList.add("lib-narrow-ask"); $id("ask-library-detail-pane").scrollTop = 0;
        if (matchMedia("(max-width: 860px)").matches) $id("ask-library-detail").querySelector("button")?.focus({ preventScroll: true });
        else $id("ask-library-list").querySelector('[aria-current="true"]')?.focus({ preventScroll: true });
      }); list.append(button);
    }
  }
  if (focusedId) [...list.querySelectorAll("button")].find(row => row.dataset.session === focusedId)?.focus({ preventScroll: true });
  const empty = $id("ask-library-empty"); empty.hidden = !!rows.length;
  empty.textContent = t(_libAskSessions.length ? "askHistoryNoResults" : "askHistoryEmpty");
}
async function pbpLibAskRefresh() {
  if (!$id("view-ask") || $id("view-ask").hidden) return;
  const run = ++_libAskLoad, revision = _libAskRevision;
  try {
    const owner = await _pbpLibAskCurrentOwner();
    if (revision !== _libAskRevision || run !== _libAskLoad) return;
    if (_libAskOwner !== owner) { _libAskOwner = owner; _libAskSessions = []; _libAskSelected = ""; _pbpLibAskRenderList(); _pbpLibAskRenderDetail(); }
    _pbpLibAskStatus(t("askHistoryLoading"));
    const [sessions] = await Promise.all([pbpAskArchiveRead({ owner }), _pbpLibAskEnsureMarkdown()]);
    if (run !== _libAskLoad || !await _pbpLibAskCurrent(owner, revision)) return;
    _libAskSessions = sessions;
    if (_libAskRequestedSession && sessions.some(session => session.id === _libAskRequestedSession)) {
      _libAskSelected = _libAskRequestedSession; _libAskRequestedSession = ""; document.body.classList.add("lib-narrow-ask");
    }
    if (!sessions.some(session => session.id === _libAskSelected)) {
      _libAskSelected = ""; document.body.classList.remove("lib-narrow-ask");
    }
    _pbpLibAskRenderList(); _pbpLibAskRenderDetail(); _pbpLibAskStatus("");
  } catch (error) {
    console.warn("[library] Ask history read failed:", error?.name, error?.code || "storage");
    if (run === _libAskLoad) _pbpLibAskStatus(t("askHistoryLoadFailed"), true);
  }
}
async function _pbpLibAskRestore(force = false) {
  const revision = _libAskRevision;
  try {
    const owner = await _pbpLibAskCurrentOwner();
    if (revision !== _libAskRevision || (!force && _libAskRestoreOwner === owner)) return;
    _libAskRestoreOwner = owner;
    const result = await chrome.runtime.sendMessage({ type: "PBP_ASK_ARCHIVE_RESTORE", owner });
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    if (result?.ok && result.connected) await pbpLibAskRefresh();
    // Connection failures remain visible in the shared Drive status. The
    // local archive stays readable while the existing queue retries.
  } catch (error) { console.warn("[library] Ask history restore failed:", error?.name); }
}
async function _pbpLibAskCopy(session) {
  const owner = _libAskOwner, revision = _libAskRevision;
  try { if (!await _pbpLibAskCurrent(owner, revision)) return; await navigator.clipboard.writeText(pbpLibAskExport(session)); if (await _pbpLibAskCurrent(owner, revision)) _pbpLibAskStatus(t("askCopied")); }
  catch (error) { console.warn("[library] Ask copy failed:", error?.name); if (revision === _libAskRevision) _pbpLibAskStatus(t("askHistoryActionFailed"), true); }
}
async function _pbpLibAskDownload(session) {
  const owner = _libAskOwner, revision = _libAskRevision;
  if (!await _pbpLibAskCurrent(owner, revision)) return;
  const url = URL.createObjectURL(new Blob([pbpLibAskExport(session)], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = "questions-and-answers.md";
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function _pbpLibAskDelete(session, anchor) {
  const owner = _libAskOwner, revision = _libAskRevision;
  showConfirmPopover(anchor, { msg: t("askDeleteConversationConfirm"), yesText: t("delete"), noText: t("askClearNo"),
    onConfirm: async () => {
      try {
        if (!await _pbpLibAskCurrent(owner, revision)) return;
        await pbpAskArchiveDelete({ owner, sessionId: session.id, isCurrent: () => revision === _libAskRevision && owner === _libAskOwner });
        if (!await _pbpLibAskCurrent(owner, revision)) return;
        _libAskSelected = ""; document.body.classList.remove("lib-narrow-ask"); await pbpLibAskRefresh(); $id("ask-library-search")?.focus({ preventScroll: true });
      } catch (error) { console.warn("[library] Ask delete failed:", error?.name); if (revision === _libAskRevision) _pbpLibAskStatus(t("askHistoryActionFailed"), true); }
    } });
}
async function _pbpLibAskContinue(session, button) {
  const owner = _libAskOwner, revision = _libAskRevision, url = pbpLibAskSafeUrl(session.url);
  const openingKey = owner + "\n" + session.id;
  if (!url || button.disabled || _libAskOpening.has(openingKey)) return;
  _libAskOpening.add(openingKey);
  button.disabled = true;
  let key = "";
  try {
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    const origin = new URL(url).origin + "/*";
    let allowed = await chrome.permissions.contains({ origins: [origin] });
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    if (!allowed) allowed = await chrome.permissions.request({ origins: [origin] });
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    if (!allowed) { _pbpLibAskStatus(t("askHistoryPermissionNeeded"), true); return; }
    const tabs = await chrome.tabs.query({ url });
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    let tab = tabs.find(row => row.url === url && !row.incognito);
    if (!tab) tab = await chrome.tabs.create({ url, active: false });
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    if (tab.status !== "complete") await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error("source_load_timeout")), 30000);
      const listener = (id, change) => { if (id === tab.id && change.status === "complete") finish(); };
      function finish(error) { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); error ? reject(error) : resolve(); }
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tab.id).then(current => { if (current.status === "complete") finish(); }, finish);
    });
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    const current = await chrome.tabs.get(tab.id);
    if (!await _pbpLibAskCurrent(owner, revision) || current.url !== url) throw new Error("source_changed");
    key = crypto.randomUUID();
    let account = ""; if (owner?.startsWith("acct_")) account = decodeURIComponent(owner.slice(5));
    await chrome.storage.local.set({ ["md_preview_data_" + key]: { pending: true, engine: "local", source: "local", tabId: tab.id,
      url, baseUrl: url, sourceTabUrl: url, title: session.title, sourceIncognito: false, account, tags: [], description: "", ts: Date.now() } });
    if (!await _pbpLibAskCurrent(owner, revision)) return;
    await chrome.tabs.create({ url: chrome.runtime.getURL("md-preview.html") + "?k=" + key + "&askSession=" + encodeURIComponent(session.id) });
    key = "";
  } catch (error) { console.warn("[library] Ask reader open failed:", error?.name); if (revision === _libAskRevision) _pbpLibAskStatus(t("askHistoryOpenFailed"), true); }
  finally {
    _libAskOpening.delete(openingKey);
    button.disabled = false;
    if (revision === _libAskRevision && owner === _libAskOwner && $id("ask-library-detail")?.dataset.session === session.id) {
      const currentButton = $id("ask-library-detail").querySelector(".ask-library-actions button");
      if (currentButton) currentButton.disabled = false;
    }
    if (key) try { await chrome.storage.local.remove("md_preview_data_" + key); }
    catch (error) { console.warn("[library] Ask preview cleanup failed:", error?.name); }
  }
}
function pbpLibAskRouteListKey(event) {
  if (!["ArrowUp", "ArrowDown", "Home", "End", "Delete", "Backspace"].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented || event.isComposing) return;
  if (pbpLibIsTypingTarget(document.activeElement) || document.querySelector(".confirm-popover, :popover-open")) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest("#ask-library-list") || target?.closest(PBP_LIB_OWN_KEYS_SELECTOR)) return;
  const row = $id("ask-library-list")?.querySelector('[aria-current="true"], [tabindex="0"]');
  if (!row?.getClientRects().length) return;
  event.preventDefault(); row.focus({ preventScroll: true });
  row.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, bubbles: true, cancelable: true }));
}

document.addEventListener("pbp-lib-view", event => {
  if (event.detail?.view === "ask") { pbpLibAskRefresh(); _pbpLibAskRestore(); }
});
document.addEventListener("DOMContentLoaded", () => {
  $id("ask-library-search")?.addEventListener("input", _pbpLibAskRenderList);
  $id("ask-library-retry")?.addEventListener("click", () => { pbpLibAskRefresh(); _pbpLibAskRestore(true); });
  $id("ask-library-list")?.addEventListener("keydown", event => {
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.defaultPrevented || event.isComposing) return;
    const rows = [...$id("ask-library-list").querySelectorAll("button")], index = rows.indexOf(event.target);
    if (index >= 0 && ["Delete", "Backspace"].includes(event.key)) {
      const session = _libAskSessions.find(row => row.id === event.target.dataset.session);
      if (session) { event.preventDefault(); _pbpLibAskDelete(session, event.target); } return;
    }
    if (index < 0 || !["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === "ArrowUp" ? -1 : 1)));
    rows[next].focus(); rows[next].click();
  });
});
if (typeof chrome !== "undefined") {
  chrome.storage?.onChanged?.addListener(changes => {
    if (!changes.pinboardToken && !changes.optSyncEnabled && !changes.syncApiKeys) return;
    _libAskRevision++; _libAskLoad++; _libAskOwner = null; _libAskRestoreOwner = null; _libAskSessions = []; _libAskSelected = "";
    document.body.classList.remove("lib-narrow-ask");
    _pbpLibAskRenderList(); _pbpLibAskRenderDetail(); pbpLibAskRefresh();
    if (!$id("view-ask")?.hidden) _pbpLibAskRestore();
  });
  chrome.runtime?.onMessage?.addListener(message => {
    if (["PBP_ASK_ARCHIVE_SYNCED", "PBP_ASK_ARCHIVE_DIRTY"].includes(message?.type) && message.owner === _libAskOwner) pbpLibAskRefresh();
  });
}
