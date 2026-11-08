// ============================================================
// Pinboard Bookmark Enhanced - vocab-send.js
// The whole-vocabulary exits: TSV download, Send all to Anki, Send all
// supported words to Eudic. Shared by options.html (options-vocab.js) and
// library.html (library-vocab.js); each page keeps its own button state and
// status line and hands this file two callbacks:
//   flash(ok, text)  -- the page's status writer
//   flush()          -- optional; resolves { ok } once a pending settings
//                       auto-save has landed (options only: the deck, port
//                       and tokens are edited there)
//   port             -- optional Anki port captured from the form at click
//                       time, before any permission or auto-save await
// Scope never follows a UI selection or search: every send reads the current
// owner's full vocabulary (rules/vocab-sync.md, UI-layer invariants).
// Call-time deps: shared.js (pbpReadSettingsWithSecrets, deobfuscateSettings,
// pbpEndpointOriginPattern, t), vocab-store.js (pbpVocabAll,
// pbpVocabCurrentOwner, pbpVocabGroups, pbpDictPrimaryLang), md-dict.js
// (pbpDictTsv, pbpDictTsvField), dict-pack.js (pbpEcdict*), anki-connect.js,
// eudic-sync.js. Complete exports hash identities locally with crypto.subtle.
// ============================================================

// First few names only: the status line is one line, and five terms are
// enough to spot the pattern (the counts still carry the full totals).
function pbpVocabTermList(terms) {
  const list = terms.slice(0, 5).join(", ");
  return terms.length > 5 ? list + "…" : list;
}

// vocab-store.js defines pbpDictPrimaryLang and both pages load it; the
// fallback only keeps this from throwing if the load order ever changes.
function _pbpVocabSendPrimary(code) {
  if (typeof pbpDictPrimaryLang === "function") return pbpDictPrimaryLang(code);
  return String(code || "").trim().toLowerCase().split(/[-_]/)[0];
}

// Derived on this device from the local ECDICT pack, for the export paths only.
// COMPUTE-ONLY: nothing here writes pbp-vocab or reaches Drive. vocab-store.js
// stays the sole writer, the 13 stored fields are untouched, and "the current
// owner's whole vocabulary" keeps meaning exactly what it meant before.
// One batched transaction for the whole export, never one per row.
async function pbpVocabSendZhMap(words) {
  if (typeof pbpEcdictLookupMany !== "function") return new Map();
  const keys = [];
  for (const w of words) {
    // English only, and the saved lemma is a second chance for an inflected form.
    // Compared through the same primary-language helper vocab-store uses for
    // record identity: a stored tag may carry a region, and a bare === "en"
    // would then match nothing and silently enrich no row at all.
    if (_pbpVocabSendPrimary(w.language) !== "en") continue;
    if (w.term) keys.push(w.term);
    if (w.lemma) keys.push(w.lemma);
  }
  if (!keys.length) return new Map();
  try { return await pbpEcdictLookupMany(keys); } catch (_) { return new Map(); }
}

function pbpVocabSendZhFor(w, zhMap) {
  if (!zhMap || !zhMap.size || _pbpVocabSendPrimary(w.language) !== "en") return "";
  const hit = (w.term && zhMap.get(pbpEcdictKey(w.term))) ||
              (w.lemma && zhMap.get(pbpEcdictKey(w.lemma)));
  if (!hit || !hit.length) return "";
  // Every matching record, not just the first. Case folding collapses distinct
  // headwords onto one key ("US" and "us"), so hit[0] would export whichever the
  // imported file listed first and lose the other sense entirely.
  const seen = new Set();
  const out = [];
  for (const r of hit) {
    for (const sense of pbpEcdictSenses(r.translation)) {
      if (seen.has(sense)) continue;
      seen.add(sense);
      out.push(sense);
    }
  }
  return out.join("; ");
}

