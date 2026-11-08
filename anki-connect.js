// ============================================================
// Pinboard Bookmark Enhanced - anki-connect.js
// Send saved vocabulary to a locally running Anki via the AnkiConnect
// add-on's HTTP API (http://127.0.0.1:8765, API v6). Pure helpers above
// PURE END load in tests/anki-connect-tests.html via file://; the client
// layer below is shared by the options and library vocabulary exports.
// The default six-field contract remains compatible with existing notes.
// Explicit multilingual export uses a separate model whose first field is a
// stable WordID; neither path migrates or updates the other model's notes.
// ============================================================

// Port is user-configurable (AnkiConnect's own config allows changing it);
// the HOST is never configurable -- loopback-only is a network invariant.
// Anything that isn't a sane port number falls back to the default 8765.
function pbpAnkiEndpointFor(port) {
  const p = String(port == null ? "" : port).trim();
  const ok = /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535;
  return "http://127.0.0.1:" + (ok ? p : "8765");
}
const PBP_ANKI_MODEL = "Pinboard Vocab";
const PBP_ANKI_FIELDS = ["Term", "Reading", "Definition", "Context", "Source", "License"];
const PBP_ANKI_MULTILINGUAL_MODEL = "Pinboard Vocab Multilingual";
const PBP_ANKI_MULTILINGUAL_FIELDS = Object.freeze([
  "WordID", "Term", "Language", "Lemma", "Reading", "Definition", "Note", "Contexts",
  "DictionarySource", "License", "Groups", "Status", "CreatedAt", "UpdatedAt",
  "SupplementalDefinition", "SupplementalSource"
]);

// Anki fields are HTML. External dictionary content is DATA, never markup
// (Yomitan advisory GHSA-g3p8-q34q-x686) -- escape every field; the only
// markup a note ever contains is our own static layout around escaped data.
function pbpAnkiEscapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Anki tag syntax forbids whitespace; a group named "考试 词汇" must not
// silently split into two tags.
function pbpAnkiTagify(s) {
  return String(s == null ? "" : s).trim().replace(/\s+/g, "-");
}

function _pbpAnkiContextsHtml(contexts) {
  return (Array.isArray(contexts) ? contexts : []).filter(Boolean).map((context) => {
    // These optional source details remain in the field for export/browser
    // use without showing internal highlight ids or raw epochs on the card.
    const metadata = (context.createdAt === undefined ? "" :
      ' data-created-at="' + pbpAnkiEscapeHtml(context.createdAt) + '"') +
      (context.highlightId === undefined ? "" :
        ' data-highlight-id="' + pbpAnkiEscapeHtml(context.highlightId) + '"');
    const source = [context.articleTitle, context.articleUrl].filter(Boolean)
      .map(pbpAnkiEscapeHtml).join("<br>");
    return '<div class="pbp-vocab-context"' + metadata + '><div class="pbp-vocab-text">' +
      pbpAnkiEscapeHtml(context.quote) + "</div>" +
      (source ? '<div class="pbp-vocab-source">' + source + "</div>" : "") + "</div>";
  }).join("");
}

