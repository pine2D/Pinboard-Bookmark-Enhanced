import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const root = resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };

const popupHtml = read("popup.html");
const manifest = JSON.parse(read("manifest.json"));
const optionsHtml = read("options.html");
check(!optionsHtml.includes('Requires "Access all websites" permission'), "options Batch hint still advertises the retired all-sites request");
const mdHtml = read("md-preview.html");
const mdPreviewJs = read("md-preview.js");
const mdExportSendJs = read("md-export-send.js");
const sharedJs = read("shared.js");
const jinaJs = read("jina.js");
const mdAiCoreJs = read("md-ai-core.js");
const mdAskJs = read("md-ask.js");
const mdHighlightJs = read("md-highlight.js");
const mdSkimJs = read("md-skim.js");
const mdTranslateJs = read("md-translate.js");
const popupJs = read("popup.js");
const popupAiJs = read("popup-ai.js");
const popupBatchJs = read("popup-batch.js");
const popupCss = read("popup.css");
const optionsConnectivityJs = read("options-connectivity.js");
const optionsCss = read("options.css");
const optionsJs = read("options.js");
const optionsThemeEarlyJs = read("options-theme-early.js");
check(optionsJs.includes('webdavLastPush.error === "insecure"') && optionsJs.includes('t("mdTargetWebhookHttpWarn")'), "persisted insecure WebDAV status lacks endpoint guidance");
const popupTagsJs = read("popup-tags.js");

const optionsTabs = optionsHtml.slice(optionsHtml.indexOf('<div class="tabs"'), optionsHtml.indexOf('</div>', optionsHtml.indexOf('<div class="tabs"')) + 6);
check(!optionsTabs.includes('id="reset-panel-btn"') && /id="mobile-tab-select"/.test(optionsHtml),
  "options.html: reset action remains inside tablist or mobile category select is missing");
check(/mobileTabSelect\.value = btn\.dataset\.panel/.test(optionsJs) &&
  /mobileTabSelect\?\.addEventListener\("change"/.test(optionsJs),
  "options.js: desktop tabs and mobile category select can drift");
check(/result && typeof result\.catch === "function"\) result\.catch\(reportConfirmError\)/.test(sharedJs),
  "shared.js: asynchronous confirm failures can become unhandled rejections");
check(/<input type="password" id="token-input"/.test(popupHtml) && /data-target="token-input"/.test(popupHtml),
  "popup.html: Pinboard token is not masked with a reveal control");
check(/<input type="password" id="opt-pinboard-token"/.test(optionsHtml) && /data-target="opt-pinboard-token"/.test(optionsHtml),
  "options.html: Pinboard token is not masked with a reveal control");
check(/<button[^>]+id="import-settings"/.test(optionsHtml) && /id="import-status"[^>]+role="status"/.test(optionsHtml),
  "options.html: settings import is not a keyboard button with live status");
for (const [id, label] of [["opt-lang", "secLanguage"], ["opt-ai-provider", "secAiProvider"], ["opt-theme", "secTheme"]]) {
  check(new RegExp(`<label[^>]+for="${id}"[^>]+data-i18n="${label}"`).test(optionsHtml),
    `options.html: ${id} lacks its visible label`);
}
check(/id="translate-target-lang-custom"[^>]+aria-labelledby="translate-target-lang-label"/.test(optionsHtml),
  "options.html: custom translation language lacks an accessible name");
check(/id="tag-gov-progress-bar"[^>]+role="progressbar"[^>]+aria-labelledby="tag-gov-progress-text"[^>]+aria-valuenow="0"/.test(optionsHtml) &&
  /id="tag-gov-progress-text"[^>]+role="status"[^>]+aria-live="polite"/.test(optionsHtml),
  "options.html: tag governance progress lacks its accessible name/value or live status");
const tagGovProgressHelper = optionsJs.slice(
  optionsJs.indexOf("function _tagGovSetProgress(value"),
  optionsJs.indexOf('document.addEventListener("click",', optionsJs.indexOf("function _tagGovSetProgress(value"))
);
check(/fill\.style\.width = percent \+ "%"/.test(tagGovProgressHelper) &&
  /bar\.setAttribute\("aria-valuenow", String\(percent\)\)/.test(tagGovProgressHelper) &&
  !optionsJs.replace(tagGovProgressHelper, "").includes('$id("tag-gov-progress-fill")'),
  "options.js: tag governance visual and ARIA progress can drift");
check(/id="tags-input"[^>]+role="combobox"[^>]+aria-controls="tags-autocomplete"[^>]+aria-expanded="false"/.test(popupHtml) &&
  /id="tags-autocomplete"[^>]+role="listbox"/.test(popupHtml),
  "popup.html: tag autocomplete lacks combobox/listbox semantics");
check(/setAttribute\("role", "option"\)/.test(popupTagsJs) &&
  /aria-activedescendant/.test(popupTagsJs) && /aria-selected/.test(popupTagsJs) &&
  /scrollIntoView\(\{ block: "nearest" \}\)/.test(popupTagsJs),
  "popup-tags.js: tag options do not expose active selection semantics");
