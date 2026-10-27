// Handwritten `ai-dev prices --provider commandcode --model <id>` outputs
// (schema as printed by ai-dev on 2026-10-26). Test data, not live prices.
const RATES = { "commandcode/deepseek-v4.1-flash": [3e-7, 1.2e-6], "commandcode/glm-5.3-flash": [1.5e-7, 5e-7], "commandcode/minimax-m3.1-flash": [1.5e-7, 6e-7],
  "commandcode/ling-3.1-flash": [3e-7, 9e-7], "commandcode/mimo-v2.6-pro": [4.35e-7, 8.7e-7], "commandcode/claude-haiku-5-5": [1e-7, 5e-7], "commandcode/gemini-3.8-flash": [1.5e-6, 7.5e-6] };
const POLICY = { "commandcode/claude-haiku-5-5": "长上下文按分档计价", "commandcode/gemini-3.8-flash": "标准费率；额度与ZDR费用另核对" };
export const prices = Object.fromEntries(Object.entries(RATES).map(([id, [input, output]]) => [id, {
  snapshot: { source: "models.json", fetched_at: 1792953993, stale_after_hours: 720, age_hours: 2, stale: false },
  result: { [id]: { litellm_provider: "commandcode", source: "https://commandcode.ai/docs/plans/goat", catalog_verified_at: "2026-10-25T18:46:33+00:00", catalog_model: id,
    ...(POLICY[id] ? { pricing_policy: POLICY[id] } : {}),
    max_context_tokens: 1000000, input_cost_per_token: input, output_cost_per_token: output, cache_read_input_token_cost: input / 10,
    ...(id.includes("haiku") ? { cache_creation_input_token_cost: 1.25e-7, input_cost_per_token_above_100k_tokens: 5e-7, output_cost_per_token_above_100k_tokens: 2.5e-6,
      cache_read_input_token_cost_above_100k_tokens: 5e-8, cache_creation_input_token_cost_above_100k_tokens: 6.25e-7 } : {}) } } }]));