// Legacy rows share the six-field TSV projection, with quote-only contexts.
// Multilingual rows come from the complete projection: wordId, user fields,
// and context objects with individual sources. Both contain raw data, never
// pre-escaped HTML (the TSV paths remain #html:false plain text).
function pbpAnkiNoteFromRow(row, deck, format = "legacy") {
  const r = row || {};
  const multilingual = format === "multilingual";
  if (multilingual && (typeof r.wordId !== "string" || !/^pbp-v1-[0-9a-f]{64}$/.test(r.wordId))) {
    throw new TypeError("invalid vocabulary identity");
  }
  const contexts = multilingual ? "" : (Array.isArray(r.contexts) ? r.contexts : [])
    .filter(Boolean).map(pbpAnkiEscapeHtml).join("<br>");
  // Groups are the vocab page's one organizational axis; dropping them made
  // every send land as an undifferentiated pile. They become plain tags
  // (filterable in Anki's browser); language gets a prefixed tag so "en"
  // never collides with a user group named "en".
  const tags = ["pinboard-enhanced"];
  const langTag = pbpAnkiTagify(r.language);
  if (langTag) tags.push("pbp-lang-" + langTag);
  for (const g of Array.isArray(r.groups) ? r.groups : []) {
    const tg = pbpAnkiTagify(g);
    if (tg && !tags.includes(tg)) tags.push(tg);
  }
  return {
    deckName: String(deck || PBP_ANKI_MODEL),
    modelName: multilingual ? PBP_ANKI_MULTILINGUAL_MODEL : PBP_ANKI_MODEL,
    fields: multilingual ? {
      WordID: r.wordId,
      Term: pbpAnkiEscapeHtml(r.term),
      Language: pbpAnkiEscapeHtml(r.language),
      Lemma: pbpAnkiEscapeHtml(r.lemma),
      Reading: pbpAnkiEscapeHtml(r.reading),
      Definition: pbpAnkiEscapeHtml(r.definition),
      Note: pbpAnkiEscapeHtml(r.note),
      Contexts: _pbpAnkiContextsHtml(r.contexts),
      DictionarySource: pbpAnkiEscapeHtml(r.dictionarySource),
      License: pbpAnkiEscapeHtml(r.license),
      Groups: (Array.isArray(r.groups) ? r.groups : []).map(pbpAnkiEscapeHtml).join("<br>"),
      Status: pbpAnkiEscapeHtml(r.status),
      CreatedAt: pbpAnkiEscapeHtml(r.createdAt),
      UpdatedAt: pbpAnkiEscapeHtml(r.updatedAt),
      SupplementalDefinition: pbpAnkiEscapeHtml(r.zh),
      SupplementalSource: pbpAnkiEscapeHtml(r.zhNote)
    } : {
      Term: pbpAnkiEscapeHtml(r.term),
      Reading: pbpAnkiEscapeHtml(r.reading),
      // Each piece is escaped on its OWN, then joined with our literal <br>.
      // Escaping a pre-joined string would show the tag as text; joining
      // pre-escaped-and-concatenated text would let dictionary data smuggle
      // markup. The model keeps its six fields, so no existing note type breaks.
      Definition: [pbpAnkiEscapeHtml(r.definition), r.zh ? pbpAnkiEscapeHtml(r.zh) : ""]
        .filter(Boolean).join("<br>"),
      Context: contexts,
      // Source stays the article URL only; dictionary provenance belongs in
      // License, where the online and local fragments are labelled separately.
      Source: pbpAnkiEscapeHtml(r.source),
      License: [pbpAnkiEscapeHtml(r.license), r.zhNote ? pbpAnkiEscapeHtml(r.zhNote) : ""]
        .filter(Boolean).join(" | ")
    },
    options: { allowDuplicate: false, duplicateScope: "deck" },
    tags
  };
}

// Existing six-field models stay unchanged. The independent complete model
// keeps management fields in Anki's browser while its card shows learning
// content and sources. Only static markup and field/conditional references.
function pbpAnkiModelDef(format = "legacy") {
  if (format === "multilingual") {
    return {
      modelName: PBP_ANKI_MULTILINGUAL_MODEL,
      inOrderFields: PBP_ANKI_MULTILINGUAL_FIELDS.slice(),
      css: ".card { font-family: sans-serif; font-size: 18px; text-align: left; overflow-wrap: anywhere; } " +
        ".pbp-vocab-text { white-space: pre-wrap; } .pbp-vocab-context { margin: 1em 0; } " +
        ".pbp-vocab-source { font-size: 0.8em; margin-top: 0.4em; }",
      cardTemplates: [{
        Name: "Vocabulary",
        Front: '<div class="pbp-vocab-text" lang="{{Language}}">{{Term}}</div>{{#Language}}<small>{{Language}}</small>{{/Language}}' +
          '{{#Reading}}<div>{{Reading}}</div>{{/Reading}}',
        Back: '{{FrontSide}}<hr id=answer><div class="pbp-vocab-text">{{Definition}}</div>' +
          '{{#Lemma}}<p lang="{{Language}}">{{Lemma}}</p>{{/Lemma}}{{#Note}}<div class="pbp-vocab-text">{{Note}}</div>{{/Note}}' +
          '{{#Contexts}}{{Contexts}}{{/Contexts}}{{#DictionarySource}}<div class="pbp-vocab-source">{{DictionarySource}}</div>{{/DictionarySource}}' +
          '{{#License}}<div class="pbp-vocab-source">{{License}}</div>{{/License}}' +
          '{{#SupplementalDefinition}}<div class="pbp-vocab-text">{{SupplementalDefinition}}</div>{{/SupplementalDefinition}}' +
          '{{#SupplementalSource}}<div class="pbp-vocab-source">{{SupplementalSource}}</div>{{/SupplementalSource}}'
      }]
    };
  }
  return {
    modelName: PBP_ANKI_MODEL,
    inOrderFields: PBP_ANKI_FIELDS.slice(),
    css: ".card { font-family: sans-serif; font-size: 18px; text-align: left; }",
    cardTemplates: [{
      Name: "Card 1",
      Front: "{{Term}}<br><i>{{Reading}}</i>",
      Back: "{{FrontSide}}<hr id=answer>{{Definition}}<br><br>{{Context}}<br><small>{{Source}} {{License}}</small>"
    }]
  };
}

