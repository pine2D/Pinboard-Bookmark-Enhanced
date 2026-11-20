// Composer add-on: patterns
//
// Emits stylistic/personality CSS based on tokens.patterns. This is the
// "interface" layer that lets tokens drive decisions beyond color/font/space
// — things like "prepend '#' before every tag" or "show private bookmarks
// with a left-border instead of a tinted background".
//
// Contract:
//   patternsLayer(tokens) -> css string (possibly empty)
//
// Output is concatenated AFTER classic-list-v2's main output but BEFORE any
// hand-authored tokens.overrides.css, so:
//   composer defaults  <  patterns  <  overrides (escape hatch)
//
// Each pattern emits `!important` rules scoped to the same selectors the main
// composer uses, ensuring predictable cascade order.

import { v } from "./_util.mjs";

export function patternsLayer(tokens) {
  const pat = tokens.patterns || {};
  const sizeXs = tokens.typo?.["size-xs"] || tokens.typo?.["size-sm"] || "12px";
  const out = [];

  // ---- P0: tag-style ----
  // Owns the full a.tag visual (base + :hover + .selected). Two values:
  //   "flat"      — no bg at rest; `#` prefix; hover shows accent-tinted bg.
  //   "underline" — no bg at rest; 1px accent-alpha underline; hover thickens.
  // Both states use `text-shadow: 0.5px 0 0 currentColor` instead of font-weight
  // changes on hover, preserving width so dense tag clouds don't reflow.
  const tagStyle = pat["tag-style"];
  const tagHoverFeedback = (background) => tagStyle === "flat"
    ? `background: ${background || v("accent-alpha")} !important; text-shadow: 0.5px 0 0 currentColor !important;`
    : tagStyle === "underline"
      ? `background: ${background || v("accent-soft")} !important; text-decoration-color: ${v("accent")} !important; text-decoration-thickness: 2.5px !important; text-decoration-skip-ink: none !important; text-shadow: 0.5px 0 0 currentColor !important;`
      : "";
  if (tagStyle === "flat") {
    out.push(
      `a.tag::before { content: "#" !important; opacity: 0.45 !important; margin-right: 1px !important; }`,
      `a.tag:hover { color: ${v("accent")} !important; ${tagHoverFeedback()} }`,
      `a.tag:hover::before { color: ${v("accent")} !important; opacity: 0.9 !important; }`,
      `a.tag.selected { color: ${v("destroy")} !important; font-weight: 700 !important; }`,
      `a.tag.selected::before { color: ${v("destroy")} !important; opacity: 0.9 !important; }`
    );
  } else if (tagStyle === "underline") {
    out.push(
      `a.tag { text-decoration: underline !important; text-decoration-color: ${v("accent-alpha")} !important; text-decoration-thickness: 1px !important; text-decoration-skip-ink: none !important; text-underline-offset: 2px !important; }`,
      `a.tag:hover { color: ${v("accent")} !important; ${tagHoverFeedback()} }`,
      `a.tag.selected { color: ${v("destroy")} !important; text-decoration-color: ${v("destroy")} !important; text-decoration-skip-ink: none !important; font-weight: 600 !important; }`
    );
  } else if (tagStyle != null) {
    throw new Error(`tag-style: unknown value "${tagStyle}" (expected "flat" or "underline")`);
  }
  // tag-style absent → composer base alone (no hover, no selected styling).

  // Opt-in cloud inks compensate for native low-frequency opacity without
  // changing font size, opacity, bookmark tags or selected tags. Reuse the
  // full hover feedback so the scoped rule keeps the tag-style treatment.
  if (tokens.palette?.["sidebar-tag-fg"]) {
    // A cloud-only fill must not change accent-alpha on bookmark tags or focus rings.
    const background = tokens.palette["sidebar-tag-hover-bg"] ? v("sidebar-tag-hover-bg") : undefined;
    out.push(
      `#tag_cloud a.tag:not(.selected) { color: ${v("sidebar-tag-fg")} !important; }`,
      `#tag_cloud a.tag:not(.selected):hover { color: ${v("sidebar-tag-hover")} !important; ${tagHoverFeedback(background)} }`
    );
  }

  // ---- P0: bookmark-title-prefix ----
  const titlePrefix = pat["bookmark-title-prefix"];
  if (typeof titlePrefix === "string" && titlePrefix.length > 0) {
    const escaped = escapeCssContent(titlePrefix);
    out.push(
      `a.bookmark_title::before { content: "${escaped}" !important; color: ${v("muted-soft")} !important; }`
    );
  }

  // ---- P0: heading-prefix ----
  const headingPrefix = pat["heading-prefix"];
  if (typeof headingPrefix === "string" && headingPrefix.length > 0) {
    const escaped = escapeCssContent(headingPrefix);
    out.push(
      `.settings_heading::before { content: "${escaped}" !important; opacity: 0.7 !important; }`
    );
  }

  // ---- P1: url-link-style ----
  const urlStyle = pat["url-link-style"];
  if (urlStyle === "pill") {
    out.push(
      `a.url_link { border-radius: 9999px !important; padding: 1px 10px !important; }`
    );
  } else if (urlStyle === "underline") {
    out.push(
      `a.url_link { background: transparent !important; padding: 0 !important; border-radius: 0 !important; text-decoration: underline !important; color: ${v("muted-soft")} !important; }`
    );
  } else if (urlStyle === "plain") {
    out.push(
      `a.url_link { background: transparent !important; padding: 0 !important; border-radius: 0 !important; color: ${v("muted-soft")} !important; font-size: ${sizeXs} !important; }`
    );
  }
  // "capsule" or missing → composer default

  // ---- P1: private-badge ----
  const privBadge = pat["private-badge"];
  if (privBadge === "border-left" || privBadge === "inset-bar") {
    // Default composer rule already emits box-shadow: inset + background.
    // border-left is deprecated (conflicts with hover-effect left-bar, ugly in dark).
    // "inset-bar" is the successor — same visual as default, kept for explicitness.
  } else if (privBadge === "dashed") {
    out.push(
      `.private { background: transparent !important; outline: 1px dashed ${v("private-accent")} !important; outline-offset: -2px !important; }`
    );
  } else if (privBadge === "stripe") {
    out.push(
      `.private { background: repeating-linear-gradient(135deg, ${v("private-bg")}, ${v("private-bg")} 6px, ${v("bg-surface")} 6px, ${v("bg-surface")} 12px) !important; }`
    );
  }
  // "tint-bg" or missing → composer default (`.private { background: private-bg }`)

  // ---- P1: focus-ring ----
  const ring = pat["focus-ring"];
  if (ring === "glow") {
    // 2px solid ring — matches shipped convention (every theme uses this).
    // Individual alpha strength controlled by each theme's accent-alpha token.
    out.push(
      `#search_query_field:focus, #banner_searchbox input[type="text"]:focus, #right_bar input#key:focus, #tweet_searchbox #search_query_field:focus {`,
      `  box-shadow: 0 0 0 2px ${v("accent-alpha")} !important;`,
      `  outline: none !important;`,
      `}`
    );
  } else if (ring === "dashed") {
    out.push(
      `input:focus, textarea:focus, select:focus { outline: 2px dashed ${v("accent")} !important; outline-offset: 2px !important; box-shadow: none !important; }`
    );
  } else if (ring === "none") {
    out.push(
      `input:focus, textarea:focus, select:focus { outline: none !important; box-shadow: none !important; }`
    );
  }
  // "thin-solid" or missing → composer default

  // ---- P2: shape ----
  // Rewrites the radius custom properties at :root so every composer rule that
  // references var(--pinboard-radius-*) gets the macro value.
  const shape = pat["shape"];
  if (shape === "sharp") {
    out.push(
      `:root { --pinboard-radius-sm: 0 !important; --pinboard-radius-md: 0 !important; --pinboard-radius-lg: 0 !important; }`
    );
  } else if (shape === "pill") {
    out.push(
      `:root { --pinboard-radius-sm: 9999px !important; --pinboard-radius-md: 9999px !important; --pinboard-radius-lg: 9999px !important; }`
    );
  }
  // "rounded" → uses whatever radius.* tokens the theme already declared

  // ---- P2: density ----
  const density = pat["density"];
  if (density === "compact") {
    out.push(
      `:root { --pinboard-space-bookmark-gap: 2px !important; --pinboard-space-right-bar-gap: 8px !important; }`,
      `.bookmark { padding: 4px 8px !important; }`
    );
  } else if (density === "roomy") {
    out.push(
      `:root { --pinboard-space-bookmark-gap: 16px !important; --pinboard-space-right-bar-gap: 20px !important; }`,
      `.bookmark { padding: 16px 20px !important; }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P2: hover-effect (REMOVED) ----
  // All bookmark-row hover effects removed — background/border changes distract
  // from reading. Title hover (a.bookmark_title:hover) is handled by the
  // composer and provides sufficient feedback. Card themes use card-shadow
  // patterns for subtle elevation on hover instead.

  // ---- P3: row-divider ----
  // Emits the border treatment on .bookmark rows. Composer's base leaves row
  // borders unspecified (shipped themes uniformly override), so this pattern
  // absorbs that repeated work. Padding is NOT touched here — that stays
  // under density control so the two axes remain independent.
  const divider = pat["row-divider"];
  if (divider === "hairline") {
    out.push(
      `.bookmark { border-bottom: 1px solid ${v("border")} !important; }`
    );
  } else if (divider === "dashed") {
    out.push(
      `.bookmark { border-bottom: 1px dashed ${v("border")} !important; }`
    );
  } else if (divider === "left-accent") {
    const w = tokens.ext?.["row-accent-width"] || "3px";
    out.push(
      `.bookmark { border-left: ${w} solid ${v("border")} !important; border-bottom: none !important; border-top: none !important; border-right: none !important; }`
    );
  } else if (divider === "none") {
    out.push(
      `.bookmark { border: none !important; }`
    );
  }

  // ---- P3: heading-accent ----
  // Layered ON TOP of composer's default .settings_heading (color + solid
  // border-bottom + padding-bottom). Only emits the *delta*, so composer
  // baseline stays intact for themes that opt out.
  const headAccent = pat["heading-accent"];
  if (headAccent === "caps") {
    out.push(
      `.settings_heading { text-transform: uppercase !important; font-size: 12px !important; letter-spacing: 0.08em !important; }`
    );
  } else if (headAccent === "dashed-underline") {
    out.push(
      `.settings_heading { border-bottom-style: dashed !important; }`
    );
  }
  // "plain" or missing → composer default

  // ---- P3: card-shadow ----
  // Drop shadow on .bookmark rows. Meant for themes whose rows read as cards
  // (background + rounded corners) — apply alongside row-divider:"none" for
  // the intended look. Applied unconditionally: opt-in via tokens.patterns.
  const cardShadow = pat["card-shadow"];
  if (cardShadow === "soft") {
    out.push(
      `.bookmark { box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05) !important; transition: box-shadow 0.2s !important; }`
    );
  } else if (cardShadow === "strong") {
    out.push(
      `.bookmark { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15) !important; transition: box-shadow 0.2s !important; }`
    );
  }
  // .bookmark:hover deltas removed: invisibly subtle AND override the .bookmark.private
  // inset stripe (same specificity, !important, declared later → wins). Cards still elevate
  // visually via the base box-shadow above; row-hover is intentionally absent per P2.

  // ---- P4: blockquote-style ----
  // 11/13 themes add a left border + padding to `.description blockquote`.
  // Width tunable via `ext.blockquote-border-width` (default 3px).
  // left-accent → uses `accent` (high-signal themes like dracula, catppuccin,
  // solarized, terminal). left-muted → uses `border` (subtle themes like
  // flexoki dark, nord-night, github-light).
  const blockquote = pat["blockquote-style"];
  if (blockquote === "left-accent" || blockquote === "left-muted") {
    const w = tokens.ext?.["blockquote-border-width"] || "3px";
    const color = blockquote === "left-accent" ? v("accent") : v("border");
    out.push(
      `.description blockquote { border-left: ${w} solid ${color} !important; padding-left: 12px !important; margin: 6px 0 !important; }`
    );
  }
  // "plain" or missing → composer default

  // ---- P4: banner-chrome ----
  // 10/13 themes apply `border-radius + padding` to #banner with a recurring
  // `padding: 8px 16px`. Radius tunable via `ext.banner-radius` (default 4px).
  // "card" adds bg-surface + bottom border + soft shadow (modern-card style).
  const bannerChrome = pat["banner-chrome"];
  if (bannerChrome === "rounded") {
    const r = tokens.ext?.["banner-radius"] || "4px";
    out.push(
      `#banner { border-radius: ${r} !important; padding: 8px 16px !important; }`
    );
  } else if (bannerChrome === "card") {
    const r = tokens.ext?.["banner-radius"] || "8px";
    out.push(
      `#banner { border-radius: ${r} !important; padding: 12px 20px !important; background: ${v("bg-surface")} !important; border-bottom: 1px solid ${v("border")} !important; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06) !important; }`
    );
  }
  // "plain" or missing → composer default

  // ---- P4: title-weight ----
  // 7/13 themes explicitly set `a.bookmark_title` weight (normal/500/600).
  // Exposes the whole scale for full control. Baseline composer uses
  // `typo.weight-heading`; this pattern overrides it for the title surface
  // specifically so tags/headings can keep their own weights.
  const titleWeight = pat["title-weight"];
  const weightMap = { normal: 400, medium: 500, semibold: 600, bold: 700 };
  if (titleWeight && titleWeight in weightMap) {
    out.push(
      `a.bookmark_title { font-weight: ${weightMap[titleWeight]} !important; }`
    );
  }

  // ---- P4: tag-size ----
  // 4/13 themes reduce `a.tag` font-size to 12px. Uses typo.size-xs when
  // available; falls back to literal 12px to preserve shipped behavior.
  const tagSize = pat["tag-size"];
  if (tagSize === "small") {
    const size = tokens.typo?.["size-xs"] || "12px";
    out.push(
      `a.tag { font-size: ${size} !important; }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P5: button-style ----
  // Every theme customizes `input[type="submit"]` and/or `input[type="button"]`:
  // most strip the native border, some round corners, a few go pill. Radius
  // tunable via `ext.button-radius` (default 4px). Color/bg stay driven by
  // composer tokens (accent / accent-fg) — this pattern only shapes the chrome.
  const buttonStyle = pat["button-style"];
  if (buttonStyle === "flat") {
    out.push(
      `input[type="submit"], input[type="button"], .search_button input[type="submit"] { border: none !important; }`
    );
  } else if (buttonStyle === "outlined") {
    out.push(
      `input[type="submit"], input[type="button"], .search_button input[type="submit"] { background: transparent !important; border: 1px solid ${v("border")} !important; color: ${v("accent")} !important; }`
    );
  } else if (buttonStyle === "rounded") {
    // Radius-only (keeps composer's border intact). Themes that also want
    // border: none should use "flat-rounded".
    const r = tokens.ext?.["button-radius"] || "4px";
    out.push(
      `input[type="submit"], input[type="button"], .search_button input[type="submit"] { border-radius: ${r} !important; }`
    );
  } else if (buttonStyle === "flat-rounded") {
    const r = tokens.ext?.["button-radius"] || "4px";
    out.push(
      `input[type="submit"], input[type="button"], .search_button input[type="submit"] { border: none !important; border-radius: ${r} !important; }`
    );
  } else if (buttonStyle === "pill") {
    out.push(
      `input[type="submit"], input[type="button"], .search_button input[type="submit"] { border: none !important; border-radius: 9999px !important; padding: 4px 14px !important; }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P5: footer-tone ----
  // 13/13 themes set `#footer` (and usually `.colophon` / `.colophon a` /
  // `.rss_link`) to a muted color. Centralizes that ~5-line repeat per theme.
  const footerTone = pat["footer-tone"];
  if (footerTone === "muted" || footerTone === "faint") {
    const opacity = footerTone === "faint" ? " opacity: 0.75 !important;" : "";
    out.push(
      `#footer, .colophon, .colophon a, .rss_link, .rss_linkbox a { color: ${v("muted-soft")} !important;${opacity} }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P5: edit-form-surface ----
  // `#edit_bookmark_form`, `#bulk_top_bar`, `#bulk_edit_box` are the three
  // "heavyweight panel" surfaces. Every theme gives them a bg+border; 2 themes
  // round corners to 12px. Radius tunable via `ext.edit-form-radius`.
  //   "panel" → bg-surface + 1px border (most themes)
  //   "card"  → panel + radius (soft-themes: modern-card, paper-ink)
  const editForm = pat["edit-form-surface"];
  if (editForm === "panel" || editForm === "card") {
    const radiusRule = editForm === "card"
      ? ` border-radius: ${tokens.ext?.["edit-form-radius"] || "12px"} !important;`
      : "";
    out.push(
      `#edit_bookmark_form, #bulk_top_bar, #bulk_edit_box { background: ${v("bg-surface")} !important; border: 1px solid ${v("border")} !important;${radiusRule} }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P5: sort-order-style ----
  // 13/13 themes style `a.sort_order_selected` — the "active sort" chip in
  // bookmark-sort tables. Bg is always a subtle tint of accent or bg-surface;
  // 6/13 additionally set color to accent for extra signal.
  //   "tinted"    → bg: accent-alpha (subtle), color inherits
  //   "accent-bg" → bg: accent-alpha, color: accent (high contrast)
  //   "surface"   → bg: bg-surface (neutral, for low-contrast themes)
  const sortOrder = pat["sort-order-style"];
  if (sortOrder === "tinted") {
    out.push(
      `a.sort_order_selected { background: ${v("accent-alpha")} !important; }`
    );
  } else if (sortOrder === "accent-bg") {
    out.push(
      `a.sort_order_selected { background: ${v("accent-alpha")} !important; color: ${v("accent")} !important; }`
    );
  } else if (sortOrder === "surface") {
    out.push(
      `a.sort_order_selected { background: ${v("bg-surface")} !important; }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P6: searchbox-style ----
  // Unifies chrome across the four search inputs every theme customizes:
  // `#search_query_field` (main column), `#banner_searchbox input[type="text"]`
  // (when shown), `#right_bar input#key` (right bar filter), and
  // `#tweet_searchbox #search_query_field` (tweet search). 13/13 themes ship
  // repeated border + radius + color + focus-ring decls for these; this
  // pattern centralizes them.
  //   "boxed"          → 1px border + ext.searchbox-radius (default 4px)
  //                      + bg-surface + text color + focus halo (accent-alpha)
  //   "outlined-accent"→ boxed + focus also shifts border-color to accent
  //   "minimal"        → no border + transparent bg (flat)
  const searchbox = pat["searchbox-style"];
  if (searchbox === "boxed" || searchbox === "outlined-accent") {
    const r = tokens.ext?.["searchbox-radius"] || "4px";
    const sel = `#search_query_field, #banner_searchbox input[type="text"], #right_bar input#key, #tweet_searchbox #search_query_field`;
    out.push(
      `${sel} { background: ${v("bg-surface")} !important; color: ${v("fg")} !important; border: 1px solid ${v("border")} !important; border-radius: ${r} !important; }`
    );
    if (searchbox === "outlined-accent") {
      out.push(
        `${sel.split(", ").map(s => `${s}:focus`).join(", ")} { border-color: ${v("accent")} !important; box-shadow: 0 0 0 2px ${v("accent-alpha")} !important; outline: none !important; }`
      );
    }
  } else if (searchbox === "minimal") {
    const sel = `#search_query_field, #banner_searchbox input[type="text"], #right_bar input#key, #tweet_searchbox #search_query_field`;
    out.push(
      `${sel} { background: transparent !important; border: none !important; border-radius: 0 !important; }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P6: tag-hover-style ----
  // Delta on top of composer's baseline `a.tag:hover` (which sets bg to
  // accent-alpha, color to tag-fg, text-decoration:none). 10/13 shipped
  // themes add extra emphasis — most commonly underline, some shift color
  // to accent. This pattern emits the delta only.
  //   "underline"       → restore text-decoration: underline
  //   "accent-text"     → shift color to accent
  //   "underline-accent"→ both
  const tagHover = pat["tag-hover-style"];
  if (tagHover === "underline") {
    out.push(
      `a.tag:hover { text-decoration: underline !important; }`
    );
  } else if (tagHover === "accent-text") {
    out.push(
      `a.tag:hover { color: ${v("accent")} !important; }`
    );
  } else if (tagHover === "underline-accent") {
    out.push(
      `a.tag:hover { color: ${v("accent")} !important; text-decoration: underline !important; }`
    );
  }
  // "default" or missing → composer baseline (accent-alpha bg only)

  // ---- P6: tag-selected-style ----
  // `a.tag.selected` is the "currently filtered" tag chip. Composer baseline
  // uses palette.destroy + bold for a strong "this is active" signal, but
  // 12/13 themes actually prefer accent-colored or theme-specific chroma.
  //   "accent"      → color: accent (keeps composer's bold weight)
  //   "accent-soft" → color: accent + normal weight (subtle)
  //   "bold-accent" → color: accent + explicit weight 600 (crisper than
  //                   composer's `bold` keyword, aids monospace/serif themes)
  const tagSelected = pat["tag-selected-style"];
  if (tagSelected === "accent") {
    out.push(
      `a.tag.selected { color: ${v("accent")} !important; }`
    );
  } else if (tagSelected === "accent-soft") {
    out.push(
      `a.tag.selected { color: ${v("accent")} !important; font-weight: normal !important; }`
    );
  } else if (tagSelected === "bold-accent") {
    out.push(
      `a.tag.selected { color: ${v("accent")} !important; font-weight: 600 !important; }`
    );
  }
  // "default" or missing → composer baseline (destroy color + bold)

  // ---- P7: title-hover-style ----
  // Delta on composer's baseline `a.bookmark_title:hover`. 6/13 themes
  // override — catppuccin-pair/flexoki-light drop the underline to keep the
  // bookmark title flat-looking on hover; dracula shifts to a brighter accent
  // tint; rose-pine/paper-ink go subtle-muted for a softer read.
  //   "no-underline" → `text-decoration: none` (keeps composer's color)
  //   "accent-color" → color shifts to `link-hover` with no underline
  //   "muted"        → color shifts to `muted-soft` with no underline
  const titleHover = pat["title-hover-style"];
  if (titleHover === "no-underline") {
    out.push(
      `a.bookmark_title:hover { text-decoration: none !important; }`
    );
  } else if (titleHover === "accent-color") {
    out.push(
      `a.bookmark_title:hover { color: ${v("link-hover")} !important; text-decoration: none !important; }`
    );
  } else if (titleHover === "muted") {
    out.push(
      `a.bookmark_title:hover { color: ${v("muted-soft")} !important; text-decoration: none !important; }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P7: description-tone ----
  // Parallel to footer-tone. 9/13 themes override `.description` with a
  // muted color and/or reduced opacity (catppuccin-pair, dracula, flexoki,
  // paper-ink, rose-pine, terminal). Color always resolves to `muted-soft`
  // so the tone stays token-driven; opacity is an extra "faint" tier for
  // themes whose muted-soft isn't muted enough on their bg.
  //   "muted" → color only
  //   "faint" → color + opacity 0.75
  const descTone = pat["description-tone"];
  if (descTone === "muted" || descTone === "faint") {
    const opacity = descTone === "faint" ? " opacity: 0.75 !important;" : "";
    out.push(
      `.description { color: ${v("muted-soft")} !important;${opacity} }`
    );
  }
  // "default" or missing → composer baseline

  // ---- P7: input-radius ----
  // 4/13 themes (catppuccin-pair, modern-card, paper-ink) apply the same
  // radius to *every* form input (`text/password/not([type])/textarea/select`)
  // en bloc. Value read from `ext.input-radius` (no default — pattern is a
  // no-op if the token isn't set). Kept distinct from `searchbox-style` /
  // `button-style` because those scope to specific selectors; this one is
  // the catch-all for non-button inputs on settings/edit pages.
  //   "rounded" → apply ext.input-radius to the form-input selector group
  const inputRadius = pat["input-radius"];
  if (inputRadius === "rounded") {
    const r = tokens.ext?.["input-radius"];
    if (r) {
      out.push(
        `input[type="text"], input:not([type]), input[type="password"], textarea, select { border-radius: ${r} !important; }`
      );
    }
  }
  // "default" or missing → composer baseline

  // ---- P8: window-chrome ----
  // Mac OS 9 Platinum desktop windowing ("platinum"): #ccc / #2a2a2a desktop,
  // straight-edge Menu Bar #banner, independent Mac windows for #main_column
  // and #right_bar with 2px horizontal pinstripe titlebars, sunken #fff /
  // #1c1c1c document wells, neutral Platinum rectangular tag chips, and 4-layer
  // stepped crisp beveled buttons.
  const windowChrome = pat["window-chrome"];
  if (windowChrome === "platinum") {
    const isDark = tokens.meta?.mode === "dark";
    const deskBg = isDark ? "#2a2a2a" : "#cccccc";
    const chromeBg = isDark ? "#3b3b3b" : "#dddddd";
    const paperBg = isDark ? "#1c1c1c" : "#ffffff";
    const groupBg = isDark ? "#252525" : "#f4f4f4";
    const groupBorder = isDark ? "#555555" : "#8c8c8c";
    const inkBorder = isDark ? "#000000" : "#262626";
    const hardShadow = isDark ? "#000000" : "#262626";
    const glint = isDark ? "#636363" : "#ffffff";
    const stripeDark = isDark ? "#191919" : "#777777";
    const bevelD1 = isDark ? "#191919" : "#777777";
    const bevelMid = isDark ? "#191919" : "#999999";
    const rowRule = isDark ? "#333333" : "#d4d4d4";
    const rowHoverBg = isDark ? "#262626" : "#f2f2f2";
    const btnFace = isDark ? "#4a4a4a" : "#dddddd";
    const btnHover = isDark ? "#575757" : "#e8e8e8";
    const btnFg = isDark ? "#ffffff" : "#262626";
    const btnBevel = isDark
      ? "inset 1px 1px 0 #4a4a4a, inset -1px -1px 0 #191919, inset 2px 2px 0 #6c6c6c, inset -2px -2px 0 #2c2c2c"
      : "inset 1px 1px 0 #dddddd, inset -1px -1px 0 #777777, inset 2px 2px 0 #ffffff, inset -2px -2px 0 #aaaaaa";
    const btnHoverBevel = isDark
      ? "inset 1px 1px 0 #575757, inset -1px -1px 0 #191919, inset 2px 2px 0 #7a7a7a, inset -2px -2px 0 #363636"
      : "inset 1px 1px 0 #e8e8e8, inset -1px -1px 0 #6e6e6e, inset 2px 2px 0 #ffffff, inset -2px -2px 0 #9e9e9e";
    const btnActiveBg = isDark ? "#202020" : "#666666";
    const btnActiveFg = "#ffffff";
    const btnActiveBevel = isDark
      ? "inset 1px 1px 0 #0c0c0c, inset -1px -1px 0 #3c3c3c, inset 2px 2px 0 #161616, inset -2px -2px 0 #2e2e2e"
      : "inset 1px 1px 0 #444444, inset -1px -1px 0 #888888, inset 2px 2px 0 #555555, inset -2px -2px 0 #777777";
    const miniBevel = `inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelD1}`;
    const miniPressed = isDark
      ? "inset 1px 1px 0 #0c0c0c, inset -1px -1px 0 #3c3c3c"
      : "inset 1px 1px 0 #444444, inset -1px -1px 0 #888888";
    const fieldBorder = isDark ? "#707070" : "#262626";
    const fieldShadow = isDark
      ? "inset 1px 1px 0 #0c0c0c, 1px 1px 0 #4c4c4c"
      : "inset 1px 1px 0 #999999, 1px 1px 0 #ffffff";
    // Neutral Mac OS 9 Platinum raised tag chips: 1px outer ring painted FIRST
    // so the 2px inner glint/shade never erases the top-left border on white paper,
    // while keeping 0px border-width delta so #tag_cloud frequency geometry is untouched.
    const chipBg = isDark ? "#444444" : "#dddddd";
    const chipBorder = isDark ? "#141414" : "#595959";
    const chipGlint = isDark ? "#666666" : "#ffffff";
    const chipShade = isDark ? "#262626" : "#b5b5b5";
    const chipHoverBg = isDark ? "#525252" : "#e8e8e8";
    const chipHoverFg = isDark ? "#ffffff" : "#111111";
    const chipHoverBorder = isDark ? "#000000" : "#262626";
    const chipRestShadow = `inset 0 0 0 1px ${chipBorder}, inset 2px 2px 0 ${chipGlint}, inset -2px -2px 0 ${chipShade}`;
    const chipHoverShadow = `inset 0 0 0 1px ${chipHoverBorder}, inset 2px 2px 0 ${chipGlint}, inset -2px -2px 0 ${chipShade}`;
    const selBg = isDark ? "#3d3dad" : "#333399";
    const selHoverBg = isDark ? "#4e4ec7" : "#24247a";
    const selFg = "#ffffff";
    const arrowHex = isDark ? "%23eaeaea" : "%23262626";
    const selectArrows = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="7" height="10" shape-rendering="crispEdges"><path fill="${arrowHex}" d="M3 0h1v1H3zM2 1h3v1H2zM1 2h5v1H1zM0 3h7v1H0zM0 6h7v1H0zM1 7h5v1H1zM2 8h3v1H2zM3 9h1v1H3z"/></svg>')`;
    const selectArrowsActive = `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="7" height="10" shape-rendering="crispEdges"><path fill="%23ffffff" d="M3 0h1v1H3zM2 1h3v1H2zM1 2h5v1H1zM0 3h7v1H0zM0 6h7v1H0zM1 7h5v1H1zM2 8h3v1H2zM3 9h1v1H3z"/></svg>')`;
    const pinstripeDecls = `content: "" !important; display: block !important; height: 18px !important; box-sizing: border-box !important; padding: 3px 6px !important; background-image: linear-gradient(${glint} 50%, ${stripeDark} 50%), linear-gradient(${chromeBg}, ${chromeBg}) !important; background-size: 100% 2px, 100% 100% !important; background-origin: content-box, border-box !important; background-clip: content-box, border-box !important; border-bottom: 1px solid ${inkBorder} !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important;`;
    const mainWindowSel = `#main_column:not(:has(> form[name="sort"])):not(:has(> #import_history_table)):not(:has(#left_toc))`;
    const paddedMainSel = `${mainWindowSel}:not(:has(> .user_navbar)):not(:has(> #settings_panel))`;
    const popupSelectSel = `select:not([multiple]):not([size]), select[size="1"]`;

    out.push(
      // Desktop & popup body surfaces + classic 12px Mac OS 9 grooved scrollbars
      `body#pinboard { background: ${deskBg} !important; }`,
      `body:not(#pinboard) { margin: 0 !important; background: ${chromeBg} !important; }`,
      `html, body, textarea, .description, .pin-ac .bd { scrollbar-width: auto !important; scrollbar-color: ${btnFace} ${deskBg} !important; }`,
      `::-webkit-scrollbar { width: 12px !important; height: 12px !important; }`,
      `::-webkit-scrollbar-track { background: ${deskBg} !important; border-left: 1px solid ${inkBorder} !important; box-shadow: inset 1px 1px 0 ${bevelMid} !important; }`,
      `::-webkit-scrollbar-thumb { background: ${btnFace} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: ${miniBevel} !important; }`,
      `::-webkit-scrollbar-thumb:hover { background: ${btnHover} !important; }`,
      `::-webkit-scrollbar-thumb:active { background: ${btnActiveBg} !important; }`,
      `::-webkit-scrollbar-corner { background: ${chromeBg} !important; }`,

      // Top Menu Bar (#banner, #sub_banner) & /add Bookmarklet Popup Header (#popup_header)
      `#banner { background: ${chromeBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 6px 12px !important; margin-bottom: 12px !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid}, 2px 2px 0 ${hardShadow} !important; }`,
      `#banner a, #top_menu a, .banner_username { text-decoration: none !important; font-weight: 600 !important; }`,
      `#banner a:hover, #top_menu a:hover { text-decoration: underline !important; }`,
      `#pinboard_name a { color: ${v("fg-strong")} !important; font-weight: 700 !important; }`,
      `#sub_banner { background: ${chromeBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 5px 10px !important; margin-bottom: 10px !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#sub_banner a { font-weight: 600 !important; text-decoration: none !important; }`,
      `#sub_banner a.selected, #sub_banner a.selected:hover { background: ${selBg} !important; color: ${selFg} !important; padding: 1px 6px !important; border-radius: 2px !important; font-weight: 700 !important; }`,
      `body:not(#pinboard) #popup_header { height: auto !important; box-sizing: border-box !important; display: flex !important; align-items: center !important; justify-content: space-between !important; padding: 4px 10px !important; margin-bottom: 10px !important; background-image: linear-gradient(${glint} 50%, ${stripeDark} 50%), linear-gradient(${chromeBg}, ${chromeBg}) !important; background-size: 100% 2px, 100% 100% !important; background-origin: content-box, border-box !important; background-clip: content-box, border-box !important; border-bottom: 1px solid ${inkBorder} !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `body:not(#pinboard) #popup_header #title, body:not(#pinboard) #popup_header #logout { float: none !important; padding: 1px 6px !important; background: ${chromeBg} !important; font-weight: 700 !important; }`,
      `body:not(#pinboard) #popup_header #title { order: 1 !important; }`,
      `body:not(#pinboard) #popup_header #logout { order: 2 !important; }`,
      `body:not(#pinboard) #main_body { padding: 4px 14px 14px !important; box-sizing: border-box !important; }`,

      // Independent Mac OS 9 Windows Across All Page Layouts
      `${mainWindowSel} { display: flow-root !important; background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-sizing: border-box !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `${mainWindowSel}::before { ${pinstripeDecls} }`,
      `${paddedMainSel} { padding: 0 14px 14px !important; }`,
      `${paddedMainSel}::before { margin: 0 -14px 12px -14px !important; }`,
      `${paddedMainSel} > #bookmarks { margin: 8px -14px -14px -14px !important; padding: 0 14px !important; border-top: 1px solid ${inkBorder} !important; }`,
      `${paddedMainSel} > #bookmarks:first-child { margin-top: -4px !important; border-top: none !important; }`,
      `${paddedMainSel} > #bookmarks .bookmark { margin: 0 -14px !important; }`,
      `${paddedMainSel} > #bookmarks > :not(.bookmark):not(#nextprev) + .bookmark { margin-top: 8px !important; border-top: 1px solid ${rowRule} !important; }`,
      `#main_column:has(> form[name="sort"]), #main_column:has(#left_toc), #note_column { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `#main_column:has(> form[name="sort"]) { box-sizing: content-box !important; padding: 0 12px 12px !important; }`,
      `#main_column:has(> form[name="sort"])::before { ${pinstripeDecls} margin: 0 -12px 10px -12px !important; }`,
      `#main_column:has(#left_toc) { position: relative !important; padding-top: 18px !important; align-items: stretch !important; box-sizing: border-box !important; }`,
      `#main_column:has(#left_toc)::before { ${pinstripeDecls} position: absolute !important; top: 0 !important; left: 0 !important; right: 0 !important; }`,
      `#main_column:has(#left_toc) > #left_toc { align-self: stretch !important; background: ${chromeBg} !important; border-right: 1px solid ${inkBorder} !important; padding: 12px 14px !important; margin-right: 0 !important; box-shadow: inset 1px 1px 0 ${glint} !important; }`,
      `#main_column:has(#left_toc) > #content_column { padding: 12px 18px !important; }`,
      `#note_column { padding: 0 16px 16px !important; box-sizing: border-box !important; }`,
      `#note_column::before { ${pinstripeDecls} margin: 0 -16px 14px -16px !important; }`,
      `#note_right_column { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 0 12px 12px !important; margin-left: 16px !important; box-sizing: border-box !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `#note_right_column::before { ${pinstripeDecls} margin: 0 -12px 10px -12px !important; }`,
      `#note_tagbox { background: ${groupBg} !important; color: ${v("fg")} !important; border: 1px solid ${groupBorder} !important; border-radius: 0 !important; padding: 6px 10px !important; box-shadow: inset 1px 1px 0 ${glint} !important; }`,
      `.flash:not(:has(p:not(:empty))) { display: none !important; }`,
      `#notes .note { border-bottom: none !important; padding: 0 !important; margin: 0 !important; }`,
      `#notes .note > span:first-child { display: block !important; padding: 7px 0 !important; border-bottom: 1px solid ${rowRule} !important; color: ${v("muted")} !important; }`,
      `#notes .note > span:first-child p.when { margin: 2px 0 0 !important; font-size: 11px !important; color: ${v("metadata-fg")} !important; }`,
      `#main_column:has(> #import_history_table) > #settings_panel, #main_column > #import_history_table, .service_box, .help_box, #profile_left_column > div:first-child:not(.service_box), #right_column { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `#main_column:has(> #import_history_table) > #settings_panel { margin-top: 0 !important; padding: 0 14px 14px !important; }`,
      `#main_column:has(> #import_history_table) > #settings_panel::before { ${pinstripeDecls} margin: 0 -14px 12px -14px !important; }`,
      `#main_column > #import_history_table { margin-top: 0 !important; }`,
      `.service_box:not(:has(*)), #right_column:not(:has(a, p, div, ul, ol, table)) { display: none !important; }`,
      `.service_box:not(.service_box .service_box)::before, .help_box::before, #profile_left_column > div:first-child:not(.service_box)::before { ${pinstripeDecls} margin: -16px -16px 12px -16px !important; }`,
      `.service_box .service_box { border: none !important; box-shadow: none !important; background: transparent !important; }`,

      // Settings Tab Control, Etched Section Grooves & Mini-Bevel Help Badges
      `#settings_panel { background: ${paperBg} !important; margin-top: 0 !important; padding: 12px 16px 16px !important; box-sizing: border-box !important; }`,
      `.settings_tabs { align-items: flex-end !important; gap: 3px !important; border-bottom: none !important; padding: 0 !important; margin-bottom: 0 !important; }`,
      `.settings_tab { height: auto !important; padding: 5px 14px !important; background: ${btnFace} !important; color: ${v("fg")} !important; border: 1px solid ${inkBorder} !important; border-radius: 3px 3px 0 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px 0 0 ${bevelD1} !important; font-weight: 600 !important; }`,
      `.settings_tab:hover:not(.settings_tab_selected) { background: ${btnHover} !important; color: ${v("fg-strong")} !important; }`,
      `.settings_tab_selected, .settings_tab.settings_tab_selected { background: ${paperBg} !important; color: ${v("fg-strong")} !important; border: 1px solid ${inkBorder} !important; border-bottom-color: ${paperBg} !important; padding: 6px 14px !important; margin-bottom: -1px !important; position: relative !important; z-index: 1 !important; box-shadow: inset 1px 1px 0 ${glint} !important; font-weight: 700 !important; }`,
      `.settings_tab_selected a { color: ${v("fg-strong")} !important; }`,
      `[class*="settings_tab_spacer"] { display: none !important; }`,
      `#settings_tab_panes { border: 1px solid ${inkBorder} !important; background: ${paperBg} !important; padding: 16px 18px !important; box-sizing: border-box !important; box-shadow: inset 1px 0 0 ${glint} !important; }`,
      `.settings_heading { font-size: 12px !important; font-weight: 700 !important; letter-spacing: 0.04em !important; color: ${v("fg-strong")} !important; border-bottom: 1px solid ${bevelMid} !important; box-shadow: 0 1px 0 ${glint} !important; padding-bottom: 4px !important; margin: 16px 0 10px !important; }`,
      `a.help { display: inline-flex !important; align-items: center !important; justify-content: center !important; min-width: 15px !important; height: 15px !important; padding: 0 3px !important; margin-left: 4px !important; vertical-align: middle !important; background: ${btnFace} !important; color: ${btnFg} !important; border: 1px solid ${inkBorder} !important; border-radius: 2px !important; box-shadow: ${miniBevel} !important; font-size: 10px !important; font-weight: 700 !important; line-height: 1 !important; text-decoration: none !important; }`,
      `a.help:hover { background: ${btnHover} !important; color: ${btnFg} !important; text-decoration: none !important; }`,

      // Bookmark Toolbars, Rows, Saved Tab Tables, Tweet Rows & Tag Chips
      `.user_navbar { background: ${chromeBg} !important; border-bottom: 1px solid ${inkBorder} !important; padding: 5px 10px !important; margin: 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#bmarks_page_nav a.filter.selected, a.sort_order_selected, #pbp-pop-sort.pbp-pop-active, .per_page_widget span[style*="background"] { background: ${selBg} !important; color: ${selFg} !important; border-radius: 2px !important; padding: 1px 5px !important; font-weight: 700 !important; text-decoration: none !important; }`,
      `#bmarks_page_nav a.filter.selected:hover { background: ${selHoverBg} !important; color: ${selFg} !important; }`,
      `#bmarks_page_nav a.rss_link { background: ${btnFace} !important; color: ${btnFg} !important; border: 1px solid ${inkBorder} !important; border-radius: 2px !important; padding: 0 6px !important; box-shadow: ${miniBevel} !important; text-decoration: none !important; }`,
      `#bmarks_page_nav a.rss_link:hover { background: ${btnHover} !important; color: ${btnFg} !important; text-decoration: none !important; }`,
      `#bookmarks { background: ${paperBg} !important; margin: 0 !important; padding: 0 !important; }`,
      `#nextprev, #top_next_prev:has(a) { background: ${chromeBg} !important; border-top: 1px solid ${inkBorder} !important; border-bottom: 1px solid ${inkBorder} !important; padding: 4px 10px !important; margin: 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#top_next_prev:has(a) { margin: 0 -14px 8px -14px !important; width: auto !important; }`,
      `#bottom_next_prev { float: none !important; display: flow-root !important; width: 100% !important; box-sizing: border-box !important; background: ${chromeBg} !important; border-top: 1px solid ${inkBorder} !important; padding: 5px 10px !important; margin: 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `${paddedMainSel} > #bottom_next_prev { margin: 8px -14px -14px -14px !important; width: auto !important; }`,
      `#nextprev #bulk_edit[style*="170, 170, 170"] { background: ${btnActiveBg} !important; color: ${btnActiveFg} !important; border-color: ${inkBorder} !important; padding: 0 6px !important; border-radius: 2px !important; }`,
      `#main_column div:has(> .edit_checkbox[style*="block"]), #main_column div:has(> .edit_checkbox[style*="inline"]) { display: flex !important; flex-wrap: wrap !important; align-items: flex-start !important; background: ${paperBg} !important; border-bottom: 1px solid ${rowRule} !important; }`,
      `#main_column div:has(> .edit_checkbox[style*="block"]) > .edit_checkbox, #main_column div:has(> .edit_checkbox[style*="inline"]) > .edit_checkbox { float: none !important; margin: 11px 0 0 12px !important; width: auto !important; flex-shrink: 0 !important; }`,
      `#main_column div:has(> .edit_checkbox[style*="block"]) > .bookmark, #main_column div:has(> .edit_checkbox[style*="inline"]) > .bookmark { box-sizing: border-box !important; flex: 1 1 calc(100% - 40px) !important; min-width: 0 !important; border-bottom: none !important; padding-left: 8px !important; margin: 0 !important; }`,
      `.bookmark { float: none !important; width: auto !important; background: ${paperBg} !important; padding: 9px 12px !important; margin: 0 !important; border-top: none !important; border-right: none !important; border-left: none !important; border-bottom: 1px solid ${rowRule} !important; border-radius: 0 !important; box-shadow: none !important; }`,
      `.bookmark.private, .bookmark.private[style*="background"] { background: ${v("private-bg")} !important; box-shadow: inset 3px 0 0 ${v("private-accent")} !important; }`,
      `a.bookmark_title { font-weight: 600 !important; }`,
      `a.url_link, a.url_link[style*="background"] { background: ${groupBg} !important; color: ${v("muted")} !important; border: 1px solid ${rowRule} !important; border-radius: 2px !important; padding: 0 5px !important; text-decoration: none !important; }`,
      `a.url_link:hover { background: ${btnHover} !important; color: ${v("fg-strong")} !important; border-color: ${inkBorder} !important; text-decoration: none !important; }`,
      `#main_column > table[cellspacing] { width: 100% !important; border-collapse: collapse !important; margin-top: 8px !important; }`,
      `#main_column > table[cellspacing] th { background: ${chromeBg} !important; color: ${v("fg-strong")} !important; font-weight: 700 !important; padding: 5px 8px !important; border-top: 1px solid ${inkBorder} !important; border-bottom: 1px solid ${inkBorder} !important; box-shadow: inset 0 1px 0 ${glint} !important; }`,
      `#main_column > table[cellspacing] td { padding: 6px 8px !important; border-bottom: 1px solid ${rowRule} !important; vertical-align: top !important; }`,
      `#main_column > table[cellspacing] tr:hover td { background: ${rowHoverBg} !important; }`,
      `a.tag { background: ${chipBg} !important; color: ${v("tag-fg")} !important; box-shadow: ${chipRestShadow} !important; border-radius: 2px !important; padding: 0 5px !important; text-decoration: none !important; }`,
      `a.tag:hover { background: ${chipHoverBg} !important; color: ${chipHoverFg} !important; box-shadow: ${chipHoverShadow} !important; text-decoration: none !important; }`,
      `a.tag.selected { background: ${selBg} !important; color: ${selFg} !important; box-shadow: inset 0 0 0 1px ${inkBorder} !important; font-weight: 700 !important; }`,
      `a.tag.selected:hover { background: ${selHoverBg} !important; color: ${selFg} !important; box-shadow: inset 0 0 0 1px ${inkBorder} !important; }`,
      `.suggested_tag { display: inline-block !important; background: ${chipBg} !important; color: ${v("tag-fg")} !important; box-shadow: ${chipRestShadow} !important; border-radius: 2px !important; padding: 1px 7px !important; margin: 2px 3px 2px 0 !important; font-weight: 600 !important; text-decoration: none !important; }`,
      `.suggested_tag:hover { background: ${chipHoverBg} !important; color: ${chipHoverFg} !important; box-shadow: ${chipHoverShadow} !important; text-decoration: none !important; }`,

      // Bundle Editor (#tagpicker, #bundle, .tagNode) — preserves exact 0px hover/select geometry
      `#tagpicker, #bundle { background: ${paperBg} !important; color: ${v("fg")} !important; border: 1px solid ${fieldBorder} !important; border-radius: 0 !important; box-shadow: ${fieldShadow} !important; padding: 8px !important; box-sizing: border-box !important; }`,
      `#tagpicker { width: 100% !important; margin-top: 12px !important; }`,
      `#tagpicker .tagNode:not(.unbundled), #bundle .tagNode, #help_content .tagNode { background: ${chipBg} !important; color: ${v("tag-fg")} !important; border-radius: 2px !important; box-shadow: ${chipRestShadow} !important; }`,
      `#tagpicker .tagNode:hover, #bundle .tagNode:hover, #help_content .tagNode:hover { background: ${chipHoverBg} !important; color: ${chipHoverFg} !important; box-shadow: ${chipHoverShadow} !important; }`,
      `#tagpicker .tagNode.unbundled:hover { background: ${rowHoverBg} !important; color: ${v("fg-strong")} !important; box-shadow: inset 0 0 0 1px ${inkBorder} !important; }`,
      `#tagpicker .tagNode.tagSelected, #bundle .tagNode.tagSelected, #help_content .tagNode.tagSelected { background: ${selBg} !important; color: ${selFg} !important; box-shadow: inset 0 0 0 1px ${inkBorder} !important; }`,
      `#tagpicker .tagNode.tagSelected:hover, #bundle .tagNode.tagSelected:hover, #help_content .tagNode.tagSelected:hover { background: ${selHoverBg} !important; color: ${selFg} !important; box-shadow: inset 0 0 0 1px ${inkBorder} !important; }`,

      // Right Sidebar Window (#right_bar & /search/ #search_right_bar) & Nested /popular/ Sidebar Alignment
      `#right_bar:not(:has(#tag_cloud:empty)), #search_right_bar { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 0 12px 12px !important; box-sizing: border-box !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `@media (min-width: 1061px) { #main_column > #right_bar { top: -1px !important; left: 706px !important; } }`,
      `@media (min-width: 761px) { ${mainWindowSel}:has(~ #right_bar), ${mainWindowSel}:has(~ #search_right_bar) { float: left !important; width: min(690px, calc(100% - 340px)) !important; } ${mainWindowSel} ~ #right_bar:not(:has(#tag_cloud:empty)), ${mainWindowSel} ~ #search_right_bar { float: left !important; width: 320px !important; margin-left: 16px !important; } #footer { clear: both !important; } }`,
      `#right_bar:not(:has(#tag_cloud:empty))::before, #search_right_bar::before { ${pinstripeDecls} margin: 0 -12px 10px -12px !important; }`,
      `#right_bar table, #search_right_bar table { width: 100% !important; border-collapse: collapse !important; }`,
      `#right_bar table td, #search_right_bar table td { padding: 3px 4px !important; }`,
      `#right_bar table tr[onmouseover]:hover, #search_right_bar table tr[onmouseover]:hover { background: ${rowHoverBg} !important; }`,

      // Sunken Text Wells (Text Inputs, Textareas, Multi-row Selects)
      `#search_query_field, #banner_searchbox input[type="text"], #right_bar input#key, #tweet_searchbox #search_query_field, input[type="text"], input:not([type]), input[type="password"], textarea, select[multiple], select[size]:not([size="1"]) { background: ${paperBg} !important; color: ${v("fg")} !important; border: 1px solid ${fieldBorder} !important; border-radius: 0 !important; box-shadow: ${fieldShadow} !important; }`,
      `#search_query_field:focus, #banner_searchbox input[type="text"]:focus, #right_bar input#key:focus, #tweet_searchbox #search_query_field:focus, input[type="text"]:focus, input:not([type]):focus, input[type="password"]:focus, textarea:focus, select[multiple]:focus, select[size]:not([size="1"]):focus { border-color: ${v("accent")} !important; box-shadow: 0 0 0 2px ${v("accent-alpha")} !important; outline: none !important; }`,

      // Authentic Mac OS 9 Platinum Popup Menu <select> + ::picker(select)
      `${popupSelectSel} { -webkit-appearance: none !important; appearance: none !important; background-color: ${btnFace} !important; background-image: ${selectArrows}, linear-gradient(90deg, ${bevelD1} 0 1px, ${glint} 1px 2px) !important; background-position: right 7px center, right 21px center !important; background-size: 7px 10px, 2px calc(100% - 4px) !important; background-repeat: no-repeat !important; color: ${btnFg} !important; font-weight: 600 !important; border: 1px solid ${inkBorder} !important; border-radius: 3px !important; padding: 4px 28px 4px 10px !important; line-height: 1.4 !important; box-shadow: ${btnBevel} !important; cursor: pointer !important; }`,
      `select:is(:not([multiple]):not([size]), [size="1"]):hover:not(:disabled):not(:active) { background-color: ${btnHover} !important; color: ${btnFg} !important; border-color: ${inkBorder} !important; box-shadow: ${btnHoverBevel} !important; }`,
      `select:is(:not([multiple]):not([size]), [size="1"]):active:not(:disabled) { background-color: ${btnActiveBg} !important; background-image: ${selectArrowsActive}, linear-gradient(90deg, #191919 0 1px, #777777 1px 2px) !important; color: ${btnActiveFg} !important; border-color: ${inkBorder} !important; box-shadow: ${btnActiveBevel} !important; }`,
      `select:is(:not([multiple]):not([size]), [size="1"]):focus, select:is(:not([multiple]):not([size]), [size="1"]):focus-visible { border-color: ${inkBorder} !important; box-shadow: ${btnBevel} !important; outline: 2px solid ${v("focus-ring")} !important; outline-offset: 1px !important; }`,
      `@supports selector(::picker(select)) { select:is(:not([multiple]):not([size]), [size="1"]) { appearance: base-select !important; } select:is(:not([multiple]):not([size]), [size="1"])::picker-icon { display: none !important; } select:is(:not([multiple]):not([size]), [size="1"]):is(:open, :open:hover):not(:disabled) { background-color: ${btnActiveBg} !important; background-image: ${selectArrowsActive}, linear-gradient(90deg, #191919 0 1px, #777777 1px 2px) !important; color: ${btnActiveFg} !important; border-color: ${inkBorder} !important; box-shadow: ${btnActiveBevel} !important; } select:is(:not([multiple]):not([size]), [size="1"])::picker(select) { appearance: base-select !important; margin-top: 2px !important; padding: 2px !important; background: ${chromeBg} !important; color: ${v("fg")} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid}, 2px 2px 0 ${hardShadow} !important; } select:is(:not([multiple]):not([size]), [size="1"]) option { position: relative !important; padding: 3px 12px 3px 22px !important; border-radius: 0 !important; font-size: 12px !important; font-weight: 600 !important; line-height: 18px !important; color: ${v("fg")} !important; background: transparent !important; } select:is(:not([multiple]):not([size]), [size="1"]) option::checkmark { display: none !important; } select:is(:not([multiple]):not([size]), [size="1"]) option:checked { background: transparent !important; color: ${v("fg-strong")} !important; font-weight: 700 !important; } select:is(:not([multiple]):not([size]), [size="1"]) option:checked::before { content: "" !important; box-sizing: content-box !important; position: absolute !important; left: 7px !important; top: 50% !important; width: 3.5px !important; height: 7px !important; border: solid currentColor !important; border-width: 0 2px 2px 0 !important; transform: translateY(-60%) rotate(45deg) !important; } select:is(:not([multiple]):not([size]), [size="1"]) option:is(:hover, :focus-visible, :checked:hover, :checked:focus-visible) { background: ${selBg} !important; color: ${selFg} !important; outline: none !important; } }`,

      // Platinum Beveled Checkboxes & Radios
      `input[type="checkbox"], input[type="radio"] { -webkit-appearance: none !important; appearance: none !important; position: relative !important; display: inline-block !important; width: 14px !important; height: 14px !important; margin: 0 4px 0 0 !important; padding: 0 !important; vertical-align: -2px !important; background: ${btnFace} !important; border: 1px solid ${inkBorder} !important; box-shadow: ${miniBevel} !important; cursor: pointer !important; }`,
      `#edit_bookmark_form label + input[type="checkbox"], body:not(#pinboard) label + input[type="checkbox"] { margin-left: 10px !important; }`,
      `input[type="checkbox"] { border-radius: 2px !important; }`,
      `input[type="radio"] { border-radius: 50% !important; }`,
      `input[type="checkbox"]:hover:not(:disabled):not(:checked), input[type="radio"]:hover:not(:disabled):not(:checked) { background: ${btnHover} !important; }`,
      `input[type="checkbox"]:active:not(:disabled):not(:checked), input[type="radio"]:active:not(:disabled):not(:checked) { background: ${btnActiveBg} !important; box-shadow: ${miniPressed} !important; }`,
      `input[type="checkbox"]:checked, input[type="radio"]:checked { background: ${selBg} !important; border-color: ${inkBorder} !important; box-shadow: inset 1px 1px 0 rgba(0,0,0,0.45) !important; }`,
      `input[type="checkbox"]:checked::after { content: "" !important; box-sizing: content-box !important; position: absolute !important; left: 4px !important; top: 1px !important; width: 3px !important; height: 7px !important; border: solid #ffffff !important; border-width: 0 2px 2px 0 !important; transform: rotate(45deg) !important; }`,
      `input[type="radio"]:checked::after { content: "" !important; position: absolute !important; left: 4px !important; top: 4px !important; width: 4px !important; height: 4px !important; border-radius: 50% !important; background: #ffffff !important; }`,
      `input[type="checkbox"]:focus-visible, input[type="radio"]:focus-visible { outline: 2px solid ${v("focus-ring")} !important; outline-offset: 1px !important; }`,
      `input[type="checkbox"]:disabled, input[type="radio"]:disabled { opacity: 0.5 !important; cursor: default !important; }`,

      // 4-Layer Stepped Bevel Push Buttons
      `input[type="submit"], input[type="button"], input[type="reset"], input[type="reset"].reset, button[type="reset"], input[type="file"]::file-selector-button, .search_button input[type="submit"], #right_bar input[type="submit"], #search_right_bar input[type="submit"], #tweet_searchbox input[type="submit"], #tagPickerNav input[type="button"], #save_changes_marker, #edit_bookmark_form input.submit, #edit_bookmark_form input.reset, .signup_button, .signup_button[style*="background"] { background: ${btnFace} !important; color: ${btnFg} !important; border: 1px solid ${inkBorder} !important; border-radius: 3px !important; box-shadow: ${btnBevel} !important; font-weight: 600 !important; }`,
      `input[type="submit"]:hover, input[type="button"]:hover, input[type="reset"]:hover, input[type="reset"].reset:hover, button[type="reset"]:hover, input[type="file"]::file-selector-button:hover, .search_button input[type="submit"]:hover, #right_bar input[type="submit"]:hover, #search_right_bar input[type="submit"]:hover, #tweet_searchbox input[type="submit"]:hover, #tagPickerNav input[type="button"]:hover, #save_changes_marker:hover, #edit_bookmark_form input.submit:hover, #edit_bookmark_form input.reset:hover, .signup_button:hover { background: ${btnHover} !important; color: ${btnFg} !important; border-color: ${inkBorder} !important; box-shadow: ${btnHoverBevel} !important; }`,
      `input[type="submit"]:active, input[type="button"]:active, input[type="reset"]:active, .search_button input[type="submit"]:active, #right_bar input[type="submit"]:active, #search_right_bar input[type="submit"]:active, #tweet_searchbox input[type="submit"]:active, #tagPickerNav input[type="button"]:active, #save_changes_marker:active, #edit_bookmark_form input.submit:active, #edit_bookmark_form input.reset:active, .signup_button:active { background: ${btnActiveBg} !important; color: ${btnActiveFg} !important; border-color: ${inkBorder} !important; box-shadow: ${btnActiveBevel} !important; }`,

      // Inline Edit Form, Bulk Edit Dialog Box, Autocomplete Menu & Responsive Breakpoints
      `#edit_bookmark_form { float: none !important; width: 100% !important; box-sizing: border-box !important; background: ${chromeBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 12px 14px !important; margin: 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `.bookmark > #edit_bookmark_form { flex: 1 1 0% !important; width: auto !important; min-width: 0 !important; max-width: 100% !important; }`,
      `#bulk_edit_options { margin: 0 !important; padding: 8px 10px !important; box-sizing: border-box !important; background: ${paperBg} !important; border-bottom: 1px solid ${inkBorder} !important; }`,
      `#bulk_edit_box { background: ${groupBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 0 !important; margin: 0 !important; box-shadow: inset 1px 1px 0 ${glint} !important; }`,
      `#bulk_top_bar { background: ${chromeBg} !important; border: none !important; border-bottom: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 5px 10px !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#bulk_edit_box a[style*="color"], #bulk_edit_box span[style*="color"] { color: ${v("accent")} !important; }`,
      `#bulk_edit_box a[style*="color"]:hover { color: ${v("link-hover")} !important; text-decoration: underline !important; }`,
      `#bulk_edit_box #confirm { background: ${chromeBg} !important; border-top: 1px solid ${inkBorder} !important; padding: 6px 10px !important; }`,
      `#bulk_edit_box #confirm #confirm_message { color: ${v("fg-strong")} !important; font-weight: 700 !important; }`,
      `.blurb_box { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `pre { background: ${groupBg} !important; border: 1px solid ${fieldBorder} !important; border-radius: 0 !important; box-shadow: ${fieldShadow} !important; }`,
      `code, tt { background: ${groupBg} !important; border: 1px solid ${rowRule} !important; border-radius: 2px !important; padding: 0 4px !important; }`,
      `a.bookmarklet { background: ${btnFace} !important; color: ${btnFg} !important; border: 1px solid ${inkBorder} !important; border-radius: 2px !important; padding: 1px 7px !important; box-shadow: ${miniBevel} !important; font-weight: 600 !important; text-decoration: none !important; }`,
      `a.bookmarklet:hover { background: ${btnHover} !important; color: ${btnFg} !important; text-decoration: none !important; }`,
      `.pin-ac .bd { background: ${chromeBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 2px !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid}, 2px 2px 0 ${hardShadow} !important; }`,
      `.pin-ac li { font-weight: 600 !important; }`,
      `.pin-ac li:hover, .pin-ac .active { background: ${selBg} !important; color: ${selFg} !important; }`,
      `@media (max-width: 1060px) { #main_column > #right_bar { position: static !important; left: auto !important; top: auto !important; width: 100% !important; margin-top: 12px !important; } }`,
      `@media (max-width: 760px) { ${mainWindowSel} { width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; } #right_bar, #search_right_bar, #main_column > #right_bar, #note_right_column { width: 100% !important; margin-left: 0 !important; margin-top: 12px !important; float: none !important; } }`,
      `@media (max-width: 640px) { #right_bar, #search_right_bar, #main_column > #right_bar { display: none !important; } }`
    );
  } else if (windowChrome != null && windowChrome !== "default") {
    throw new Error(`window-chrome: unknown value "${windowChrome}" (expected "default" or "platinum")`);
  }

  if (!out.length) return "";
  return `\n/* === patterns layer (tokens.patterns) === */\n` + out.join("\n") + "\n";
}

// CSS ::before/::after `content:` must be a quoted string. We already wrap in
// double-quotes, so escape any " and \ in the user glyph. Keep printable-ASCII
// glyphs (schema caps at 8 chars, typical values: "> ", "$ ", "# ", "» ").
function escapeCssContent(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
