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
  // #1c1c1c document wells, Lavender rectangular tag chips, and 4-layer
  // stepped crisp beveled buttons.
  const windowChrome = pat["window-chrome"];
  if (windowChrome === "platinum") {
    const isDark = tokens.meta?.mode === "dark";
    const deskBg = isDark ? "#2a2a2a" : "#cccccc";
    const chromeBg = isDark ? "#3b3b3b" : "#dddddd";
    const paperBg = isDark ? "#1c1c1c" : "#ffffff";
    const inkBorder = isDark ? "#000000" : "#262626";
    const hardShadow = isDark ? "#000000" : "#262626";
    const glint = isDark ? "#636363" : "#ffffff";
    const stripeDark = isDark ? "#191919" : "#777777";
    const bevelMid = isDark ? "#191919" : "#999999";
    const rowRule = isDark ? "#333333" : "#d4d4d4";
    const rowHoverBg = isDark ? "#252525" : "#f5f5fa";
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
    const fieldBorder = isDark ? "#707070" : "#262626";
    const fieldShadow = isDark
      ? "inset 1px 1px 0 #0c0c0c, 1px 1px 0 #4c4c4c"
      : "inset 1px 1px 0 #999999, 1px 1px 0 #ffffff";
    const lavBg = isDark ? "#2a2a48" : "#ebebff";
    const lavBorder = isDark ? "#5a5aa8" : "#9999ff";
    const lavHoverBg = isDark ? "#323257" : "#dcdcff";
    const lavHoverFg = isDark ? "#f4f4ff" : "#11114d";
    const lavHoverBorder = isDark ? "#8080e0" : "#6666cc";
    const selBg = isDark ? "#3d3dad" : "#333399";
    const selHoverBg = isDark ? "#4e4ec7" : "#24247a";
    const selFg = "#ffffff";
    const mainWindowSel = `#main_column:not(:has(> form[name="sort"])):not(:has(> #import_history_table)):not(:has(#left_toc))`;

    out.push(
      `body#pinboard { background: ${deskBg} !important; }`,
      `body:not(#pinboard) { background: ${chromeBg} !important; }`,
      `#banner { background: ${chromeBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 6px 12px !important; margin-bottom: 12px !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid}, 2px 2px 0 ${hardShadow} !important; }`,
      `#banner a, #top_menu a, .banner_username { text-decoration: none !important; font-weight: 600 !important; }`,
      `#banner a:hover, #top_menu a:hover { text-decoration: underline !important; }`,
      `#pinboard_name a { color: ${v("fg-strong")} !important; font-weight: 700 !important; }`,
      `#sub_banner { background: ${chromeBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 5px 10px !important; margin-bottom: 10px !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#sub_banner a { font-weight: 600 !important; text-decoration: none !important; }`,
      `#sub_banner a.selected, #sub_banner a.selected:hover { background: ${selBg} !important; color: ${selFg} !important; padding: 1px 6px !important; border-radius: 2px !important; font-weight: 700 !important; }`,
      `${mainWindowSel} { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-sizing: border-box !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `${mainWindowSel}::before { content: "" !important; display: block !important; height: 18px !important; box-sizing: border-box !important; padding: 3px 6px !important; background-color: ${chromeBg} !important; background-image: linear-gradient(${glint} 50%, ${stripeDark} 50%) !important; background-size: 100% 2px !important; background-origin: content-box !important; background-clip: content-box !important; border-bottom: 1px solid ${inkBorder} !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#main_column:has(> form[name="sort"]), #main_column:has(#left_toc), #note_column { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `#note_column { padding: 12px 14px !important; }`,
      `#main_column:has(> #import_history_table) > #settings_panel, #main_column > #import_history_table, .service_box, .help_box, #right_column { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `.service_box .service_box { border: none !important; box-shadow: none !important; background: transparent !important; }`,
      `#settings_panel { background: ${paperBg} !important; padding: 10px 12px !important; box-sizing: border-box !important; }`,
      `.settings_tab_selected { background: ${paperBg} !important; border-color: ${inkBorder} !important; border-top: 2px solid ${v("accent")} !important; border-bottom-color: ${paperBg} !important; }`,
      `.user_navbar { background: ${chromeBg} !important; border-bottom: 1px solid ${inkBorder} !important; padding: 5px 10px !important; margin: 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#bmarks_page_nav a.filter.selected { background: ${selBg} !important; color: ${selFg} !important; border-radius: 2px !important; }`,
      `#bmarks_page_nav a.filter.selected:hover { background: ${selHoverBg} !important; color: ${selFg} !important; }`,
      `#bookmarks { background: ${paperBg} !important; margin: 0 !important; padding: 0 !important; }`,
      `#nextprev { background: ${chromeBg} !important; border-top: 1px solid ${inkBorder} !important; border-bottom: 1px solid ${inkBorder} !important; padding: 4px 10px !important; margin: 0 !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#nextprev #bulk_edit[style*="170, 170, 170"] { background: ${btnActiveBg} !important; color: ${btnActiveFg} !important; border-color: ${inkBorder} !important; }`,
      `.bookmark { background: ${paperBg} !important; padding: 9px 12px !important; margin: 0 !important; border-top: none !important; border-right: none !important; border-left: none !important; border-bottom: 1px solid ${rowRule} !important; border-radius: 0 !important; box-shadow: none !important; }`,
      `.bookmark.private, .bookmark.private[style*="background"] { background: ${v("private-bg")} !important; box-shadow: inset 3px 0 0 ${v("private-accent")} !important; }`,
      `a.bookmark_title { font-weight: 600 !important; }`,
      `a.tag { background: ${lavBg} !important; color: ${v("tag-fg")} !important; box-shadow: inset 0 0 0 1px ${lavBorder} !important; border-radius: 2px !important; padding: 0 4px !important; text-decoration: none !important; }`,
      `a.tag:hover { background: ${lavHoverBg} !important; color: ${lavHoverFg} !important; box-shadow: inset 0 0 0 1px ${lavHoverBorder} !important; text-decoration: none !important; }`,
      `a.tag.selected { background: ${selBg} !important; color: ${selFg} !important; box-shadow: inset 0 0 0 1px ${inkBorder} !important; font-weight: 700 !important; }`,
      `a.tag.selected:hover { background: ${selHoverBg} !important; color: ${selFg} !important; box-shadow: inset 0 0 0 1px ${inkBorder} !important; }`,
      `#right_bar:not(:has(#tag_cloud:empty)) { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 0 12px 12px !important; box-sizing: border-box !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `@media (min-width: 761px) { ${mainWindowSel}:has(~ #right_bar) { float: left !important; width: min(690px, calc(100% - 340px)) !important; } ${mainWindowSel} ~ #right_bar:not(:has(#tag_cloud:empty)) { float: left !important; width: 320px !important; margin-left: 16px !important; } #footer { clear: both !important; } }`,
      `#right_bar:not(:has(#tag_cloud:empty))::before { content: "" !important; display: block !important; height: 18px !important; margin: 0 -12px 10px -12px !important; box-sizing: border-box !important; padding: 3px 6px !important; background-color: ${chromeBg} !important; background-image: linear-gradient(${glint} 50%, ${stripeDark} 50%) !important; background-size: 100% 2px !important; background-origin: content-box !important; background-clip: content-box !important; border-bottom: 1px solid ${inkBorder} !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `#right_bar table tr[onmouseover]:hover { background: ${rowHoverBg} !important; }`,
      `#search_query_field, #banner_searchbox input[type="text"], #right_bar input#key, #tweet_searchbox #search_query_field, input[type="text"], input:not([type]), input[type="password"], textarea, select { background: ${paperBg} !important; color: ${v("fg")} !important; border: 1px solid ${fieldBorder} !important; border-radius: 0 !important; box-shadow: ${fieldShadow} !important; }`,
      `#search_query_field:focus, #banner_searchbox input[type="text"]:focus, #right_bar input#key:focus, #tweet_searchbox #search_query_field:focus, input[type="text"]:focus, input:not([type]):focus, input[type="password"]:focus, textarea:focus, select:focus { border-color: ${v("accent")} !important; box-shadow: 0 0 0 2px ${v("accent-alpha")} !important; outline: none !important; }`,
      `input[type="submit"], input[type="button"], input[type="reset"], input[type="reset"].reset, button[type="reset"], input[type="file"]::file-selector-button, .search_button input[type="submit"], #right_bar input[type="submit"], #tweet_searchbox input[type="submit"], #tagPickerNav input[type="button"], #save_changes_marker, .signup_button, .signup_button[style*="background"] { background: ${btnFace} !important; color: ${btnFg} !important; border: 1px solid ${inkBorder} !important; border-radius: 3px !important; box-shadow: ${btnBevel} !important; font-weight: 600 !important; }`,
      `input[type="submit"]:hover, input[type="button"]:hover, input[type="reset"]:hover, input[type="reset"].reset:hover, button[type="reset"]:hover, input[type="file"]::file-selector-button:hover, .search_button input[type="submit"]:hover, #right_bar input[type="submit"]:hover, #tweet_searchbox input[type="submit"]:hover, #tagPickerNav input[type="button"]:hover, #save_changes_marker:hover, .signup_button:hover { background: ${btnHover} !important; color: ${btnFg} !important; border-color: ${inkBorder} !important; box-shadow: ${btnHoverBevel} !important; }`,
      `input[type="submit"]:active, input[type="button"]:active, input[type="reset"]:active, .search_button input[type="submit"]:active, #right_bar input[type="submit"]:active, #tweet_searchbox input[type="submit"]:active, #tagPickerNav input[type="button"]:active, #save_changes_marker:active, .signup_button:active { background: ${btnActiveBg} !important; color: ${btnActiveFg} !important; border-color: ${inkBorder} !important; box-shadow: ${btnActiveBevel} !important; }`,
      `#edit_bookmark_form, #bulk_top_bar, #bulk_edit_box { background: ${chromeBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; padding: 10px 12px !important; box-shadow: inset 1px 1px 0 ${glint}, inset -1px -1px 0 ${bevelMid} !important; }`,
      `.pin-ac .bd { background: ${paperBg} !important; border: 1px solid ${inkBorder} !important; border-radius: 0 !important; box-shadow: 2px 2px 0 ${hardShadow} !important; }`,
      `@media (max-width: 1060px) { #main_column > #right_bar { position: static !important; left: auto !important; width: 100% !important; margin-top: 12px !important; } }`,
      `@media (max-width: 760px) { ${mainWindowSel} { width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; } #right_bar, #main_column > #right_bar { width: 100% !important; margin-left: 0 !important; margin-top: 12px !important; float: none !important; } }`,
      `@media (max-width: 640px) { #right_bar, #main_column > #right_bar { display: none !important; } }`
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
