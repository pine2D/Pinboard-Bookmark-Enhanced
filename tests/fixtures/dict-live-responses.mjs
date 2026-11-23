// Handwritten OpenAI-compatible HTTP response fixtures, verified on 2026-11-23
// against live Bailian (qwen3.8-flash), SiliconFlow (deepseek-ai/DeepSeek-V4.1-Flash),
// and Command Code (/v1/chat/completions) envelopes. They remain deliberately
// independent of production parsers, prompts and archive constructors.
const envelope = (id, created, content, promptTokens, completionTokens) => ({
  id, object: "chat.completion", created, model: "fixture-model", system_fingerprint: "",
  choices: [{ index: 0, logprobs: null, finish_reason: "stop", message: { role: "assistant", content: content === undefined ? "" : content } }],
  usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } }
});
export const entryResponse = envelope("offline-entry-fixture", 1795407766, JSON.stringify({
  word: "provider", language: "en", pronunciation: "/prəˈvaɪdər/",
  meanings: [{ partOfSpeech: "noun", definition: "提供服务、物品或资源的人或机构。", examples: [
    { text: "The company is an internet service provider.", translation: "这家公司是互联网服务提供商。" }
  ] }],
  learning: { version: 2, formation: "由动词 provide 加表示执行者的后缀 -er 构成。", history: "", related: [
    { word: "provide", relation: "family", note: "表示提供，是这个名词对应的动词。" }
  ] }
}), 400, 240);
export const supplementResponse = envelope("offline-supplement-fixture", 1795407767, JSON.stringify({
  language: "zh-Hans", summary: "常用搭配强调所提供的服务类型。", items: [{ sense: 1,
    title: "service provider", explanation: "表示服务提供商，前面可以加具体的服务类别来限定范围。",
    example: "We need a reliable service provider.", translation: "我们需要可靠的服务提供商。", sourceIndex: -1
  }]
}), 500, 180);
// The two usage-point cases after the 2026-10-27 redesign (plan 1B.9): the
// "collocations and sentence patterns" card in its own wire shape, and the
// confusables supplement in the shared shape. sourceIndex is left out as the
// confusables schema asks, so the product's response normalization is used.
export const patternsResponse = envelope("offline-patterns-fixture", 1795407768, JSON.stringify({
  language: "zh-Hans", patterns: [
    { sense: 1, head: "a provider of <something>", note: "说明某个机构或个人提供哪一类东西，介词“of”后面接所提供的服务或物品。",
      example: "The city is a major provider of public housing.", translation: "这座城市是公共住房的主要提供者。" },
    { sense: 1, head: "<service> provider", note: "前面直接加名词说明服务类别，例如“service provider”和“care provider”。",
      example: "Our internet provider raised its prices.", translation: "我们的网络服务商提高了价格。" }
  ]
}), 520, 210);
export const confusablesResponse = envelope("offline-confusables-fixture", 1795407769, JSON.stringify({
  language: "zh-Hans", summary: "“provider” 偏重提供服务的一方，“supplier” 多指供应货物的一方。", items: [{ sense: 1,
    title: "“provider” 与 “supplier”", explanation: "“provider” 多用于服务或资源的提供方；“supplier” 多指向企业供应原料或货物的一方，换用后所指的业务类型会改变。",
    example: "The hospital changed its food supplier.", translation: "医院更换了食品供应商。"
  }]
}), 560, 190);
