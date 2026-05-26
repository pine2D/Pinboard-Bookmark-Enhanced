# Adding a New Theme

Step-by-step for adding a 14th+ theme to the factory. Distilled from the lessons
of the tag-style cascade refactor — read this before you start so you don't
spend rounds 2 through 6 of a 1-round task.

---

## TL;DR

```bash
# 1. copy a template tokens file
cp docs/theme-surface/pilots/github-light.tokens.json \
   docs/theme-surface/pilots/<your-slug>.tokens.json

# 2. edit the palette / typo / patterns to taste

# 3. regenerate shipped CSS into pinboard-themes.js
node docs/theme-surface/tools/sync-all.mjs

# 4. ensure all gates pass
node docs/theme-surface/tools/diff-all.mjs --strict
node docs/theme-surface/tools/cascade-lint.mjs
node docs/theme-surface/tools/override-drift.mjs
node docs/theme-surface/tools/token-coverage.mjs
```

If all four exit 0 you're done. Reload the extension at
`chrome://extensions/` and pick your theme from the options page.

---

## 1 · Pick a template

| New theme is... | Copy from | Why |
|-----------------|-----------|-----|
| Light, minimal | `github-light.tokens.json` | Smallest overrides block, cleanest patterns |
| Dark, minimal | `nord-night.tokens.json` | Same shape, dark palette already balanced |
| Adaptive (auto light+dark) | `flexoki.tokens.json` | The only theme that uses `modes` |
| Colorful / playful | `catppuccin-latte.tokens.json` | Full palette, all P3+ patterns used |
| Brutalist / serif / editorial | `paper-ink.tokens.json` | Serif typo + tag-style underline |

The two recommended starting points are `github-light` (light) and `nord-night`
(dark). Both have well-documented overrides, consistent palette naming, and
deliberately small patterns blocks so you can layer in only what your theme
needs.

---

## 2 · Required token fields

Authoritative schema: `docs/theme-surface/tokens.schema.json`. Minimum keys
your tokens.json must declare:

### `meta`

| Key | Purpose |
|-----|---------|
| `slug` | Must match the filename stem |
| `name` | Display name in the options dropdown |
| `description` | One-line tagline |
| `author` | Your handle |

### `layout`

| Key | Purpose |
|-----|---------|
| `mode` | Must be `"classic-list-v2"` (the only supported composer for shipped themes) |
| `max-width` | Optional column cap, e.g. `"1240px"` or `"none"` |
| `bookmark-style` | `"flat"` or `"card"` |

### `palette`

The 17 required slots:
`bg`, `bg-surface`, `fg`, `fg-strong`, `muted`, `muted-soft`,
`border`, `border-strong`, `accent`, `accent-hover`, `accent-soft`, `accent-alpha`,
`input-bg`, `private-bg`, `destroy`, `tag-bg`, `row-hover`.

`_util.mjs#expandPalette` fills sensible fallbacks for the other ~16 slots
(`btn-bg`, `link-hover`, `focus-ring`, `tag-fg`, `success`, ...). You can
override any of them explicitly.

### `typo`

`family`, `size-base`, `size-sm`, `size-lg`, `size-xs`, `line-height`,
`weight-body`, `weight-heading`.

### `space`

`unit`, `bookmark-gap`, `main-padding`. Others (`sub-banner-y`,
`right-bar-gap`, `form-gap`) fall back to `unit`.

### `radius`

`sm`, `md`, `lg`. `md` falls back to `sm` and `lg` to `md` if omitted.

### `border`

`width`, `style`, `hairline`. Defaults: `1px solid <palette.border>`.

---

## 3 · `patterns` block

Patterns are the personality layer — toggle stylistic decisions without
authoring overrides. Each is opt-in; omit a key to keep composer baseline.

