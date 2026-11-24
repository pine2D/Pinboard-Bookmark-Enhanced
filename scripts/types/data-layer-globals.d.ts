// Dev-only ambient declarations for cross-file runtime helpers consumed by the
// 28 pure data-layer, sync, backup, send, cache, AI, dictionary, and conversion scripts checked under
// scripts/jsconfig.data-layer.json.
// Never shipped in the extension ZIP (scripts/ is excluded from release.sh).

/// <reference types="chrome" />

interface Window {
  __PBP_TYPO_CMP_COUNT?: () => number;
  __PBP_TYPO_CMP_INC?: () => number;
  __pp_urlShimInstalled?: boolean;
}

interface PbpCodedError extends Error {
  code?: string;
  status?: number;
  reason?: string;
  paramHint?: string;
}

declare var __pbpTestSyncSetLarge: ((key: string, value: any) => Promise<any>) | undefined;
declare var pbpMarkdownToPlainText: ((md: string) => string) | undefined;

// ---- site-rules.js (IIFE-attached window/self globals) ----
declare function applySiteRule(
  doc: Document,
  url: string,
): {
  id: string;
  contentHtml?: string;
  title?: string;
  url: string;
  math?: boolean;
  forum?: boolean;
  error?: string;
} | null;
declare function pbpSiteRuleText(html: string): string;

interface PbpStripTrackingResult {
  cleaned: string;
  removedCount: number;
  original: string;
}

type PbpDomControlElement = HTMLElement & {
  checked?: boolean;
  disabled?: boolean;
  files?: FileList | null;
  value?: string;
};

interface PbpBackupMetadata {
  createdAt: string;
  extensionVersion: string;
  source: string;
  includesSecrets?: boolean;
}

interface PbpPreflightBackupLibraryResult {
  schemaVersion: number;
  metadata?: PbpBackupMetadata;
  highlights?: Record<string, any>;
  highlightsOwner?: string;
  vocabulary?: { owner: string; records: any[] };
}

interface PbpBookmarkServiceState {
  active: string;
  chosen: string;
  activeStored: boolean;
  area: "sync" | "local";
  ready: Record<string, boolean>;
}

interface PbpAiCustomProviderEntry {
  id: string;
  name: string;
  protocol: string;
  baseUrl: string;
  model: string;
  slot: number;
}

// ---- pinboard-themes.js ----
declare const PINBOARD_THEMES: Record<string, { name?: string; css: string; [key: string]: any }>;
declare const ADAPTIVE_THEME_MAP: Record<string, [string, string]>;

// ---- vendor/ ----
declare class Defuddle {
  constructor(doc: Node, options?: Record<string, any>);
  parse(): {
    content?: string;
    title?: string;
    author?: string;
    published?: string;
    site?: string;
    wordCount?: number;
    [key: string]: any;
  };
}

declare class TurndownService {
  constructor(options?: Record<string, any>);
  addRule(
    key: string,
    rule: {
      filter: string | string[] | ((node: HTMLElement, options: any) => boolean);
      replacement: (content: string, node: HTMLElement, options: any) => string;
    },
  ): this;
  keep(filter: string | string[] | ((node: HTMLElement, options: any) => boolean)): this;
  remove(filter: string | string[] | ((node: HTMLElement, options: any) => boolean)): this;
  turndown(html: string | Node): string;
  escape(str: string): string;
}

declare namespace marked {
  class Renderer {
    [key: string]: any;
  }
  class TextRenderer {
    [key: string]: any;
  }
  namespace Parser {
    function parseInline(tokens: any[], options?: Record<string, any>): string;
  }
  function lexer(src: string, options?: Record<string, any>): any[];
  function parser(tokens: any[], options?: Record<string, any>): string;
  function parse(src: string, options?: Record<string, any>): string;
  function parseInline(src: string, options?: Record<string, any>): string;
  function use(...args: Record<string, any>[]): void;
  function walkTokens(tokens: any[], callback: (token: any) => void): void;
}

declare const DOMPurify: {
  sanitize(dirty: string | Node, cfg?: Record<string, any>): string;
  addHook(
    entryPoint: string,
    hookFunction: (currentNode: Element, hookEvent: any, config: any) => void,
  ): void;
};

declare const hljs: {
  configure(options: Record<string, any>): void;
  getLanguage(name: string): unknown;
  highlightElement(element: Element): void;
  highlightAuto(code: string, languageSubset?: string[]): { language?: string; relevance: number; value: string };
  listLanguages(): string[];
};

declare function renderMathInElement(elem: Element, options?: Record<string, any>): void;

// ---- md-dict.js ----
declare function pbpDictTsvField(v: unknown, columnIndex?: number): string;
declare function pbpDictTsv(rows: readonly Record<string, any>[]): string;

// ---- popup-ai.js ----
declare const AI_PROVIDER_ORDER: readonly string[];

// ---- background.js ----
declare const statusCache: Map<string, any>;
declare function getCurrentBookmarkAuth(): Promise<{
  service: string;
  token: string;
  account: string;
  [key: string]: any;
}>;
declare function runSaveDeliveryTransaction<T>(task: () => Promise<T>): Promise<T>;

