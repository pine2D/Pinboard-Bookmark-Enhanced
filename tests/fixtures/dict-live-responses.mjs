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
// The two usage-point cases after the 2026-10-27 redesign (plan 1B.9): the
// "collocations and sentence patterns" card in its own wire shape, and the
// confusables supplement in the shared shape. sourceIndex is left out as the
// confusables schema asks, so the product's response normalization is used.
export const patternsResponse = {
  id: "offline-patterns-fixture", object: "chat.completion", created: 1792886402,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
    language: "zh-Hans", patterns: [
      { sense: 1, head: "a provider of <something>", note: "说明某个机构或个人提供哪一类东西，介词“of”后面接所提供的服务或物品。",
        example: "The city is a major provider of public housing.", translation: "这座城市是公共住房的主要提供者。" },
      { sense: 1, head: "<service> provider", note: "前面直接加名词说明服务类别，例如“service provider”和“care provider”。",
        example: "Our internet provider raised its prices.", translation: "我们的网络服务商提高了价格。" }
    ]
  }) } }], usage: { prompt_tokens: 520, completion_tokens: 210, total_tokens: 730 }
};
export const confusablesResponse = {
  id: "offline-confusables-fixture", object: "chat.completion", created: 1792886403,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
    language: "zh-Hans", summary: "“provider” 偏重提供服务的一方，“supplier” 多指供应货物的一方。", items: [{ sense: 1,
      title: "“provider” 与 “supplier”", explanation: "“provider” 多用于服务或资源的提供方；“supplier” 多指向企业供应原料或货物的一方，换用后所指的业务类型会改变。",
      example: "The hospital changed its food supplier.", translation: "医院更换了食品供应商。"
    }]
  }) } }], usage: { prompt_tokens: 560, completion_tokens: 190, total_tokens: 750 }
};
