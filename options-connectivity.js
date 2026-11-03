// ============================================================
// Options page — API connectivity tests (AI providers + Pinboard token).
// Exposes setupApiTests(); options.js calls it after DOMContentLoaded.
//
// Self-contained: depends only on globals (callAI, hasAIKey, t, $id, chrome).
// ============================================================

function pbpLiveAiSettingsSnapshot(provider) {
  function getOptVal(id, fallback) { return $id(id)?.value?.trim() || fallback || ""; }
  const out = {
    aiProvider: provider,
    geminiApiKey: getOptVal("opt-gemini-key"), geminiModel: getOptVal("opt-gemini-model", "gemini-3.5-flash-lite"),
    openaiApiKey: getOptVal("opt-openai-key"), openaiModel: getOptVal("opt-openai-model", "gpt-5.4-nano"), openaiBaseUrl: getOptVal("opt-openai-baseurl", "https://api.openai.com/v1"),
    claudeApiKey: getOptVal("opt-claude-key"), claudeModel: getOptVal("opt-claude-model", "claude-haiku-4-5"),
    deepseekApiKey: getOptVal("opt-deepseek-key"), deepseekModel: getOptVal("opt-deepseek-model", "deepseek-v4-flash"),
    qwenApiKey: getOptVal("opt-qwen-key"), qwenModel: getOptVal("opt-qwen-model", "qwen-flash"),
    // The default only stands in for a missing element: a select showing no
    // option ("", a region this version does not know) is passed through so
    // the resolver fails it closed instead of testing Beijing.
    qwenRegion: $id("opt-qwen-region")?.value ?? "beijing", qwenWorkspaceId: getOptVal("opt-qwen-workspace"),
    minimaxApiKey: getOptVal("opt-minimax-key"), minimaxModel: getOptVal("opt-minimax-model", "MiniMax-M2"),
    openrouterApiKey: getOptVal("opt-openrouter-key"), openrouterModel: getOptVal("opt-openrouter-model", "openai/gpt-oss-20b"),
    ollamaBaseUrl: getOptVal("opt-ollama-baseurl", "http://localhost:11434"), ollamaModel: getOptVal("opt-ollama-model", "llama3.2"),
    groqApiKey: getOptVal("opt-groq-key"), groqModel: getOptVal("opt-groq-model", "openai/gpt-oss-20b"),
    mistralApiKey: getOptVal("opt-mistral-key"), mistralModel: getOptVal("opt-mistral-model", "mistral-small-latest"),
    cohereApiKey: getOptVal("opt-cohere-key"), cohereModel: getOptVal("opt-cohere-model", "command-r7b-12-2024"),
    siliconflowApiKey: getOptVal("opt-siliconflow-key"), siliconflowModel: getOptVal("opt-siliconflow-model", "Qwen/Qwen3-8B"),
    zhipuApiKey: getOptVal("opt-zhipu-key"), zhipuModel: getOptVal("opt-zhipu-model", "glm-4.7-flash"),
    kimiApiKey: getOptVal("opt-kimi-key"), kimiModel: getOptVal("opt-kimi-model", "kimi-k2.6"),
    // Region and format selects pass "" through like the Model Studio region.
    arkApiKey: getOptVal("opt-ark-key"), arkModel: getOptVal("opt-ark-model", "doubao-seed-2-0-mini-260428"),
    arkRegion: $id("opt-ark-region")?.value ?? "cn",
    opencodeApiKey: getOptVal("opt-opencode-key"), opencodeModel: getOptVal("opt-opencode-model", "glm-5.3-flash"),
    opencodeProtocol: $id("opt-opencode-protocol")?.value ?? "openai",
    commandcodeApiKey: getOptVal("opt-commandcode-key"), commandcodeModel: getOptVal("opt-commandcode-model", "deepseek/deepseek-v4-flash"),
    commandcodeProtocol: $id("opt-commandcode-protocol")?.value ?? "openai",
    customApiKey: getOptVal("opt-custom-key"), customModel: getOptVal("opt-custom-model"), customBaseUrl: getOptVal("opt-custom-baseurl"),
  };
  // The custom entries' unsaved edits live in the editor model, not in the
  // shared panel's fields (which show one entry at a time).
  if (pbpOptAiCustomEditorState) Object.assign(out, pbpOptAiCustomSnapshot(pbpOptAiCustomEditorState));
  return out;
}

// ============================================================
// Custom AI provider entries: the Settings editor model.
// One shared #fields-custom panel edits every entry ("custom" = slot 1 plus
// the aiCustomProviders list), so each entry's unsaved values are held here,
// keyed by id, and the panel is refilled on every switch. Pure functions and
// two small DOM helpers; test pages load this file directly.
// ============================================================
let pbpOptAiCustomEditorState = null;
// setupApiTests' field-mark helpers, published for options.js.
let pbpOptMarkFieldInvalid = null;
let pbpOptClearFieldInvalid = null;
// Entry ids whose Test is in flight; the shared Test button follows the
// entry on screen.
const pbpAiTestInflight = new Set();