| Pattern | Values | What it does |
|---------|--------|--------------|
| `tag-style` | `flat` \| `underline` | **Required.** Owns `a.tag` base/hover/selected. |
| `bookmark-title-prefix` | string (≤ 8 chars) | Pseudo-element prefix on titles, e.g. `"› "` |
| `heading-prefix` | string (≤ 8 chars) | Same, for `.settings_heading` |
| `url-link-style` | `pill` \| `underline` \| `plain` \| (default `capsule`) | Reshapes `a.url_link` |
| `private-badge` | `inset-bar` \| `dashed` \| `stripe` \| (default tint-bg) | How private bookmarks read |
| `focus-ring` | `glow` \| `dashed` \| `none` \| (default `thin-solid`) | Input focus chrome |
| `shape` | `sharp` \| `pill` \| (default `rounded`) | Overrides radius custom props |
| `density` | `compact` \| `roomy` \| (default) | Row gap + padding |
| `row-divider` | `hairline` \| `dashed` \| `left-accent` \| `none` | Bookmark row separator |
| `heading-accent` | `caps` \| `dashed-underline` \| (default `plain`) | `.settings_heading` chrome |
| `card-shadow` | `soft` \| `strong` | Drop shadow on rows (pair with `row-divider: "none"`) |
| `blockquote-style` | `left-accent` \| `left-muted` | `.description blockquote` left border |
| `banner-chrome` | `rounded` \| `card` | `#banner` shape |
| `title-weight` | `normal` \| `medium` \| `semibold` \| `bold` | `a.bookmark_title` font-weight |
| `tag-size` | `small` | Shrinks `a.tag` to `typo.size-xs` |
| `button-style` | `flat` \| `outlined` \| `rounded` \| `flat-rounded` \| `pill` | Submit/button chrome |
| `footer-tone` | `muted` \| `faint` | Mutes `#footer`, `.colophon`, `.rss_link` |
| `edit-form-surface` | `panel` \| `card` | Heavyweight form panels |
| `sort-order-style` | `tinted` \| `accent-bg` \| `surface` | `a.sort_order_selected` |
| `searchbox-style` | `boxed` \| `outlined-accent` \| `minimal` | Search input chrome |
| `sort-table-style` | `enabled` | Order-rank input + row-hover treatment |
| `tag-hover-style` | `underline` \| `accent-text` \| `underline-accent` | Delta on `a.tag:hover` |
| `tag-selected-style` | `accent` \| `accent-soft` \| `bold-accent` | Delta on `a.tag.selected` |
| `title-hover-style` | `no-underline` \| `accent-color` \| `muted` | Delta on `a.bookmark_title:hover` |
| `description-tone` | `muted` \| `faint` | `.description` tone |
| `searchbox-width` | `full` | `#search_query_field { width: 100% }` |
| `input-radius` | `rounded` | Uniform radius across all form inputs (requires `ext.input-radius`) |

`tag-style` is required because it owns the full tag visual. Without it the
composer emits no `a.tag:hover` or `a.tag.selected` rules and cascade-lint
will flag the gap.

---

## 4 · `overrides.css` — the escape hatch

For per-theme rules the composer + patterns cannot express, append raw CSS
under `overrides.css`. Composer output → patterns layer → overrides, so
overrides win the cascade by source order at equal specificity.

**Cascade collision warning.** If you override a selector the composer already
emits with `:not(.tag)` (and similar exclusions), copy the exclusions verbatim
or `override-drift` will block your commit. Example:

```css
/* BAD — re-broadens the composer's scoped selector */
#right_bar a { color: #abc !important; }

/* GOOD — preserves the :not(.tag) scoping */
#right_bar a:not(.tag) { color: #abc !important; }
```

Selectors currently scoped this way in `classic-list-v2.mjs`:

- `#right_bar a:not(.tag)` + `:hover`
- `#tag_cloud a:not(.tag)` + `:hover`
- `#tag_cloud_header a:not(.tag)` + variants

The lint hint will tell you exactly which `:not(...)` to add.

---

## 5 · `modes` (optional, for adaptive themes)

Only flexoki uses this. A mode declares a `trigger` (a selector prefix) and
a delta palette / typo / etc. Every composer rule is re-emitted with the
trigger prepended.

```jsonc
"modes": {
  "dark": {
    "trigger": "html.pbp-dark",
    "palette": { "bg": "#100F0F", "fg": "#CECDC3", ... }
  }
}
```

The runtime toggles `html.pbp-dark` based on the user's OS preference. If you
ship an adaptive theme, `cascade-lint` will detect it and run the 6 dark-mode
probes in addition to the 9 light probes.

