// Handwritten OpenAI-compatible HTTP response fixtures. They are deliberately
// independent of production parsers, prompts and archive constructors.
export const entryResponse = {
  id: "offline-entry-fixture", object: "chat.completion", created: 1792886400,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
    word: "provider", language: "en", pronunciation: "/prəˈvaɪdər/",
    meanings: [{ partOfSpeech: "noun", definition: "提供服务、物品或资源的人或机构。", examples: [
      { text: "The company is an internet service provider.", translation: "这家公司是互联网服务提供商。" }
    ] }],
    learning: { version: 2, formation: "由动词 provide 加表示执行者的后缀 -er 构成。", history: "", related: [
      { word: "provide", relation: "family", note: "表示提供，是这个名词对应的动词。" }
    ] }
  }) } }], usage: { prompt_tokens: 400, completion_tokens: 240, total_tokens: 640 }
};
export const supplementResponse = {
  id: "offline-supplement-fixture", object: "chat.completion", created: 1792886401,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
    language: "zh-Hans", summary: "常用搭配强调所提供的服务类型。", items: [{ sense: 1,
      title: "service provider", explanation: "表示服务提供商，前面可以加具体的服务类别来限定范围。",
      example: "We need a reliable service provider.", translation: "我们需要可靠的服务提供商。", sourceIndex: -1
    }]
  }) } }], usage: { prompt_tokens: 500, completion_tokens: 180, total_tokens: 680 }
};