check(/finally\s*\{\s*container\.setAttribute\("aria-busy", "false"\)/.test(popupTagsJs),
  "popup-tags.js: suggested tags remain permanently busy after completion");
check(/const btn = document\.createElement\("button"\);[\s\S]{0,80}btn\.type = "button";[\s\S]{0,100}btn\.className = "preset-btn";/.test(popupBatchJs),
  "popup-batch.js: tag presets are not native buttons");
check(/btn\.disabled = true;\s*\$id\("tags-input"\)\?\.focus\(\)/.test(popupBatchJs),
  "popup-batch.js: used tag preset drops focus on a disabled button");
const cleanHint = popupJs.slice(popupJs.indexOf("function _renderCleanHint"), popupJs.indexOf('document.addEventListener("DOMContentLoaded"'));
check(cleanHint.indexOf('hint.classList.add("hidden")') < cleanHint.indexOf("urlInput.focus()"),
  "popup.js: URL-clean undo hides its focused button without returning focus");

check(manifest.host_permissions.join(",") === "https://api.pinboard.in/*,https://pinboard.in/*",
  "manifest.json: required hosts are not limited to core Pinboard access");
check(manifest.optional_host_permissions.join(",") === "*://*/*",
  "manifest.json: optional host ceiling is redundant or missing");

for (const [name, html] of [["popup.html", popupHtml], ["options.html", optionsHtml], ["md-preview.html", mdHtml]]) {
  const links = html.matchAll(/<a\b[^>]*target="_blank"[^>]*>/g);
  for (const [tag] of links) check(/\brel="[^"]*\bnoopener\b[^"]*"/.test(tag), `${name}: target=_blank missing rel=noopener -> ${tag}`);
}

const staticAccordionHeaders = optionsHtml.matchAll(/<(?<tag>\w+)\b(?<attrs>[^>]*class="accordion-header"[^>]*)>/g);
for (const m of staticAccordionHeaders) {
  const attrs = m.groups.attrs;
  const target = (attrs.match(/\bdata-target="([^"]+)"/) || [])[1];
  check(m.groups.tag === "button", `options.html: accordion ${target} is <${m.groups.tag}>`);
  check(/\btype="button"/.test(attrs), `options.html: accordion ${target} missing type=button`);
  check(new RegExp(`\\baria-controls="${target}"`).test(attrs), `options.html: accordion ${target} missing aria-controls`);
}

check(/const head = document\.createElement\("button"\);/.test(optionsJs), "options.js: dynamic accordion header is not a button");
check(/head\.type = "button";/.test(optionsJs), "options.js: dynamic accordion header missing type=button");
check(/head\.setAttribute\("aria-controls", head\.dataset\.target\);/.test(optionsJs), "options.js: dynamic accordion header missing aria-controls");

const helperSource = optionsJs.slice(0, optionsJs.indexOf('document.addEventListener("DOMContentLoaded"'));
const permissionHelpers = Function(helperSource + "; return { pbpExactOriginPermissionSnapshot, pbpRevokeLegacyAllSitesPermission }; ")();
check(permissionHelpers.pbpExactOriginPermissionSnapshot([
  "*://*/*",
  "https://api.pinboard.in/*",
  "https://custom.example:8443/*",
  "https://*.example.com/*",
  "http://localhost:*/*",
  "not a pattern",
  "https://api.pinboard.in/*"
]).join(",") === "https://api.pinboard.in/*,https://custom.example:8443/*",
"options.js: legacy revoke snapshot is not limited to unique exact origins");

{
  const wildcard = "*://*/*";
  const exact = ["https://api.pinboard.in/*", "https://custom.example:8443/*"];
  const active = new Set([wildcard, ...exact]);
  const calls = [];
  const result = await permissionHelpers.pbpRevokeLegacyAllSitesPermission({
    async getAll() { calls.push("getAll"); return { origins: [...active] }; },
    async remove({ origins }) { calls.push("remove:" + origins.join(",")); active.delete(wildcard); return true; },
    async request({ origins }) { calls.push("request:" + origins.join(",")); return true; },
    async contains({ origins }) { calls.push("contains:" + origins[0]); return active.has(origins[0]); }
  });
  check(result.ok && calls.join("|") === [
    "getAll",
    "remove:*://*/*",
    "request:" + exact.join(","),
    "contains:" + exact[0],
    "contains:" + exact[1],
    "contains:*://*/*"
  ].join("|"), "options.js: legacy revoke does not restore/verify the exact snapshot in order");
}

{
  const wildcard = "*://*/*";
  const exact = "https://custom.example/*";
  const active = new Set([wildcard, exact]);
  const result = await permissionHelpers.pbpRevokeLegacyAllSitesPermission({
    async getAll() { return { origins: [...active] }; },
    async remove() { active.clear(); return true; },
    async request() { return false; },
    async contains({ origins }) { return active.has(origins[0]); }
  });
  check(!result.ok && result.wildcardAbsent && result.missing.includes(exact),
    "options.js: partial exact-origin restoration can be reported as success");
}

check(optionsJs.includes("btn.disabled = result.wildcardAbsent"),
  "options.js: partial legacy revoke failure can be retried into a false success");

const sendRuntimeStart = mdExportSendJs.indexOf("async function pbpSendToTarget");
const sendRuntimeEnd = mdExportSendJs.indexOf("\n}", sendRuntimeStart) + 2;
const sendRuntime = mdExportSendJs.slice(sendRuntimeStart, sendRuntimeEnd);
check(sendRuntimeStart >= 0 && /permissions\.contains/.test(sendRuntime) && !/permissions\.request/.test(sendRuntime),
  "md-export-send.js: execution layer must contain-check without requesting");
const doSendStart = mdPreviewJs.indexOf("async function doSend(id)");
const doSendEnd = mdPreviewJs.indexOf("primary.addEventListener", doSendStart);
const doSend = mdPreviewJs.slice(doSendStart, doSendEnd);
check(doSendStart >= 0 && doSendEnd > doSendStart &&
  doSend.indexOf("await pbpRequestTargetPermission(id, cfg)") >= 0 &&
  doSend.indexOf("await pbpRequestTargetPermission(id, cfg)") < doSend.indexOf("await pbpSetLastTarget(id)"),
  "md-preview.js: Send-to permission request is not the first await before last-target storage");

check(/const PBP_JINA_ORIGIN_PATTERN = "https:\/\/r\.jina\.ai\/\*";/.test(sharedJs) &&
  !/const\s+JINA_ORIGIN_PATTERN/.test(jinaJs) && /PBP_JINA_ORIGIN_PATTERN/.test(jinaJs),
  "Jina exact-origin pattern is not shared by preview and Service Worker paths");
const jinaRetryStart = mdPreviewJs.indexOf("async function retryExtract(engine, failure)");
const jinaRetryEnd = mdPreviewJs.indexOf("async function attemptExtract(engine)", jinaRetryStart);
const jinaRetry = mdPreviewJs.slice(jinaRetryStart, jinaRetryEnd);
check(jinaRetryStart >= 0 && jinaRetryEnd > jinaRetryStart &&
  jinaRetry.indexOf("inFlight = true") >= 0 &&
  jinaRetry.indexOf("inFlight = true") < jinaRetry.indexOf("await pbpRequestJinaHostPermission()") &&
  jinaRetry.indexOf("await pbpRequestJinaHostPermission()") >= 0 &&
  jinaRetry.indexOf("await pbpRequestJinaHostPermission()") < jinaRetry.indexOf("await attemptExtract(engine)") &&
  /finally\s*\{\s*inFlight = false;/.test(jinaRetry),
  "md-preview.js: Jina retry is not guarded before its exact-origin request");
const switchRetryStart = mdPreviewJs.indexOf('if (e === "jina" && jinaPermissionMissing)');
const switchHandlerStart = mdPreviewJs.lastIndexOf('seg.addEventListener("click", async () => {', switchRetryStart);
const switchRetryEnd = mdPreviewJs.indexOf("chrome.runtime.sendMessage", switchRetryStart) + "chrome.runtime.sendMessage".length;
const switchRetry = mdPreviewJs.slice(switchHandlerStart, switchRetryEnd);
check(switchHandlerStart >= 0 && switchRetryEnd > switchRetryStart &&
  switchRetry.indexOf("switching = true") >= 0 &&
  switchRetry.indexOf("switching = true") < switchRetry.indexOf("await pbpRequestJinaHostPermission()") &&
  switchRetry.indexOf("await pbpRequestJinaHostPermission()") < switchRetry.indexOf("chrome.runtime.sendMessage") &&
  /if \(!await pbpRequestJinaHostPermission\(\)\) \{[\s\S]*?switching = false;[\s\S]*?applyAvailability\(curEngine\);[\s\S]*?return;/.test(switchRetry),
  "md-preview.js: Jina engine retry is not guarded before its permission request");
const renderErrorState = mdPreviewJs.slice(
  mdPreviewJs.indexOf("function renderErrorState"),
  mdPreviewJs.indexOf("function pbpRequestJinaHostPermission")
);
check(renderErrorState.indexOf('btn.textContent = t(permissionRequired ? "aiGrantRetry" : "askErrRetry")') >= 0 &&
  renderErrorState.indexOf("btn.disabled = true") < renderErrorState.indexOf("await retryFn()") &&
  renderErrorState.indexOf("btn.disabled = false") > renderErrorState.indexOf("await retryFn()") &&
  mdPreviewJs.includes('pr && pr.error === "host_permission"'),
  "md-preview.js: Jina permission retry lacks grant copy or synchronous button guard");

const aiRecoveryStart = mdAiCoreJs.indexOf("async function pbpAiRetryWithPermission");
const aiRecoveryEnd = mdAiCoreJs.indexOf("// ---- IDB persistence", aiRecoveryStart);
const aiRecovery = mdAiCoreJs.slice(aiRecoveryStart, aiRecoveryEnd);
check(aiRecoveryStart >= 0 && aiRecovery.indexOf("await requestAIHostPermissions(settings)") >= 0 &&
  aiRecovery.indexOf("await requestAIHostPermissions(settings)") < aiRecovery.indexOf("await retry()"),
  "md-ai-core.js: retry callback can run before the provider permission request");
check((mdAskJs.match(/pbpAiRetryWithPermission\(/g) || []).length >= 2,
  "md-ask.js: Ask and Explain do not both use permission-aware retry");
const skimRegenStart = mdSkimJs.indexOf("async function _pbpSkimRegen()");
const skimRegen = mdSkimJs.slice(skimRegenStart, mdSkimJs.indexOf("// Init hookup", skimRegenStart));
check(skimRegenStart >= 0 && skimRegen.indexOf("await pbpAiRetryWithPermission") >= 0 &&
  skimRegen.indexOf("st.running = true") >= 0 &&
  skimRegen.indexOf("st.running = true") < skimRegen.indexOf("await pbpAiRetryWithPermission") &&
  skimRegen.indexOf("retry.disabled = true") < skimRegen.indexOf("await pbpAiRetryWithPermission") &&
  skimRegen.indexOf("await pbpAiRetryWithPermission") < skimRegen.indexOf("body.replaceChildren()") &&
  /finally\s*\{[\s\S]*?st\.running = false;[\s\S]*?retry\.disabled = false;/.test(skimRegen),
  "md-skim.js: regenerate is not guarded before permission recovery");
const explainRetryStart = mdAskJs.indexOf('retry.className = "xp-retry"');
const explainRetryEnd = mdAskJs.indexOf("wrap.appendChild(retry)", explainRetryStart);
const explainRetry = mdAskJs.slice(explainRetryStart, explainRetryEnd);
check(explainRetryStart >= 0 && explainRetryEnd > explainRetryStart &&
  explainRetry.indexOf("retry.disabled = true") >= 0 &&
  explainRetry.indexOf("retry.disabled = true") < explainRetry.indexOf("await pbpAiRetryWithPermission") &&
  (explainRetry.match(/retry\.disabled = false/g) || []).length === 2,
  "md-ask.js: Explain permission retry lacks a synchronous button guard");
const trStart = mdTranslateJs.slice(mdTranslateJs.indexOf("async function _pbpTrStart(st)"), mdTranslateJs.indexOf("// Fill one block", mdTranslateJs.indexOf("async function _pbpTrStart(st)")));
check(trStart.indexOf("await pbpAiRetryWithPermission") >= 0 &&
  trStart.indexOf("await pbpAiRetryWithPermission") < trStart.indexOf("if (st.workReady) await st.workReady"),
  "md-translate.js: Continue does work before permission recovery");

check(/async function _pbpWebdavRequestPermission[\s\S]{0,240}if \(!origin\) return null;[\s\S]{0,180}catch \(_\) \{ return false; \}/.test(optionsJs),
  "options.js: WebDAV permission preflight does not distinguish invalid URL from denied permission");
check(/function _pbpWebdavPermissionError[\s\S]{0,180}granted === null \? "mdTargetWebhookHttpWarn" : "webdavPermDenied"/.test(optionsJs),
  "options.js: WebDAV permission errors do not map invalid and denied states separately");
check((optionsJs.match(/const errorKey = _pbpWebdavPermissionError\(granted\);/g) || []).length === 4,
  "options.js: WebDAV Test/Push/Pull/auto-push do not all use the permission-state mapping");
const webdavAutoStart = optionsJs.indexOf('$id("opt-webdav-autopush")?.addEventListener');
const webdavAutoEnd = optionsJs.indexOf("// ---- WebDAV: render", webdavAutoStart);
const webdavAutoHandler = optionsJs.slice(webdavAutoStart, webdavAutoEnd);
check(webdavAutoStart >= 0 && webdavAutoEnd > webdavAutoStart &&
  !/target\.value\s*=(?!=)|dispatchEvent\(/.test(webdavAutoHandler),
  "options.js: WebDAV auto-push permission failure mutates the saved schedule");

const waybackLoadStart = optionsJs.indexOf("// ---- Wayback: check permission on load");
const waybackToggleStart = optionsJs.indexOf("// ---- Wayback: toggle permission", waybackLoadStart);
const waybackClearStart = optionsJs.indexOf("// ---- Wayback: clear", waybackToggleStart);
const waybackLoad = optionsJs.slice(waybackLoadStart, waybackToggleStart);
const waybackToggle = optionsJs.slice(waybackToggleStart, waybackClearStart);
check(waybackLoadStart >= 0 && waybackToggleStart > waybackLoadStart &&
  !/checked\s*=\s*false|waybackArchiveEnabled\s*=\s*false|getSettingsStorage\(\)/.test(waybackLoad),
  "options.js: Wayback load-time permission failure disables the saved setting");
check(waybackClearStart > waybackToggleStart &&
  !/checked\s*=\s*false|dispatchEvent\(/.test(waybackToggle),
  "options.js: Wayback permission denial disables the user's choice");
check(/result\.missing\.join\(", "\)/.test(optionsJs) && !/result\.ok[\s\S]{0,300}batchPermNone/.test(optionsJs),
  "options.js: legacy revoke restoration failure is not reported explicitly");

const popupRetryStart = popupAiJs.indexOf('$id("ai-error-retry")?.addEventListener');
const popupRetryEnd = popupAiJs.indexOf('$id("ai-error-fallback")?.addEventListener', popupRetryStart);
const popupRetry = popupAiJs.slice(popupRetryStart, popupRetryEnd);
check(popupRetryStart >= 0 && popupRetryEnd > popupRetryStart &&
  popupRetry.indexOf("retryBtn.disabled = true") >= 0 &&
  popupRetry.indexOf("retryBtn.disabled = true") < popupRetry.indexOf("await requestAIHostPermissions") &&
  popupRetry.indexOf("retryBtn.disabled = false") > popupRetry.indexOf("await requestAIHostPermissions") &&
  popupRetry.indexOf("await requestAIHostPermissions(recovery.settings, extraOrigins)") === popupRetry.indexOf("await ") &&
  popupRetry.includes("recovery.origins.filter") && !popupRetry.includes("PBP_JINA_ORIGIN_PATTERN") &&
  !popupRetry.includes("aiContentSource"),
  "popup-ai.js: permission retry recomputes destinations instead of using the failed-stage origins");
check(/err\.permissionStage = "extracting";[\s\S]{0,100}err\.permissionOrigins = origins;/.test(popupAiJs) &&
  (popupAiJs.match(/e\.permissionStage = "calling";/g) || []).length === 2 &&
  (popupAiJs.match(/e\.permissionOrigins = _aiRequiredOriginPatterns\(settings\);/g) || []).length === 2,
  "popup-ai.js: extraction and provider permission failures do not record their actual stage/origins");

const popupWaybackStart = popupJs.indexOf('$id("archive-check").addEventListener("change", async (e) =>');
const popupWaybackEnd = popupJs.indexOf("// Setup UI features immediately", popupWaybackStart);
const popupWayback = popupJs.slice(popupWaybackStart, popupWaybackEnd);
check(popupWaybackStart >= 0 && popupWaybackEnd > popupWaybackStart &&
  popupWayback.indexOf('await chrome.permissions.request({ origins: ["https://web.archive.org/*"] })') === popupWayback.indexOf("await ") &&
  !popupWayback.includes("permissions.contains"),
  "popup.js: Wayback grant is not the first await in the checkbox gesture");

const markdownClickStart = popupJs.indexOf('jinaMdBtn.addEventListener("click", async () =>');
const markdownClickEnd = popupJs.indexOf("// Fetch all user tags first", markdownClickStart);
const markdownClick = popupJs.slice(markdownClickStart, markdownClickEnd);
check(markdownClickStart >= 0 && markdownClickEnd > markdownClickStart &&
  markdownClick.indexOf("jinaMdBtn.disabled = true") >= 0 &&
  markdownClick.indexOf("jinaMdBtn.disabled = true") < markdownClick.indexOf("await chrome.permissions.request") &&
  markdownClick.indexOf("jinaMdBtn.disabled = false") > markdownClick.indexOf("await chrome.permissions.request") &&
  markdownClick.indexOf("await chrome.permissions.request({ origins: [PBP_JINA_ORIGIN_PATTERN] })") === markdownClick.indexOf("await ") &&
  markdownClick.includes('result.code === "host_permission"') && markdownClick.includes('t("aiGrantRetry")'),
  "popup.js: Markdown host-permission recovery is not a Jina-only first-await grant and retry");

const tagGovClickStart = optionsJs.indexOf('$id("tag-gov-ai-btn")?.addEventListener');
const tagGovClickEnd = optionsJs.indexOf("await renderWaybackLog()", tagGovClickStart);
const tagGovClick = optionsJs.slice(tagGovClickStart, tagGovClickEnd);
check(tagGovClickStart >= 0 && tagGovClickEnd > tagGovClickStart &&
  tagGovClick.indexOf("btn.disabled = true") >= 0 &&
  tagGovClick.indexOf("btn.disabled = true") < tagGovClick.indexOf("await requestAIHostPermissions(pending)") &&
  tagGovClick.indexOf("btn.disabled = false") > tagGovClick.indexOf("await requestAIHostPermissions(pending)") &&
  tagGovClick.indexOf("await requestAIHostPermissions(pending)") === tagGovClick.indexOf("await ") &&
  tagGovClick.includes("tagGovAiPendingSettings !== pending") &&
  tagGovClick.includes("await runTagGovAi(pending)"),
  "options.js: tag-governance grant click does not request before retrying the saved settings snapshot");
check(/opt-ai-provider[\s\S]{0,160}tagGovAiPendingSettings = null/.test(optionsJs.slice(optionsJs.indexOf("let tagGovAiPendingSettings"))),
  "options.js: tag-governance pending permission retry is not cleared when provider changes");
check(/function pbpLiveAiSettingsSnapshot\(provider\)/.test(optionsConnectivityJs) &&
  /const cs = pbpLiveAiSettingsSnapshot\(provider\);/.test(optionsConnectivityJs) &&
  (optionsConnectivityJs.match(/geminiApiKey: getOptVal/g) || []).length === 1 &&
  tagGovClick.indexOf("const live = pbpLiveAiSettingsSnapshot") < tagGovClick.indexOf("let sNow = await") &&
  tagGovClick.includes("sNow = { ...sNow, ...live"),
  "Options connectivity and tag governance do not share one live provider form snapshot");

check(/@media \(max-width: 720px\)[\s\S]*\.container\s*{[\s\S]*grid-template-columns:\s*1fr/.test(optionsCss), "options.css: missing mobile one-column container rule");
check(/@media \(max-width: 720px\)[\s\S]*\.options-nav\s*{[\s\S]*position:\s*static/.test(optionsCss) &&
  /@media \(max-width: 720px\)[\s\S]*\.tabs\s*{\s*display:\s*none/.test(optionsCss),
  "options.css: mobile category select does not replace the desktop tablist");

function runOptionsEarly({ mode = "auto", preset = "", dark = false, chrome } = {}) {
  const root = { dataset: { theme: "stale" } };
  const values = new Map([["pp-theme", mode], ["pp-theme-preset", preset]]);
  const timers = [];
  const context = {
    document: { documentElement: root, addEventListener() {}, getElementById() { return null; } },
    window: { matchMedia: () => ({ matches: dark }) },
    localStorage: {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
  if (chrome) context.chrome = chrome;
  runInNewContext(optionsThemeEarlyJs, context);
  return { root, values, timers };
}

for (const [preset, expected] of [["flexoki", "flexoki-dark"], ["solarized", "solarized-dark"], ["catppuccin", "catppuccin-mocha"]]) {
  const run = runOptionsEarly({ mode: "auto", preset, dark: true });
  check(run.root.dataset.theme === expected, `options-theme-early.js: ${preset} did not follow dark matchMedia without chrome`);
}
for (const preset of ["__proto__", "constructor"]) {
  const run = runOptionsEarly({ mode: "dark", preset });
  check(run.root.dataset.theme === preset, `options-theme-early.js: inherited key ${preset} interrupted theme bootstrap`);
}
const earlyLight = runOptionsEarly({ mode: "light", dark: true });
check(!("theme" in earlyLight.root.dataset),
  "options-theme-early.js: light/no-preset did not clear a stale theme without chrome");
check(earlyLight.timers.length === 1 && earlyLight.timers[0].ms === 3000, "options-theme-early.js: 3s fail-open timer is missing");
earlyLight.timers[0]?.fn();
check(earlyLight.root.dataset.optionsReady === "fallback", "options-theme-early.js: fail-open did not release the gate");
const earlyReady = runOptionsEarly();
earlyReady.root.dataset.optionsReady = "1";
earlyReady.timers[0]?.fn();
check(earlyReady.root.dataset.optionsReady === "1", "options-theme-early.js: fail-open overwrote authoritative readiness");

const sourceLocal = { get: defaults => Promise.resolve("optSyncEnabled" in defaults
  ? { optSyncEnabled: false } : { optTheme: "light", themePresetKey: "" }) };
const corrected = runOptionsEarly({ mode: "dark", preset: "dracula", chrome: { storage: { local: sourceLocal } } });
await new Promise(resolve => setImmediate(resolve));
check(corrected.values.get("pp-theme") === "light" && corrected.values.get("pp-theme-preset") === "" &&
  !("theme" in corrected.root.dataset), "options-theme-early.js: authoritative storage did not correct mirror and theme");

const optionsHead = optionsHtml.slice(optionsHtml.indexOf("<head>"), optionsHtml.indexOf("</head>"));
const optionsEarlyTag = '<script src="options-theme-early.js"></script>';
check(optionsHead.indexOf(optionsEarlyTag) >= 0 &&
  optionsHead.indexOf(optionsEarlyTag) < optionsHead.indexOf('<link rel="stylesheet" href="options.css">') &&
  (optionsHtml.match(/options-theme-early\.js/g) || []).length === 1,
  "options.html: theme bootstrap is not one synchronous head script before options.css");
check(/\.container\s*{[\s\S]{0,100}visibility:\s*hidden/.test(optionsCss) &&
  /html\[data-options-ready\]\s+\.container\s*{\s*visibility:\s*visible/.test(optionsCss),
  "options.css: stable first-frame gate is missing");
function inOrder(source, ...parts) {
  let cursor = -1;
  return parts.every(part => (cursor = source.indexOf(part, cursor + 1)) >= 0);
}
const optionsThemeApplyStart = optionsJs.indexOf("function applyOptionsPageTheme");
const optionsThemeApplyEnd = optionsJs.indexOf("// Track active preset key", optionsThemeApplyStart);
const optionsThemeApply = optionsJs.slice(optionsThemeApplyStart, optionsThemeApplyEnd);
check(optionsThemeApply.includes("pbpApplyOptionsEarlyTheme(themeMode, presetKey)") &&
  !optionsThemeApply.includes("pbpStoreOptionsThemeMirror"),
  "options.js: visual theme apply also mutates the persisted mirror");
check(inOrder(optionsJs,
  "Object.entries(fieldMap)", "el.value = val", "Object.entries(checkMap)", "el.checked = val",
  "syncKeysToggle.checked = syncApiKeys", "applyOptionsPageTheme(currentPresetKey, s.optTheme);",
  "pbpStoreOptionsThemeMirror(s.optTheme, currentPresetKey);",
  'document.documentElement.dataset.optionsReady = "1";', "// Language change"),
  "options.js: General values, authoritative theme/mirror, and ready gate are out of order");
check(inOrder(optionsJs, "const res = await persistSettings(data);", "if (!res.ok)",
  "pbpStoreOptionsThemeMirror(data.optTheme, data.themePresetKey);",
  "const overlay = await saveOverlayWithFallback(overlayValue);"),
  "options.js: theme mirror is updated before settings persistence succeeds or after overlay work");

check(/const el = document\.createElement\("button"\);[\s\S]{0,240}el\.className = "stag";/.test(popupTagsJs), "popup-tags.js: suggested tag is not a button");
check(/const aa = document\.createElement\("button"\);[\s\S]{0,240}aa\.className = "add-all-link";/.test(popupTagsJs), "popup-tags.js: add-all is not a button");
check(/const rm = document\.createElement\("button"\);[\s\S]{0,240}rm\.className = "tag-remove";/.test(popupTagsJs), "popup-tags.js: tag remove is not a button");
check(/<button\b(?=[^>]*id="tags-last-used")(?=[^>]*type="button")[^>]*>/.test(popupHtml), "popup.html: #tags-last-used is not a button");

check(/<section\b(?=[^>]*id="batch-permission")(?=[^>]*aria-labelledby="batch-permission-title")[^>]*>/.test(popupHtml) &&
  /<ul\b[^>]*id="batch-permission-list"[^>]*>/.test(popupHtml),
  "popup.html: Batch permission disclosure lacks labelled section/list semantics");
check(["batch-permission-grant", "batch-permission-cancel"].every(id =>
  new RegExp(`<button\\b(?=[^>]*id="${id}")(?=[^>]*type="button")[^>]*>`).test(popupHtml)),
  "popup.html: Batch permission actions are not real buttons");
const batchGrantStart = popupBatchJs.indexOf('grantBtn?.addEventListener("click", async () =>');
const batchGrantEnd = popupBatchJs.indexOf('cancelBtn?.addEventListener', batchGrantStart);
const batchGrant = popupBatchJs.slice(batchGrantStart, batchGrantEnd);
check(batchGrantStart >= 0 && batchGrantEnd > batchGrantStart &&
  batchGrant.indexOf("await chrome.permissions.request({ origins: pending.origins })") === batchGrant.indexOf("await ") &&
  batchGrant.indexOf("await chrome.permissions.request({ origins: pending.origins })") < batchGrant.indexOf("await dispatchBatchSave"),
  "popup-batch.js: Grant does not request the disclosed origins as its first await before starting Batch");
check(!/\bconfirm\s*\(/.test(popupBatchJs) && !popupBatchJs.includes("BATCH_PERMISSION_DISCLOSE_LIMIT") &&
  !popupBatchJs.includes("batchPermMore") && !popupBatchJs.includes("*://*/*"),
  "popup-batch.js: native confirm, truncated disclosure, or broad wildcard remains");
check(/\.batch-permission-list\s*\{[\s\S]*?max-height:\s*92px;[\s\S]*?overflow:\s*auto;/.test(popupCss),
  "popup.css: complete Batch permission list is not bounded with scrolling");

check(/<aside\b(?=[^>]*id="rail")(?=[^>]*aria-labelledby="preview-title")[^>]*>/.test(mdHtml),
  "md-preview.html: mobile drawer is not labelled by the document title");
const drawerSetupStart = mdPreviewJs.indexOf("function setupDrawer()");
const drawerSetupEnd = mdPreviewJs.indexOf("function pbpRailDrawerClose()", drawerSetupStart);
const drawerSetup = mdPreviewJs.slice(drawerSetupStart, drawerSetupEnd);
const drawerCloseEnd = mdPreviewJs.indexOf("function pbpFocusArticleTarget", drawerSetupEnd);
const drawerClose = mdPreviewJs.slice(drawerSetupEnd, drawerCloseEnd);
check(drawerSetupStart >= 0 && drawerSetup.includes("main.inert = true") &&
  drawerSetup.includes('rail.setAttribute("aria-modal", "true")') &&
  drawerSetup.includes("requestAnimationFrame(() =>") &&
  drawerSetup.includes('(document.getElementById("btn-rendered") || rail).focus()') &&
  drawerSetup.includes('window.matchMedia("(max-width: 1000px)").addEventListener("change"') &&
  drawerSetup.includes("if (!e.matches) pbpRailDrawerClose()"),
"md-preview.js: drawer open/breakpoint state does not manage modal inertness");
check(drawerClose.includes('document.body.classList.remove("rail-open")') &&
  drawerClose.includes("scrim.hidden = true") && drawerClose.includes('rail.removeAttribute("aria-modal")') &&
  drawerClose.includes("main.inert = false"),
"md-preview.js: shared drawer close does not clear every modal state");
const focusTargetEnd = mdPreviewJs.indexOf("// In tr-only mode", drawerCloseEnd);
const focusTarget = mdPreviewJs.slice(drawerCloseEnd, focusTargetEnd);
check(focusTarget.includes("pbpRailDrawerClose()") && focusTarget.includes("target.focus({ preventScroll: true })") &&
  mdPreviewJs.includes("pbpFocusArticleTarget(target);") &&
  mdAskJs.includes("pbpFocusArticleTarget(target);") &&
  (mdHighlightJs.match(/pbpFocusArticleTarget\(/g) || []).length >= 2,
"md-preview: TOC, Ask citations, and Notebook do not share visible-target focus recovery");

const askOpen = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskSetOpen"), mdAskJs.indexOf("// Clear:", mdAskJs.indexOf("function _pbpAskSetOpen")));
check(askOpen.includes("drawerWasOpen") && askOpen.includes("pbpRailDrawerClose()") &&
  askOpen.includes('document.getElementById("rail-toggle")') && askOpen.includes("getBoundingClientRect()") &&
  askOpen.includes('document.getElementById("ask-open")') && askOpen.includes(".find(isVisible)"),
"md-ask.js: opening Ask from the drawer leaves a hidden opener/focus target");
const askError = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskErrorUi"), mdAskJs.indexOf("// Core runner", mdAskJs.indexOf("function _pbpAskErrorUi")));
check(askError.indexOf("aEl.focus()") >= 0 && askError.indexOf("aEl.focus()") < askError.indexOf("aEl.replaceChildren()"),
  "md-ask.js: Ask retry removes its focused button before focus handoff");
const askClear = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskShowClearConfirm"), mdAskJs.indexOf("// ---- Restore persisted", mdAskJs.indexOf("function _pbpAskShowClearConfirm")));
check(askClear.indexOf("input.focus()") < askClear.indexOf("strip.remove()") &&
  askClear.indexOf("clearBtn.focus()") < askClear.lastIndexOf("strip.remove()"),
"md-ask.js: clear confirmation removes the focused action before focus handoff");
const askRegenerate = mdAskJs.slice(mdAskJs.indexOf("function _pbpAskRegenerate"), mdAskJs.indexOf("// ---- Clear:", mdAskJs.indexOf("function _pbpAskRegenerate")));
check(askRegenerate.indexOf("el.focus()") >= 0 && askRegenerate.indexOf("el.focus()") < askRegenerate.indexOf("el.replaceChildren()"),
  "md-ask.js: regenerate removes its focused button before focus handoff");
const skimRegenFocus = mdSkimJs.slice(mdSkimJs.indexOf("async function _pbpSkimRegen"), mdSkimJs.indexOf("// Init hookup", mdSkimJs.indexOf("async function _pbpSkimRegen")));
check(skimRegenFocus.indexOf("body.focus()") >= 0 && skimRegenFocus.indexOf("body.focus()") < skimRegenFocus.indexOf("body.replaceChildren()"),
  "md-skim.js: retry removes its focused button before focus handoff");
const explainRun = mdAskJs.slice(mdAskJs.indexOf("async function _pbpExplainRun"), mdAskJs.indexOf("// ---- Explain: open", mdAskJs.indexOf("async function _pbpExplainRun")));
check(explainRun.indexOf("body.focus()") >= 0 && explainRun.indexOf("body.focus()") < explainRun.indexOf("body.replaceChildren()"),
  "md-ask.js: Explain retry removes its focused button before focus handoff");

const articleInject = mdPreviewJs.indexOf("renderedView.innerHTML = renderedHtml");
const firstProgressQueue = mdPreviewJs.indexOf("queueReadingStats();", articleInject);
check(articleInject >= 0 && firstProgressQueue > articleInject &&
  !mdPreviewJs.slice(mdPreviewJs.indexOf("// Reading stats"), articleInject).includes("renderStats();") &&
  mdPreviewJs.includes("new ResizeObserver(queueReadingStats).observe(renderedView)"),
"md-preview.js: reading progress is measured before article layout or not refreshed after layout changes");

// i18n substitutions ride t()/getMessage() ARGS, never a manual replace on
// the result: for any messages.json key carrying a "placeholders" block,
// chrome.i18n.getMessage (the t() fallback in auto-language mode) consumes
// $NAME$ placeholders BEFORE a manual replace could see them -- the value
// silently rendered empty (mdEmbedPartial counts and the reading-progress
// percent shipped blank for every auto-language user until 2026-07). The
// pattern bans ANY literal $NAME$ manual replace/replaceAll in root JS
// (Codex cross-audit: anchoring on the t(...) call missed nested-paren args,
// a variable between call and replace, and replaceAll); $NAME$ syntax exists
// only for i18n placeholders here, and the safe {name}-token replaces on
// placeholder-less keys don't match.
for (const f of readdirSync(root).filter((n) => n.endsWith(".js"))) {
  const m = read(f).match(/\.replace(?:All)?\(\s*["'`]\$[A-Za-z_]\w*\$["'`]\s*,/);
  check(!m, `${f}: literal $NAME$ manual replace -- pass substitutions as t() args instead -> ${m && m[0]}`);
}
// applyI18n (i18n.js) can never supply substitutions, so a placeholders key
// wired to a data-i18n* attribute renders empty (auto mode) or as a literal
// $NAME$ (manual language) -- the intersection must stay empty.
// Plus a HEURISTIC dead-key smoke check: every placeholders key's string
// literal must appear somewhere in root JS/HTML (batchSavedNotify survived
// the batch-to-SW migration by a year). Heuristic by design: a comment can
// satisfy it and it doesn't verify arg counts -- the runtime audit for that
// was done by hand (Codex-verified, 2026-07); this just catches key deletions
// and renames going stale.
{
  const enMessages = JSON.parse(read("_locales/en/messages.json"));
  const phKeys = Object.entries(enMessages).filter(([, d]) => d && d.placeholders).map(([k]) => k);
  const htmlSrc = readdirSync(root).filter((n) => n.endsWith(".html")).map(read).join("\n");
  const allSrc = readdirSync(root).filter((n) => n.endsWith(".js")).map(read).join("\n") + htmlSrc;
  for (const key of phKeys) {
    check(!new RegExp(`data-i18n[a-z-]*="${key}"`).test(htmlSrc),
      `md/popup/options HTML: placeholders key "${key}" bound via data-i18n* (applyI18n cannot pass substitutions)`);
    check(allSrc.includes(`"${key}"`), `_locales/en: placeholders key "${key}" has no call site in any root JS/HTML (dead key across 9 locales?)`);
  }
}

// ---- Reader typography invariants (plan B, the four defects Codex acceptance
// reproduced live -- each check encodes one so it cannot silently return;
// .qa-scan/typo-export-probe.mjs is the manual behavioral deep-probe, this is
// the per-verify gate). ----
const mdCss = read("md-preview.css");
const mdReaderJs = read("md-reader.js");
// (1) Load race: the tier maps/apply MUST live in shared.js (loaded before
// md-preview.js), never in the later md-reader.js defer script; and the
// pre-render read in md-preview.js must fetch the tier keys with the payload.
check(sharedJs.includes("function pbpTypoApplyVars") && sharedJs.includes("PBP_TYPO_FONT_SCALES"),
  "shared.js: typography tier maps/apply moved out (md-preview.js pre-render apply would race again)");
check(!mdReaderJs.includes("function pbpTypoApplyVars") && !mdReaderJs.includes("PBP_TYPO_FONT_SCALES ="),
  "md-reader.js: re-defines typography maps/apply (load-order race: it loads AFTER md-preview.js)");
{
  // Both indexes checked >= 0 explicitly: a DELETED apply call returns -1,
  // and -1 < renderAt would sail through the bare comparison (Codex final
  // review) -- the gate must catch removal, not just reordering.
  const applyAt = mdPreviewJs.indexOf("pbpTypoApplyVars(");
  const renderAt = mdPreviewJs.indexOf("renderedView.innerHTML = renderedHtml");
  check(mdPreviewJs.includes('"pbp_font_tier", "pbp_leading_tier"]') &&
    applyAt >= 0 && renderAt >= 0 && applyAt < renderAt,
    "md-preview.js: typography tiers not applied before the first render (rode the MP_KEY read)");
}
// (2) Scroll grab: tier changes settle the anchor SYNCHRONOUSLY -- the 300ms
// second phase belongs to the width path's max-width transition only.
{
  const typoSet = mdReaderJs.slice(mdReaderJs.indexOf("function _pbpTypoSet"), mdReaderJs.indexOf("function _pbpTypoSyncPop"));
  check(typoSet.includes("_pbpZenSettleAnchor(anchor)") && !typoSet.includes("_pbpZenSettleAfterLayout"),
    "md-reader.js: _pbpTypoSet uses the delayed two-phase settle (drags a user scroll back within 300ms)");
  check(mdReaderJs.includes("if (window.scrollY === 0) return null;"),
    "md-reader.js: _pbpZenCaptureAnchor lost the scrollY=0 guard (layout change at page top scrolls the reader)");
}
// (3) h4-h6 stay pinned while p/li follow the leading tier.
{
  // font-size anchor skips the h1-h6 text-wrap:balance rule, whose second
  // line starts with the same "#rendered-view h4, ..." selector text.
  check(/#rendered-view h4, #rendered-view h5, #rendered-view h6 \{[^}]*font-size: 1em;[^}]*line-height: 1\.75;/.test(mdCss),
    "md-preview.css: h4-h6 lost their pinned line-height (they'd follow the prose leading tier)");
  check((mdCss.match(/line-height: var\(--pbp-prose-leading, 1\.75\)/g) || []).length >= 3,
    "md-preview.css: the prose leading var no longer covers container+p+li");
}
// (4) Print: the consolidated open-popover hide must sit AFTER every
// ':popover-open { display: flex }' base rule (equal (1,1,0) specificity --
// source order decides, media queries add none) and must cover every popover.
{
  const lastFlex = mdCss.lastIndexOf(":popover-open { display: flex; }");
  const hideBlock = mdCss.indexOf("#explain-pop:popover-open, #pb-hl-bar:popover-open");
  check(hideBlock > lastFlex && hideBlock !== -1,
    "md-preview.css: consolidated print popover-hide block is missing or precedes a ':popover-open{display:flex}' base rule (open popovers print again)");
  const popIds = [...mdCss.matchAll(/#([a-z-]+):popover-open \{ display: flex; \}/g)].map((m) => m[1]);
  const hideRule = mdCss.slice(hideBlock, mdCss.indexOf("}", hideBlock));
  for (const id of popIds) {
    check(hideRule.includes(`#${id}:popover-open`), `md-preview.css: popover #${id} missing from the consolidated print hide (prints when open)`);
  }
}
// text-autospace must keep exempting the character grid.
check(mdCss.includes("text-autospace: normal") && /#rendered-view :is\(pre, code, kbd, samp\) \{\s*\n\s*text-autospace: no-autospace;/.test(mdCss),
  "md-preview.css: text-autospace code/pre exemption lost (autospace widens code glyph runs next to CJK)");

// ---- A4: export reuse of the preview fix cache (Codex-adjudicated). Scoped
// to the resolveEmbed function body, not the whole file. ----
{
  const embedFn = mdPreviewJs.slice(mdPreviewJs.indexOf("async function resolveEmbed"), mdPreviewJs.indexOf("// Fill header"));
  // The partition is synchronous and sits BEFORE the permission prompt --
  // chrome.permissions.request must stay the click chain's FIRST await, and a
  // full cache hit must reach zero-prompt/zero-network without ever asking.
  const partAt = embedFn.indexOf("pbpEmbedCacheEntryValid(");
  const permAt = embedFn.indexOf("chrome.permissions.request");
  check(partAt >= 0 && permAt >= 0 && partAt < permAt,
    "md-preview.js: resolveEmbed cache partition missing or moved after the permission prompt (first-await gesture invariant)");
  // The hotlink retry draws failures from the NETWORK list only: cache hits
  // and budget-dropped entries must never reach the DNR retry round.
  check(embedFn.includes("toFetch.filter((u) => !fetched.has(u))") &&
    !embedFn.includes("scan.candidates.filter((u) => !fetched.has(u))"),
    "md-preview.js: resolveEmbed retry round no longer scoped to the network list (cache/budget-dropped urls would refetch)");
}

if (fail.length) {
  console.error(fail.join("\n"));
  process.exit(1);
}
console.log("ui contract ok");