// ---- md-highlight.js / md-ask.js / md-mermaid.js / md-embed.js / md-preview.js ----
declare function pbpHlComposeSection(items: readonly any[]): string;
declare function pbpHlInlineMark(md: string, items: readonly any[], view?: string): string;
declare function pbpAskExportNamespace(snapshot: any, occupied?: string, preferred?: string): string;
declare function pbpAskExportMarkdown(snapshot: any, opts?: Record<string, any>): string;
declare function pbpAskExportHtml(snapshot: any, opts?: Record<string, any>): string;
declare function pbpMermaidApplyCached(root: ParentNode): void;
declare function detectArticleLang(text: string): string;
declare const PBP_EMBED_MIME_EXT: Readonly<Record<string, string>>;
declare function pbpEmbedCanonicalUrl(u: string): string;

// ---- shared.js ----
declare const AI_TAG_CAP: number;
declare const TAG_GUIDANCE: string;
declare const DEFAULT_TAG_PROMPT: string;
declare const DEFAULT_SUMMARY_PROMPT: string;
declare const PBP_AI_PROTOCOLS: readonly ("openai" | "anthropic")[];
declare const POSTS_ADD_URI_BUDGET: number;
declare function pbpAiCustomEntryIdOk(id: unknown): boolean;
declare function pbpAiEndpointNorm(url: unknown): string;
declare function pbpAiCustomEntries(s?: Record<string, any> | null): PbpAiCustomProviderEntry[];
declare function pbpTagGroupKey(name: unknown): string;
declare function pbpFormatQuote(text: string, service?: string): string;
declare function pinboardFetch(url: string, options?: RequestInit): Promise<Response>;
declare function buildPostsAddUri(params: {
  token: string;
  url: string;
  title?: string;
  extended?: string;
  tags?: string;
  shared?: string;
  toread?: string;
  dt?: string;
  replace?: boolean;
}): string;
declare const API_KEY_FIELDS: readonly string[];
declare const PBP_AI_CUSTOM_SLOTS: readonly number[];
declare const PBP_BACKUP_LAST_EXPORT_KEY: string;
declare const PBP_BOOKMARK_SETTING_KEYS: readonly string[];
declare const PBP_DEEPSEEK_FETCH_ORIGIN_PATTERN: string;
declare const PBP_JINA_ORIGIN_PATTERN: string;
declare const PBP_LARGE_FALLBACK_KEYS: ReadonlySet<string>;
declare const PBP_PINBOARD_VERIFIED_KEY: string;
declare const SETTINGS_DEFAULTS: Record<string, any>;

declare function $id(id: string): PbpDomControlElement | null;
declare function setStatusIcon(el: Element | null, ok: boolean, text: unknown): void;
declare function showConfirmPopover(
  anchor: Element | null,
  opts: {
    msg?: string;
    subject?: string;
    detail?: string;
    yesText?: string;
    noText?: string;
    altText?: string;
    variant?: string;
    tone?: string;
    onConfirm?: () => any;
    onCancel?: () => any;
    onAlt?: () => any;
    onDismiss?: () => any;
  },
): boolean;

declare function resolveCacheMs(cacheDuration: unknown): number;
declare function getSettingsStorage(): Promise<chrome.storage.StorageArea>;
declare function pbpReadSettingsWithSecrets(
  query?: string | readonly string[] | Record<string, any> | null,
): Promise<Record<string, any>>;
declare function deobfuscateKey(val: unknown): string;
declare function deobfuscateSettings<T extends Record<string, any>>(s: T): T;
declare function persistSettings(
  data: Record<string, any>,
  opts?: { previewModelChanges?: Record<string, string>; previewModelReset?: boolean },
): Promise<{ ok: boolean; fellBackToLocal?: boolean; error?: Error }>;
declare function syncSetLarge(key: string, value: any, opts?: { mergeBase?: unknown }): Promise<any>;
declare function syncGetLarge<T = any>(key: string, defaultValue: T, opts?: { withBasis?: false }): Promise<T>;
declare function syncGetLarge<T = any>(key: string, defaultValue: T, opts: { withBasis: true }): Promise<{ value: T; basis: unknown }>;
declare function pbpAssertChunkedSyncReadComplete(key: string, value: unknown, explicitBasis?: unknown): Promise<void>;
declare function pbpAssertChunkedSettingsComplete(settings: Record<string, any>): Promise<void>;
declare function pbpDetectLargeLocalFallbacks(snapshot: Record<string, any>): string[];
declare function pbpLargeFallbackFieldLabel(key: string): string;

declare function pbpVocabCurrentOwner(): Promise<string>;
declare function pbpPersonalLibraryAccount(opts?: { initialize?: boolean }): Promise<string>;
declare function pbpPinboardAccountFromToken(token: unknown): string;

