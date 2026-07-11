// ============================================================
// Options page — settings export/import (backup file).
// Exposes setupBackup({ exportableKeys, saveOverlayWithFallback }).
// Schema-version aware: v2 backups use customOverlayCSS, v1 uses customCSS.
// ============================================================

// Classify a syncSetLarge("savedThemes") failure during import.
// Quota errors mean the data WAS preserved to local (syncSetLarge's fallback),
// so report partial success — not the misleading generic "Invalid file".
// Returns a t() key, or null to signal "rethrow as a genuine import failure".
function importThemesResult(err) {
  if (!err) return "importedReload";
  if (/QUOTA|quota/i.test(err.message || "")) return "importPartial";
  return null;
}

// Applies a parsed backup JSON blob (from a file import OR a WebDAV pull) to
// storage: whitelist-filters to exportableKeys, merges exportTargets per-target
// (protecting live secret fields the backup never carried), persists via
// persistSettings, migrates v1->v2 CSS if needed, and imports savedThemes.
// Returns a t() status key ("importedReload" | "importPartial"). Throws on
// a genuine persist failure -- callers decide how to surface that.
async function pbpApplyBackupPayload(data, { exportableKeys, saveOverlayWithFallback }) {
  const schemaVersion = data._schemaVersion || 1;
  const { _schemaVersion, _highlights, customCSS, customOverlayCSS, savedThemes: importedThemes, ...rest } = data;
  const safeData = Object.fromEntries(
    Object.entries(rest).filter(([k]) => exportableKeys.includes(k))
  );
  if (schemaVersion >= 2 && customOverlayCSS !== undefined) pbpAssertOverlaySize(customOverlayCSS);
  const settingsStorage = await getSettingsStorage();
  if (safeData.exportTargets) {
    // Export/webdav-push strips nested secrets, so a raw key-set here would
    // blast away live tokens (github PAT, webhook Authorization) with the
    // secret-less backup copy. Merge per target onto what's already stored
    // so untouched secret fields survive; only the backed-up (non-secret)
    // fields actually update.
    let curRead = await settingsStorage.get({ exportTargets: {} });
    curRead = await pbpApplySecretOverlay(curRead);
    const current = curRead.exportTargets || {};
    const merged = Object.assign({}, current);
    for (const [tid, cfg] of Object.entries(safeData.exportTargets)) {
      merged[tid] = Object.assign({}, merged[tid], cfg);
    }
    safeData.exportTargets = merged;
  }
  const importRes = await persistSettings(safeData);
  if (!importRes.ok) throw importRes.error || new Error("settings import failed");

  if (schemaVersion >= 2) {
    if (customOverlayCSS !== undefined) await saveOverlayWithFallback(customOverlayCSS);
  } else {
    // v1 → v2: detect preset match, derive overlay
    const oldKey = safeData.themePresetKey || "";
    let resolvedKey = oldKey;
    if (!resolvedKey && customCSS) {
      for (const [key, theme] of Object.entries(PINBOARD_THEMES)) {
        if (theme.css.trim() === customCSS.trim()) { resolvedKey = key; break; }
      }
      if (resolvedKey) {
        for (const [parent, [light, dark]] of Object.entries(ADAPTIVE_THEME_MAP)) {
          if (resolvedKey === light || resolvedKey === dark) { resolvedKey = parent; break; }
        }
      }
    }
    let newOverlay = "";
    if (customCSS) {
      const preset = resolvedKey ? PINBOARD_THEMES[resolvedKey] : null;
      const presetCSS = preset ? preset.css : "";
      const variants = ADAPTIVE_THEME_MAP[resolvedKey] || [];
      const allowed = [presetCSS, ...variants.map(k => PINBOARD_THEMES[k]?.css || "")];
      newOverlay = allowed.some(c => c && c.trim() === customCSS.trim()) ? "" : customCSS;
    }
    await (await getSettingsStorage()).set({ themePresetKey: resolvedKey || "" });
    await saveOverlayWithFallback(newOverlay);
  }

  let themesStatusKey = "importedReload";
  if (importedThemes !== undefined) {
    try {
      await syncSetLarge("savedThemes", importedThemes);
    } catch (e) {
      const key = importThemesResult(e);
      if (key === null) throw e; // null sentinel = non-quota failure -> caller's catch handles it
      themesStatusKey = key; // "importPartial": data preserved to local by syncSetLarge fallback
    }
  }
  if (_highlights && typeof _highlights === "object") {
    const cleanedHighlights = pbpCleanHighlightBackup(_highlights);
    if (Object.keys(cleanedHighlights).length) await chrome.storage.local.set(cleanedHighlights);
  }
  return themesStatusKey;
}

