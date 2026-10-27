// Handwritten server-shaped responses for the OFFLINE redesign rehearsal:
// OpenAI chat.completion envelopes and MediaWiki api.php (formatversion=2)
// bodies, written by hand from the public response formats. Nothing here is
// produced by production constructors, and nothing is a live model result.
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
let sequence = 0;
// mimo's gateway answers under an upstream alias (as some OpenAI-compatible
// gateways do): the probe records it, freeze registers it, full accepts it.
const SERVED = { "commandcode/mimo-v2.6-pro": "xiaomi/mimo-v2.6-pro-preview" };
const completion = (model, content, finish = "stop", usage = { prompt_tokens: 900, completion_tokens: 320, total_tokens: 1220 }, served = SERVED[model] ?? model) => json(200, {
  id: "chatcmpl-rehearsal-" + (++sequence), object: "chat.completion", created: 1792972800, model: served,
  choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content } }], usage });

const ENTRY = {
  provider: ["名词", "提供服务、物品或资源的人或机构。", "Our internet provider is down.", "我们的网络服务商出故障了。"],
  based: ["形容词", "以某事物为基础的；位于某地的。", "The film is based on a true story.", "这部电影根据真实故事改编。"],
  charge: ["名词", "费用；为商品或服务支付的金额。", "There is no charge for delivery.", "送货不收费。"],
  ran: ["动词", "run 的过去式，表示跑、经营或运行。", "She ran to the bus stop.", "她跑向公交车站。"],
  "take off": ["短语动词", "（飞机）起飞；脱下衣物。", "The plane will take off soon.", "飞机马上就要起飞了。"],
  notwithstanding: ["介词", "尽管；虽然有……，仍然。", "Notwithstanding the delay, we finished.", "尽管有延误，我们还是完成了。"],
  bekommen: ["verb", "To receive or get something; it does not mean to become.", "Ich habe einen Brief bekommen.", "I received a letter."],
  embarazada: ["adjective", "Pregnant; it does not mean embarrassed.", "Mi hermana está embarazada.", "My sister is pregnant."],
  actuellement: ["副词", "目前；现在（不是“实际上”）。", "Il travaille actuellement à Paris.", "他目前在巴黎工作。"],
  magari: ["副词", "也许；但愿（表示希望）。", "Magari domani piove.", "也许明天会下雨。"],
  "давать": ["动词", "给；允许（未完成体）。", "Он часто даёт советы.", "他经常给出建议。"],
  "눈치": ["名词", "察言观色的能力；眼色。", "그는 눈치가 빠르다.", "他很会察言观色。"],
  "やばい": ["形容词", "危险的；（口语）非常厉害的。", "このラーメン、やばい。", "这碗拉面太好吃了。"],
  "随便": ["adjective", "Casual; as one pleases; whatever you like.", "你随便坐。", "Sit wherever you like."]
};
const TEXT = {
  "zh-Hans": { summary: "这些要点帮助学习者在日常交流中更自然地使用这个表达。",
    explanation: "这个用法通常用来说明动作涉及的具体对象，后面接名词短语，语气中性，适合书面和口头场合。",
    translation: "这是一句演练用的中文译文，表达原句的基本意思。",
    note: "这个句型后面接具体对象，用来说明动作涉及的范围，语气比较中性。", contrast: "两者都能用在相似场合，但这个词更强调结果，换用另一个词会让语气更随意。",
    gloss: "在这句话里，这个词表示后面的动作不受前面情况的影响。", etymology: "这个词由更短的词根加上后缀构成，构词方式比较常见。" },
  en: { summary: "These points help a learner use the expression naturally in everyday situations.",
    explanation: "This use usually names the thing involved directly after the expression, and the tone stays neutral in speech and writing.",
    translation: "This is a rehearsal translation that keeps the basic meaning of the sentence.",
    note: "Use this pattern with a direct object to say what the action concerns; the tone is neutral.", contrast: "Both forms fit similar situations, but this one stresses the result, while the alternative sounds more casual.",
    gloss: "In this sentence the word shows that the action happens regardless of what came before.", etymology: "The word is built from a shorter root with a common suffix." }
};
const READING = {
  notwithstanding: "尽管下着雨，她还是不肯待在家里。", charge: "那天晚上船长接管了这艘船。",
  "давать": "父亲不想给他路费。", magari: "要是真的就好了，那个女人望着大海说。", provider: "自从父亲病倒的那个冬天起，他就是家里唯一的经济支柱。"
};
const fail = (model, term, kind) => ({
  "commandcode/glm-5.3-flash|ran|register": "http500", "commandcode/minimax-m3.1-flash|take off|scenarios": "length",
  "commandcode/gemini-3.8-flash|눈치|entry": "empty", "commandcode/ling-3.1-flash|magari|card": "overlimit",
  "commandcode/mimo-v2.6-pro|charge|card": "mixed", "commandcode/claude-haiku-5-5|随便|card": "emptycard",
  "commandcode/deepseek-v4.1-flash|давать|reading": "unreadable",
  // The gateway answers with another model: the driver must stop this model.
  "commandcode/gemini-3.8-flash|随便|grammar": "othermodel"
})[model + "|" + term + "|" + kind] || "";