declare function pbpBookmarkFormatTags(names: readonly string[]): string;
declare function pbpBookmarkEndpoint(raw: unknown): string;
declare function pbpRetryAfterDelay(value: unknown, now?: number): number | undefined;
declare function pbpBookmarkDescriptionText(value: unknown): string;
declare function pbpBookmarkDescriptionChanged(next: unknown, stored: unknown): boolean;
declare function pbpLinkdingOverlongTag(names: unknown): string;
declare function pbpLinkdingUrlRejected(url: unknown): boolean;
declare function pbpEndpointOriginPattern(raw: unknown): string | null;
declare function pbpBookmarkServiceId(settings?: Record<string, any> | null): string;
declare function pbpBookmarkServiceLabel(settings?: Record<string, any> | null): string;
declare function pbpBookmarkConnection(settings?: Record<string, any> | null): {
  service: string;
  token: string;
  account: string;
  baseUrl: string;
  sharingEnabled?: boolean;
  connectionId?: string;
  gatewayType?: string;
  headers?: [string, string][];
  readLaterListId?: string;
};
declare function pbpBookmarkServiceReadyHere(
  settings: Record<string, any>,
  service: string,
  verified: unknown,
): Promise<boolean>;
declare function pbpReadBookmarkServiceState(): Promise<PbpBookmarkServiceState>;
declare function pbpSwitchBookmarkService(
  service: string,
  extra?: Record<string, any>,
): Promise<{ ok: boolean; fellBackToLocal?: boolean; error?: Error }>;

declare function pbpDictDefaultView(settings?: Record<string, any>): string;
declare function pbpAiWorkspaceIdOk(ws: unknown): boolean;
declare function pbpAiCustomNameOk(name: unknown): boolean;
declare function pbpAiCustomKeyField(slot: number): string;
declare function pbpAiCustomKeyOpen(
  settings: Record<string, any> | null | undefined,
  entry: Record<string, any> | null | undefined,
): string;
declare function pbpSanitizeAiCustomProviders(list: unknown): PbpAiCustomProviderEntry[] | null;
declare function pbpExportTargetSecretKeys(targetId: string): string[];
declare function pbpIsLocalDocUrl(rawUrl: unknown): boolean;

declare function stripTrackingParams(
  urlStr: string,
  settings?: {
    enabled?: boolean;
    aggressiveMode?: boolean;
    customParams?: string[];
    excludeParams?: string[];
  },
): PbpStripTrackingResult;

declare function pbpIsPlainRecord(value: unknown): value is Record<string, any>;
declare function pbpBackupValueError(key: string): TypeError & { pbpBackupField: string };
declare function pbpBackupErrorField(error: unknown): string;
declare function pbpSanitizeBackupThemes(value: unknown): Array<{ name: string; css: string }>;
declare function pbpIsHighlightBackupKey(key: unknown): key is string;
declare function pbpReadHighlightBackupSource(): Promise<Record<string, any>>;
declare function pbpBuildHighlightBackup(
  allLocal: Record<string, any> | null | undefined,
  ownerScope: string,
): Record<string, any> | null;
declare function pbpHighlightBackupHasOwnedItems(
  allLocal: Record<string, any> | null | undefined,
): boolean;
declare function pbpCleanHighlightBackup(highlights: unknown): Record<string, any>;
declare function pbpScopeHighlightBackupImport(
  highlights: Record<string, any> | null | undefined,
  ownerScope: string,
): Record<string, any>;
declare function pbpMergeHighlightBackupRecord(
  stored: unknown,
  incoming: unknown,
  ownerScope: string,
): { items: any[]; [key: string]: any } | null;
declare function pbpAddMissingHighlightBackupRecord(
  stored: unknown,
  incoming: unknown,
  ownerScope: string,
): { items: any[]; [key: string]: any } | null;
declare function pbpCanonicalBackupOwner(value: unknown): string;
declare function pbpBackupOwnerScope(value: unknown): string;
declare function pbpPreflightBackupLibrary(data: unknown): PbpPreflightBackupLibraryResult;
declare function pbpBackupLocalFallbackFields(
  prepared: Record<string, any>,
  syncState: { enabled?: boolean; localFallbackKeys?: string[] } | null | undefined,
  sections?: Record<string, { enabled?: boolean }>,
): string[];
declare function pbpBuildBackupPreview(
  prepared: Record<string, any>,
  currentOwner: string,
  syncState: { enabled: boolean; localFallbackKeys: string[] },
  options?: { restorePoint?: boolean },
): Record<string, any>;
declare function pbpHighlightBackupOwnerAllowed(
  backupOwner: string | undefined,
  currentAccount: string,
  accountResolved?: boolean,
): boolean;
declare function pbpBackupFilename(date?: Date, includeSecrets?: boolean): string;
declare function pbpBuildBackupSnapshot(
  settings: Record<string, any> | null | undefined,
  extra?: {
    libraryOnly?: boolean;
    includeSecrets?: boolean;
    overlay?: string;
    savedThemes?: any[];
    highlights?: Record<string, any> | null;
    highlightsOwner?: string;
    vocabulary?: { owner: string; records: any[] } | null;
  },
): Record<string, any>;
declare function pbpCountBackupSecrets(data: unknown): number;