// Canonical row shared by the TSV export and the Anki send (spec: both
// derive from the SAME canonical shape; the Anki side escapes its own copy).
// zh and zhNote stay SEPARATE from definition/license: the Anki path has to
// escape each piece on its own before joining them with its own trusted <br>,
// and pre-joining here would either double-escape or smuggle markup through.
function pbpVocabSendCanonicalRow(w, zhMap, tag) {
  const zh = pbpVocabSendZhFor(w, zhMap);
  return {
    term: w.term,
    // Only pbpAnkiNoteFromRow reads these two (they become note tags);
    // pbpDictTsv ignores unknown keys, so the TSV shape is untouched.
    language: w.language || "",
    groups: pbpVocabGroups(w),
    reading: w.ipa || "",
    definition: (w.gloss || "").replace(/\s*\n\s*/g, " "),
    contexts: (Array.isArray(w.contexts) ? w.contexts : []).map((c) => c && c.quote).filter(Boolean),
    source: (w.contexts && w.contexts[0] && w.contexts[0].articleUrl) || "",
    license: [w.license, w.sourceUrl].filter(Boolean).join(" "),
    zh,
    // Labelled so the local Chinese never looks like it came from the online
    // entry, and carrying the diagnostic pack identity. Never presented as a
    // confirmed data licence.
    zhNote: zh ? t("vocabZhFromPack") + (tag ? " (" + tag + ")" : "") : ""
  };
}