export async function dispatch(_url, init) {
  const request = JSON.parse(init.body), prompt = request.messages[0].content, model = request.model;
  if (init.headers.Authorization !== "Bearer dict-redesign-browser-placeholder") throw new Error("rehearsal_key_leak");
  const input = JSON.parse(prompt.split("\n").at(-1)), lang = input.targetLanguage.lang, t = TEXT[lang] || TEXT.en;
  const kind = prompt.startsWith("Create a concise reusable dictionary entry") ? "entry" : prompt.startsWith("Create one compact usage card") ? "card"
    : prompt.startsWith("Explain one original sentence") ? "reading" : input.category;
  const mode = fail(model, input.term, kind);
  // mimo refuses response_format by name, OpenAI error shape: the product's
  // dialect negotiation drops it once per browser profile and remembers.
  if (model === "commandcode/mimo-v2.6-pro" && request.response_format) return json(400, { error: {
    message: "Unsupported parameter: 'response_format' is not supported with this model.", type: "invalid_request_error", param: "response_format", code: "unsupported_parameter" } });
  if (mode === "http500") return json(500, { error: { message: "Upstream provider error", type: "server_error", code: "upstream_error" } });
  if (mode === "empty") return completion(model, "", "stop", { prompt_tokens: 420, completion_tokens: 0, total_tokens: 420 });
  if (mode === "length") return completion(model, '{"language":"' + lang + '","summary":"', "length", { prompt_tokens: 900, completion_tokens: 8192, total_tokens: 9092 });
  if (kind === "entry") {
    const [pos, definition, text, translation] = ENTRY[input.term];
    const meanings = [{ partOfSpeech: pos, definition, examples: [{ text, translation }] }];
    if (input.term === "charge") meanings.push({ partOfSpeech: "动词", definition: "收费；要价。", examples: [] });
    return completion(model, JSON.stringify({ word: input.term, language: input.sourceLanguage, pronunciation: "", meanings }), "stop", { prompt_tokens: 440, completion_tokens: 190, total_tokens: 630 });
  }
  if (kind === "card") {
    const item = (head, note, example) => ({ sense: 1, head, note, example, translation: t.translation });
    // Contrast examples differ from the pattern example except for charge,
    // which repeats it (one deliberate cross-section duplicate).
    const contrastExample = input.term === "charge" ? ENTRY[input.term][2] + " " : ENTRY[input.term][2].replace(/[.!?。！？]$/u, "") + " (contrast).";
    let patterns = [item(input.term + " <something>", t.note, ENTRY[input.term][2])], contrasts = [item(input.term + " alternative", t.contrast, contrastExample)];
    if (mode === "overlimit") patterns = Array.from({ length: 6 }, (_, i) => item(input.term + " <slot " + (i + 1) + ">", t.note, ENTRY[input.term][2]));
    if (mode === "mixed") patterns.push({ sense: 2, head: "charge <someone> for <something>", note: "This note is written in English and must be removed by the per-item language check.", example: "They charged me for the repair.", translation: "They charged me." });
    if (mode === "emptycard") { patterns = []; contrasts = []; }
    // Gemini-compat style: reasoning only inside total_tokens.
    const usage = model.includes("gemini") ? { prompt_tokens: 1100, completion_tokens: 520, total_tokens: 4620 } : { prompt_tokens: 1100, completion_tokens: 520, total_tokens: 1620 };
    return completion(model, JSON.stringify({ language: lang, patterns, contrasts }), "stop", usage);
  }
  if (kind === "reading") {
    const body = mode === "unreadable" ? { language: lang, readable: false, sense: 0, gloss: "", translation: "" }
      : { language: lang, readable: true, sense: 1, gloss: t.gloss, translation: READING[input.term] || t.translation };
    return completion(model, JSON.stringify(body), "stop", { prompt_tokens: 760, completion_tokens: 160, total_tokens: 920 });
  }
  if (kind === "etymology") {
    const sourced = input.sources.length > 0;
    return completion(model, JSON.stringify({ language: lang, summary: t.summary, items: [{ kind: sourced ? "history" : "formation", sense: 0,
      title: input.term, explanation: t.etymology, sourceIndex: sourced ? 0 : -1 }] }), "stop", { prompt_tokens: 1040, completion_tokens: 220, total_tokens: 1260 });
  }
  if (kind === "literature") {
    return completion(model, JSON.stringify({ language: lang, summary: t.summary, items: [{ sense: 1, title: input.sources[0].work,
      explanation: t.gloss, translation: t.translation, sourceIndex: 0 }] }), "stop", { prompt_tokens: 990, completion_tokens: 210, total_tokens: 1200 });
  }
  // collocations and confusables share one example (two duplicate items per
  // word); the other categories use their own.
  const example = ["collocations", "confusables"].includes(kind) ? ENTRY[input.term][2] : ENTRY[input.term][2].replace(/[.!?。！？]$/u, "") + " (" + kind + ").";
  return completion(model, JSON.stringify({ language: lang, summary: t.summary, items: [{ sense: 1, title: input.term + " · " + kind,
    explanation: t.explanation, example, translation: t.translation }] }), "stop", { prompt_tokens: 720, completion_tokens: 300, total_tokens: 1020 },
    mode === "othermodel" ? "commandcode/gemini-3.8-flash-lite" : undefined);
}

