// ============================================================
// Options page — settings export/import (backup file).
// Exposes setupBackup({ exportableKeys, saveOverlayWithFallback }).
// Schema-version aware: v2 backups use customOverlayCSS, v1 uses customCSS.
// ============================================================

function setupBackup({ exportableKeys, saveOverlayWithFallback }) {
  $id("export-settings").addEventListener("click", async () => {
    const raw = await (await getSettingsStorage()).get(exportableKeys);
    const exportData = Object.fromEntries(
      Object.entries(raw).filter(([, v]) => v !== undefined)
    );
    exportData._schemaVersion = 2;
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
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "Pinboard Bookmark Enhanced settings backup.json"; a.click();
    URL.revokeObjectURL(url);
  });

  $id("import-settings-file").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const schemaVersion = data._schemaVersion || 1;
      const { _schemaVersion, customCSS, customOverlayCSS, savedThemes: importedThemes, ...rest } = data;
      const safeData = Object.fromEntries(
        Object.entries(rest).filter(([k]) => exportableKeys.includes(k))
      );
      await (await getSettingsStorage()).set(safeData);

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
        await chrome.storage.sync.set({ themePresetKey: resolvedKey || "" });
        await saveOverlayWithFallback(newOverlay);
      }

      if (importedThemes !== undefined) await syncSetLarge("savedThemes", importedThemes);
      const status = $id("import-status");
      status.textContent = t("importedReload");
      setTimeout(() => { status.textContent = ""; }, 3000);
    } catch (err) {
      console.error("[import] failed", err);
      const status = $id("import-status");
      status.textContent = t("importInvalid");
      status.style.color = "#c00";
      setTimeout(() => { status.textContent = ""; status.style.color = ""; }, 3000);
    }
    e.target.value = "";
  });
}
