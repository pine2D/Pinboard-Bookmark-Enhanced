// Dev-only ambient declarations for cross-file runtime helpers consumed by the
// 19 pure data-layer, sync, backup, send, and cache scripts checked under
// scripts/jsconfig.data-layer.json.
// Never shipped in the extension ZIP (scripts/ is excluded from release.sh).

/// <reference types="chrome" />

interface Window {
  __PBP_TYPO_CMP_COUNT?: () => number;
  __PBP_TYPO_CMP_INC?: () => number;
}

declare var __pbpTestSyncSetLarge: ((key: string, value: any) => Promise<any>) | undefined;

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

// ---- i18n.js ----
declare function t(key: string, ...args: string[]): string;
declare function uiLangToBCP47(): string;

// ---- ai.js ----
declare function fetchWithTimeout(
  url: string | URL,
  options?: RequestInit,
  timeoutMs?: number,
): Promise<Response>;

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

// ---- md-dict.js & dict-pack.js ----
declare function pbpDictTsvField(v: unknown, columnIndex?: number): string;
declare function pbpDictTsv(rows: readonly Record<string, any>[]): string;
declare function pbpEcdictKey(word: unknown): string;
declare function pbpEcdictSenses(translation: unknown): string[];
declare function pbpEcdictLookupMany(
  keys: readonly string[],
): Promise<Map<string, Array<{ translation?: string; [key: string]: any }>>>;
declare function pbpEcdictMeta(): Promise<{
  state: string;
  rung?: string;
  decodedCrc32?: string | number;
  [key: string]: any;
} | null>;

// ---- shared.js ----
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