const section = (h2, h3, body) => `<div class="mw-heading mw-heading2"><h2>${h2}</h2></div><div class="mw-heading mw-heading3"><h3>${h3}</h3></div><p>${body}</p>`;
const WIKTIONARY = {
  "en.wiktionary.org": { charge: section("English", "Etymology", "From Middle English <i>chargen</i>, from Old French <i>chargier</i> (to load)."),
    notwithstanding: section("English", "Etymology", "From Middle English, from <i>not</i> + <i>withstanding</i>."),
    provider: section("English", "Etymology", "From <i>provide</i> + <i>-er</i>.") },
  "de.wiktionary.org": { bekommen: '<div class="mw-heading mw-heading2"><h2>bekommen (Deutsch)</h2></div><p title="Etymologie und Morphologie">Herkunft:</p><dl><dd>von mittelhochdeutsch <i>bekomen</i>, althochdeutsch <i>biqueman</i></dd></dl>' },
  "es.wiktionary.org": { embarazada: section("Español", "Etimología", "Participio de <i>embarazar</i>.") },
  "fr.wiktionary.org": { actuellement: section("Français", "Étymologie", "Dérivé de <i>actuel</i> avec le suffixe <i>-ment</i>.") },
  "it.wiktionary.org": { magari: section("Italiano", "Etimologia", "Dal greco <i>makárie</i>, beato.") },
  "ru.wiktionary.org": { "давать": section("Русский", "Этимология", "Происходит от праслав. <i>*davati</i>.") },
  "ja.wiktionary.org": { "やばい": section("日本語", "語源", "江戸時代の語「やば」に由来するとされる。") }
};
const novel = (author, paragraph) => `<div class="ws-header"><a href="${author[0]}">${author[1]}</a></div><p>${paragraph}</p>`;
const WIKISOURCE = {
  "en.wikisource.org": {
    notwithstanding: ["Fixture Novel/Chapter 3", 301, novel(["/wiki/Author:Fixture_Writer", "Fixture Writer"], "Notwithstanding the rain, she would not stay at home. She took her coat and walked to the station before dawn."), "Novels"],
    charge: ["Second Fixture Novel/Chapter 1", 302, novel(["/wiki/Author:Another_Writer", "Another Writer"], "The captain took charge of the ship that night. The crew went quietly to work and nobody questioned the order."), "Novels"],
    provider: ["Fixture Tale/Chapter 2", 303, novel(["/wiki/Author:Fixture_Writer", "Fixture Writer"], "He had been the sole provider for his family since the winter his father fell ill."), "Short stories"] },
  "ru.wikisource.org": { "давать": ["Тестовый роман/Глава 1", 401, novel(["/wiki/Автор:Тест_Писатель", "Тест Писатель"], "Отец не хотел давать ему денег на дорогу. Он молча вышел из дома и долго стоял у ворот."), "Романы"] },
  "it.wikisource.org": { magari: ["Romanzo di prova/Capitolo 2", 501, novel(["/wiki/Autore:Scrittore_di_prova", "Scrittore di prova"], "Magari fosse vero, disse la donna guardando il mare. Poi tornò in casa senza aggiungere altro."), "Romanzi"] }
};
const WIKIPEDIA = {
  "en.wikipedia.org": { based: ["Based", 601, "<p>Based is a slang term used to express approval of an opinion that is independent of popular views.</p>"] },
  "ja.wikipedia.org": { "やばい": ["やばい", 701, "<p>「やばい」は危険や不都合を表す俗語で、近年は肯定的な驚きにも使われる。</p>"] }
};
const missing = () => json(200, { error: { code: "missingtitle", info: "The page you specified doesn't exist.", docref: "See https://www.mediawiki.org/w/api.php for API usage." }, servedby: "mw-api-ext.fixture" });
const parsed = (title, pageid, html, categories) => json(200, { parse: { title, pageid, revid: pageid * 1000 + 7,
  text: '<div class="mw-content-ltr mw-parser-output" lang="und" dir="ltr">' + html + "</div>", categories: categories.map(category => ({ sortkey: "", category })) } });

