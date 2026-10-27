// Handwritten OpenAI-compatible chat completion responses for the offline
// rehearsal of scripts/dict-redesign-test-r2.mjs (word "charge", en ->
// zh-Hans). They are independent of the production prompts, parsers and
// archive constructors: each answer is written the way a model returns it
// for the arm's schema (confusables without sourceIndex, etymology without
// example/translation), so the product's own response normalization runs.
const completion = (id, created, content, usage) => ({ id, object: "chat.completion", created, model: "rehearsal/model-a",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }], usage });

export const entryResponse = completion("r2-entry-fixture", 1793059200, {
  word: "charge", language: "en", pronunciation: "/tʃɑːdʒ/",
  meanings: [
    { partOfSpeech: "名词", definition: "（商品或服务的）费用，收费。", examples: [
      { text: "There is no charge for delivery.", translation: "送货不收费。" }] },
    { partOfSpeech: "动词", definition: "指控，控告（某人犯有某罪）。", examples: [
      { text: "He was charged with theft.", translation: "他被控犯有盗窃罪。" }] }
  ]
}, { prompt_tokens: 420, completion_tokens: 260, total_tokens: 680 });

export const patternsResponse = completion("r2-patterns-fixture", 1793059201, {
  language: "zh-Hans", patterns: [
    { sense: 1, head: "free of charge", note: "表示不收取任何费用，通常放在句末说明整个动作免费。",
      example: "The museum is open free of charge on Sundays.", translation: "博物馆周日免费开放。" },
    { sense: 2, head: "charge <someone> with <an offence>", note: "表示正式指控某人犯有某种罪行，罪行放在介词“with”之后，常用被动语态。",
      example: "She was charged with fraud.", translation: "她被控犯有欺诈罪。" }
  ]
}, { prompt_tokens: 610, completion_tokens: 230, total_tokens: 840 });

export const confusablesResponse = completion("r2-confusables-fixture", 1793059202, {
  language: "zh-Hans", summary: "“charge” 泛指收取的费用，“fee” 多指固定的专业服务费。", items: [{ sense: 1,
    title: "“charge” 与 “fee”", explanation: "“charge” 泛指为商品或服务支付的金额；“fee” 多指付给律师、学校等机构的固定费用，换用后语气更正式。",
    example: "The school raised its tuition fee.", translation: "学校提高了学费。" }]
}, { prompt_tokens: 650, completion_tokens: 200, total_tokens: 850 });

export const etymologyResponse = completion("r2-etymology-fixture", 1793059203, {
  language: "zh-Hans", summary: "现代英语里常用前缀和后缀从这个词派生新词。", items: [{ kind: "formation", sense: 0,
    title: "re- + charge", explanation: "加前缀“re-”构成“recharge”，表示再次充电或重新补充；加后缀“-er”构成“charger”，指充电器。",
    sourceIndex: -1 }]
}, { prompt_tokens: 700, completion_tokens: 180, total_tokens: 880 });

// Chosen by the production prompt's opening line and payload, never by provider.
export function responseFor(body) {
  const content = body.messages[0].content, payload = JSON.parse(content.split("\n").at(-1));
  if (content.startsWith("Create one compact usage card")) return patternsResponse;
  if (content.startsWith("Create a concise language-learning supplement")) return payload.category === "etymology" ? etymologyResponse : confusablesResponse;
  return entryResponse;
}

// MediaWiki Action API error body for a page that does not exist (the shape
// en.wiktionary.org returns for action=parse on a missing title), so the
// etymology click runs without sources and asks for formation only.
export function wikimediaResponse() {
  return { error: { code: "missingtitle", info: "The page you specified doesn't exist.",
    docref: "See https://en.wiktionary.org/w/api.php for API usage." }, servedby: "mw-api-ext.eqiad.main-0" };
}