// Only verified store identities may become an external duplicate key. Hash
// the canonical ID, not editable content, and never expose its raw owner.
async function pbpVocabSendWordId(w, owner) {
  if (!w || typeof owner !== "string" || !owner.trim() || w.owner !== owner ||
      typeof w.term !== "string" || !pbpDictNormalizeTerm(w.term) ||
      typeof w.language !== "string" || !pbpDictPrimaryLang(w.language) ||
      typeof w.id !== "string" || w.id !== pbpDictVocabKey(owner, w.language, w.term)) {
    throw new Error("invalid vocabulary identity");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(w.id));
  return "pbp-v1-" + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// This parallel projection deliberately starts from stored rows. The legacy
// projection folds newlines and strips context provenance, so it cannot be a
// source for complete exports. Enumerating content fields also keeps causal
// versions and other sync-only metadata out of both external formats.
async function pbpVocabSendCompleteRows(words, owner, zhMap, tag) {
  return Promise.all(words.map(async (w) => {
    const wordId = await pbpVocabSendWordId(w, owner);
    const zh = pbpVocabSendZhFor(w, zhMap);
    return {
      wordId,
      term: w.term,
      language: w.language,
      lemma: w.lemma ?? null,
      reading: w.ipa ?? "",
      definition: w.gloss ?? "",
      note: w.note ?? "",
      contexts: (Array.isArray(w.contexts) ? w.contexts : []).map((context) => {
        const copy = {};
        for (const key of ["quote", "articleUrl", "articleTitle", "highlightId", "createdAt"]) {
          if (context && Object.hasOwn(context, key)) copy[key] = context[key];
        }
        return copy;
      }),
      dictionarySource: w.sourceUrl ?? "",
      license: w.license ?? "",
      groups: Array.isArray(w.groups) ? w.groups.slice() : [],
      status: w.status ?? "",
      createdAt: w.createdAt ?? "",
      updatedAt: w.updatedAt ?? "",
      zh,
      zhNote: zh ? t("vocabZhFromPack") + (tag ? " (" + tag + ")" : "") : ""
    };
  }));
}

// Plain-text content export, not an Anki model definition or restore backup.
// JSON cells retain each context's own provenance and the full group list.
function pbpVocabCompleteTsv(rows) {
  const columns = ["WordID", "Term", "Language", "Lemma", "Reading", "Definition", "Note", "ContextsJSON",
    "DictionarySource", "License", "GroupsJSON", "Status", "CreatedAt", "UpdatedAt",
    "SupplementalDefinition", "SupplementalSource"];
  const lines = ["#separator:Tab", "#html:false", "#columns:" + columns.join("\t"), "#pbp-vocab-schema:complete-v1"];
  for (const row of rows) {
    lines.push([row.wordId, row.term, row.language, row.lemma, row.reading, row.definition, row.note,
      JSON.stringify(row.contexts), row.dictionarySource, row.license, JSON.stringify(row.groups),
      row.status, row.createdAt, row.updatedAt, row.zh, row.zhNote].map(pbpDictTsvField).join("\t"));
  }
  return lines.join("\n") + "\n";
}

// Diagnostic identity of the imported pack: rung plus a short slice of the
// CRC32. Not an identity or licence claim -- 32 bits collide.
// Read AFTER the lookup and passed per export, never held in a module variable:
// reading it first let a pack swapped in mid-export label content that came from
// a different pack, and one variable let a TSV and an Anki send overwrite each
// other's label.
async function pbpVocabSendEcdictTag() {
  try {
    const meta = (typeof pbpEcdictMeta === "function") ? await pbpEcdictMeta() : null;
    return meta && meta.state === "ready"
      ? "ECDICT " + (meta.rung || "") + " " + String(meta.decodedCrc32 || "").slice(0, 8)
      : "";
  } catch (_) { return ""; }
}

// A just-edited setting may still sit in the options page's debounced
// auto-save; the caller's flush lands it first, and a failed flush aborts
// (Codex final-review MEDIUM precedent). No flush = nothing pending.
async function _pbpVocabSendFlushed(flush, flash) {
  if (typeof flush !== "function") return true;
  let flushed = null;
  try { flushed = await flush(); } catch (e) { console.warn("[vocab] settings flush failed:", e?.name, e?.message); }
  if (flushed && flushed.ok) return true;
  flash(false, t("vocabSettingsSaveFailed"));
  return false;
}

// Whether "Send all supported words to Eudic" has anything to do for the
// current owner: a token is configured and at least one word is in a language
// Eudic takes. Fail-closed: any read failure answers false, so the action is
// hidden rather than offering a send that would have nothing to send.
async function pbpVocabEudicReady() {
  try {
    const s = await pbpReadSettingsWithSecrets({ dictEudicToken: SETTINGS_DEFAULTS.dictEudicToken });
    if (!(s && s.dictEudicToken)) return false;
    if (typeof pbpEudicPartition !== "function") return false;
    const rows = await pbpVocabAll(await pbpVocabCurrentOwner());
    return pbpEudicPartition(rows).byLang.size > 0;
  } catch (_) {
    return false;
  }
}

// TSV download. The owner is captured before reading the rows and re-checked
// after every await and before the Blob is built: never download the previous
// account's words under the new account's export click.
async function pbpVocabExportTsv({ flash, flush, format = "legacy" } = {}) {
  try {
    if (!(await _pbpVocabSendFlushed(flush, flash))) return;
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    if ((await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    // Nothing to write: pbpDictTsv([]) still emits the three Anki header lines,
    // so without this the click downloads a wordless file and says nothing.
    // dictAnkiNothing names no target ("No words to send yet."), so it is
    // reused here instead of duplicated under an export-specific key. Placed
    // before the enrichment awaits: an empty set has nothing to enrich.
    if (!rows.length) { flash(false, t("dictAnkiNothing")); return; }
    const zhMap = await pbpVocabSendZhMap(rows);
    const zhTag = await pbpVocabSendEcdictTag();
    if ((await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    const complete = format === "complete";
    const canonical = complete
      ? await pbpVocabSendCompleteRows(rows, owner, zhMap, zhTag)
      : rows.map((w) => pbpVocabSendCanonicalRow(w, zhMap, zhTag));
    // Hashing adds an asynchronous boundary. A switch during local crypto
    // must abort before any previous account's content reaches a download.
    if (complete && (await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    const tsv = complete ? pbpVocabCompleteTsv(canonical) : pbpDictTsv(canonical);
    const blob = new Blob([tsv], { type: "text/tab-separated-values" });
    const a = document.createElement("a");
    const d = new Date();
    const stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    a.href = URL.createObjectURL(blob);
    a.download = "vocab-" + stamp + (complete ? "-complete" : "") + ".tsv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    console.warn("[vocab] TSV export failed:", e?.name, e?.message);
    flash(false, t("vocabExportFailed"));
  }
}

// Send-to-Anki chain. Ordering is the spec (anki spec rev2 §3):
// (1) FIRST await = chrome.permissions.request when the caller supplies its
// form's port; without a form, one settings read supplies the port first
// (user gesture; already-granted resolves true without UI), (2)
// requestPermission as the first AnkiConnect action, (3..n) owner derived
// AFTER the permission awaits and re-checked via ownerCheck before every later
// dispatch -- the permission dialogs can sit open long enough for an account
// switch (fail-closed invariant). The caller must reach this with no await of
// its own in between, or the click's transient activation can lapse.
async function pbpVocabSendToAnki({ flash, flush, port: clickedPort } = {}) {
  try {
    // Options supplies the live field synchronously: reading storage before
    // its auto-save flush could send to an old, still-running Anki instance.
    // Keep that click's port for BOTH the first permission request and every
    // dispatch, including when a permission dialog outlives another edit.
    // Library has no editable field, so its one fast settings read remains.
    const port = clickedPort === undefined
      ? (await pbpReadSettingsWithSecrets({ dictAnkiPort: SETTINGS_DEFAULTS.dictAnkiPort })).dictAnkiPort
      : clickedPort;
    const pattern = pbpEndpointOriginPattern(pbpAnkiEndpointFor(port));
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); }
    catch (e) {
      console.warn("[vocab] Anki host permission request failed:", e?.name, e?.message);
      flash(false, t("dictAnkiHostPermissionDenied"));
      return;
    }
    if (!granted) { flash(false, t("dictAnkiHostPermissionDenied")); return; }
    // requestPermission FIRST (spec §3): the long human-approval wait happens
    // BEFORE owner derivation, so the owner snapshot below stays fresh.
    const perm = await pbpAnkiCall("requestPermission", {}, "", 120000, port);
    if (!perm.ok || !perm.result) { flash(false, t("dictAnkiConnectPermissionFailed")); return; }
    if (perm.result.permission !== "granted") { flash(false, t("dictAnkiConnectPermissionDenied")); return; }
    const apiVersion = Number(perm.result.version);
    if (!Number.isFinite(apiVersion) || apiVersion < 6) {
      flash(false, t("dictAnkiVersionUnsupported"));
      return;
    }
    const keyRequired = perm.result.requireApiKey === true || perm.result.requireApikey === true;
    if (!(await _pbpVocabSendFlushed(flush, flash))) return;
    const raw = await pbpReadSettingsWithSecrets({
      dictAnkiDeck: SETTINGS_DEFAULTS.dictAnkiDeck,
      dictAnkiKey: SETTINGS_DEFAULTS.dictAnkiKey,
      dictAnkiFormat: SETTINGS_DEFAULTS.dictAnkiFormat
    });
    const s = deobfuscateSettings(raw);
    if (keyRequired && !s.dictAnkiKey) { flash(false, t("dictAnkiKeyRequired")); return; }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    if ((await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    if (!rows.length) { flash(false, t("dictAnkiNothing")); return; }
    const zhMap = await pbpVocabSendZhMap(rows);
    const zhTag = await pbpVocabSendEcdictTag();
    if ((await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    const format = s.dictAnkiFormat === "multilingual" ? "multilingual" : "legacy";
    const canonical = format === "multilingual"
      ? await pbpVocabSendCompleteRows(rows, owner, zhMap, zhTag)
      : rows.map((w) => pbpVocabSendCanonicalRow(w, zhMap, zhTag));
    if (format === "multilingual" && (await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    const res = await pbpAnkiSendRows(canonical, {
      deck: s.dictAnkiDeck || "Pinboard Vocab",
      key: s.dictAnkiKey || "",
      port,
      format,
      ownerCheck: async () => (await pbpVocabCurrentOwner()) === owner
    });
    if ((await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    if (res.stage === "done") {
      let msg = t("dictAnkiResult", String(res.added), String(res.skipped), String(res.failed));
      // Name the casualties: a bare count leaves "re-send the whole library
      // and hope" as the only recovery move.
      if (res.failed > 0 && Array.isArray(res.failedTerms) && res.failedTerms.length) {
        msg += " · " + t("vocabFailedTerms", pbpVocabTermList(res.failedTerms));
      }
      flash(res.failed === 0, msg);
    } else if (res.stage === "modelMismatch") {
      flash(false, format === "multilingual"
        ? t("dictAnkiModelMismatchNamed", pbpAnkiModelDef(format).modelName)
        : t("dictAnkiModelMismatch"));
    } else if (res.stage === "modelFields") {
      flash(false, t("dictAnkiFieldCheckFailed"));
    } else if (res.stage === "owner") {
      flash(false, t("vocabAccountChanged"));
    } else {
      // Pipeline stages (deck/model/precheck/add) carry AnkiConnect's own
      // error text; use the generic send failure only when no detail exists.
      flash(false, res.error || t("dictAnkiFailed"));
    }
  } catch (e) {
    console.warn("[vocab] Anki send failed:", e?.name, e?.message);
    flash(false, t("dictAnkiFailed"));
  }
}

// Send-to-Eudic chain: the exact Eudic origin is requested first (user
// gesture), then the owner's full vocabulary goes out, unsupported languages
// skipped by pbpEudicSendRows.
async function pbpVocabSendToEudic({ flash, flush } = {}) {
  try {
    const pattern = pbpEndpointOriginPattern(PBP_EUDIC_ENDPOINT);
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [pattern] }); } catch (e) { console.warn("[vocab] Eudic host permission request failed:", e?.name, e?.message); }
    if (!granted) { flash(false, t("dictEudicHostPermissionDenied")); return; }
    if (!(await _pbpVocabSendFlushed(flush, flash))) return;
    const raw = await pbpReadSettingsWithSecrets({ dictEudicToken: SETTINGS_DEFAULTS.dictEudicToken });
    const s = deobfuscateSettings(raw);
    if (!s.dictEudicToken) { flash(false, t("dictEudicTokenRequired")); return; }
    const owner = await pbpVocabCurrentOwner();
    const rows = await pbpVocabAll(owner);
    if ((await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    // pbpEudicSendRows sends nothing for an empty set and still returns
    // stage "done" with all-zero counters, which the branch below would flash
    // as a successful send. Same guard, order and key as the Anki twin above;
    // the action can outlive the words that revealed it.
    if (!rows.length) { flash(false, t("dictAnkiNothing")); return; }
    const res = await pbpEudicSendRows(rows, {
      token: s.dictEudicToken,
      ownerCheck: async () => (await pbpVocabCurrentOwner()) === owner
    });
    if ((await pbpVocabCurrentOwner()) !== owner) { flash(false, t("vocabAccountChanged")); return; }
    if (res.stage === "owner") {
      flash(false, t("vocabAccountChanged"));
    } else if (res.stage === "auth") {
      flash(false, t("dictEudicTokenRequired"));
    } else if (res.forbidden) {
      flash(false, t("dictEudicRejected"));
    } else if (res.failed) {
      // Parameter errors surface the server's own message (spec §2).
      let msg = res.error || t("dictEudicFailed");
      if (Array.isArray(res.failedTerms) && res.failedTerms.length) {
        msg += " · " + t("vocabFailedTerms", pbpVocabTermList(res.failedTerms));
      }
      flash(false, msg);
    } else if (res.generic) {
      // ANY generic batch poisons the totals -- never show a partial count
      // as if it were the whole story.
      flash(true, t("dictEudicGenericOk"));
    } else {
      let msg = t("dictEudicResult", String(res.added), String(res.skipped), String(res.unsupported));
      if (res.unsupported > 0 && Array.isArray(res.unsupportedTerms) && res.unsupportedTerms.length) {
        msg += " · " + t("vocabUnsupportedTerms", pbpVocabTermList(res.unsupportedTerms));
      }
      // Words existed but none were in a language Eudic takes: nothing was
      // accepted or deduplicated away, so the counts must not read as a
      // successful send just because no request failed.
      flash(res.added > 0 || res.skipped > 0, msg);
    }
  } catch (e) {
    console.warn("[vocab] Eudic send failed:", e?.name, e?.message);
    flash(false, t("dictEudicFailed"));
  }
}
