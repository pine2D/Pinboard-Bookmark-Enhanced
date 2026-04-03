// ============================================================
// Pinboard Bookmark Plus - Shared Constants
// ============================================================

const DEFAULT_TAG_PROMPT = `Suggest 5-10 bookmark tags for the following webpage. Tags should be lowercase, use hyphens for multi-word. Return ONLY a JSON array.

Title: {{title}}
URL: {{url}}
Content: {{content}}

Format: ["tag1","tag2"]`;

const DEFAULT_SUMMARY_PROMPT = `Summarize the following webpage concisely in 2-4 sentences. Focus on key points. {{lang_instruction}}

Title: {{title}}
Content: {{content}}`;

// Simple obfuscation for API keys stored in chrome.storage
// Not real encryption — prevents casual plaintext reading
function obfuscateKey(key) {
  if (!key) return "";
  try { return "obf:" + btoa(unescape(encodeURIComponent(key))); } catch (_) { return key; }
}
function deobfuscateKey(val) {
  if (!val) return "";
  if (!val.startsWith("obf:")) return val; // backwards compatible with plaintext
  try { return decodeURIComponent(escape(atob(val.substring(4)))); } catch (_) { return val; }
}

const SETTINGS_DEFAULTS = {
  pinboardToken: "",
  aiProvider: "gemini",
  geminiApiKey: "", geminiModel: "gemini-2.0-flash",
  openaiApiKey: "", openaiModel: "gpt-4o-mini", openaiBaseUrl: "https://api.openai.com/v1",
  claudeApiKey: "", claudeModel: "claude-sonnet-4-20250514",
  deepseekApiKey: "", deepseekModel: "deepseek-chat",
  qwenApiKey: "", qwenModel: "qwen-turbo",
  minimaxApiKey: "", minimaxModel: "MiniMax-Text-01",
  openrouterApiKey: "", openrouterModel: "google/gemini-2.0-flash-exp:free",
  ollamaBaseUrl: "http://localhost:11434", ollamaModel: "llama3",
  customApiKey: "", customModel: "", customBaseUrl: "", customName: "Custom",
  aiSummaryLang: "auto", aiCacheDuration: 60,
  customTagPrompt: "", customSummaryPrompt: "",
  optPrivateDefault: false, optPrivateIncognito: false, optReadlaterDefault: false,
  optAutoDescription: true, optBlockquote: true, optIncludeReferrer: true,
  optAiAutoTags: false,
  ctxAutoNotes: true, ctxBlockquote: true, ctxDefaultTags: "", ctxAiTags: false, ctxAiSummary: false,
  qsAutoNotes: true, qsBlockquote: true, qsDefaultTags: "", qsAiTags: false, qsAiSummary: false,
  rlAutoNotes: true, rlBlockquote: true, rlDefaultTags: "", rlAiTags: false, rlAiSummary: false,
  optBatchTagEnabled: true, optBatchTag: "batch_saved",
  batchAiTags: false, batchAiSummary: false, batchSkipExisting: false,
  optShowRecent: true, optShowSearch: true, optTheme: "auto",
  notifyContextMenu: true, notifyQuickSave: true, notifyReadLater: true,
  notifyTabSet: true, notifyBatchSave: true, notifyErrors: true,
  customFont: "", customCSS: ""
};

const API_KEY_FIELDS = ["pinboardToken","geminiApiKey","openaiApiKey","claudeApiKey","deepseekApiKey","qwenApiKey","minimaxApiKey","openrouterApiKey","customApiKey"];

function deobfuscateSettings(s) {
  API_KEY_FIELDS.forEach(k => { if (s[k]) s[k] = deobfuscateKey(s[k]); });
  return s;
}
