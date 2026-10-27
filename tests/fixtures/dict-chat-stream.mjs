// Handwritten OpenAI-compatible streaming wire body for the offline driver
// replays (plan 2.7: dictionary generation streams). It writes the documented
// chat.completion.chunk event shape around a handwritten answer, independent
// of the product's stream reader and of the drivers' SSE parser:
//   developers.openai.com/api/reference/resources/chat (streaming)
// A gateway keep-alive comment comes first (OpenRouter documents
// ": OPENROUTER PROCESSING"); then a role chunk, the answer text in content
// chunks of about one token each (three characters; splits fall inside JSON
// strings), as DeepSeek and OpenRouter send them, each event carrying the
// id/object/created/model/system_fingerprint and choice logprobs fields; a
// final chunk with an empty delta, the finish_reason and the usage some
// gateways attach to it; and [DONE]. Each event ends with a blank line. Real
// framing size matters: the driver bridges bound the raw SSE body, and a body
// cut into a handful of large chunks would hide that bound.
export function chatCompletionStream(completion, { charsPerChunk = 3 } = {}) {
  const choice = completion.choices[0], text = choice.message.content;
  const chunk = (delta, finish, extra = {}) => "data: " + JSON.stringify({ id: completion.id || "chatcmpl-fixture",
    object: "chat.completion.chunk", created: completion.created || 0, model: "fixture", system_fingerprint: "fp_fixture",
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }], ...extra }) + "\n\n";
  const parts = [];
  for (let at = 0; at < text.length; at += charsPerChunk) parts.push(text.slice(at, at + charsPerChunk));
  return ": OPENROUTER PROCESSING\n\n" + chunk({ role: "assistant", content: "" }, null) +
    parts.map(part => chunk({ content: part }, null)).join("") +
    chunk({}, choice.finish_reason, completion.usage ? { usage: completion.usage } : {}) + "data: [DONE]\n\n";
}