const PBP_OPT_AI_CUSTOM_FIELDS = ["name", "protocol", "baseUrl", "model", "key"];

function _pbpOptAiCustomBlank() {
  return { id: "custom", name: "", protocol: "openai", baseUrl: "", model: "", slot: 1, key: "", keyRebind: false, keyTouched: false };
}

// The editor model of one settings read. "custom" always has a draft (blank
// when unused) because its five keys are always written; it is in `order`
// only when pbpAiCustomEntries counts it. List entries keep their stored
// field values as read -- an enum this version does not know round-trips
// untouched (R7), since only pbpOptAiCustomUpdate writes a draft. A list
// whose entries cannot be told apart (no valid unique id and slot) is
// `locked`: it is shown as far as it can be read and never written back.
function pbpOptAiCustomState(s) {
  const st = s || {};
  const state = { drafts: {}, order: [], rawSlots: {}, freedSlots: new Set(), locked: false };
  for (const slot of PBP_AI_CUSTOM_SLOTS) {
    const raw = st[pbpAiCustomKeyField(slot)];
    state.rawSlots[slot] = typeof raw === "string" ? raw : "";
  }
  const custom = _pbpOptAiCustomBlank();
  if (typeof st.customDisplayName === "string") custom.name = st.customDisplayName;
  if (st.customProtocol !== undefined) custom.protocol = st.customProtocol;
  custom.baseUrl = typeof st.customBaseUrl === "string" ? st.customBaseUrl : "";
  custom.model = typeof st.customModel === "string" ? st.customModel : "";
  custom.key = deobfuscateKey(typeof st.customApiKey === "string" ? st.customApiKey : "") || "";
  state.drafts.custom = custom;
  if (pbpAiCustomEntries(st).some((e) => e.id === "custom")) state.order.push("custom");
  const list = st.aiCustomProviders;
  if (list !== undefined && !Array.isArray(list)) state.locked = true;
  const slots = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    const ok = e && typeof e === "object" && !Array.isArray(e) && pbpAiCustomEntryIdOk(e.id) && !state.drafts[e.id]
      && PBP_AI_CUSTOM_SLOTS.includes(e.slot) && !slots.has(e.slot);
    if (!ok) { state.locked = true; continue; }
    slots.add(e.slot);
    const key = pbpAiCustomKeyOpen(st, e);
    state.drafts[e.id] = {
      id: e.id, name: e.name, protocol: e.protocol, baseUrl: e.baseUrl, model: e.model, slot: e.slot,
      key, keyRebind: state.rawSlots[e.slot] !== "" && key === "", keyTouched: false,
    };
    state.order.push(e.id);
  }
  return state;
}

function pbpOptAiCustomOrder(state) {
  return state ? state.order.slice() : [];
}

// A new entry: the unused "custom" slot first, else custom-xxxxxx in a free
// key slot. The id's six characters come from crypto bytes by rejection
// sampling (a byte >= 252 would bias % 36); a short or colliding draw is
// retried a bounded number of times. null when full or no id was found.
function pbpOptAiCustomAdd(state, { randomBytes, defaultName }) {
  if (!state || state.order.length >= PBP_AI_CUSTOM_MAX) return null;
  const nameFor = () => {
    const taken = new Set(state.order.map((id) => String(state.drafts[id].name).trim()));
    for (let n = state.order.length + 1; ; n++) {
      const name = String(defaultName(n)).trim().slice(0, 40);
      if (!taken.has(name)) return name;
    }
  };
  if (!state.order.includes("custom")) {
    const draft = state.drafts.custom;
    Object.assign(draft, { name: nameFor(), protocol: "openai", keyRebind: false });
    state.order.unshift("custom");
    return "custom";
  }
  if (state.locked) return null;
  const used = new Set(state.order.filter((id) => id !== "custom").map((id) => state.drafts[id].slot));
  const free = PBP_AI_CUSTOM_SLOTS.filter((slot) => !used.has(slot));
  const slot = free.find((n) => state.rawSlots[n] === "") ?? free[0];
  if (slot === undefined) return null;
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = null;
  for (let attempt = 0; attempt < 8 && !id; attempt++) {
    let text = "";
    for (const b of randomBytes(16)) {
      if (b < 252) text += alphabet[b % 36];
      if (text.length === 6) break;
    }
    const candidate = "custom-" + text;
    if (text.length === 6 && candidate !== "custom" && !state.drafts[candidate]) id = candidate;
  }
  if (!id) return null;
  state.freedSlots.delete(slot);
  // An orphan slot (a key whose entry is gone) is taken over empty, so the
  // new entry neither inherits it nor warns about it; the save writes "".
  if (state.rawSlots[slot] !== "") {
    state.rawSlots[slot] = "";
    state.freedSlots.add(slot);
  }
  state.drafts[id] = { id, name: nameFor(), protocol: "openai", baseUrl: "", model: "", slot, key: "", keyRebind: false, keyTouched: false };
  state.order.push(id);
  return id;
}

