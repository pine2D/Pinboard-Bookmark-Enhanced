import { expandPalette } from "./_util.mjs";
import { mergeTokens } from "./compose-theme.mjs";
import { deriveUiColors } from "./_ui-derive.mjs";

// popup theme id -> { pilot, mode, useDarkMode? }
// 12 themes map 1:1; the flexoki pilot yields BOTH flexoki-light and flexoki-dark.
export const POPUP_THEME_MAP = [
  { id: "modern-card", pilot: "modern-card", mode: "light" },
  { id: "nord-night", pilot: "nord-night", mode: "dark" },
  { id: "terminal", pilot: "terminal", mode: "dark" },
  { id: "paper-ink", pilot: "paper-ink", mode: "light" },
  { id: "dracula", pilot: "dracula", mode: "dark" },
  { id: "flexoki-light", pilot: "flexoki", mode: "light" },
  { id: "flexoki-dark", pilot: "flexoki", mode: "dark", useDarkMode: true },
  { id: "solarized-light", pilot: "solarized-light", mode: "light" },
  { id: "solarized-dark", pilot: "solarized-dark", mode: "dark" },
  { id: "catppuccin-latte", pilot: "catppuccin-latte", mode: "light" },
  { id: "catppuccin-mocha", pilot: "catppuccin-mocha", mode: "dark" },
  { id: "gruvbox-dark", pilot: "gruvbox-dark", mode: "dark" },
  { id: "rose-pine", pilot: "rose-pine", mode: "dark" },
  { id: "github-light", pilot: "github-light", mode: "light" },
];

function emitPp(ui) {
  const lines = [];
  const set = (k, val) => lines.push(`  --pp-${k}: ${val};`);
  for (const k of ["bg", "bg2", "fg", "fg-muted", "fg-hint", "link", "accent", "accent2",
    "border", "divider", "input-bg", "input-focus-bg", "tag-bg", "tag-fg", "tag-hover", "drop-hover",
    "banner-bg", "banner-bd", "banner-fg", "warn-bg", "warn-bd", "warn-fg",
    "ok-bg", "ok-bd", "ok-fg", "offline-bg", "offline-bd", "offline-fg",
    "danger", "spinner-bg", "spinner-fg", "preset-bg", "preset-bd", "preset-fg"]) {
    if (ui[k] != null) set(k, ui[k]);
  }
  // info-* are aliases of banner-* (no separate derivation)
  set("info-bg", "var(--pp-banner-bg)");
  set("info-bd", "var(--pp-banner-bd)");
  set("info-fg", "var(--pp-banner-fg)");
  return lines.join("\n");
}

// tokensByPilot: { [pilotSlug]: parsedTokensJson }
export function composePopupThemes(tokensByPilot) {
  const blocks = [];
  for (const entry of POPUP_THEME_MAP) {
    const tk = tokensByPilot[entry.pilot];
    if (!tk) throw new Error(`popup-chrome: missing pilot ${entry.pilot} for ${entry.id}`);
    const merged = entry.useDarkMode && tk.modes?.dark ? mergeTokens(tk, tk.modes.dark) : tk;
    const palette = expandPalette(merged.palette);
    const ui = deriveUiColors(palette, entry.mode);
    blocks.push(`html[data-theme="${entry.id}"] {\n${emitPp(ui)}\n}`);
  }
  return blocks.join("\n");
}
