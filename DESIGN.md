---
name: Pinboard Bookmark Enhanced
description: A precise, quiet toolkit for saving, reading, and learning from the web — a neutral skeleton that 14 presets can reskin.
colors:
  bookmark-blue: "#4477bb"
  bookmark-blue-dark: "#4385BE"
  on-accent: "#ffffff"
  on-accent-dark: "#171615"
  canvas: "#f5f5f0"
  panel: "#ffffff"
  ink: "#333333"
  ink-muted: "#666666"
  structure-line: "#858585"
  hairline: "#e8e8e8"
  soft-fill: "#eaeaea"
  soft-fill-hover: "#dfdfdf"
  button-fill: "#eaeae5"
  focus-core: "#5d88c2"
  chip-wash: "#e8edf4"
  warm-ink: "#1C1B1A"
  warm-ink-raised: "#282726"
  paper-text: "#cecdc3"
  paper-text-muted: "#9F9D96"
  warm-ink-fill: "#343331"
  focus-core-dark: "#4280b6"
  amber-chip-text-dark: "#d9a916"
  save-green: "#1a7f37"
  warn-amber: "#9a6700"
  danger-red: "#cc0000"
  danger-red-dark: "#E8705F"
  reader-paper: "#FFFCF0"
  reader-ink: "#1C1B1A"
  reader-link: "#205EA6"
  highlight-yellow: "#facc15"
  highlight-green: "#4ade80"
  highlight-blue: "#60a5fa"
  highlight-red: "#f87171"
  highlight-purple: "#c084fc"
typography:
  display:
    fontFamily: "\"Helvetica Neue\", Verdana, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"微软雅黑\", \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"WenQuanYi Micro Hei\", sans-serif"
    fontSize: "72px"
    fontWeight: 700
    lineHeight: 1.15
  headline:
    fontFamily: "\"Helvetica Neue\", Verdana, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"微软雅黑\", \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"WenQuanYi Micro Hei\", sans-serif"
    fontSize: "18px"
    fontWeight: 600
  title:
    fontFamily: "\"Helvetica Neue\", Verdana, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"微软雅黑\", \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"WenQuanYi Micro Hei\", sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: "24px"
  body:
    fontFamily: "\"Helvetica Neue\", Verdana, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"微软雅黑\", \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"WenQuanYi Micro Hei\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: "20px"
  label:
    fontFamily: "\"Helvetica Neue\", Verdana, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"微软雅黑\", \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"WenQuanYi Micro Hei\", sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: "18px"
  overline:
    fontFamily: "\"Helvetica Neue\", Verdana, \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"微软雅黑\", \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"WenQuanYi Micro Hei\", sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.5px"
  prose:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Inter\", Roboto, \"Helvetica Neue\", \"PingFang SC\", \"Microsoft YaHei\", sans-serif"
    fontSize: "clamp(1.0625rem, 1rem + 0.4vw, 1.375rem)"
    fontWeight: 400
    lineHeight: 1.75
  mono:
    fontFamily: "\"SF Mono\", Consolas, Menlo, \"Liberation Mono\", \"PingFang SC\", \"Hiragino Sans GB\", \"Microsoft YaHei\", \"微软雅黑\", \"Noto Sans SC\", \"Noto Sans CJK SC\", \"Source Han Sans SC\", \"WenQuanYi Micro Hei\", monospace"
    fontSize: "13px"
rounded:
  sm: "3px"
  md: "8px"
  lg: "10px"
  full: "9999px"
spacing:
  sp-1: "2px"
  sp-2: "4px"
  sp-3: "6px"
  sp-4: "8px"
  sp-5: "12px"
  sp-6: "16px"
  sp-7: "24px"
  sp-8: "32px"
