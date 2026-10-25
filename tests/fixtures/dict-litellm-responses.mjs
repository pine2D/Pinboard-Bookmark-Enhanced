// Independent synthetic responses for an offline harness rehearsal, NOT live
// model results or evidence to send to a provider. No production constructors.
import { entryResponse, supplementResponse } from "./dict-live-responses.mjs";
export const evidence = {
  "provider:etymology": { ok: true, sources: [] },
  "based:etymology": { ok: true, sources: [] },
  "provider:literature": { ok: true, sources: [{ title: "Synthetic Novel/Chapter 1", url: "https://en.wikisource.org/wiki/Synthetic_Novel/Chapter_1?oldid=123",
    excerpt: "He was the sole provider for his family.", author: "Fixture Author", work: "Synthetic Novel", location: "Chapter 1, paragraph 1",
    language: "en", genre: "novel", revision: "123", retrievedAt: 1792886400000 }] },
  "based:culture": { ok: true, sources: [{ title: "Based", url: "https://en.wikipedia.org/wiki/Based?oldid=456",
    excerpt: "Based is slang for expressing approval of an opinion or action.", author: "", work: "Based", location: "paragraph 1",
    language: "en", genre: "culture", revision: "456", retrievedAt: 1792886400000 }] }
};
export async function dispatch(_url, init) {
  const request = JSON.parse(init.body), prompt = request.messages[0].content;
  const input = JSON.parse(prompt.split("\n").at(-1));
  if (init.headers["x-litellm-num-retries"] !== "0" || request.disable_fallbacks !== true || request.num_retries !== 0) throw new Error("rehearsal_limits_missing");
  let response;
  if (prompt.startsWith("Create a concise reusable dictionary entry")) {
    response = structuredClone(entryResponse);
    if (prompt.includes('"term":"based"')) response.choices[0].message.content = JSON.stringify({
      word: "based", language: "en", pronunciation: "", meanings: [{ partOfSpeech: "形容词", definition: "在网络交流中表示赞同某人的观点或行为。", examples: [] }],
      learning: { version: 2, formation: "", history: "", related: [] }
    });
  } else if (input.category === "literature") {
    response = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
      language: "zh-Hans", summary: "这段文字强调人物承担家庭生计的责任。", items: [{ sense: 1, title: "家庭供养者",
        explanation: "这里指为家人提供生活所需的人，重点是家庭责任。", translation: "他是家里唯一的经济支柱。", sourceIndex: 0 }]
    }) } }], usage: { prompt_tokens: 650, completion_tokens: 140, total_tokens: 790 } };
  } else if (input.category === "culture") {
    response = { choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
      language: "zh-Hans", summary: "这是网络交流中的赞同表达。", items: [{ sense: 1, title: "based",
        explanation: "资料支持的用法是对观点或行为表示赞同，不能据此断言流行程度或起源。", sourceIndex: 0 }]
    }) } }], usage: { prompt_tokens: 650, completion_tokens: 140, total_tokens: 790 } };
  } else response = structuredClone(supplementResponse);
  return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
}
