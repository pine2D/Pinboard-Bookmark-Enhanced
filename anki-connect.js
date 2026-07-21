// ============================================================
// Pinboard Bookmark Enhanced - anki-connect.js
// Send saved vocabulary to a locally running Anki via the AnkiConnect
// add-on's HTTP API (http://127.0.0.1:8765, API v6). Pure helpers above
// PURE END load in tests/anki-connect-tests.html via file://; the client
// layer below runs only in options.html (options-vocab.js wires the button).
// Known limit: the 6-field contract has no Language column, so same-spelled
// terms across languages dedupe against each other inside one deck (matches
// the TSV contract; accepted for v1).
// ============================================================

const PBP_ANKI_ENDPOINT = "http://127.0.0.1:8765";
const PBP_ANKI_MODEL = "Pinboard Vocab";
const PBP_ANKI_FIELDS = ["Term", "Reading", "Definition", "Context", "Source", "License"];

// Anki fields are HTML. External dictionary content is DATA, never markup
// (Yomitan advisory GHSA-g3p8-q34q-x686) -- escape every field; the only
// markup a note ever contains is our own literal <br> joining contexts.
function pbpAnkiEscapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// row: the same canonical shape options-vocab.js feeds pbpDictTsv
// ({term, reading, definition, contexts[], source, license}) -- derived from
// the raw vocab record, NEVER from already-HTML-escaped values (the TSV path
// stays #html:false plain text).
function pbpAnkiNoteFromRow(row, deck) {
  const r = row || {};
  const contexts = (Array.isArray(r.contexts) ? r.contexts : [])
    .filter(Boolean).map(pbpAnkiEscapeHtml).join("<br>");
  return {
    deckName: String(deck || PBP_ANKI_MODEL),
    modelName: PBP_ANKI_MODEL,
    fields: {
      Term: pbpAnkiEscapeHtml(r.term),
      Reading: pbpAnkiEscapeHtml(r.reading),
      Definition: pbpAnkiEscapeHtml(r.definition),
      Context: contexts,
      Source: pbpAnkiEscapeHtml(r.source),
      License: pbpAnkiEscapeHtml(r.license)
    },
    options: { allowDuplicate: false, duplicateScope: "deck" },
    tags: ["pinboard-enhanced"]
  };
}

// createModel params: 6 fields + one minimal Term->rest template. Pure
// {{Field}} references only -- no scripts, no styling beyond a plain card.
function pbpAnkiModelDef() {
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

// Strict name+order equality against the 6-field contract. AnkiConnect
// silently drops values for field names the model doesn't have, so a
// user-modified model must ABORT the send, never silently lose data.
function pbpAnkiFieldsMatch(names) {
  if (!Array.isArray(names) || names.length !== PBP_ANKI_FIELDS.length) return false;
  for (let i = 0; i < PBP_ANKI_FIELDS.length; i++) {
    if (names[i] !== PBP_ANKI_FIELDS[i]) return false;
  }
  return true;
}

// ---- PURE END ----