// Delete an entry: "custom" goes back to blank (its keys are cleared on the
// next save); a list entry's slot is freed and written "" on the next save.
function pbpOptAiCustomRemove(state, id) {
  if (!state || !state.drafts[id]) return false;
  if (id === "custom") {
    state.drafts.custom = Object.assign(_pbpOptAiCustomBlank(), { keyTouched: true });
  } else {
    if (state.locked) return false;
    const { slot } = state.drafts[id];
    delete state.drafts[id];
    state.freedSlots.add(slot);
    state.rawSlots[slot] = "";
  }
  state.order = state.order.filter((x) => x !== id);
  return true;
}

// Write one field of one draft, but only a value the list sanitizer would
// accept (the same Task 5 predicates, R3): a refused value is not written and
// the last accepted one stays. Names, addresses and models are stored
// trimmed. "custom" may have no name (shown as the generic custom name).
function pbpOptAiCustomUpdate(state, id, field, value) {
  const draft = state && state.drafts[id];
  if (!draft || !PBP_OPT_AI_CUSTOM_FIELDS.includes(field)) return false;
  if (id !== "custom" && state.locked) return false;
  const text = typeof value === "string" ? value.trim() : "";
  if (field === "protocol") {
    if (!PBP_AI_PROTOCOLS.includes(value)) return false;
    draft.protocol = value;
  } else if (field === "name") {
    if (!((id === "custom" && text === "") || pbpAiCustomNameOk(text))) return false;
    draft.name = text;
  } else if (field === "baseUrl") {
    if (!(text === "" || pbpAiCustomBaseUrlOk(text))) return false;
    draft.baseUrl = text;
  } else if (field === "model") {
    if (!pbpAiCustomModelOk(text)) return false;
    draft.model = text;
  } else {
    draft.key = text;
    draft.keyTouched = true;
    draft.keyRebind = false;
  }
  return true;
}

// The settings this editor owns, ready to save: the five "custom" keys, the
// list in display order, each occupied slot's key sealed to its entry (an
// entry with no usable key keeps the slot's stored value unless its key was
// edited), and "" for slots freed in this session. Other slots are left out
// so the save writes nothing there. A locked list writes neither the list
// nor its slots.
function pbpOptAiCustomCollect(state) {
  // No editor (the settings never loaded): write none of the custom keys.
  if (!state) return {};
  const c = state.drafts.custom;
  const out = {
    customDisplayName: c.name, customProtocol: c.protocol,
    customBaseUrl: c.baseUrl, customApiKey: obfuscateKey(c.key), customModel: c.model,
  };
  if (state.locked) return out;
  out.aiCustomProviders = [];
  for (const id of state.order) {
    if (id === "custom") continue;
    const d = state.drafts[id];
    const entry = { id: d.id, name: d.name, protocol: d.protocol, baseUrl: d.baseUrl, model: d.model, slot: d.slot };
    out.aiCustomProviders.push(entry);
    const sealed = d.key ? pbpAiCustomKeySeal(entry, d.key) : "";
    // A typed key that cannot be sealed yet (no valid address, or a format
    // this version does not know) must not wipe what is stored: only an
    // actual clear writes "".
    const keep = d.key && !sealed;
    out[pbpAiCustomKeyField(d.slot)] = sealed || (d.keyTouched && !keep ? "" : state.rawSlots[d.slot]);
  }
  for (const slot of state.freedSlots) {
    const field = pbpAiCustomKeyField(slot);
    if (!(field in out)) out[field] = "";
  }
  return out;
}

// The same settings as live values for a Test or a configured-provider
// check: plain keys, envelopes deobfuscated.
function pbpOptAiCustomSnapshot(state) {
  const out = pbpOptAiCustomCollect(state);
  out.customApiKey = state.drafts.custom.key;
  for (const slot of PBP_AI_CUSTOM_SLOTS) {
    const field = pbpAiCustomKeyField(slot);
    if (field in out) out[field] = deobfuscateKey(out[field]);
  }
  return out;
}

function pbpOptAiCustomLabel(state, id) {
  const d = state && state.drafts[id];
  const name = d && typeof d.name === "string" ? d.name.trim() : "";
  return name || (typeof t === "function" ? t("provCustomShort") : "Custom");
}

// Write an entry's label into `el`. The fallback label is interface text and
// carries data-i18n, so a later language load (applyI18n) re-translates it;
// a name the user gave is left alone.
function _pbpOptAiCustomLabelInto(el, state, id) {
  const d = state && state.drafts[id];
  const named = !!(d && typeof d.name === "string" && d.name.trim());
  if (named) el.removeAttribute("data-i18n");
  else el.setAttribute("data-i18n", "provCustomShort");
  el.textContent = pbpOptAiCustomLabel(state, id);
}