export async function wikimedia(url) {
  const host = url.hostname, action = url.searchParams.get("action");
  if (host.startsWith("ko.")) return new Response("<html><body>upstream connect error</body></html>", { status: 503, headers: { "Content-Type": "text/html" } });
  if (action === "query") {
    const query = url.searchParams.get("srsearch") || "", table = host.endsWith("wikisource.org") ? WIKISOURCE[host] : host.endsWith("wikipedia.org") ? WIKIPEDIA[host] : null;
    const hits = Object.entries(table || {}).filter(([term]) => query.includes('"' + term + '"')).map(([, row]) => ({ ns: 0, title: row[0], pageid: row[1] }));
    return json(200, { batchcomplete: true, query: { searchinfo: { totalhits: hits.length }, search: hits } });
  }
  const page = url.searchParams.get("page");
  if (host.endsWith("wiktionary.org")) {
    const html = WIKTIONARY[host]?.[page];
    return html ? parsed(page, 100 + page.length, html, ["Fixture entries"]) : missing();
  }
  const table = host.endsWith("wikisource.org") ? WIKISOURCE[host] : WIKIPEDIA[host];
  for (const row of Object.values(table || {})) {
    if (row[0] === page || row[0].toLocaleLowerCase() === String(page).toLocaleLowerCase()) return parsed(row[0], row[1], row[2], row[3] ? [row[3]] : ["Fixture"]);
  }
  return missing();
}
