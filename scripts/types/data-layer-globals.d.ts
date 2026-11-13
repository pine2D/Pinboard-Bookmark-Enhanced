// Dev-only ambient declarations for cross-file runtime helpers consumed by the
// 6 pure data-layer scripts checked under scripts/jsconfig.data-layer.json.
// Never shipped in the extension ZIP (scripts/ is excluded from release.sh).

/// <reference types="chrome" />

interface PbpStripTrackingResult {
  cleaned: string;
  removedCount: number;
  original: string;
}

// ---- shared.js ----
declare function pbpBookmarkFormatTags(names: readonly string[]): string;
declare function pbpBookmarkEndpoint(raw: unknown): string;
declare function pbpRetryAfterDelay(value: unknown, now?: number): number | undefined;
declare function pbpBookmarkDescriptionText(value: unknown): string;
declare function pbpBookmarkDescriptionChanged(next: unknown, stored: unknown): boolean;
declare function pbpLinkdingOverlongTag(names: unknown): string;
declare function pbpLinkdingUrlRejected(url: unknown): boolean;
declare function pbpEndpointOriginPattern(raw: unknown): string | null;
declare function deobfuscateKey(val: unknown): string;
declare function pbpVocabCurrentOwner(): Promise<string>;
declare function stripTrackingParams(
  urlStr: string,
  settings?: {
    enabled?: boolean;
    aggressiveMode?: boolean;
    customParams?: string[];
    excludeParams?: string[];
  },
): PbpStripTrackingResult;

// ---- md-convert.js ----
declare function applyFrontmatter(
  md: string,
  meta?: Record<string, any>,
  opts?: { fields?: string[] },
): string;
declare function safeFilename(title?: string): string;
declare function buildObsidianUri(opts?: {
  action?: "new" | "daily" | string;
  name?: string;
  folder?: string;
  vault?: string;
  clipboard?: boolean;
  append?: boolean;
  content?: string;
}): string;

// ---- vocab-gdrive.js ----
declare function pbpVocabOwnerHash(owner: string): Promise<string>;

// ---- ai-cache.js ----
declare function _pbpAiOpenDB(): Promise<IDBDatabase>;