// API key rides at the TOP LEVEL of the request envelope -- AnkiConnect's
// handler reads request.get("key"); params.key would not authenticate.
function pbpAnkiBuildRequest(action, params, key) {
  const req = { action: String(action || ""), version: 6, params: params || {} };
  if (key) req.key = String(key);
  return req;
}

// Takes the raw response TEXT (not a parsed object) so malformed JSON is a
// testable failure, and parses AnkiConnect's {result, error} envelope.
function pbpAnkiParseResult(text) {
  let data;
  try { data = JSON.parse(String(text == null ? "" : text)); } catch (_) {
    return { ok: false, result: null, error: "malformed response" };
  }
  if (!data || typeof data !== "object") return { ok: false, result: null, error: "malformed response" };
  if (data.error != null) return { ok: false, result: data.result == null ? null : data.result, error: String(data.error) };
  return { ok: true, result: "result" in data ? data.result : null, error: null };
}

// Strict name+order equality against the selected model's contract. AnkiConnect
// silently drops values for field names the model doesn't have, so a
// user-modified model must ABORT the send, never silently lose data.
function pbpAnkiFieldsMatch(names, format = "legacy") {
  const fields = format === "multilingual" ? PBP_ANKI_MULTILINGUAL_FIELDS : PBP_ANKI_FIELDS;
  if (!Array.isArray(names) || names.length !== fields.length) return false;
  for (let i = 0; i < fields.length; i++) {
    if (names[i] !== fields[i]) return false;
  }
  return true;
}

// ---- PURE END ----

// ---- Client (options.html and library.html) ------------------------------

