// Handwritten OpenAI-compatible streaming wire body for the offline driver
// replays (plan 2.7: dictionary generation streams), verified on 2026-11-23
// against live Bailian, MiniMax, SiliconFlow, and Command Code SSE streams.
// It writes the documented chat.completion.chunk event shape around a
// handwritten answer, independent of the product's stream reader and of the
// drivers' SSE parser:
//   developers.openai.com/api/reference/resources/chat (streaming)
// A gateway keep-alive comment comes first (OpenRouter documents
// ": OPENROUTER PROCESSING"); then a role chunk, the answer text in content
// chunks of about one token each (three characters; splits fall inside JSON
// strings), each event carrying id/object/created/model/system_fingerprint,
// choice logprobs, and usage:null; a stop chunk (content:null, finish_reason),
// a trailing empty-choices usage chunk when usage is present, and [DONE].
// Real framing size matters: the driver bridges bound the raw SSE body.
export function chatCompletionStream(completion, { charsPerChunk = 3 } = {}) {
  const choice = completion.choices[0], text = choice.message.content;
  const id = completion.id === undefined ? "chatcmpl-fixture" : completion.id;
  const created = completion.created === undefined ? 0 : completion.created;
  const model = completion.model === undefined ? "fixture" : completion.model;
  const chunk = (choices, usage = null) => "data: " + JSON.stringify({ id, object: "chat.completion.chunk",
    created, model, system_fingerprint: "", choices, usage }) + "\n\n";
  const parts = [];
  for (let at = 0; at < text.length; at += charsPerChunk) parts.push(text.slice(at, at + charsPerChunk));
  return ": OPENROUTER PROCESSING\n\n" +
    chunk([{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }]) +
    parts.map(part => chunk([{ index: 0, delta: { content: part }, logprobs: null, finish_reason: null }])).join("") +
    chunk([{ index: 0, delta: { content: null }, logprobs: null, finish_reason: choice.finish_reason }]) +
    (completion.usage === undefined ? "" : chunk([], completion.usage)) + "data: [DONE]\n\n";
}