components:
  button:
    backgroundColor: "{colors.button-fill}"
    textColor: "#000000"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-hover:
    backgroundColor: "{colors.soft-fill-hover}"
  button-primary:
    backgroundColor: "{colors.bookmark-blue}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-sm:
    backgroundColor: "{colors.button-fill}"
    rounded: "{rounded.md}"
    height: "28px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "32px"
  button-danger-quiet:
    backgroundColor: "{colors.button-fill}"
    textColor: "{colors.danger-red}"
    rounded: "{rounded.md}"
    height: "32px"
  confirm-yes:
    backgroundColor: "{colors.danger-red}"
    textColor: "#ffffff"
    rounded: "{rounded.sm}"
    padding: "2px 8px"
  field:
    backgroundColor: "{colors.soft-fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "4px 8px"
    height: "32px"
  field-hover:
    backgroundColor: "{colors.soft-fill-hover}"
  chip:
    backgroundColor: "{colors.button-fill}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  chip-selected:
    backgroundColor: "{colors.chip-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    padding: "2px 10px"
  switch-track:
    backgroundColor: "{colors.structure-line}"
    rounded: "{rounded.full}"
    width: "28px"
    height: "16px"
  switch-track-on:
    backgroundColor: "{colors.bookmark-blue}"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    padding: "8px 12px"
    height: "32px"
  listbox-option-selected:
    backgroundColor: "{colors.bookmark-blue}"
    textColor: "{colors.on-accent}"
    rounded: "{rounded.sm}"
    height: "32px"
---

# Design System: Pinboard Bookmark Enhanced

## Overview

**Creative North Star: "The Precise Toolkit"**

This UI is a well-kept tool drawer. Every control sits in a known slot at a known size, gives instant feedback, and gets out of the way. Quality is not shown through decoration. It shows in alignment that holds to the pixel, contrast that clears AA on every theme, and a response that is already finished by the time the finger lifts. The user opens the popup dozens of times a day on a 4K Windows machine, so the system favors calm, dense, predictable surfaces over expressive ones.

The default theme is a **neutral skeleton**. Its light side is a warm off-white canvas with soft gray fills and one Bookmark Blue accent. Its dark side is Warm Ink: Flexoki's warm black with paper-colored text, never a cold blue-gray. Personality is delegated to 14 named presets (Dracula, Nord Night, Catppuccin, Solarized, Terminal, and others), all generated by the theme factory from the same role tokens. A preset may change color, radius, and focus-ring shape, but it never changes geometry, density outside the two allowed rungs, or interaction language.

The reader (md-preview) and the notes and vocabulary page (library) lean **warm and readable**: paper-like canvases, a generous prose measure, and structure carried by type scale and whitespace instead of boxes. The popup and options pages lean **compact and efficient**: label columns, a strict control-height ladder, and dense rows.

**Key Characteristics:**
- Flat by default. Shadows belong only to things that float (popovers, listbox menus, confirm bubbles, toasts).
- Soft Fill controls: filled, never outlined at rest; instant press; one soft focus glow.
- One accent, used for primary action, selection, focus, and links, and nothing decorative.
- Tokens per surface (`--pp-*` popup, `--opt-*` options, `--lib-*` library, unprefixed in the reader), all generated by `docs/theme-surface/`. The frontmatter records the **options** surface's default light values as the canonical reference, plus key dark (Warm Ink) values.
- Fast-font discipline: explicit CJK stacks, named monospace first, no emoji glyphs anywhere in UI.

## Colors

A low-saturation neutral base with one blue voice, semantic status colors that are tinted fills (not loud badges), and a five-color highlighter set that belongs to the user's content, not to the chrome.