// No Content-Type header ON PURPOSE: a string body ships as text/plain,
// which is CORS-simple and skips the OPTIONS preflight. Before an origin is
// trusted, AnkiConnect's preflight answer may carry the DEFAULT
// Access-Control-Allow-Origin (http://localhost) and the browser would kill
// a preflighted request before requestPermission ever runs.
async function pbpAnkiCall(action, params, key, timeoutMs, port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 10000);
  try {
    const resp = await fetch(pbpAnkiEndpointFor(port), {
      method: "POST",
      body: JSON.stringify(pbpAnkiBuildRequest(action, params, key)),
      signal: ctrl.signal
    });
    return pbpAnkiParseResult(await resp.text());
  } catch (e) {
    return { ok: false, result: null, error: (e && e.name === "AbortError") ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

// Full send pipeline. opts: {deck, key, port, format, ownerCheck: async () => bool}.
// ownerCheck re-derives the CURRENT owner and compares to the rows' owner --
// called before every dispatch that follows a potentially long await
// (fail-closed account isolation; the Anki permission dialog can sit open
// for minutes). Returns {stage, added, skipped, failed, error}.
async function pbpAnkiSendRows(rows, opts) {
  const deck = (opts && opts.deck) || PBP_ANKI_MODEL;
  const key = (opts && opts.key) || "";
  const ownerCheck = (opts && opts.ownerCheck) || (async () => true);
  const port = (opts && opts.port) || "";
  const format = opts?.format === "multilingual" ? "multilingual" : "legacy";
  const modelName = format === "multilingual" ? PBP_ANKI_MULTILINGUAL_MODEL : PBP_ANKI_MODEL;
  // failedTerms names every counted failure so the UI can say WHICH words
  // need attention -- a bare count sent users re-sending the whole library.
  const out = { stage: "", added: 0, skipped: 0, failed: 0, failedTerms: [], error: null };
  let notes;
  try { notes = rows.map((r) => pbpAnkiNoteFromRow(r, deck, format)); }
  catch (_) {
    out.stage = "input";
    out.error = "invalid vocabulary identity";
    return out;
  }

  // requestPermission/version/keyRequired happen in _pbpVocabSendAnki BEFORE
  // settings/owner (spec §3 ordering) -- this pipeline starts at createDeck.
  if (!(await ownerCheck())) { out.stage = "owner"; out.error = "account changed"; return out; }
  const deckRes = await pbpAnkiCall("createDeck", { deck }, key, 10000, port); // idempotent
  if (!deckRes.ok) { out.stage = "deck"; out.error = deckRes.error; return out; }

  if (!(await ownerCheck())) { out.stage = "owner"; out.error = "account changed"; return out; }
  const models = await pbpAnkiCall("modelNames", {}, key, 10000, port);
  if (!models.ok || !Array.isArray(models.result)) { out.stage = "model"; out.error = models.error || "modelNames failed"; return out; }
  if (!(await ownerCheck())) { out.stage = "owner"; out.error = "account changed"; return out; }
  if (!models.result.includes(modelName)) {
    const created = await pbpAnkiCall("createModel", pbpAnkiModelDef(format), key, 10000, port);
    if (!created.ok) { out.stage = "model"; out.error = created.error; return out; }
  } else {
    const fields = await pbpAnkiCall("modelFieldNames", { modelName }, key, 10000, port);
    if (!fields.ok || !Array.isArray(fields.result)) {
      out.stage = "modelFields";
      out.error = fields.error || "modelFieldNames failed";
      return out;
    }
    if (!pbpAnkiFieldsMatch(fields.result, format)) {
      // AnkiConnect silently drops values for unknown field names -- a
      // user-modified model must abort, never silently lose data.
      out.stage = "modelMismatch";
      out.error = "model fields incompatible";
      return out;
    }
  }

  if (!(await ownerCheck())) { out.stage = "owner"; out.error = "account changed"; return out; }
  const can = await pbpAnkiCall("canAddNotesWithErrorDetail", { notes }, key, 30000, port);
  if (!can.ok || !Array.isArray(can.result) || can.result.length !== notes.length) {
    out.stage = "precheck";
    out.error = can.error || "precheck failed";
    return out;
  }
  const addable = [];
  const addableTerms = [];
  const seenFirst = new Set();
  for (let i = 0; i < can.result.length; i++) {
    const d = can.result[i];
    const term = (rows[i] && rows[i].term) || "";
    if (d && d.canAdd) {
      // The precheck compares against the collection only. Two notes in this
      // batch sharing a first field (same word spelled in two languages under
      // the legacy model) pass it, then addNotes rolls the WHOLE batch back on
      // the second one. Keep the first and skip the rest, like a duplicate.
      const first = notes[i].fields && Object.values(notes[i].fields)[0];
      const dupKey = notes[i].deckName + "\u0000" + notes[i].modelName + "\u0000" + String(first == null ? "" : first);
      if (seenFirst.has(dupKey)) { out.skipped++; continue; }
      seenFirst.add(dupKey);
      addable.push(notes[i]); addableTerms.push(term);
    }
    else if (d && /duplicate/i.test(String(d.error || ""))) out.skipped++;
    else { out.failed++; out.failedTerms.push(term); }
  }
  if (!addable.length) { out.stage = "done"; return out; }

  if (!(await ownerCheck())) { out.stage = "owner"; out.error = "account changed"; return out; }
  const added = await pbpAnkiCall("addNotes", { notes: addable }, key, 60000, port);
  if (!added.ok || !Array.isArray(added.result) || added.result.length !== addable.length) {
    // addNotes is batch-rollback: on ANY error it deletes the notes it had
    // already added and returns a top-level error -- count the whole batch
    // as failed, never claim partial success. A response array shorter than
    // the request (malformed/truncated) is symmetric with the length check
    // on canAddNotesWithErrorDetail above and must fail closed the same way.
    out.stage = "add";
    out.failed += addable.length;
    out.failedTerms.push(...addableTerms);
    out.error = added.error || "addNotes failed";
    return out;
  }
  for (let i = 0; i < added.result.length; i++) {
    if (added.result[i] == null) { out.failed++; out.failedTerms.push(addableTerms[i]); }
    else out.added++;
  }
  out.stage = "done";
  return out;
}
