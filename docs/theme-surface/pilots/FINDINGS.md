# Pilot: github-light — Findings

Date: 2026-04-14 · Method: render `classic-list` composer with extracted tokens; diff against shipped CSS in `pinboard-themes.js` line 2510.

## Headline numbers

| Metric | Shipped | Generated | Coverage |
|---|---:|---:|---:|
| Bytes | 14 751 | 9 312 | 63% |
| Selectors | 148 | 42 | **6.8 %** (10 exact matches) |
| Distinct hex colors | 21 | — | **67 %** mapped into tokens (14/21) |

**Verdict**: Sprint 2 scaffolding is **not ready for Sprint 3** as currently designed. Selector coverage is an order of magnitude short of what a shipped theme needs. The gap is architectural, not a quick fix.

## Root cause analysis

The 6.8 % number is not "mostly right with a few gaps" — it's a **selector-scoping mismatch** + a **surface-inventory shortfall**.

### 1. Selector-scoping mismatch (~60 % of the gap)

Shipped themes use **three scoping worlds**:
- `body#pinboard` (main app pages)
- `body:not(#pinboard)` (edit popup, save popup — iframed views)
- **Unscoped** — bare `.bookmark`, `a.tag`, `input[type="submit"]` etc.

My composer only emits `#main_column`-scoped selectors. Even when my rule targets the right element, the selector string doesn't match. Example:

| Shipped | My composer | Match? |
|---|---|---|
| `.bookmark` | `#main_column .bookmark` | ❌ (still works at runtime, but the diff can't tell) |
| `input[type="submit"]` | `#main_column form input[type="submit"]` | ❌ (mine is stricter, may not cover popup context) |
| `a.bookmark_title` | `#main_column .bookmark a.bookmark_title` | ❌ |

**Implication**: raw selector-string equality is the wrong coverage metric. A computed-style comparison on a real DOM would be more honest. But the **real** finding holds: shipped themes deliberately use bare selectors to cover popup + iframed contexts that `#main_column`-scoping misses.

### 2. Surface-inventory shortfall (~25 % of the gap)

Manifest v1 has 35 surfaces; github-light touches ~55. Missing from manifest:

- **Bookmark micro-elements**: `.star`, `.selected_star`, `a.url_link` (amber pill), `a.url_display`, `a.cached`, `a.when`, `.edit_links a`, `a.copy_link`, `a.unread`
- **Right-bar expansions**: `#tag_cloud`, `#tag_cloud_header`, `a.tag_heading_selected`, `a.tag.selected`, `a.sort_order_selected`, `a.bundle`
- **Form extensions**: `.suggested_tag`, `a.help`, `.email_secret`, `#edit_bookmark_form`, `input[type="checkbox"]`/`[type="radio"]` (accent-color)
- **Settings page**: `#settings_panel`, `.settings_tabs`, `.settings_tab`, `.settings_tab_selected`, `.settings_heading`, `#settings_tab_panes`
- **Profile page**: `.service_box`, `.help_box`, `#profile_left_column`, `#profile_right_column`
- **Bulk edit**: `#bulk_top_bar`, `#bulk_edit_box`
- **Save popup**: `#popup_header`, `.formtable`, `body:not(#pinboard)` scope
- **Notes**: `.note`, `#note_right_column`
- **Pagination**: `.next_prev`, `.next_prev_widget`, `#nextprev a.edit`
- **Footer**: `.colophon`, `.colophon a`

### 3. Palette-slot shortfall (7 colors / ~33 %)

Tokens schema needs:
- **Soft muted variants** (`#8c959f`, `#6e7781`) — shipped uses 3 shades of muted, schema has 1
- **Success color** (`#2da44e`, `#2c974b`) — for subscription `submit` buttons
- **Alpha variants** (`#0969da40`, rgba tints) — for card hover borders
- **Legacy tokens** (`#aaa`, `#24292f`) — referenced by inline-override rules inside the theme itself
- **Accent-tint-bg** (`#e8ecf0`) — `.help` badge
- **Private-accent color** (`#bf8700`) — border-left stripe for private entries
- **Cached-link palette** (`#fff8c5` bg, `#bf8700` fg) — `a.url_link` amber pill

## What this means for Sprint 3

**Don't migrate 13 themes onto the current scaffold.** We'd lose ~60 % of the shipped styling and break popup/settings/profile pages.

Three paths, ranked by realism:

### Path A — Expand the scaffold (heavy)

Grow manifest to ~60 surfaces, add the missing palette slots (target ~25), extend composers to emit under `body#pinboard`, `body:not(#pinboard)`, and bare contexts. **Effort**: roughly 2× what Sprint 2 produced. **Risk**: still not clear this is enough — themes like `modern-card` and `flexoki` may have even richer surface use.

### Path B — Tokens-only migration (pragmatic, recommended)

Keep manifest + tokens.schema as the authoritative spec. **Drop the composer as a CSS generator**. Instead, migrate shipped themes by replacing hard-coded hex with `var(--pinboard-*)` referencing the theme's tokens — a search-and-replace refactor, not a rewrite. The base layer (`_base.mjs` → inline overrides + `:root` vars) ships as a shared prelude string every theme concatenates. Composers live on as **demo references** for new themes written from scratch (magazine stays, proves extensibility).

- Pros: ships 13 themes in a week, matches the zero-build ethos, composers still prove the model.
- Cons: existing themes don't get layout-mode switching — their layout is whatever their CSS already encodes.

### Path C — Hybrid (phased)

Run Path B now to unblock velocity. Add a `layout-mode` CSS flag (`body[data-pinboard-layout="card-grid"]`) that **optionally** activates composer-generated CSS alongside the shipped theme. Users opt in per-theme. Over time, shipped themes can be rewritten composer-first, but that's a future sprint, not a blocker for the spec going live.

## Artifacts

- `github-light.tokens.json` — best-effort token extraction
- `github-light.generated.css` — classic-list composer output (9 312 B, 42 selectors)
- `github-light.shipped.css` — shipped CSS extracted from `pinboard-themes.js` (14 751 B, 148 selectors)
- `render-github-light.mjs` — re-runnable pilot driver; regenerate with `node render-github-light.mjs`
- `report.json` — machine-readable coverage numbers

## Recommendation

**Pause Sprint 3. Choose a path** (A / B / C). Path B is the fastest way to realize the spec's value without rebuilding the composers to cover the full surface. If the tweaking/authoring goal is "new themes look great, old themes keep shipping," Path B does that. Path A is the purist choice and worth doing, but it's another full sprint of work.