### Primary
- **Bookmark Blue** (#4477bb light; #4385BE in Warm Ink dark): The only accent. Used for the primary action (Save, solid primary buttons), the "on" state of switches, the selected listbox option, the selected nav item's edge in themed modes, links, and as the source that focus cores are derived from. Popup and library carry their own AA-derived siblings (#3b72d9, #1a73e8), which are re-derived per surface and never eyeballed.
- **On-Accent** (#ffffff light; #171615 dark): Text and icons placed on Bookmark Blue. In dark mode it flips to near-black because the dark accent is light enough to need dark text.

### Secondary
- **Chip Wash** (#e8edf4): The pale blue wash for selected chips and tonal buttons. In Warm Ink dark, tag chips turn **amber** (#d9a916 text on a dark ground) instead of blue. This is deliberate and comes from the Flexoki palette.

### Neutral
- **Canvas** (#f5f5f0): Options page background, a slightly warm off-white. Library uses #f7f7f8, popup uses #ffffff.
- **Panel** (#ffffff): Raised panels in options and floating layers everywhere.
- **Ink** (#333333): Primary text on the options surface. Popup uses #2a2d33, library #1a1a2e.
- **Ink Muted** (#666666): Secondary text, hints, and inactive nav items. Only allowed on canvas or panel, never on a control fill.
- **Structure Line** (#858585): The 3:1 structural border, used for switch-off tracks, popover outlines, and the confirm bubble. It is not used for dividing content.
- **Hairline** (#e8e8e8): Section edges on options panels. The hairline level is the strongest divider allowed on a canvas.
- **Soft Fill / Soft Fill Hover / Button Fill** (#eaeaea / #dfdfdf / #eaeae5): Resting and hover fills for fields and buttons.
- **Warm Ink / Warm Ink Raised / Warm Ink Fill** (#1C1B1A / #282726 / #343331): The default dark page, panel, and control fill.
- **Paper Text / Paper Text Muted** (#cecdc3 / #9F9D96): Default dark primary and secondary text.

### Status
- **Save Green** (#1a7f37), **Warn Amber** (#9a6700), **Danger Red** (#cc0000; #E8705F dark): Status text. As surfaces they appear as tinted fill + matching text, for example popup ok #e3f3e8 / #1f7a3c, warn #fdeaea / #b13636, offline #fdf3dd / #8a6410, info #edf3fd / #2d5db3. In light mode their borders collapse into the fill.

### Reader & Highlights
- **Reader Paper / Reader Ink / Reader Link** (#FFFCF0 / #1C1B1A / #205EA6 light; Warm Ink #1C1B1A / #CECDC3 / #6095C5 dark): Defined with `light-dark()`. Both schemes are the Flexoki family, so the reader is one warm paper in light and dark (light switched from Tailwind slate on 2026-10-15). Its chrome (rail, panels) sits on a slightly deeper paper (#F7F5EA), and every popover shadow uses the warm ink (rgba(28, 27, 26, a)) rather than a cool slate. The reader never adopts the 14 presets.
- **Highlighter set** (yellow #facc15, green #4ade80, blue #60a5fa, red #f87171, purple #c084fc): Painted at about 40–45% alpha as CSS Custom Highlights, and as muted Flexoki equivalents in dark mode. These are user-content colors and are never reused as UI status or accent.

### Named Rules
**The One Voice Rule.** Bookmark Blue is the only chromatic accent in the chrome. It marks action, selection, focus, and links, and is never decoration, illustration, or section color.

**The Derived, Not Picked Rule.** Every text/fill pair is derived to WCAG AA (4.5:1 text, 3:1 UI parts) by the theme factory, and focus cores are derived from the accent to at least 3:1. Never hand-pick a hex in a consuming rule. Edit composers or pilots, then run `sync-all`.

**The Weak Text Rule.** Hint, muted, and link text never sit on a control fill. Controls use their own AA-derived `btn-fg-muted`.

## Typography

**UI Font:** "Helvetica Neue", Verdana, followed by an explicit fast CJK stack (PingFang SC, Hiragino Sans GB, Microsoft YaHei, 微软雅黑, Noto Sans SC, Noto Sans CJK SC, Source Han Sans SC, WenQuanYi Micro Hei), then sans-serif.
**Reader Font:** -apple-system / Segoe UI / Inter / Roboto Latin, with per-`:lang` Han stacks (zh-Hans, zh-Hant, ja, ko). `system-ui` is banned.
**Mono Font:** "SF Mono", Consolas, Menlo, Liberation Mono, then the same CJK stack, then monospace.

**Character:** A plain, legible grotesque that never draws attention to itself in the tools, and a roomier system serifless voice for long reading. The type carries hierarchy so that boxes do not have to.

### Hierarchy
- **Display** (700, 72 / 56 / 44 / 36px responsive, 1.15): Library cover titles only. This is the one place the system speaks loudly.
- **Headline** (600, 18px): Options page title.
- **Title** (600, 16px/24px): Section titles in options; library row titles use 15px/20px.
- **Body** (400, 14px/20px): Options and library body copy and control labels. Popup body is 12px with 11px labels, because 550px of width holds a dense form.
- **Label** (400, 12px/18px): Helper text, meta, counts.
- **Overline** (600, 11px, 0.5px tracking, uppercase): Sidebar group labels in options and section heads in the reader rail. Never used for body text.
- **Prose** (400, 17px→22px fluid clamp, 1.75 leading): Reader body. Users can step the size (×0.9–1.2), leading (1.6 / 1.75 / 1.9), and measure (680 / 880 / 1080px). Headings run h1 2em/700/−0.025em down to h6 .875em, and only headings use `text-wrap: balance`.

### Named Rules
**The Fast Fallback Rule.** Every UI font stack names fast CJK families before `sans-serif`, and every mono stack names a real mono font first and CJK before `monospace`. `button, input, select` always `font-family: inherit`. A fallback to a slow font freezes cold first paint on high-DPI Windows for 1–3s.

**The 11px Floor Rule.** No UI text below 11px.

**The Two Rungs Rule.** Density has exactly two rungs, comfortable and compact (only Terminal and Gruvbox Dark use compact). Themes never define their own type sizes.

## Layout

- **Popup:** Fixed width of 550px (user-adjustable 420–720px), with a 72px label column (`--pp-label-indent`) aligning every row's control edge. Rows are 4px/16px padded and stacked tightly.
- **Options:** A 1040px max container on a two-column grid. The sidebar is `minmax(160px, max-content)` and sticky at 24px, and content panels sit beside it. Preference rows are at least 44px tall (36px compact), with a 12px rhythm, 32px between sections, and 16px panel padding. Geometry follows Chrome's settings page.
- **Library:** A flat two-column canvas made of an index rail (`clamp(360px, 20vw, 520px)`) and a detail column (max 840px), separated by a 48px gap (64px at ≥1920px). Page padding is 24 → 32 → 48px by width, and spacing comes from a 10-step scale (2/4/8/12/16/24/32/48/64/96, with no 6px step).
- **Reader:** A 256px left rail (it becomes a drawer at ≤1000px), with a prose column measured by user preference and main padding of 48/32/96px. The Ask panel docks right and pushes the main column instead of covering it.
- Spacing scales differ per surface (popup and options: 2/4/6/8/12/16/24(/32)). Component recipes write pixel values, and the factory maps each value to the token of equal value on that surface.

**The Relationship Owns the Space Rule.** Gaps belong to the relationship between elements (action-row gap 8, cluster gap 4, field rhythm), not to the elements themselves. Surface HTML never carries inline margin, padding, or gap.

## Elevation & Depth

Flat by default. Resting controls, panels, rows, and the library canvas carry no shadow. Depth comes from two tonal layers (canvas, then panel or fill) and from type. Shadows appear only on things that genuinely float above unrelated content, and those floating layers also keep a 3:1 outline because they cover arbitrary content.

### Shadow Vocabulary
- **Key lip** (`0 1px 0 rgba(0,0,0,.04)`): Keyboard key caps (`kbd`) only.
- **Float md** (`0 4px 12px rgba(0,0,0,.08), 0 2px 4px rgba(0,0,0,.04)`): Confirm popovers, toasts, and listbox menus. Library derives its own version from `--lib-fg` at 22% and 12% so it tints with the theme.
- **Float lg** (`0 8px 24px rgba(0,0,0,.12), 0 4px 8px rgba(0,0,0,.06)`): Autocomplete dropdowns.
- **Reader pop** (`0 8px 30px rgba(15,23,42,.22)`): Reader pop panels.
- **Switch thumb** (`0 1px 2px rgba(0,0,0,.28), 0 0 0 0.5px rgba(0,0,0,.06)`): The only shadow on a resting control. It gives the thumb a physical edge.
- **Focus glow** (`0 0 6px 1px color-mix(in srgb, accent 45%, transparent)`): Not elevation. It is the focus signal, and its shape is theme-owned.

### Named Rules
**The Flat Canvas Rule.** On a canvas (especially library), regions are separated by type scale, whitespace, column alignment, hanging labels, and small section heads. No cards, color blocks, inset wells, or divider lines. Floating layers are the only exception (user ruling, 2026-10-03).

## Shapes

Gently rounded and consistent. Small parts use 3px corners (library 4px), controls and panels use 8px, floating layers 10px (library 12px), and chips, switch tracks, and color dots are full pills. Presets may change radius: Warm Ink tightens to 3/6/8 and its tag chips become 6px squares. Three laws apply. Radius only ever comes from a token. An inner radius never exceeds its outer radius. A pill's radius is half its height, with horizontal padding at least the radius. In fused controls (segmented groups, the tags input) the container owns the border and radius, and inner parts have none.

## Components

### Buttons
Soft, filled, and instant.
- **Shape:** Gently rounded (8px).
- **Default:** Button Fill ground with ink text, 32px tall (28px compact) with 12px horizontal padding and 14px text. The border collapses into the fill at rest but keeps its 1px so nothing shifts.
- **Primary:** Bookmark Blue ground, On-Accent text, weight 600. Hover mixes the accent 88% toward ink. In the popup the primary is the Save button (`#submit-btn`, 24px horizontal padding), which repaints itself as a disabled fill instead of fading.
- **Hover / Press / Focus / Disabled:** Hover swaps to the hover fill. Press is `scale(0.97)`, instant both ways and never transitioned. Focus keeps the border slot, turns it to the focus core, and adds the soft glow. Disabled is `opacity .45` with `not-allowed`.
- **Ghost / Tonal:** Ghost is transparent with a 6% ink hover. Tonal uses the Chip Wash ground and chip text at 600 weight.
- **Danger:** Two tiers only. *Quiet* uses danger text with a danger-tinted border on the normal fill. *Solid* (danger ground, white text) appears only as the confirm bubble's "yes".
- **Small:** Control height − 4px, with text one step down. In the popup the ladder is 26 (md) and 20 (sm) with 12/11px text. That is a registered popup variant, not drift.
- **Registered popup variants:** The quick-row equal-split strip (`.qbtn`), the Markdown strip squares, feedback-card buttons (which inherit the card's color through `currentColor`), and tag preset pills each keep their own geometry but share the same press and focus language.

### Chips
- **Style:** Full pill, 2px/10px padding, 12px/14px text. Suggested tags sit on the chip wash with chip text. AI-suggested tags use the purple secondary text color (#7b45c1 in the popup).
- **State:** Unselected chips use the button fill. Selected chips use the chip wash at weight 600. Used suggestions go transparent with a strikethrough in hint color.

### Inputs / Fields (Soft Fill)
- **Style:** Filled, with no visible border at rest. The 1px border equals the fill, and the fill must separate from its host surface by at least 1.10:1. 8px radius, 4px/8px padding, 32px tall in options and library (26px in the popup), 14px text (12px in the popup). Selects use a 12px chevron drawn with stroke 1.5.
- **Hover:** Fill and border deepen together, like a well being pressed.
- **Focus:** The fill stays the same. The border becomes the focus core and the soft glow appears, on `:focus-visible` only.
- **Checkbox / radio:** Native, with `accent-color` set to Bookmark Blue. Options also has a drawn 20px pick mark.

### Switch
- **Track:** 28×16, borderless pill. Off is Structure Line, on is Bookmark Blue. The 12px thumb in panel color slides 12px in 150ms.
- **Row:** Text on the left, track pushed right, and the whole row is the hit area. Focus draws a 1px accent outline offset 2px plus the glow. In forced-colors mode it falls back to a native checkbox.

### Listbox (custom select)
- **Trigger:** Looks like a Soft Fill field with a value and a 16px chevron, sized to `max-content` with a 240px minimum.
- **Menu:** Panel ground, 1px structure outline, 10px radius, float-md shadow. It flips upward when space runs out. In the library it renders in the top layer through Popover. Options are 32px rows with 3px radius. The active option gets the hover fill, and the selected option gets a Bookmark Blue ground with On-Accent text.

### Confirm Bubble
A small anchored bubble rather than a modal. It has panel ground, a 1px structure outline, a 3px radius, float-md shadow, and 11px bold danger-colored copy, with a solid danger "yes" and an outlined "no". It enters in 120ms (opacity plus a 4px rise) and exits in 100ms.

### Navigation (options sidebar)
- **Style:** Left-aligned 32px text rows at 13px in Ink Muted, with a 2px transparent left edge and 0/3/3/0 corners.
- **Hover:** Text turns to ink, and a faint fill and gray left edge appear.
- **Active:** Ink text at weight 600 with a filled ground and a solid left edge (ink in default light, Bookmark Blue whenever a theme attribute is present, including default dark).
- **Group labels:** 11px uppercase overline in hint color, not interactive. A busy tab shows a 6px pulsing dot.

### Library Index Row (signature)
A full-width row button with no border, laid out as a 10px highlight-color dot and the content. The excerpt is 14/20 clamped to 2 lines, the note line is 13/18 muted with a 12px pencil, and meta is 12/16. State is carried by background alone: hover, current, batch-selected band, and selected-and-current, each a derived fill with 8px inset corners. Pressing deepens the row instead of scaling it. Focus is a 2px inset outline.

### Reader Rail & Pills (signature)
The reader's rail is a 256px surface column with uppercase overline section heads, each over a 1px top rule, and CSS-drawn disclosure triangles. Pill toggles and segmented buttons show "pressed" as the hover fill plus a link-colored border and link text. Inverted near-black chips are not used. Reader focus is its own 2px link-colored outline offset 2px. Hover never opens an overlay in the reader.

## Do's and Don'ts

### Do:
- **Do** take every color, radius, and focus ring from the surface's tokens with bare `var(--ns-x)` and no fallback, and change them only through `docs/theme-surface/` composers and pilots followed by `node docs/theme-surface/tools/sync-all.mjs`.
- **Do** keep controls on the ladder: 32/28px (options and library), 26/20px (popup and reader), at least 24px for every icon hit area, and at least 44px for options preference rows.
- **Do** press with `scale(0.97)` (buttons) or a deeper background (whole rows), instantly. Transitions list properties explicitly and stay at 200ms or less (150ms for state changes).
- **Do** use one of three focus placements: bordered (fields, `.btn`), borderless (1px accent outline + glow for links, tabs, chips, and switches), or inset (2px for rows and segment cells).
- **Do** use Lucide v0.525.0 paths at stroke 2 inside a 24 box for every icon. Give icon-only buttons a `title`, an `aria-label`, and a 24px hit area.
- **Do** separate canvas regions with type, whitespace, and alignment.

### Don't:
- **Don't** draw color blocks, cards, inset wells, or divider lines to section a flat canvas (library), and don't go above hairline weight for section edges on options panels.
- **Don't** outline controls at rest or change a field's fill on focus.
- **Don't** add shadows to resting surfaces. Shadows are for floating layers only.
- **Don't** use literal emoji or dingbats (⚠ ✓ ✗ ✕ ↻ ▸ ▾ ℹ) in UI. `×` (U+00D7) is the only literal symbol allowed.
- **Don't** lead a mono stack with `ui-monospace` or bare `monospace`, or omit fast CJK families from any UI stack.
- **Don't** use `transition: all`, add first-paint entrance animations, load remote fonts, or ship any runtime dependency.
- **Don't** open overlays on hover in the reader, and don't apply the 14 presets to the reader.
- **Don't** hand-edit `pinboard-themes.js` or any `@generated:*` region in popup.css, options.css, or library.css.
- **Don't** set hint, muted, or link-colored text on a control fill.