// Delete an entry and settle the page around it, in this order: remove it,
// pick the provider (the current one, or when the deleted entry WAS current
// the first configured provider in `order` without it, else gemini), apply
// that provider -- which stashes the outgoing provider's reader model under
// the deleted id -- then drop that stash and the entry's health record.
function pbpOptAiCustomDeleteEntry({ state, id, current, snapshot, order, ollamaGranted, previewModelMap, applyProvider, forgetHealth }) {
  if (!pbpOptAiCustomRemove(state, id)) return null;
  const next = current === id
    ? (pbpAiFirstConfiguredProvider(snapshot(), new Set([id]), { ollamaGranted, order }) || "gemini")
    : current;
  applyProvider(next);
  if (previewModelMap) delete previewModelMap[id];
  forgetHealth("ai:" + id);
  return next;
}

// The DOM id stem a provider's controls use: every custom entry shares the
// "custom" panel.
function pbpOptAiDomId(provider) {
  return provider === "custom" || pbpAiCustomEntryIdOk(provider) ? "custom" : provider;
}

// The custom entry the provider picker is on, or "".
function pbpOptAiCustomActiveId() {
  const value = $id("opt-ai-provider")?.value || "";
  return pbpOptAiDomId(value) === "custom" ? value : "";
}

// List the entries in the provider picker: the static "custom" option shows
// while that entry exists (or is selected), each list entry gets an option
// named by textContent, and a stored provider this device cannot resolve
// keeps the picker's value through a placeholder option instead of turning
// into "" (which a save would write back). A group with nothing visible is
// hidden. `current` is the value the picker must keep.
function pbpOptAiCustomRenderOptions(select, state, current) {
  if (!select) return;
  const stat = select.querySelector('option[value="custom"]');
  const group = stat ? stat.parentElement : select;
  for (const o of select.querySelectorAll("option[data-ai-custom-entry],option[data-provider-unavailable]")) o.remove();
  if (stat) {
    stat.hidden = !(state.order.includes("custom") || current === "custom");
    _pbpOptAiCustomLabelInto(stat, state, "custom");
  }
  for (const id of state.order) {
    if (id === "custom") continue;
    const opt = document.createElement("option");
    opt.value = id;
    _pbpOptAiCustomLabelInto(opt, state, id);
    opt.setAttribute("data-ai-custom-entry", "");
    group.appendChild(opt);
  }
  const value = typeof current === "string" ? current : "";
  if (value && /^[a-z][a-z0-9_-]{0,31}$/.test(value) && ![...select.options].some((o) => o.value === value)) {
    const ph = document.createElement("option");
    ph.value = value;
    ph.textContent = typeof t === "function" ? t("aiProviderUnavailable") : value;
    ph.setAttribute("data-i18n", "aiProviderUnavailable");
    ph.setAttribute("data-provider-unavailable", "");
    group.appendChild(ph);
  }
  for (const g of select.querySelectorAll("optgroup")) g.hidden = ![...g.children].some((o) => !o.hidden);
  select.value = value;
}

// The parts of the panel that follow an entry's format: the base URL hint
// (which path is appended) and the unknown-format warning.
function pbpOptAiCustomSyncFormat(state, id) {
  const d = state && state.drafts[id];
  if (!d) return;
  const hint = $id("hint-custom-baseurl");
  if (hint) {
    const key = d.protocol === "anthropic" ? "hintCustomBaseUrlAnthropic" : "hintCustomBaseUrl";
    hint.setAttribute("data-i18n", key);
    hint.textContent = t(key);
  }
  const warn = $id("ai-custom-protocol-warn");
  if (warn) warn.hidden = PBP_AI_PROTOCOLS.includes(d.protocol);
}

// True while a list entry holds a typed key that cannot be sealed yet (the
// address is empty or invalid, or the format is unknown to this version).
function pbpOptAiCustomKeyUnsealed(state, id) {
  const d = state && state.drafts[id];
  if (!d || id === "custom" || !d.key) return false;
  const entry = { id: d.id, name: d.name, protocol: d.protocol, baseUrl: d.baseUrl, model: d.model, slot: d.slot };
  return !pbpAiCustomKeySeal(entry, d.key);
}

function pbpOptAiCustomSyncKeyHint(state, id) {
  const hint = $id("ai-custom-key-pending");
  if (hint) hint.hidden = !pbpOptAiCustomKeyUnsealed(state, id);
}

// Add and Delete are unavailable while the stored list could not be read
// (locked) or when the limit is reached; the matching hint says why.
function pbpOptAiCustomSyncActions(state) {
  const add = $id("add-custom-provider");
  const del = $id("delete-custom-entry");
  const limitHint = $id("ai-custom-limit-hint");
  const lockedHint = $id("ai-custom-locked-hint");
  const locked = !!(state && state.locked);
  const full = !state || state.order.length >= PBP_AI_CUSTOM_MAX;
  if (add) {
    add.disabled = full || locked;
    const why = locked ? "ai-custom-locked-hint" : full ? "ai-custom-limit-hint" : "";
    if (why) add.setAttribute("aria-describedby", why);
    else add.removeAttribute("aria-describedby");
  }
  if (del) {
    del.disabled = locked;
    if (locked) del.setAttribute("aria-describedby", "ai-custom-locked-hint");
    else del.removeAttribute("aria-describedby");
  }
  if (limitHint) limitHint.hidden = !full || locked;
  if (lockedHint) lockedHint.hidden = !locked;
}