function setupBackup({ exportableKeys, saveOverlayWithFallback }) {
  $id("import-settings").addEventListener("click", () => $id("import-settings-file").click());

  $id("export-settings").addEventListener("click", async () => {
    const raw = await (await getSettingsStorage()).get(exportableKeys);
    const exportData = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => v !== undefined)
    );
    exportData._schemaVersion = 2;
    const includeHighlightsEl = $id("opt-backup-include-highlights");
    if (includeHighlightsEl) exportData.backupIncludeHighlights = !!includeHighlightsEl.checked;
    // Strip NESTED secrets (e.g. exportTargets.github.token) — the top-level
    // API_KEY_FIELDS exclusion only covers flat keys, so a nested token would
    // otherwise ride into this shareable plaintext backup. Keep non-secret
    // fields (enabled/vault/folder) so config still roundtrips.
    if (exportData.exportTargets && typeof PBP_EXPORT_TARGETS !== "undefined") {
      const cleaned = {};
      for (const [tid, cfg] of Object.entries(exportData.exportTargets)) {
        cleaned[tid] = Object.assign({}, cfg);
        const row = PBP_EXPORT_TARGETS[tid];
        ((row && row.settings) || []).forEach((s) => { if (s.type === "secret") delete cleaned[tid][s.key]; });
        delete cleaned[tid].token;   // belt: also drop a bare token from orphan/removed targets (e.g. old logseq)
      }
      exportData.exportTargets = cleaned;
    }
    // Read overlay from sync OR local fallback (preserve user data either way)
    const overlayFlags = await chrome.storage.sync.get({ optOverlayInLocal: false });
    let overlay = "";
    if (overlayFlags.optOverlayInLocal) {
      const local = await chrome.storage.local.get({ customOverlayCSS_localFallback: "" });
      overlay = local.customOverlayCSS_localFallback;
    } else {
      overlay = await syncGetLarge("customOverlayCSS", "");
    }
    if (overlay) exportData.customOverlayCSS = overlay;
    const savedThemesData = await syncGetLarge("savedThemes", []);
    if (savedThemesData.length) exportData.savedThemes = savedThemesData;
    if (exportData.backupIncludeHighlights !== false) {
      try {
        const allLocal = await chrome.storage.local.get(null);
        const highlights = pbpBuildHighlightBackup(allLocal);
        if (highlights) exportData._highlights = highlights;
      } catch (_) {}
    }
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "Pinboard Bookmark Enhanced settings backup.json"; a.click();
    URL.revokeObjectURL(url);
  });

  $id("import-settings-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    let parsed = false;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      parsed = true;
      const themesStatusKey = await pbpApplyBackupPayload(data, { exportableKeys, saveOverlayWithFallback });
      const status = $id("import-status");
      setStatusIcon(status, themesStatusKey === "importPartial" ? false : true, t(themesStatusKey));
      setTimeout(() => { status.textContent = ""; }, 3000);
    } catch (err) {
      console.error("[import] failed", err);
      const status = $id("import-status");
      setStatusIcon(status, false, t(parsed ? "importApplyFailed" : "importInvalid"));
      status.style.color = "#c00";
      setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 3000);
    }
    e.target.value = "";
  });
}
