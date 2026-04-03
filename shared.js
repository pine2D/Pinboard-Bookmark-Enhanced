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