// Fill the shared panel with one entry's draft. false when there is none.
function pbpOptAiCustomFillPanel(state, id) {
  const d = state && state.drafts[id];
  if (!d) return false;
  const set = (elId, v) => { const el = $id(elId); if (el) el.value = typeof v === "string" ? v : ""; };
  const fields = ["opt-custom-name", "opt-custom-protocol", "opt-custom-baseurl", "opt-custom-key", "opt-custom-model"];
  for (const elId of fields) {
    const el = $id(elId);
    if (el && pbpOptClearFieldInvalid) pbpOptClearFieldInvalid(el);
  }
  const protoBtn = $id("opt-custom-protocol-btn");
  if (protoBtn && pbpOptClearFieldInvalid) pbpOptClearFieldInvalid(protoBtn);
  set("opt-custom-name", d.name);
  // A format this version does not know shows no option, like a region.
  set("opt-custom-protocol", PBP_AI_PROTOCOLS.includes(d.protocol) ? d.protocol : "");
  set("opt-custom-baseurl", d.baseUrl);
  set("opt-custom-key", d.key);
  set("opt-custom-model", d.model);
  const title = $id("fields-custom-title");
  if (title) _pbpOptAiCustomLabelInto(title, state, id);
  pbpOptAiCustomSyncFormat(state, id);
  const rebind = $id("ai-custom-key-rebind");
  if (rebind) rebind.hidden = !d.keyRebind;
  pbpOptAiCustomSyncKeyHint(state, id);
  for (const warn of ["ai-custom-name-invalid", "ai-custom-baseurl-invalid", "ai-custom-model-invalid"]) {
    const el = $id(warn);
    if (el) el.hidden = true;
  }
  const status = $id("test-custom-status");
  if (status) {
    status.textContent = "";
    status.classList.remove("ok", "bad", "pending", "warn");
  }
  const test = $id("test-custom");
  if (test) test.disabled = pbpAiTestInflight.has(id);
  if (typeof window !== "undefined") window.pbpListboxSync?.($id("opt-custom-protocol"));
  return true;
}