---

## 6 · Verification loop

Run all four in this order. Each must exit 0.

```bash
node docs/theme-surface/tools/sync-all.mjs           # regenerate + drift-guard
node docs/theme-surface/tools/cascade-lint.mjs       # cascade conflicts
node docs/theme-surface/tools/override-drift.mjs     # bare overrides on scoped composers
node docs/theme-surface/tools/token-coverage.mjs     # missing token definitions
```

`sync-all` is the orchestrator — it runs `render-all`, `apply-tokens` × N,
`diff-all --strict`, `contrast-audit`, `layout-lint`, and `url-lint`. The
other three are independent checks the pre-commit hook also runs.

The pre-commit hook runs all four automatically when any `composers/`,
`pilots/*.tokens.json`, or `tools/*.mjs` file is staged. Do not bypass with
`--no-verify` — if a check fires it's a real bug.

---

## 7 · Common pitfalls

1. **Forgetting `patterns.tag-style`.** The composer emits only the base
   `a.tag` rule; tag-style owns `:hover` and `.selected`. Without it, hovering
   a tag does nothing and selected tags look identical to unselected. Both
   `flat` and `underline` are valid starting points.

2. **Bare `#right_bar a` override.** Composer emits `#right_bar a:not(.tag)`
   so the tag-style pattern can win on tag elements. A bare override
   re-hijacks tags. `override-drift` will catch this and print the exact
   selector to use instead.

3. **Inconsistent token definitions across themes.** If you copy a palette
   slot from another theme, make sure the value makes semantic sense in
   yours. catppuccin-mocha's selected color used to be `#cba6f7` (mauve);
   it now derives from `destroy` via `tag-selected-style`. Prefer
   patterns/tokens over hard-coded overrides whenever possible.

4. **Adaptive dark cascade is separate.** When you add a `modes.dark`
   block, the composer is re-run with the merged palette and every selector
   gets the trigger prefix. A dark-mode regression won't show up in the
   default probes — `cascade-lint` covers this automatically, but you must
   verify by running it after every dark-palette edit.

5. **Missing token definitions.** `v("some-token")` in a composer resolves
   to `var(--pinboard-some-token)`. If your theme doesn't define
   `some-token` (and there's no fallback in `_util.mjs#expandPalette`),
   browsers silently fall back to CSS initial — invisible to drift-guard.
   `token-coverage` catches this.

---

## 8 · Visual smoke test

1. Reload the extension at `chrome://extensions/` (toggle off/on or click the
   refresh icon on the unpacked extension card).
2. Open Pinboard and switch your theme in the extension options.
3. Compare against `docs/theme-surface/snapshots/` and `.qa-scan/` for the
   reference state of the 13 pages × hover/focus/selection.

The four pages most worth checking by eye:
- `home` — bookmark list, tag cloud, pagination
- `add` (popup) — form inputs, submit buttons
- `settings` — heavyweight forms, `.settings_heading`
- `tweets` — right_bar-heavy layout, sort tables

---

## 9 · Submitting

This is a single-author project, so "submitting" means landing a commit on
`main`. Two-file diff plus a sensible message:

```bash
git add docs/theme-surface/pilots/<slug>.tokens.json pinboard-themes.js
git commit -m "feat(theme): add <slug> theme"
```

`sync-all` regenerates `pinboard-themes.js` in place, so stage both files.

---

## Don't hand-edit pinboard-themes.js

`pinboard-themes.js` is the runtime artifact. It is fully regenerated
on every `sync-all` invocation from composer output + per-theme tokens.
Any rule you add directly will be silently overwritten the next time
sync-all runs.

If you need a rule that doesn't fit the composer:

- **Applies to all 13 themes** → add it to `composers/classic-list-v2.mjs`
  (or `_patterns.mjs` if it should be opt-in per theme).
- **Applies to one theme only** → add it to that theme's
  `pilots/<slug>.tokens.json` `overrides.css` string.

The `handedit-audit` pre-commit hook detects any rule in
`pinboard-themes.js` not derivable from the composer pipeline and
blocks the commit. If you see it fire, follow its diagnostic hint
to migrate the rule to the proper layer.