function setupApiTests() {

  function recordHealth(id, ok, code) {
    if (typeof pbpRecordConnectionHealth !== "function") return;
    pbpRecordConnectionHealth(id, ok, code).catch((e) => {
      console.warn("[connection-health] record failed:", e?.name, e?.message);
    });
  }

  // State lives in classes only. An inline `style.color` outranks every themed
  // rule, so the old hardcoded #888/#080/#c00 stayed put on the dark presets --
  // #c00 measured 1.71:1 on Nord Night. .save-status.pending/.ok/.bad carry the
  // themed tokens instead; setStatusIcon() owns .ok/.bad, these own .pending
  // and .warn.
  function setStatusPending(statusEl, text) {
    if (!statusEl) return;
    statusEl.classList.remove("ok", "bad", "warn");
    statusEl.classList.add("pending");
    statusEl.textContent = text;
  }
  function setStatusResult(statusEl, ok, text) {
    if (!statusEl) return;
    statusEl.classList.remove("pending", "warn");
    setStatusIcon(statusEl, ok, text);
  }
  // A third tier beside the two setStatusIcon knows: the target itself answered,
  // but a setting that depends on it did not (K96 -- the Reader's per-provider
  // model override). .ok would put a green tick over the word "failed"; .bad
  // would paint "this API key is broken" over a provider that just replied.
  // Reuses the --opt-warn role the export targets' .et-test-status.warn already
  // carries, so no new colour enters the surface.
  function setStatusWarn(statusEl, text) {
    if (!statusEl) return;
    statusEl.classList.remove("pending", "ok", "bad");
    statusEl.classList.add("warn");
    const ic = document.createElement("span");
    ic.className = "status-ic warn";
    ic.innerHTML = PBP_ICONS.warning;
    statusEl.replaceChildren(ic, document.createTextNode(" " + (text != null ? String(text) : "")));
  }

  // A failure that is about one field (no key, a malformed or rejected token)
  // marks that field invalid, points its description at the line that says
  // why, and hands focus back, so the fix starts where the problem is. The
  // next edit clears the mark. A field's own description (the Model Studio
  // region and workspace fields carry hints and a standing warning) is set
  // aside while the failure reason describes it, and put back when it clears.
  // `focus: false` marks a field the user is leaving without pulling focus back.
  function markFieldInvalid(field, reasonId, { focus = true } = {}) {
    if (!field) return;
    if (!field.dataset.invalidMarked) field.dataset.prevDescribedby = field.getAttribute("aria-describedby") || "";
    field.dataset.invalidMarked = "1";
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", reasonId);
    if (focus) field.focus();
    // A list box's button (listbox.js: "<select id>-btn") clears when its
    // select changes; a text field clears on input.
    const select = field.id.endsWith("-btn") ? $id(field.id.slice(0, -4)) : null;
    if (select && select.tagName === "SELECT") select.addEventListener("change", () => clearFieldInvalid(field), { once: true });
    else field.addEventListener("input", () => clearFieldInvalid(field), { once: true });
  }
  function clearFieldInvalid(field) {
    if (!field || !field.dataset.invalidMarked) return;
    const prev = field.dataset.prevDescribedby || "";
    delete field.dataset.invalidMarked;
    delete field.dataset.prevDescribedby;
    field.removeAttribute("aria-invalid");
    if (prev) field.setAttribute("aria-describedby", prev);
    else field.removeAttribute("aria-describedby");
    if (field === tokenInput) validateTokenField();
  }
  pbpOptMarkFieldInvalid = markFieldInvalid;
  pbpOptClearFieldInvalid = clearFieldInvalid;

  // Only a SUCCESSFUL result is wiped by a timer. A failure is the one line the
  // user has to read and usually copy -- the provider's own error body, the
  // model_not_found hint, the rejected origin -- so it stays on screen until the
  // next run for that target overwrites it (every run opens with
  // cancelStatusClear + setStatusPending, so failures replace, never pile up).
  // Held anonymously, a pending clear fires in the middle of the NEXT run for
  // the same target and erases a real result off screen; keyed by target, each
  // run cancels its predecessor's clear before scheduling its own.
  const _testClearTimers = new Map();
  function cancelStatusClear(key) {
    clearTimeout(_testClearTimers.get(key));
    _testClearTimers.delete(key);
  }
  // `live` (optional) says whether the status line still belongs to `key`:
  // the custom entries share one line, so a clear for an entry the panel no
  // longer shows must not wipe the entry now on screen.
  function scheduleStatusClear(key, statusEl, ms, live) {
    cancelStatusClear(key);
    _testClearTimers.set(key, setTimeout(() => {
      _testClearTimers.delete(key);
      if (live && !live()) return;
      statusEl.textContent = "";
      statusEl.classList.remove("ok", "bad", "pending", "warn");
    }, ms));
  }

  async function testAIProvider(provider) {
    // Every custom entry shares the "custom" panel's button, status line and
    // key field; timers, in-flight guards and health records stay per entry.
    const dom = pbpOptAiDomId(provider);
    const statusEl = $id(`test-${dom}-status`);
    if (!statusEl) return;
    // The shared line belongs to whichever entry the picker shows: a result
    // that arrives after the user switched entries is dropped (its health
    // record is still written). Without a picker (test pages) it is live.
    const live = () => dom !== "custom" || !$id("opt-ai-provider") || pbpOptAiCustomActiveId() === provider;
    const pending = (text) => { if (live()) setStatusPending(statusEl, text); };
    const result = (ok, text) => { if (live()) setStatusResult(statusEl, ok, text); };
    const warn = (text) => { if (live()) setStatusWarn(statusEl, text); };
    const mark = (field) => { if (live()) markFieldInvalid(field, statusEl.id); };
    // The call underneath is an unbounded network request. Without this the
    // button stayed live throughout, so a second click started a concurrent run
    // against the same status element. Mirrors the Pinboard token test below.
    const btn = $id(`test-${dom}`);
    if (btn?.disabled || pbpAiTestInflight.has(provider)) return;
    pbpAiTestInflight.add(provider);
    if (btn) btn.disabled = true;
    cancelStatusClear(provider);
    try {
      pending(t("testTesting"));

      const cs = pbpLiveAiSettingsSnapshot(provider);

      // A custom address the request could never use is reported on the
      // address field, synchronously and before any permission prompt.
      if (dom === "custom") {
        const listed = Array.isArray(cs.aiCustomProviders)
          ? cs.aiCustomProviders.find((e) => e && e.id === provider) : null;
        // An entry deleted elsewhere or not synced here yet: nothing to test
        // and no key to ask for (hasAIKey would read it as a missing key).
        if (provider !== "custom" && !listed) {
          result(false, t("aiErrorProviderMissing"));
          recordHealth(`ai:${provider}`, false, "provider_missing");
          return;
        }
        const base = provider === "custom" ? cs.customBaseUrl : listed?.baseUrl;
        if (base !== undefined && !(typeof base === "string" && base && pbpAiCustomBaseUrlOk(base))) {
          result(false, t("aiCustomBaseUrlInvalid"));
          recordHealth(`ai:${provider}`, false, "endpoint_invalid");
          mark($id("opt-custom-baseurl"));
          return;
        }
      }

      if (!hasAIKey(cs)) {
        result(false, t("testNoApiKey"));
        recordHealth(`ai:${provider}`, false, "missing_key");
        mark($id(`opt-${dom}-key`));
        return;
      }

      // Test is a direct user gesture: request only this provider's exact origin before
      // calling it. Automatic/background paths stay contains-only and never prompt.
      let originPattern = null;
      let granted = false;
      // Settings that form no request (a region, workspace or API format) are
      // caught here, synchronously and before any permission prompt, and
      // point at the field to fix.
      try {
        originPattern = _aiTargetOriginPattern(cs);
      } catch (err) {
        if (err?.code === "endpoint_invalid" && err.reason) {
          result(false, err.message);
          recordHealth(`ai:${provider}`, false, "endpoint_invalid");
          const field = err.reason === "region_unknown" ? $id(`opt-${dom}-region-btn`)
            : err.reason === "protocol_unknown" ? $id(`opt-${dom}-protocol-btn`)
            : $id(`opt-${dom}-workspace`);
          mark(field);
          return;
        }
        // An entry that was deleted or has not synced here: nothing to ask for.
        if (err?.code === "provider_missing") {
          result(false, err.message);
          recordHealth(`ai:${provider}`, false, "provider_missing");
          return;
        }
        console.warn("[connectivity] AI permission request failed:", err?.name, err?.message);
        result(false, err?.message || t("networkError"));
        recordHealth(`ai:${provider}`, false, "permission_error");
        return;
      }
      try {
        granted = await requestAIHostPermissions(cs);
      } catch (err) {
        console.warn("[connectivity] AI permission request failed:", err?.name, err?.message);
        result(false, err?.message || t("networkError"));
        recordHealth(`ai:${provider}`, false, "permission_error");
        return;
      }
      if (!granted) {
        result(false, t("aiErrorHostPermission", originPattern.replace(/\/\*$/, "")));
        recordHealth(`ai:${provider}`, false, "permission_denied");
        return;
      }

      try {
        const reply = await callAI(cs, "Reply with just the word: OK");

        // Second leg (K96): the Reader's per-provider model override. The call
        // above used the provider's CONFIGURED model -- the one popup tags and
        // summaries, background quick-save, Batch and tag governance actually
        // send -- so it stays the subject of the green light and its request
        // shape is untouched. The override is an extra request with nothing but
        // opts.model changed; callAI's four branches all honour opts.model
        // (md-video.js does the same), so this needs no new machinery.
        //
        // Read off the VISIBLE field, not storage: pbpLiveAiSettingsSnapshot
        // above enumerates 15 providers' key/model/baseUrl and carries no
        // previewAiModel* key at all, while options.js's updateProviderFields ->
        // syncPreviewModelToProvider keeps #opt-preview-ai-model holding exactly
        // the SELECTED provider's entry (and writes that visible value back to
        // previewAiModelByProvider on submit). Hence the guard: the other
        // fourteen Test buttons must not borrow a model their provider was
        // never asked to serve.
        //
        // Second guard (F4, final review): the Reader AI master switch. A
        // user who turned Reader AI off can still have a stale value sitting
        // in #opt-preview-ai-model -- without this, every Test click pays
        // for a second request probing a model the Reader will never call.
        // `!== false` matches options.js:242's own reading of this checkbox.
        const ov = $id("opt-ai-provider")?.value === provider && $id("opt-preview-ai-enabled")?.checked !== false
          ? ($id("opt-preview-ai-model")?.value || "").trim()
          : "";
        if (ov) {
          try {
            await callAI(cs, "Reply with just the word: OK", { model: ov });
          } catch (ovErr) {
            console.warn("[connectivity] reader model override failed:", ovErr?.name, ovErr?.message);
            const ovTimedOut = ovErr?.name === "AbortError" || ovErr?.name === "TimeoutError";
            // ok:true on purpose. The provider answered a moment ago, so filing
            // this as a provider failure would render "this API key is broken"
            // over a mistyped or retired reader model; the overview reads
            // override_bad as its own warning row instead.
            warn(t("testOverrideFailed", ov,
              ovTimedOut ? t("testTimeout") : (ovErr?.message || "")));
            recordHealth(`ai:${provider}`, true, "override_bad");
            return;
          }
          recordHealth(`ai:${provider}`, true, "connected");
          if (!live()) return;
          setStatusResult(statusEl, true, t("testOkWithOverride", (reply || "OK").substring(0, 20), ov));
          scheduleStatusClear(provider, statusEl, 4000, live);
          return;
        }

        recordHealth(`ai:${provider}`, true, "connected");
        if (!live()) return;
        setStatusResult(statusEl, true, t("testConnected", (reply || "OK").substring(0, 20)));
        scheduleStatusClear(provider, statusEl, 4000, live);
      } catch (err) {
        // Two names, one meaning: the request deadline is an AbortSignal.timeout
        // (TimeoutError) while a caller-driven cancel is AbortError — same pairing
        // as pbpClassifyPinboardError and wayback.js.
        const timedOut = err?.name === "AbortError" || err?.name === "TimeoutError";
        let msg = timedOut ? t("testTimeout") : err.message;
        if (err?.code === "model_not_found") {
          // Display name from the provider picker's own option, not the internal id.
          const provOpt = [...($id("opt-ai-provider")?.options || [])].find((o) => o.value === cs.aiProvider);
          const mnf = pbpAiModelNotFoundText(provOpt?.textContent.trim() || cs.aiProvider);
          msg = mnf.msg + " " + mnf.hint;
        }
        result(false, msg);
        recordHealth(`ai:${provider}`, false,
          timedOut ? "timeout" : (err?.code === "model_not_found" ? "model_not_found" : "failed"));
      }
    } finally {
      pbpAiTestInflight.delete(provider);
      // The shared custom button belongs to the entry on screen now.
      if (btn && live()) btn.disabled = false;
    }
  }

  ["gemini","openai","claude","deepseek","qwen","minimax","openrouter","groq","mistral","cohere","siliconflow","zhipu","kimi","ark","opencode","commandcode","ollama","custom"].forEach(p => {
    // One listener per button (R13): the shared custom button tests the
    // entry the picker shows.
    $id(`test-${p}`)?.addEventListener("click", () => testAIProvider(p === "custom" ? (pbpOptAiCustomActiveId() || "custom") : p));
  });

  // ---- Pinboard token: real-time format validation (shared.js rule) ----
  const tokenInput = $id("opt-pinboard-token");
  const tokenWarn = $id("token-format-warn");
  function validateTokenField() {
    const val = tokenInput.value.trim();
    const bad = pbpIsValidTokenFormat(val) === false;
    tokenWarn.classList.toggle("visible", bad);
    // A mark left by a failed test outranks the live format check until the
    // next edit clears it (blur alone must not erase "this token was rejected").
    if (tokenInput.dataset.invalidMarked) return;
    if (bad) {
      tokenInput.setAttribute("aria-invalid", "true");
      tokenInput.setAttribute("aria-describedby", "token-format-warn");
    } else {
      tokenInput.removeAttribute("aria-invalid");
      tokenInput.removeAttribute("aria-describedby");
    }
  }
  tokenInput?.addEventListener("input", validateTokenField);
  tokenInput?.addEventListener("blur", validateTokenField);
  validateTokenField();

  // ---- Test Pinboard API token (via background to avoid native auth dialog) ----
  $id("test-pinboard-token")?.addEventListener("click", async () => {
    const btn = $id("test-pinboard-token");
    const statusEl = $id("test-pinboard-status");
    const token = tokenInput.value.trim();
    if (pbpIsValidTokenFormat(token) !== true) {
      // The format warning under the field already says exactly this; a second
      // copy in the status slot read as two different errors in two colours.
      statusEl.textContent = "";
      statusEl.classList.remove("ok", "bad", "pending", "warn");
      tokenWarn.classList.add("visible");
      markFieldInvalid(tokenInput, "token-format-warn");
      recordHealth("pinboard", false, "invalid_token");
      // This path returns above the cancelStatusClear below, so a clear armed by
      // a preceding successful run has to be dropped here or it wipes this line.
      cancelStatusClear("pinboard");
      return;
    }
    btn.disabled = true;
    cancelStatusClear("pinboard");
    setStatusPending(statusEl, t("testTesting"));
    try {
      const resp = await chrome.runtime.sendMessage({ type: "test_pinboard_token", token });
      if (resp?.ok) {
        setStatusResult(statusEl, true, t("testConnected", token.split(":")[0]));
        recordHealth("pinboard", true, "connected");
        scheduleStatusClear("pinboard", statusEl, 5000);
        // A tested token is the Settings page's Pinboard login (options.js switches to it).
        document.dispatchEvent(new CustomEvent("pbp:pinboard-token-ok", {detail:{token}}));
      } else if (resp?.error === "timeout") {
        setStatusResult(statusEl, false, t("pinboardErrorTimeout"));
        recordHealth("pinboard", false, "timeout");
      } else if (resp?.error === "network") {
        setStatusResult(statusEl, false, t("pinboardTestUnreachable"));
        recordHealth("pinboard", false, "network");
      } else {
        // Same call as popup.js's login submit: a 429/5xx status must not
        // read (or log) as "your token is wrong" (K155).
        const key = pbpPinboardTestErrorKey(resp);
        setStatusResult(statusEl, false, t(key));
        recordHealth("pinboard", false,
          key === "pinboardErrorRateLimit" ? "rate_limit" : key === "pinboardErrorServer" ? "server" : "auth");
        if (key === "loginFailed") markFieldInvalid(tokenInput, statusEl.id);
      }
    } catch (e) {
      console.warn("[connectivity] Pinboard test failed:", e?.name, e?.message);
      setStatusResult(statusEl, false, t("pinboardTestUnreachable"));
      recordHealth("pinboard", false, "network");
    } finally {
      btn.disabled = false;
    }
  });
}
