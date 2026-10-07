// tests/render-audit-checklist.mjs — HAND-WRITTEN oracle. Never generate from
// composers/ui-components.mjs, composers/_ui-derive.mjs, the *-chrome.mjs
// token registries, or the pilots/*.tokens.json recipe sources.
//
// WHY hand-written and not generated: composers/ui-components.mjs (the
// recipe source) and the *-chrome.mjs token registries are exactly what this
// audit exists to check. A checklist mechanically derived FROM them would
// pass by construction -- a bug in the recipe would silently become "the new
// correct answer" instead of a failure. This was a Codex BLOCK verdict during
// the design-uplift SDD review (see docs/theme-surface/COMPONENTS.md's
// consumer table at the top of that file: this file is listed as the single
// source of truth for every geometry/contrast rule tagged `[render]`,
// independent of every generator in this repo). Every entry below was
// written by reading the shipped CSS (library.css / options.css / popup.css)
// and COMPONENTS.md by hand -- not derived, not scraped, not looped over a
// selector list pulled from a generator's output.
//
// Consumed by scripts/ui-render-audit.mjs. A CHECKS entry does NOT carry a
// `theme` field: the runner crosses every entry against every value in
// THEMES below, so "same selector, 15 theme states" is a runner-level concern
// (how do we reach a rendered instance), not an oracle-level one (what
// should be true once we're there). The known-failures key format
// (scripts/ui-render-audit.mjs) folds theme back in:
// "<surface>|<theme>|<selector>|<state>|<check>".
//
// One exception to "no theme field" (library redesign 2026-10-03, plan T3):
// `themes: [...]` limits an entry to those THEMES values. Only for the
// library layout states below, whose geometry a theme changes through its
// density tier alone -- "" (default, comfortable) and "terminal" (compact)
// cover both tiers, and 13 more passes would re-measure identical boxes.
//
// Library layout states (each drives its own fresh page, so the selector is
// a label, not a query; it must not contain "-detail-"):
//   noPageScroll      -- { widths, height, tolerancePx }: at every width x
//                        both views x detail closed/open, the html element
//                        fits the window and no scroll container scrolls
//                        sideways; plus the 420px list -> detail -> back
//                        round trip keeps the list region's scrollTop.
//   filterScrollReset -- { inputs, viewport, probeOffset }: each named user
//                        input puts its list region back at the top (T3c).
//   libAxis           -- { sizes, tolerancePx, scrollbarPx }: P / L / G
//                        geometry and the row fill against the index column,
//                        at DPR 1 and 1.5 and after a re-measure (T3c).
//   visibleRowCount   -- { width, height, comfortable, compact }: whole rows
//                        the list region shows, and the row pitch, per
//                        density tier (G3, T4e).
//   focusRowVisible   -- { width, height, steps, passes }: ArrowDown never
//                        leaves the focused row outside the list region (G2).
//   listHeaderFit     -- { width, height, count, indexWidths }: nine locales
//                        x index widths (+ each locale's need -1 / +1),
//                        browse / select, both views: no header child past
//                        the index or out of its group, no overlapping
//                        siblings, and the form shown = the measured fit
//                        (G7); `actual` reports the widest need.
//   filterScrollResetToggles -- true: the status and colour toggles put
//                        their list back at the top (G6, T4e).
//   hangOrder         -- { view, scenarios, indexWindows }: every hang label
//                        in the view's detail pane is above its content or
//                        left of it on its first line, by container width:
//                        each breakpoint +-3 at 1px from 200 above / below,
//                        in the change's own task and after it settled, plus
//                        a coarse 8px pass; index-column and window drivers
//                        (T8f; the driver's comment has the sampling cross).
//                        `fullThemes` (default [""]) limits the window driver
//                        and the coarse settled pass to those themes; every
//                        other listed theme runs the index driver's 1px
//                        passes (both directions, both phases), the coarse
//                        early pass, the monotonic main column rule, the
//                        counter-examples and the label minimums (cost: the
//                        two extra passes added ~250s to a 4-shard verify).
//                        Under --shard the default and terminal rows run in
//                        a named shard (4 shards: 3 and 1), not their theme's
//                        own (shard 0, which also runs the sweep, and 2):
//                        RELOCATED_ROWS in scripts/ui-render-audit.mjs,
//                        falling back to the last shard for other counts;
//                        each row runs once either way.
// paneFit's optional `bleed: [selector]` names a list region that hangs out
// of its pane by design: its own box is exempt; what it contains is measured
// against the region's content box. Its overhang is allowed in the pane's
// scrollWidth only up to the region's measured scrollbar gutter + 4px (the
// designed bleed) + tolerancePx -- a larger overhang is still a paneScroll.
//
// expect keys (see docs/theme-surface/COMPONENTS.md for the exact rule
// behind each -- section references in comments below):
//   textContrast   -- computed `color` vs the actual composited ancestor
//                      background, WCAG ratio must be >= this floor (§1.3,
//                      §7.1 "成对消费律")
//   iconContrast   -- computed SVG stroke (inherits `color` via
//                      stroke="currentColor") vs actual background,
//                      ratio must be >= this floor (§2.2, WCAG 1.4.11)
//   iconVCenter    -- |svg boundingRect center Y - host button's content-box
//                      center Y| must be <= this many px (§2.3 `iconVCenter`)
//   backgroundAlphaMax -- computed background alpha must be <= this ceiling.
//                      Used when an icon-only affordance keeps a larger hit
//                      target but must not expose that target as a painted
//                      button shell in a low-emphasis state.
//   padGteRadiusH  -- computed padding-inline (px) >= min(border-radius px,
//                      height/2) -- pill law 2 (§5.1, §5.4 `padGteRadiusH`).
//                      `true` checks both sides; "start" checks the leading
//                      side only, for a chip whose trailing end is its own
//                      action button (concentric with the end cap)
//   padVMin        -- computed padding-block (px) >= this many px --
//                      pill law 3, applies to every chip/badge (§5.1, §5.4)
//   heightEqWith   -- { selector, tolerancePx }: |this element's
//                      getBoundingClientRect().height - the comparison
//                      selector's height| <= tolerancePx. For same-row
//                      alignment (§6.3 `rowRungEq`) -- a single-selector
//                      `expect` key can't express "matches its neighbor",
//                      so this is the one two-selector shape in the
//                      vocabulary. The comparison selector is metadata on
//                      the check, not part of the known-failures key (the
//                      key's `check` segment stays the plain string
//                      "heightEqWith").
//   hitAreaMin     -- effective hit-area width AND height both >= this many
//                      px (§1.4 `hitAreaMin`). Includes the §1.5 ::before
//                      hit-area expansion when present (COMPONENTS.md §1.4
//                      always said "含 ::before 扩张" -- scripts/ui-render-
//                      audit.mjs's probeSelector reads
//                      getComputedStyle(el, "::before").width/height, which
//                      Chromium already resolves to the USED pixel size for
//                      an absolutely positioned, inset-constrained pseudo-
//                      element (verified live, never the literal "auto").
//                      Falls back to the host's own getBoundingClientRect()
//                      when there's no ::before or it isn't
//                      position:absolute. USER RULING: only icon-only
//                      buttons get this hard assertion -- do not add it to
//                      any icon+text button. design-uplift final-fix I2:
//                      no CHECKS entries carry this key any more -- the
//                      runner class-scans every icon-only <button> for it
//                      instead (scripts/ui-render-audit.mjs's sweepProbe
//                      family 4, gated the same as everything below through
//                      known-failures), so a new icon-only button is
//                      covered automatically instead of needing a hand-
//                      enumerated entry here.
//   widthLtParent  -- computed width (px) <= parent element's CONTENT-box
//                      width - 8px (NOT border-box: a stretched flex item
//                      fills exactly the parent's content box, which sits
//                      inside the parent's own padding+border -- comparing
//                      against border-box width let those alone eat past
//                      the 8px margin and made the guard unable to ever
//                      fail for its one real target, a review-caught bug in
//                      this check's first version. probeSelector computes
//                      it from the parent's getBoundingClientRect().width
//                      minus its computed padding and border). Regression
//                      guard for chip/badge elements that are flex ITEMS of
//                      a column-direction flex container: a flex item is
//                      always block-level regardless of its own inline-
//                      flex/inline-block display value (CSS Display §2.7),
//                      so the container's default `align-items: stretch`
//                      silently fills it to 100% width unless a real
//                      `width` declaration opts out -- a bug the chip
//                      family's generated recipe can't see (it never
//                      declares `width` either way, by design: pill/chip
//                      geometry is content-sized in every OTHER context
//                      this campaign uses it in). The 8px margin clears
//                      normal text-content width variance while still
//                      catching a full stretch (which reads as == parent
//                      content width, not "close to it").
//   textContrastMulti -- { ratio, extraBgSelectorVar }: computed `color` vs
//                      BOTH the actual composited background AND the
//                      current surface's `--{ns}-{extraBgSelectorVar}`
//                      token (e.g. "btn-hover"), each >= ratio. For
//                      `[aria-pressed]` chips, whose hover state repaints
//                      onto `--{ns}-btn-hover` instead of their resting
//                      chip-bg (§5.3/§5.4's `fgToAAMulti` pattern -- the
//                      chip's text color has to survive both paints, not
//                      just the one currently on screen). If the token
//                      can't be resolved to a color, the check degrades to
//                      the single actual-background comparison and the
//                      verdict's `note` says so explicitly -- it never
//                      silently drops the second background.
//   colorSchemeMatchesTheme -- true: computed `color-scheme` on <html> must
//                      include "dark" when the active THEMES entry is one of
//                      the 8 dark presets, "light" otherwise (Task 6). The
//                      one check in this file whose pass/fail literally
//                      depends on which THEMES value is active -- every
//                      other check's `expect` is a theme-independent
//                      literal; this one stays theme-independent IN THE
//                      CHECKLIST (`colorSchemeMatchesTheme: true`, no
//                      literal "light"/"dark") and scripts/ui-render-audit.mjs
//                      computes the expected value itself from the THEMES
//                      loop's current theme, same spirit as `heightEqWith`
//                      cross-referencing a second selector rather than a
//                      static number. Proxy for native-control (scrollbar,
//                      number spinner) rendering mode -- the thumb/track
//                      pixels themselves aren't probeable, but `color-scheme`
//                      is what actually drives them (COMPONENTS.md's "成对
//                      消费律" applied to a UA-rendered pair instead of an
//                      author-painted one).
//   textInset      -- { h, v }: for an element with a direct (own, not a
//                      descendant's) non-whitespace text node, the smaller
//                      of its two opposing insets (text bbox to the nearest
//                      element-or-ancestor's border padding-box edge) must
//                      be >= h horizontally, >= v vertically (§7.6). The
//                      border host is found by walking up from the element
//                      (self counts at depth 0) to the nearest ALL-FOUR-
//                      SIDES bordered box, stopping at any scrollable or
//                      single-line-ellipsis boundary in between -- see
//                      scripts/ui-render-audit.mjs's findBorderBoxHost for
//                      the full walk. Task 14: options preset-preview's
//                      `<summary>` text sat flush against its enclosing
//                      `#preset-preview-section`'s border because an id
//                      selector zeroed the summary's own horizontal padding.
//   childContainment -- true: a `<summary>`'s icon/pseudo-element children
//                      (svg, ::before, ::after) must stay inside the
//                      summary's own border-box, +/-1px tolerance (§7.6).
//                      Scoped to `<summary>` only -- ordinary buttons'
//                      `::before` hit-area expansion (§1.5) is SUPPOSED to
//                      paint outside the host's visual box, so this check
//                      would misfire on every one of them if it weren't
//                      disclosure-specific. Task 14: the same zeroed-padding
//                      bug left no room for the ::after chevron's rotated
//                      7x7 bbox, which painted ~1.45px past the border.
//   beforeExists   -- true: the host's ::before pseudo-element actually
//                      renders (non-zero size), not just that `content` is
//                      declared. Reuses --sweep's own measurePseudo helper
//                      (containmentChildren) -- pseudo-elements aren't
//                      document.querySelector-able, so this is the only
//                      layer that can see one at all. design-uplift preset-
//                      row redesign (2026-08-04): the swatch dot that
//                      replaced the old bordered-pill chrome.
//   insetBand      -- { minInsetPx, blockInsetPx, radiusVar }: the element
//                      that PAINTS a list's hover/selected band must be held
//                      at least minInsetPx clear of its container on both
//                      inline sides, blockInsetPx on both block sides, and
//                      carry exactly the radius rung named by radiusVar
//                      (e.g. "radius-md") on THAT theme -- a rung, not a px
//                      floor, because a theme's ladder is authoritative
//                      (gruvbox-dark's md is 2px and that is correct)
//                      (COMPONENTS.md §9 law 3, Soft Fill). One verdict for
//                      both halves on purpose: a rounded band at full bleed
//                      still cuts the container's corners, and an inset
//                      square band still reads as a stripe -- neither half
//                      is a design rule on its own. `actual` reports the
//                      smaller of the two insets; a zero radius fails with
//                      an explicit note instead of passing on the inset
//                      alone. blockInsetPx and minRadiusPx were added
//                      2026-08-05 after the first version passed on an
//                      implementation the user rejected on sight: 4px inline
//                      / 0px block plus a 2px radius satisfied "inset AND
//                      rounded" to the letter while reading as a misaligned
//                      stripe. The gap was in the oracle, not in the run.
//                      radiusVar (not a px number) came out of the same
//                      round: the first repair used minRadiusPx: 4 and
//                      immediately red-flagged gruvbox-dark, whose whole
//                      ladder is 2px by design.
//                      Written against the band-painting element,
//                      which is NOT always the row: library's vocabulary
//                      rows paint --row-bg on .notes-card-top inside
//                      .vocab-card, so the entry names the child.
//   tabChrome      -- { activeUnderline, underlinePx }: a tab is a label plus
//                      a selection edge (§9 law 7). BOTH branches assert "no
//                      shell" (no fill, no radius) -- that is the half that
//                      regressed. activeUnderline:true additionally requires
//                      an opaque bottom border of >= underlinePx (default 2);
//                      false requires none. Two entries, two selectors, one
//                      key -- the runner cannot ask "is this the selected
//                      one", the checklist says which is which.
//   outlineContrast -- N: computed outline-color vs the REAL composited
//                      background the ring paints OVER (bgStack minus the
//                      host's own layer, since outline-offset pushes the
//                      ring outside the host's border box onto its
//                      parent's paint), WCAG 1.4.11 non-text floor (§3.3
//                      `focusRingContrast`, generalized from focus-only to
//                      any rendered ring). design-uplift preset-row
//                      redesign: the 2px accent selection ring that
//                      replaced the old border-drawn check tick.
//   heightPx       -- { value, tolerancePx=1 } OR { comfortable, compact,
//                      tolerancePx=1 }: |getBoundingClientRect().height -
//                      value| <= tolerancePx. Added for popup's `.stag` chip
//                      (D6/D7, Task 5): no prior chip entry (.vocab-group-
//                      chip, .tag-gov-chip-face) needed a literal height,
//                      since their rung was already proven indirectly via
//                      padVMin+padGteRadiusH below -- this is the direct form
//                      for when the checklist wants to assert the number
//                      itself (COMPONENTS.md §5.1's 18px chip rung, "no
//                      border" case), not just its two law components. The
//                      { comfortable, compact } form (Task 3, ui-system-
//                      stage0-design §4) is for the rare control whose target
//                      itself redefines under html[data-density="compact"]
//                      (e.g. #opt-popup-width-custom's --opt-control-h) --
//                      the runner picks the live tier off probeSelector's own
//                      `density` read, same pattern colorSchemeMatchesTheme
//                      uses for raw.rootColorScheme. A bare `value` always
//                      wins when present, so this is opt-in per entry.
//   minHeightPx    -- same two shapes as heightPx, read against the CSS
//                      computed min-height PROPERTY instead of the rendered
//                      box height (Task 3, ui-system-stage0-design §4): the
//                      stage-0 pref-row label is pinned by min-height, so a
//                      wrapped (long) label can still grow past the floor
//                      without failing this the way a literal heightPx
//                      target would.
//   borderTopWidthPx -- { value, tolerancePx=0.5 }: |computed border-top-
//                      width (px) - value| <= tolerancePx (Task 3, ui-
//                      system-stage0-design §4). The stage-0 pref-row
//                      hairline -- a literal 1px `.pref-row + .pref-row`
//                      border-top inside a non-radio .pref-group, never a
//                      density token, so this key never takes the
//                      { comfortable, compact } shape.
//   paddingLeftPx  -- { value, tolerancePx=0.5 } OR { comfortable, compact,
//                      tolerancePx=0.5 } (same two shapes as heightPx above,
//                      Task 3, ui-system-stage3a-design §3): |computed
//                      padding-left (px) - value| <= tolerancePx. Added for
//                      the stage-0 indent mechanism -- `.pref-row-sub`'s
//                      `> label` and `.entry-block-sub` both read the SAME
//                      fixed --opt-sp-7 (24px) in both density tiers (unlike
//                      heightPx's control-height rows, the indent is not a
//                      density token), so every consumer of this key so far
//                      uses the flat `value` shape.
//   widthPx        -- { min?, max?, tolerancePx=0.5 }: getBoundingClientRect()
//                      .width against either or both bounds -- `max` is a
//                      CEILING, not heightPx's target value (`max-width`
//                      never forces a field wider than its container, so the
//                      same field legitimately renders narrower than `max`
//                      on a viewport too small for the cap to engage;
//                      asserting |diff| <= tolerance would wrongly fail that
//                      case); `min` (final fix wave, Ruling 29 F2) is the
//                      mirror-image FLOOR, FAIL not SKIP the same as `max`.
//                      Options field-width-by-kind (T6, taste-uplift-batch3,
//                      D2, COMPONENTS.md §6.1): one representative id per
//                      content kind (select/key-wrap/.fg-url/plain-text/
//                      number), each pinned to that kind's tier from
//                      ui-components.mjs's formRules() (the key-wrap/.fg-url/
//                      plain-text width TIERS -- the legacy 320/420/520
//                      ladder -- were retired in stage 3c; see the
//                      widthLteWith re-pins below. select's own min-240
//                      floor and number's own max-96 cap were never part of
//                      that ladder and are still live).
//   widthLteWith   -- { selector, tolerancePx=0.5 }: this element's
//                      getBoundingClientRect().width <= the comparison
//                      selector's width + tolerancePx. widthPx's `max` is a
//                      literal; this is for a ceiling that is only known at
//                      render time (final fix wave, Ruling 29 F2: the select
//                      tier's "never wider than the field column" half,
//                      where "the column" has no fixed px value). Same
//                      two-selector shape as heightEqWith above, on the
//                      width axis, and sharing its compareSelector probe
//                      slot -- a check declaring both throws SETUP.
//   hitRectMin     -- { height?, width? }: getBoundingClientRect() of THIS
//                      element must be at least these many px on each named
//                      axis -- FAIL, never SKIP, on a zero-size or short
//                      rect. hitAreaMin (family 4) only sweeps buttons; this
//                      is the per-row form for a non-button hit target, first
//                      used for the `.switch` primitive's transparent native
//                      input, which overhangs its 20px row by 2px top and
//                      bottom to reach the 24px floor (COMPONENTS.md §6.1).
//   seedChecked    -- (row-level, not under `expect`) { input, checked }:
//                      the runner sets `document.querySelector(input)
//                      .checked` to this value before the probe (property
//                      write, no change event -> no autosave) and restores
//                      the original value afterwards. Lets one row pin a
//                      checkbox- OR radio-driven state (stage-3b Task 1
//                      widened this from checkbox-only for `.pick`'s
//                      radio-backed mark -- writing `.checked = true` on a
//                      radio input is the same spec-defined DOM side effect
//                      as a real click for the rest of its native `name`
//                      group) such as the `.switch` track's or `.pick`
//                      mark's off/on fill, without depending on the storage
//                      default. state "checked" REQUIRES
//                      seedChecked.checked === true (it is only a distinct
//                      results key for the on state).
//   tab            -- optional (options only): the tab id whose panel owns the
//                      row (e.g. "storage" -> #tab-storage). The runner clicks
//                      it, waits for the selector to attach (JS-built rows),
//                      opens enclosing non-help <details>, then measures.
//                      Absent: the runner derives the tab from the selector
//                      the way it always has. New rows always set it.
//   open           -- (row-level, not under `expect`, used with state: "open",
//                      Task 4, ui-system-stage2, Controller ruling C):
//                      { click: selector }. The runner scripts .focus() onto
//                      `click`'s target then presses a REAL keyboard Space
//                      (page.keyboard.press("Space")) -- not a raw .click() --
//                      so the state this reveals is reached through the
//                      SAME code path a keyboard user's Tab + Space takes
//                      (a `select-only combobox`'s onKeydown " " branch,
//                      listbox.js), a materially different path from
//                      a mouse click listener. Throws a SETUP ERROR if the
//                      target cannot be focused or the press did not flip
//                      its `aria-expanded` to "true". Closed again (Escape)
//                      once the probe has read what it needs, same
//                      leave-no-state-behind discipline as hover's pointer
//                      reset and focusWithin's blur.
//   arrowDown      -- { checked: "<selector>" }: after focusing the row's
//                      radio and a trusted ArrowDown, <selector> must be
//                      checked (state "arrowDown").
//   fontSizePx     -- { value, tolerancePx=0.5 } OR { comfortable, compact,
//                      tolerancePx=0.5 } (same two shapes as heightPx above,
//                      Task 3): |computed font-size (px) - value| <=
//                      tolerancePx. For a typography rule with no geometry
//                      law of its own, e.g. `.stag-num`'s pinned 11px ordinal
//                      (D7), or the stage-0 pref-row's --opt-text-body copy.
//   fontVariantNumericContains -- string: computed `font-variant-numeric`
//                      must contain this token, e.g. "tabular-nums"
//                      (`.stag-num`, D7 -- keeps 1-9 from jittering the
//                      chip's width as Alt+N slots reassign).
//   textDecorationLineContains -- string: computed `text-decoration-line`
//                      must contain this token, e.g. "line-through" (T5 fix
//                      round F6, `.stag.used` -- a struck-through chip, not
//                      just a colour/fill swap).
//   bgEqVar / colorEqVar -- role name (e.g. "chip-bg"/"chip-fg"/
//                      "ai-chip-fg"): the element's computed background-
//                      color / color must equal (±1 per RGB channel,
//                      browser-rounding headroom only) the ACTIVE theme's
//                      live `--{ns}-{role}` token, read the same way
//                      textContrastMulti's extraBgSelectorVar already reads
//                      a token. bgEqVar shares that same background-role
//                      slot (no check sets both it and textContrastMulti);
//                      colorEqVar reads its OWN separate slot, because a
//                      single check legitimately sets BOTH at once against
//                      TWO DIFFERENT tokens (`.stag` below: bgEqVar
//                      "chip-bg" + colorEqVar "chip-fg") -- sharing one slot
//                      between them was tried first and silently made
//                      colorEqVar compare against whichever token bgEqVar
//                      had already claimed (caught live before this shipped).
//                      Distinct from textContrast: that proves the PAIR clears AA;
//                      this proves the fill/text is THIS token specifically,
//                      not a coincidentally-similar colour that happens to
//                      pass. `.stag`/`.stag.ai` (D6/D7, Task 5) are the first
//                      consumers -- chip-bg/chip-fg/ai-chip-fg are all
//                      already contrast-audit-gated token PAIRS, so this
//                      checks token IDENTITY on top of that, render-side.
//   borderColorEqVar -- role name (e.g. "border"): mirrors bgEqVar/colorEqVar,
//                      just against the computed border-color instead of
//                      background-color/color -- the element's border must
//                      equal (±1/channel) the active theme's `--{ns}-{role}`
//                      token. Own probe slot (extraBorderColorVarName), same
//                      reason colorEqVar didn't share bgEqVar's: a check
//                      could legitimately want both bgEqVar and
//                      borderColorEqVar on the same element (a mark's fill
//                      AND its ring) against two different tokens. Compares
//                      the FIRST of the computed top|right|bottom|left
//                      border-color quad (added stage-3b Task 1, `.pick-mark`
//                      -- its border is uniform on every side, so one side
//                      stands in for all four rather than a second raw shape).
//   borderSidesEqVar -- role name: ALL FOUR computed border sides equal the
//                      token and are painted (computed width > 0 -- Chromium
//                      snaps a 1px border to whole device pixels, 0.666667px
//                      on a 1.5-scaled host -- and style not none/hidden;
//                      Chromium keeps the colour of an unpainted side). A
//                      value box paints one frame colour all round in every
//                      state (stage 4, spec 2026-09-30-ui-fields-stage4-
//                      design §2.1: no bottom edge), so a side-only repaint
//                      or unpaint cannot hide behind a correct top side.
//                      Shares borderColorEqVar's probe slot -- a row may not
//                      set both (SETUP ERROR).
//
// weakTextOnFill (family 13, weak-text-on-fill batch T5, COMPONENTS.md
// §9.1 law 8): no CHECKS entries carry this key -- like hitAreaMin (family
// 4) and families 5-12, the runner class-scans instead of taking a hand-
// enumerated selector list, so a new consumer is covered automatically
// rather than needing a row added here. Unlike families 4-12 (theme-
// invariant geometry, one sweep pass), this one IS per-theme: colour tokens
// vary by theme, so scripts/ui-render-audit.mjs's weakTextProbe runs once
// per (surface, theme) from inside the CHECKS loop's already-open page
// (recordWeakTextHits' call sites in runSimpleTheme/runLibraryTheme) rather
// than a second whole-matrix navigation pass.
//   SCOPE: every element with a direct (own, non-descendant) text node, plus
//     every icon-only button/`.btn`/`a.btn` (an SVG icon has no colour of
//     its own -- it inherits `color` via `stroke="currentColor"`, so the
//     host's computed `color` is what a text check would read anyway).
//     computed `color` is compared against the ACTIVE theme's live
//     `--{ns}-fg-hint` / `--{ns}-fg-muted` / `--{ns}-link` values (never a
//     CSS-source literal); if it matches one of those TEXT roles, the
//     nearest non-transparent `background-color` walking from the element
//     itself up through its ancestors (some consumers, e.g. `.md-strip-btn`,
//     paint their own background; others, e.g. `.connection-health-state`,
//     inherit it from a parent) is compared against the same theme's live
//     `--{ns}-btn-bg` / `--{ns}-btn-hover` / `--{ns}-input-bg` /
//     `--{ns}-chip-bg` -- and, library only, its seven S2 row fills
//     (`--lib-row-bg-hover` … `--lib-row-band-current-bg-hover`), live
//     tokens like the rest. A match on both sides is a FAIL.
//   REST STATE ONLY -- hover is explicitly OUT of scope. This family covers
//     the cascade shape a static same-selector scan (tests/ui-contract-
//     tests.mjs) structurally cannot see (colour on one rule, the fill on an
//     ancestor rule), not every state a control can be in; hover's token-
//     side coverage is contrast-audit's `btn-fg-muted vs btn-hover` / `fg vs
//     btn-hover` rows, which gate the ROLE regardless of which selector
//     paints it.
//   COVERAGE (T5 fix wave, F5a/F5b): this family runs its OWN activation
//     loop, not just whatever CHECKS groups happen to open for other
//     reasons. options: all 13 tab panels (every `.panel`, `.panel{display:
//     none}` in options.css means 12 of them are otherwise never scanned),
//     every non-help `<details>` inside the active panel, the appearance
//     tab's preset-preview section, its theme-name popover
//     (`#save-custom-theme` -> `.theme-name-popover`) and a confirm popover
//     (`.saved-theme-del` -> `.confirm-popover`), and the Account tab's
//     Connection Status disclosure. popup: the rest state, the 11 hidden-
//     by-default legs scripts/ui-render-audit.mjs's runSweep already knows
//     how to reveal (existing-banner/url-warning/url-clean-hint/presets-row/
//     suggest-row/ai-error-card/ai-error-fallback/batch-permission/batch-
//     progress/md-actions-strip/offline-queue-list, plus the offline-queue
//     rows themselves), and the confirm popover. library: vocab rest state,
//     the vocab batch-selected band, the notes batch-selected band (each
//     opener is fail-CLOSED -- a missing target throws SETUP rather than
//     silently scanning the wrong state). options' and library's panel/leg
//     openers all throw `SETUP: ...` on a missing target instead of
//     silently skipping (a shape a future selector rename could otherwise
//     turn into a silent "0 FAIL"). popup's legs instead `console.warn`:
//     ten of the eleven hidden-leg ids are static popup.html markup
//     (always present, just CSS-hidden, so a missing target there can't
//     actually happen), and the eleventh -- the offline-queue ROWS, the
//     one leg actually built at runtime from seeded data -- warns when it
//     fails to render, mirroring runSweep's own warn for the identical
//     condition. scripts/ui-render-audit.mjs prints scanned counts per
//     (surface, theme, context) either way, so "0 FAIL" can be told apart
//     from "never opened".
//   EXEMPTIONS -- every class is a TRIGGER, not an automatic drop: a hit is
//     only exempted once the REAL painted ratio between the scanned colour
//     and the resolved fill (reusing contrast-audit.mjs's own `cr`) clears
//     4.5:1 for text or 3:1 for an icon-only affordance (the same floor
//     COMPONENTS.md §9.1 uses for icons). A trigger that fails its ratio is
//     still reported, annotated `[was-exempt-by ...]` so the near-miss is
//     visible rather than looking like a plain scan miss.
//     - `:disabled` (WCAG 1.4.3) -- the ONLY unconditional exemption, no
//       ratio gate: checked via the live `disabled` IDL property walked up
//       the ancestor chain, never by matching ":disabled" in a selector
//       string, so a scratch selector like `.x:not(:disabled)` or
//       `.x:disabled ~ .y` can't be mistaken for the real exemption (tests/
//       ui-contract-tests.mjs tightened the analogous static-scan exemption
//       to the same rule, Ruling 16).
//     - identity -- the scanned colour ALSO equals one of the tokens
//       COMPONENTS.md §9.1 law 8 itself sanctions as text-on-fill: `fg`,
//       `btn-fg`, `btn-fg-muted`, and (library only) `--lib-row-selected-fg` /
//       `--lib-row-current-fg-muted`.
//       Every matching role name is recorded (not first-match-wins) so a
//       collapse across more than one sanctioned token is labelled
//       correctly.
//     - selection-marker -- the scanned colour equals `accent` AND the
//       element carries a selection-state marker (`aria-pressed="true"`,
//       `aria-selected="true"`, `aria-current`, `.active`, `.selected`):
//       accent painted on a pressed/selected control, not hint/muted/link
//       misuse (library's pressed sort-seg cell is the reviewed, accepted
//       instance of this shape).
//     - safe-host -- the resolved fill is EXACTLY (no tolerance) one of the
//       page-level surfaces fg-hint/fg-muted are independently guaranteed
//       AA against on every themed block (contrast-audit.mjs's
//       auditCssThemes/auditLibraryThemes): `bg`, `bg2`/`panel`, and, on
//       options only, `pf-bg`/`code-bg` (D5) and, on popup only,
//       `drop-hover` (options never declares `--opt-drop-hover`, so that
//       role is not in its safe-host list at all). `link` is EXCLUDED from
//       this exemption on popup/options -- neither surface has a "link vs
//       <host>" row in contrast-audit.mjs, so there is no guarantee to fall
//       back on; library keeps `link` eligible because its "link vs bg"/
//       "link vs panel" rows genuinely cover it.
//   OUT OF SCOPE (T5 fix wave, F5c -- not silently missed, deliberately not
//     modelled): background-image/gradient fills; `::before`/`::after`
//     fills; `::placeholder` text; alpha compositing (`parseColor` discards
//     alpha -- a semi-transparent fill or text colour is not resolved
//     against its true composited result); icon-only `<a>`/`<summary>`
//     (the icon-only scan is scoped to `button, [role='button'], .btn,
//     a.btn`) and icons inside a button that ALSO carries its own label
//     text (the icon's colour is not independently probed there); any
//     `color-mix()` fill other than library's two batch-selection bands.
//   Options' target role set is fg-hint/fg-muted/link only -- COMPONENTS.md
//     §9.1 law 8 does not name a fourth "fg-dim" role, and `--opt-fg-dim`
//     was itself retired before this batch (taste-uplift batch2 Task 5); the
//     plan's D4 mention of it does not correspond to a live token.
//
// Media-preference coverage stays in this hand-written oracle for the same
// reason as CHECKS: deriving the selectors from the generated CSS would let
// a broken recipe redefine its own expected output. The runner crosses the
// four representative theme states below with both scenarios and all three
// surfaces, then asks evaluateMediaProbe() to fail closed on observable
// outcomes. It deliberately does not require author colours to survive
// forced-colors; the browser is expected to replace them with system colours.
export const MEDIA_THEMES = ["", "github-light", "terminal", "flexoki-dark"];

export const MEDIA_SCENARIOS = [
  {
    id: "forced-colors",
    query: "(forced-colors: active)",
    features: [{ name: "forced-colors", value: "active" }],
  },
  {
    id: "more-contrast",
    query: "(prefers-contrast: more)",
    features: [{ name: "prefers-contrast", value: "more" }],
  },
];

export const MEDIA_CHECKS = [
  {
    surface: "popup",
    text: "#submit-btn",
    control: "#submit-btn",
    focus: "#submit-btn",
    selected: null,
    minTextContrast: 4.5,
  },
  {
    surface: "options",
    text: "#tab-general",
    control: "#tab-general",
    focus: "#tab-general",
    selected: "#tab-general",
    unselected: "#tab-popup",
    minTextContrast: 4.5,
  },
  {
    surface: "library",
    text: "#vocab-list .notes-card-head",
    control: "#vocab-search",
    focus: "#vocab-search",
    selected: "#lib-tab-vocab",
    unselected: "#lib-tab-notes",
    minTextContrast: 4.5,
  },
];

export function evaluateMediaProbe(probe, check) {
  const failures = [];
  const fail = (name, actual, expected, note) => failures.push({
    check: name,
    status: "FAIL",
    actual,
    expected,
    note: note || null,
  });

  if (probe?.queryMatches !== true) {
    fail("mediaQuery", probe?.queryMatches ?? null, true, "emulated media query did not match");
  }

  const textVisible = probe?.text?.found === true && probe.text.visible === true;
  if (!textVisible) {
    fail("textVisible", textVisible, true, `critical text not visible: ${check.text}`);
  } else {
    const minimum = check.minTextContrast ?? 4.5;
    const contrast = probe.text.contrast;
    if (!Number.isFinite(contrast) || contrast < minimum) {
      fail("textContrast", Number.isFinite(contrast) ? contrast : null, minimum, `critical text loses contrast: ${check.text}`);
    }
  }

  const controlVisible = probe?.control?.found === true && probe.control.visible === true;
  if (!controlVisible) {
    fail("controlVisible", controlVisible, true, `critical control not visible: ${check.control}`);
  }

  const focusVisible = probe?.focus?.found === true && probe.focus.visible === true;
  const focusCue = focusVisible && probe.focus.active === true && probe.focus.cue === true;
  if (!focusCue) {
    fail("focusCue", focusCue, true, `focus indicator is missing or only changes colour: ${check.focus}`);
  }

  if (check.selected) {
    const selectedVisible = probe?.selected?.found === true && probe.selected.visible === true;
    const selectedCue = selectedVisible && probe.selected.selected === true && probe.selected.cue === true;
    if (!selectedCue) {
      fail("selectedCue", selectedCue, true, `selected state lacks semantics or a structural marker: ${check.selected}`);
    } else if (check.unselected) {
      // The marker has to be the selected element's own: an unselected
      // sibling showing a line on every one of the same carriers (outline,
      // shadow or border side, in a colour that stands off its backdrop)
      // leaves nothing that tells the two apart.
      const sibling = probe?.unselected;
      const siblingOk = sibling?.found === true && sibling.visible === true && sibling.selected === false;
      const own = (probe.selected.carriers || []).filter((c) => !(sibling?.carriers || []).includes(c));
      if (!siblingOk || own.length === 0) {
        fail("selectedCue", siblingOk ? (sibling.carriers || []).join(" ") : "unselected sibling missing", "a carrier the unselected sibling lacks",
          `every structural marker of ${check.selected} is also on unselected ${check.unselected}`);
      }
    }
  }

  return failures;
}

// Selectors below are written against the CURRENT shipped markup (pre-Task
// 9/10 uplift). Task 9/10/12/13 migrate one selector's underlying CSS at a
// time and delete the matching known-failures key as they land -- this file
// itself does not change shape when that happens, only known-failures does.

export const CHECKS = [
  // ---- defect 1/4: .btn declares no `color`; text + currentColor icon fall
  // to the UA ButtonText system color instead of a themed, AA-derived value.
  // library has zero `html[data-theme] .btn` override so ALL 13 presets +
  // the default state are exposed (COMPONENTS.md §1.3). Since T7 the
  // instance is the dictionary column's md "Look up" button (text only);
  // T7b adds .vocab-detail-status for the icon half. ----
  { surface: "library", page: "library.html", selector: "#vocab-lookup-go", state: "default",
    expect: { textContrast: 4.5 } },

  // ---- COMPONENTS.md §9 law 3 (Soft Fill, inset selection). Both of
  // library's lists paint a hover/selected band; before the uplift the
  // vocabulary one had NEITHER a radius nor an inset (a selected row ran
  // edge to edge and its corners cut the list container's own), and the
  // notes one had the radius but no inset. Written per LIST because the two
  // paint on different elements -- .vocab-card delegates its band to the
  // .notes-card-top child, .notes-hit owns its own -- so a single shared
  // selector could not reach both, and a regression in either list has to
  // fail on its own key rather than hiding behind the other. 4px is the
  // shipped inset; the check reads the band element's own margin, so it
  // measures what is painted rather than what the stylesheet says. ----
  { surface: "library", page: "library.html", selector: ".vocab-card .notes-card-top", state: "default",
    expect: { insetBand: { minInsetPx: 4, blockInsetPx: 2, radiusVar: "radius-md" } } },
  { surface: "library", page: "library.html", selector: ".notes-hit", state: "default",
    expect: { insetBand: { minInsetPx: 4, blockInsetPx: 2, radiusVar: "radius-md" } } },

  // ---- Row states, S2 (USER RULING 2026-10-03; spec 2026-10-03-library-
  // redesign §3.8 / §9.3; earlier: 2026-08-06 selection rebuild). Eight
  // states per list, driven on ONE row with the real gestures (Ctrl+click,
  // click, hover) and read with the pointer parked in the detail pane:
  // rest / hover / current / current+hover carry no marker, the four
  // selected states carry the same 1px ring, so inside each group the FILL
  // is the only separator -- the runner already demands >= minDelta for any
  // same-marker pair. fillOnlyPairs switches the marker escape hatch off for
  // the pairs the ruling names ("the fill IS the signal"), so a marker added
  // back later cannot stand in for a fill. stepPairs are one row's own hover
  // steps: same marker, legitimately < 24, gated >= minStep instead. Every
  // state's painted fill must equal its derived token (runner
  // ROW_STATE_TOKENS) -- the derivation is gated in theme-ui-derive-tests,
  // this proves the page reads it. textSelectors measures every text a row
  // carries (title, secondary text) against its own band in all eight states.
  { surface: "library", page: "library.html", selector: "#vocab-list .vocab-card .notes-card-top", state: "rowStates",
    expect: { bandDistinct: { minDelta: 24, minTextContrast: 4.5,
      textSelectors: [".notes-card-head", ".vocab-row-gloss", ".notes-row-meta"],
      fillOnlyPairs: [["rest", "selected"], ["rest", "current"], ["hover", "current"], ["selected", "selected+current"], ["selected+hover", "selected+current"]],
      stepPairs: [["rest", "hover"], ["current", "current+hover"], ["selected", "selected+hover"], ["selected+current", "selected+current+hover"]],
      minStep: 8 } } },
  // The notes list paints on .notes-hit-btn, not on a child row, so it gets its own entry; same eight states and floors.
  { surface: "library", page: "library.html", selector: ".notes-hit .notes-hit-btn", state: "rowStates",
    expect: { bandDistinct: { minDelta: 24, minTextContrast: 4.5,
      textSelectors: [".notes-hit-text", ".notes-hit-note", ".notes-hit-meta"],
      fillOnlyPairs: [["rest", "selected"], ["rest", "current"], ["hover", "current"], ["selected", "selected+current"], ["selected+hover", "selected+current"]],
      stepPairs: [["rest", "hover"], ["current", "current+hover"], ["selected", "selected+hover"], ["selected+current", "selected+current+hover"]],
      minStep: 8 } } },

  // ---- List header, round 2 (user ruling 2026-08-07). Four bare rows, and
  // the one thing that has to hold for all of them is that they run the full
  // width of the list column and end flush with their own last control. The
  // version this replaced failed both ways at once: the filter controls were
  // wrapped in a single non-shrinking flex unit that could only fit whole or
  // drop whole, and the count row handed its slack to an EMPTY status span's
  // `margin-left: auto`, leaving "Select all" stranded mid-row.
  //
  // Two measurements per row, because neither implies the other -- a row can
  // be full width and still end 40px short of its last control, and it can hug
  // its contents while being narrower than the column. Widths bracket the
  // single-pane threshold on both sides so a row that only breaks in one
  // column width cannot hide.
  { surface: "library", page: "library.html", selector: ".vocab-list-pane", state: "headerRowsFlush",
    expect: { headerRowsFlush: { widths: [2560, 1680, 1100, 800], tolerancePx: 1, columnSel: ".vocab-list-pane",
      rows: [".vocab-filter-toolbar", ".vocab-filter-row", ".vocab-context-bar", "#vocab-batch-toolbar"],
      // The batch row replaces the count row in place (spec §3.9). The pair
      // is [rest, open]: the runner sweeps every width twice, at rest (count
      // row must render and be flush, batch row must not render) and with a
      // selection made through `toggle` (the other way round), so both rows
      // are measured and neither can hide behind the other.
      exclusive: [[".vocab-context-bar", "#vocab-batch-toolbar"]], toggle: "vocabSelection",
      mayVanish: [] } } },

  // ---- 2026-08-06 narrow-width overflow report: `a.notes-row-open` ran 351px
  // past the vocabulary detail pane's right edge at a 900px viewport and
  // handed the pane a 327px horizontal scroll. Root cause was a bare inline
  // <a> whose max-width / overflow / text-overflow are inert per CSS 2.1
  // while its inherited white-space: nowrap is not -- so the rule read as
  // "clip this" and the browser painted one unbreakable full-width line.
  //
  // The gate is a CLASS SCAN, not a list of the selectors that were caught:
  // an enumerated probe only ever covers what someone already thought of, and
  // this defect was in an element nobody had thought about since the class
  // stopped being used on the notes ROW it was sized for. The widths bracket
  // the 860px narrow-mode threshold on the wide side (the two-pane layout is
  // where a pane can be too small for its contents) up to the point where the
  // reading column stops shrinking. Both panes of the view are scanned in one
  // pass, so a fix that just moves the overflow from the list to the detail
  // still fails. `expected` is 0 -- nothing may escape a pane, ever.
  { surface: "library", page: "library.html", selector: ".vocab-list-pane", state: "paneFit",
    expect: { paneFit: { widths: [420, 861, 1280, 1600, 2560], tolerancePx: 1, bleed: [".vocab-list-region"],
      panes: [".vocab-list-pane", "#vocab-detail-pane"] } } },
  { surface: "library", page: "library.html", selector: ".notes-list-pane", state: "paneFit",
    expect: { paneFit: { widths: [420, 861, 1280, 1600, 2560], tolerancePx: 1, bleed: [".notes-list-region"],
      panes: [".notes-list-pane", "#notes-detail-pane"] } } },
  // ---- T8e notes detail (spec 2026-10-03-library-redesign §9.2 G4 / G5, notes
  // half). Selector .notes-sheet routes them to the notes view without the
  // group-level detail open (no "-detail-"): each driver opens its own seeded
  // scenario (LIB_SEED) -- G4 and paneFit on the shared page, putting the
  // previous selection back afterwards; G5 in a scratch page of its own.
  // G4: T7b's driver and scan (LIB_INK_VIEWS.notes): every first-line display
  // text's INK top stays inside the detail pane (canvas measureText ascent over
  // the DOM baseline -- not Range rects, which return the ascent+descent box),
  // plus T7b's screenshot cross-check with the pane switched to overflow:
  // visible, plus the cover title's size (the .lib-cover family's tiers).
  // G5: where the columns land in each notes tier, named by its container
  // width C and kept >= 40px off every tier edge (T8f: 1000 hang column,
  // 1312 "this page" column beside the full 800 excerpt column): 2560 -> C
  // ~1873 and 1920 -> ~1361 (column, 420 / ~385 wide), 1600 -> ~1113 (hang
  // column only), 1280 -> ~793 (one column), DPR 1. Every page keeps 48 from
  // its head to the first excerpt -- the single-highlight page too, where a
  // "this page" column taller than its rows could push the excerpt down.
  // The column widths asserted here follow from C alone; the three locales
  // (en, de, fr -- fr's delete is what sets the column's 336 minimum) only
  // change how TALL the "this page" column is, i.e. the 48 check above.
  // Labels against their quotes are hangOrder's (T8f).
  { surface: "library", page: "library.html", selector: ".notes-sheet", state: "displayInkTop", themes: ["", "terminal"],
    expect: { displayInkTop: { view: "notes", sizes: [[2560, 1300], [1280, 800]], cases: ["notes-cover", "notes-solo", "notes-diacritic", "notes-multi"],
      coverPx: { 2560: 72, 1280: 44 } } } },
  // G4 by glyph class (final review #10 / #5): the cases above cover a CJK
  // title (not pulled up), a Latin title (pulled up) and a Latin title whose
  // capital carries a diacritic (É, the ink the half-leading pull-up has to
  // leave room for). The column titles are UI copy, so their CJK case is a
  // zh_CN interface: at 2560 the notes sheet shows the "这一页" column and
  // the vocabulary sheet the "词典" column, both first-line titles.
  { surface: "library", page: "library.html", selector: ".notes-sheet", state: "displayInkTop", themes: [""],
    expect: { displayInkTop: { view: "notes", locale: "zh_CN", sizes: [[2560, 1300]], cases: ["notes-multi", "notes-diacritic"] } } },
  { surface: "library", page: "library.html", selector: ".notes-sheet", state: "libGeometry", themes: ["", "flexoki-dark", "terminal"],
    expect: { libGeometry: { view: "notes", scenarios: ["notes-multi", "notes-solo"], locales: ["en", "de", "fr"],
      viewports: [
        { width: 2560, height: 1300, tier: "side", containerPx: [1352, 4000] },
        { width: 1920, height: 1080, tier: "side", containerPx: [1352, 4000] },
        { width: 1600, height: 900, tier: "hang", containerPx: [1040, 1272] },
        { width: 1280, height: 800, tier: "single", containerPx: [0, 960] },
      ],
      hangPx: 112, excerptMaxPx: 800, sideGapPx: 64, sideMinPx: 336, sideMaxPx: 420,
      headToFirstExcerptPx: 48, currentPx: 26, otherPx: 18, tolerancePx: 1 } } },
  // paneFit over the notes MULTI-highlight state (spec §9.2 checklist :716-721:
  // panes cover the notes multi state): nothing in the excerpt flow or the
  // "this page" column may escape the pane at any width.
  { surface: "library", page: "library.html", selector: ".notes-sheet", state: "paneFit",
    expect: { paneFit: { widths: [420, 861, 1280, 1600, 2560], tolerancePx: 1, panes: ["#notes-detail-pane"], notesScenario: "notes-multi" } } },
  // Separate entry, NOT folded into the one above (debt-sweep 2026-08-07):
  // headerRowsFlush only proves "flush single line" >=860px, where the
  // single-pane threshold guarantees room for one. Below it wrapping is
  // explicitly ALLOWED (the F5 fix, 473f324, gave .vocab-filter-row
  // `flex-wrap: wrap` there) -- what still must never happen is the row
  // pushing content past the pane's own box or forcing the pane itself to
  // scroll horizontally, which is exactly what paneFit already measures
  // (pastRightEdge / pastLeftEdge / paneScroll) for every element inside the
  // pane, not just the four named header rows. F5 itself (93px overflow at
  // 320, 53px at 360, caught only because the responsive fixture was for
  // once aligned to real markup) is the simplest counter-example this
  // closes: reintroduce `flex-wrap: nowrap` on `.vocab-filter-row` and
  // paneScroll fires at both widths. `#vocab-detail-pane` is deliberately
  // EXCLUDED from this entry's `panes` (unlike the one above): this is
  // specifically the list-pane's OWN narrow-wrap contract, and needs
  // `resetNarrowDetail` so it measures the list actually showing (see that
  // flag's comment in drivePaneFit) rather than whatever `-detail-` check
  // ran earlier in the same theme's batch and left `body.lib-narrow-detail`
  // set -- the detail pane's OWN narrow-width behavior is a separate,
  // unexamined question this entry does not answer.
  // Selector deliberately distinct from the entry above ("(narrow)" suffix,
  // not a real CSS selector) -- both are state:"paneFit" against the same
  // element, and every paneFit result reports through the SAME literal
  // check-type string ("paneFit", hardcoded in runOneCheck), so surface +
  // theme + selector + state is the only thing keyOf() has left to tell two
  // entries apart. An identical selector here would silently collide known-
  // failures keys with the entry above.
  { surface: "library", page: "library.html", selector: ".vocab-list-pane (narrow)", state: "paneFit",
    expect: { paneFit: { widths: [320, 360], tolerancePx: 1, resetNarrowDetail: true, bleed: [".vocab-list-region"], panes: [".vocab-list-pane"] } } },
  // ---- Library redesign 2026-10-03 §9.2 G1 (plan T3): the page itself never
  // scrolls. Each tab has two scroll containers (the list region and the
  // detail pane); at every width, in both views, with the detail closed and
  // open, the html element fits the window and no scroll container scrolls
  // sideways. The same state drives the narrow list -> detail -> back round
  // trip (spec §12 T3: the list keeps its place).
  { surface: "library", page: "library.html", selector: "html (noPageScroll)", state: "noPageScroll", themes: ["", "terminal"],
    expect: { noPageScroll: { widths: [420, 861, 1280, 1920, 2560], height: 900, tolerancePx: 1 } } },
  // ---- §9.2 G6 (plan T3): a filter starts its list again from the top. T3
  // covers the search box, the group filter and the notes filter; T4 appends
  // "status" and "color", T6 appends "sort" (same entry, longer `inputs`).
  { surface: "library", page: "library.html", selector: "#vocab-search (filterScrollReset)", state: "filterScrollReset", themes: ["", "terminal"],
    expect: { filterScrollReset: { inputs: ["search", "group", "sort", "notesFilter"], viewport: [1280, 700], probeOffset: 200 } } },
  // ---- §9.2 G5, the axis subset (plan T3, Review Focus 1): the search box
  // at P, the detail axis at P + L + G, the row fill on the index column --
  // at 2560x1300 and 1280x800, at DPR 1 and 1.5 with a 17px scrollbar, and
  // after --lib-sb-w is knocked out and re-measured (re-theme / resize).
  // T7 / T8 add the rest of G5 (head sizes, the reference column, the page
  // side column) as their own states.
  { surface: "library", page: "library.html", selector: "#vocab-search (libAxis)", state: "libAxis", themes: ["", "terminal"],
    expect: { libAxis: { sizes: [[2560, 1300], [1280, 800]], tolerancePx: 1, scrollbarPx: 17 } } },
  // followup3's "not fused into a third cell" ruling for the narrow-screen
  // lookup door (library.css ".vocab-filter-row > .vocab-lookup-narrow")
  // never had a gate (debt-sweep 2026-08-07). 500px: comfortably inside the
  // <860px band where the door is display:inline-flex, and measured (this
  // task) to keep the sort menu button and door on one flex line without
  // wrapping at every width down to 320 -- 500 is not a magic number, just a
  // representative point in that always-one-line range.
  { surface: "library", page: "library.html", selector: ".vocab-filter-row", state: "gapMin",
    expect: { gapMin: { width: 500, fromSel: "#vocab-sort-btn", toSel: ".vocab-lookup-narrow", min: 12 } } },

  // ---- COMPONENTS.md §9 law 7 (real tabs). The header's two tabs used to be
  // buttons in tab clothing -- fill, border, radius-md -- which is what the
  // user called out on the grid. Both states are reachable in the default
  // state (vocabulary is selected on load), so no focus/hover plumbing is
  // needed; two selectors, because "selected" and "unselected" assert
  // opposite things about the underline and the same thing about the shell.
  // insetBand's radiusVar has no counterpart here on purpose: a tab's correct
  // radius is 0, and tabChrome checks that directly. ----
  { surface: "library", page: "library.html", selector: ".lib-tab.active", state: "default",
    expect: { tabChrome: { activeUnderline: true, underlinePx: 2 }, textContrast: 4.5 } },
  { surface: "library", page: "library.html", selector: ".lib-tab:not(.active)", state: "default",
    expect: { tabChrome: { activeUnderline: false }, textContrast: 4.5 } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-delete", state: "default",
    expect: { textContrast: 4.5, iconContrast: 3, iconVCenter: 1 } },   // also defect 5
  // Two page deletes from T8d on ("this page" column + footer, spec §5.1 I4);
  // the runner's 1280 viewport is C < 1312, where the footer copy is the one
  // displayed -- a bare .notes-detail-delete would select the hidden column copy.
  { surface: "library", page: "library.html", selector: ".notes-detail-footer > .notes-detail-delete", state: "default",
    expect: { textContrast: 4.5 } },

  // ---- defect 6: quiet-tier danger (COMPONENTS.md §4.4 `dangerQuietContrast`
  // -- "hover 态同测"). .vocab-detail-delete/.notes-detail-delete are both
  // `.btn.danger` instances (library-vocab.js:513 / library-notes.js:405);
  // their RESTING textContrast is already covered by the two default-state
  // entries above. This is the hover half: `.btn.danger:hover:not(:disabled)`
  // repaints `background` to `color-mix(danger 8%, btn-bg)` -- a real
  // background change, not just a color-blind pseudo-class toggle -- so
  // danger-quiet-fg's AA margin has to survive that tint too, not just the
  // resting btn-bg it was solved against (Task 5's "hover 底 ... 混入比例
  // ≤10%, 使被审计的配对仍具代表性" tolerance). Uses the `state: "hover"`
  // vocabulary scripts/ui-render-audit.mjs's runOneCheck() drives with a
  // real Playwright page.hover() (dispatches actual pointer events, so the
  // live cascade's own `:hover` match produces the getComputedStyle read --
  // not a class-toggle stand-in). ----
  { surface: "library", page: "library.html", selector: ".vocab-detail-delete", state: "hover",
    expect: { textContrast: 4.5 } },
  { surface: "library", page: "library.html", selector: ".notes-detail-footer > .notes-detail-delete", state: "hover",
    expect: { textContrast: 4.5 } },

  // ---- primary tier (COMPONENTS.md §1.2, Task 4 taste-uplift-batch2):
  // `.btn.primary` is the one committing action of a flow -- library's only
  // instance is `.vocab-note-save` (library-vocab.js). Same "default AND
  // hover" shape as the danger-quiet pair just above, for the same reason:
  // `.btn.primary:hover:not(:disabled)` repaints `background` to
  // `color-mix(in srgb, accent 88%, fg)`, a real fill change, so on-accent's
  // AA margin has to survive that tint too, not just the resting accent fill
  // it was solved against.
  //
  // Options' primary instance, `#backup-import-apply`, is NOT used here: it
  // stays `disabled` until a real backup file has been picked and its
  // preview parsed (options-backup.js), and sits inside
  // `#backup-import-preview[hidden]` until then -- reaching it live would
  // mean driving a full JSON-backup-import round trip through this harness,
  // not a cheap DOM reveal. library's `.vocab-note-save` is used as the
  // audited primary instance instead (sanctioned fallback, task-4-brief.md
  // Step 2); `:disabled` is exempt from textContrast (§3.4) so
  // `#backup-import-apply` not being probed here is not a coverage gap on
  // that axis either way.
  //
  // The selector is compound (`.vocab-detail-footer .vocab-note-save`, not
  // the bare class) for the same reason `.vocab-detail-pane .vocab-group-unit`
  // is above: `.vocab-note-save`'s own class carries no "-detail-" substring,
  // so scripts/ui-render-audit.mjs's needsDetailOpen() would not open the
  // detail pane for it on the selector string alone. `.vocab-note-save`
  // ALSO starts `hidden` (visibility, not display -- library.css) until the
  // note textarea's value diverges from the word's saved note; the runner's
  // needsNoteDirty() reveal step types into `.vocab-note-input` (the same
  // `input` event a real user's keystroke fires) right after the detail pane
  // opens, which is what actually flips `.vocab-note-save`'s `hidden` off. ----
  { surface: "library", page: "library.html", selector: ".vocab-detail-footer .vocab-note-save", state: "default",
    expect: { textContrast: 4.5 } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-footer .vocab-note-save", state: "hover",
    expect: { textContrast: 4.5 } },

  // options has a themed-state override (options.css:1244) that patches
  // every preset -- but the DEFAULT (no-preset) state ALSO passes today,
  // for an unrelated reason: options.css sets `:root { color-scheme: light }`
  // (library has no such declaration -- exactly why library's copy of this
  // bug IS visible and this one mostly isn't), which forces UA ButtonText
  // to resolve near-black unconditionally, and the default background is
  // light, so black-on-light clears AA by coincidence. Measured:
  // `color: rgb(0,0,0)` on `rgb(245,245,240)`, ~19:1, every theme, verified.
  // This entry is a confirmed TRUE NEGATIVE today, not a script bug -- it
  // stays as a regression guard: if Task 9 deletes the html[data-theme]
  // override without adding `color: var(--opt-btn-fg)` in the same commit,
  // themed states go dark and this check starts failing (§1.3).
  { surface: "options", page: "options.html", selector: ".btn", state: "default",
    expect: { textContrast: 4.5 } },

  // Save feedback now lives on the panel-colored persistent footer.
  { surface: "options", page: "options.html", selector: "#auto-save-status", state: "default",
    expect: { textContrast: 4.5 } },
  { surface: "options", page: "options.html", selector: "#auto-save-status", state: "classState", addClass: ["saved"],
    expect: { textContrast: 4.5 } },

  // Context help is intentionally quieter than an ordinary ghost action:
  // the 24px hit target remains, while hover is communicated by glyph
  // color/opacity rather than exposing the whole target as a filled button.
  { surface: "options", page: "options.html", selector: ".context-help > summary.context-help-toggle", state: "hover",
    expect: { backgroundAlphaMax: 0 } },

  // ---- defect 3: .vocab-group-chip is `padding: 0 4px` on a `radius-full`
  // pill -- both pill laws violated (COMPONENTS.md §5.1, §5.4). (re-pointed
  // T4d: list rows show groups as plain text now; the chip family lives on in
  // the detail pane) The read-only list pill this row used to measure is
  // gone; every remaining group chip is `.removable`, whose trailing 4px pad
  // seats the x concentric with the end cap -- so law 2 is held on the
  // leading (text) side, where the label meets the curve. ----
  { surface: "library", page: "library.html", selector: ".vocab-detail-group-chips .vocab-group-chip.removable", state: "default",
    expect: { textContrast: 4.5, padGteRadiusH: "start", padVMin: 2 } },
  // ---- options' chip-family target (COMPONENTS.md §5.2 `selectable`). The
  // review-queue redesign (2026-09) retired .tag-gov-kind-badge -- the kind is
  // plain text now -- and the tags themselves became the chips. Needs the
  // "tags" tab active AND a seeded plural pair (book/books) before a group
  // row exists to probe; see runSimpleTheme's options-specific branch and the
  // cached_user_tags seed in main(). Two rows because the two looks consume
  // DIFFERENT colour pairs: resting is btn-fg/btn-bg (the audited Soft Fill
  // control pair -- a fg-tint-of-panel fill was tried first and fell to
  // 4.39:1 on solarized-dark, since that theme's base fg/panel margin is only
  // 4.86:1 and any further fg-tint erodes it below 4.5), checked is
  // chip-fg/chip-bg. ----
  { surface: "options", page: "options.html", selector: ".tag-gov-chip > input:not(:checked) + .tag-gov-chip-face", state: "default",
    expect: { textContrast: 4.5, padGteRadiusH: true, padVMin: 2 } },
  { surface: "options", page: "options.html", selector: ".tag-gov-chip > input:checked + .tag-gov-chip-face", state: "default",
    expect: { textContrast: 4.5, padGteRadiusH: true, padVMin: 2 } },
  // The count inherits its face's own color (see .tag-gov-chip-count in
  // options.css) rather than fg-muted, so it shares whichever pair above
  // applies to its state -- no separate unaudited pair to probe here.
  { surface: "options", page: "options.html", selector: ".tag-gov-chip > input:not(:checked) + .tag-gov-chip-face > .tag-gov-chip-count", state: "default",
    expect: { textContrast: 4.5 } },
  // Tonal merge button: chip-fg/chip-bg at rest, chip-fg/btn-hover on hover.
  { surface: "options", page: "options.html", selector: ".tag-gov-group-row .btn.tonal", state: "default",
    expect: { textContrast: 4.5 } },
  { surface: "options", page: "options.html", selector: ".tag-gov-group-row .btn.tonal", state: "hover",
    expect: { textContrast: 4.5 } },
  // ---- Ruling 8: #tag-gov-lowcount-list's own checkbox chips (renderLowCountTags,
  // "Low-count tags" disclosure). Same .tag-gov-chip primitive as the group-row
  // chips just above, but a DIFFERENT DOM branch never seeded (the seed's plural
  // pair never has count<=1) and never opened before this -- the checklist rows
  // above never exercised it, and neither did --sweep's own click-every-tab pass,
  // because the disclosure it opens generically had nothing but the empty state
  // inside. See main()'s cached_user_tags seed (misc/wip) and the "tags" tab
  // setup above (clicks #tag-gov-lowcount > summary before this group runs).
  // Unchecked only: every low-count chip starts and stays unchecked until a
  // reader clicks one, same as the group-row's own unchecked-state entry above. ----
  { surface: "options", page: "options.html", selector: "#tag-gov-lowcount-list .tag-gov-chip > input:not(:checked) + .tag-gov-chip-face", state: "default",
    expect: { textContrast: 4.5, padGteRadiusH: true, padVMin: 2 } },
  // "N selected" (options.js's pbpSyncTagGovDeleteBtnState): a <span class="hint">
  // living in .fg-actions next to Select-all and Delete -- shares the panel's
  // ordinary hint-on-panel contrast pair, not the chip-fg/chip-bg pair above.
  { surface: "options", page: "options.html", selector: "#tag-gov-selected-count", state: "default",
    expect: { textContrast: 4.5 } },

  // ---- defect 5 (2nd instance): .btn-ic in library only has 4 container-
  // scoped equivalents; every other host (incl. .vocab-detail-speak) falls
  // back to inline-element baseline alignment instead of a centered box
  // (COMPONENTS.md §2.1, §2.4). popup's .btn-ic is in scope for §2's base
  // rule even though popup is exempt from the rest of the button family. ----
  { surface: "library", page: "library.html", selector: ".vocab-detail-speak", state: "default",
    expect: { iconContrast: 3, iconVCenter: 1 } },
  // .btn-ic's OWN box only ever contains its own svg -- comparing .btn-ic's
  // rect against its svg's rect for iconVCenter is a vacuous assertion
  // (popup.css's `.btn-ic { display:inline-flex; align-items:center }` rule
  // guarantees that child is always centered inside its own parent; the
  // diff is structurally 0 regardless of any real bug). iconContrast is the
  // real check here: color is inherited through the host (.header-ic sets
  // `color: var(--pp-fg-muted)`), so it genuinely exercises the token.
  { surface: "popup", page: "popup.html", selector: ".btn-ic", state: "default",
    expect: { iconContrast: 3 } },
  // The defect-5 shape was `.btn-ic`'s `vertical-align:-3px` (popup.css,
  // `.btn-ic`'s own rule) -- a heuristic offset relative to the HOST
  // button's own line box, not to .btn-ic's own interior. That only showed
  // up when measured against the host, and only when the host wasn't itself
  // a flex container (a flex host makes `vertical-align` inert on its
  // flex-item children, which is why `.header-ic`/`.qbtn`/`.clear-all-link`
  // -- all `display:flex`+`align-items:center` -- never reproduced it).
  // `#offline-queue-clear` (`.offline-clear`) was the one member of this
  // link-styled icon-button group that never got the declaration: 1.7px off
  // centre on 15 themes, 2.7px on terminal (COMPONENTS.md's own account of
  // this, popup.css's `.offline-clear` rule cites the same numbers). NOW
  // FIXED (debt-sweep 2026-08-07 re-verified, but the fix itself predates
  // this branch -- popup-buttons battle, `.offline-clear { display:
  // inline-flex; align-items: center }`): re-measured diff is 0.004px, this
  // key is no longer in known-failures.json, and this entry is a live
  // regression guard against the fix regressing, not a description of an
  // open defect. Needs at least one offline-queue item to be visible
  // (`#offline-queue-bar` is hidden when the queue is empty) -- the runner
  // seeds one and explicitly re-triggers `window.PPOffline.refresh()` after
  // navigation (see scripts/ui-render-audit.mjs's popup setup). This was
  // NOT a fixture-only race: root-caused and fixed (debt-sweep 2026-08-07,
  // popup.js) -- `showOfflineQueueStatus()` used to sit after the
  // unsupported-URL early `return`, so it silently never ran at all on any
  // unsupported-URL page (chrome://, about:, file://, a PDF viewer, or the
  // popup's own extension:// URL -- what every direct navigation to
  // popup.html hits, harness included). A real user with items stuck in the
  // offline queue got no indication of them from any tab that wasn't a
  // plain http(s) page, not merely a slow one: empirically confirmed by
  // waiting 2s past the automatic call with no manual refresh -- the bar
  // never appeared. Fixed by moving the call before the early return, next
  // to `setupTabSet()` which already ran unconditionally for the same
  // reason. The manual re-trigger below is now redundant on a patched
  // build but kept as defense in depth for this test's own setup ordering.
  { surface: "popup", page: "popup.html", selector: "#offline-queue-clear", state: "default",
    expect: { iconVCenter: 1 } },

  // ---- defect 2: .vocab-batch-bar row height mismatch. The group-name
  // input keeps the md-rung padding (library.css:830 `padding: 4px 8px`)
  // vs. a true row-mate .btn-sm's 2px 8px (COMPONENTS.md §6.3 `rowRungEq`).
  // The comparison target is #vocab-invert-selection, NOT #vocab-add-group:
  // #vocab-add-group/#vocab-remove-group live inside .vocab-group-unit,
  // whose `align-items: stretch` (library.css:1045) already stretches them
  // to match the oversized input -- comparing against them would silently
  // launder the exact bug this check exists to catch. #vocab-invert-selection
  // is a plain .btn.btn-sm sibling in the OUTER .vocab-batch-bar row
  // (align-items:center, no stretch), so it renders at its true height and
  // is the one that actually visibly mismatches the group-input/-step unit.
  // Selectors are the real ids from library.html's markup (library-vocab.js
  // only reads them via $id, it doesn't construct this row). Needs a
  // selected row to reveal the bar (`.vocab-batch-bar.selecting`) -- the
  // runner checks a row's checkbox first for any check using `heightEqWith`.
  // RE-POINTED 2026-08-05 (COMPONENTS.md §8): the probe used to be
  // #vocab-group-input itself. After the fused-control rebuild the input is
  // 18px and its 1px border lives on the .vocab-group-unit shell instead, so
  // the raw input measures 2px under a .btn-sm by construction -- the CONTROL
  // is still 20px. Measuring the shell keeps the original power (md-rung
  // padding creeping back would push the shell to 24px and fail exactly as
  // before) while measuring the thing the user actually sees line up.
  // .vocab-batch-bar's align-items is center, so the shell renders at its
  // natural height and can't be laundered by a stretch the way the two
  // stepper cells inside it can.
  { surface: "library", page: "library.html", selector: "#vocab-batch-toolbar .vocab-group-unit", state: "default",
    expect: { heightEqWith: { selector: "#vocab-invert-selection", tolerancePx: 1 } } },
  // ---- library T4d (spec §3.9): the batch rows. Vocabulary = two rows at
  // the sm rung + one 8px gap (64 / 56) whenever its status slot is empty;
  // notes = one row (min-height 28 / 24).
  { surface: "library", page: "library.html", selector: "#vocab-batch-toolbar", state: "default",
    expect: { heightPx: { comfortable: 64, compact: 56 } } },
  { surface: "library", page: "library.html", selector: ".notes-batch-bar", state: "default",
    expect: { minHeightPx: { comfortable: 28, compact: 24 } } },

  // ---- §1.4 hitAreaMin -- design-uplift final-fix I2 migrated this from
  // two hand-enumerated entries (#vocab-invert-selection, #library-link) to
  // a runner-side class-scan over every icon-only <button>; see the
  // scripts/ui-render-audit.mjs's sweepProbe family-4 comment and the
  // `expect` vocabulary note near the top of this file. ----

  // ---- library T4b (spec §3.2 / §3.4): the status toggles are the
  // .lib-toggle primitive, md 32 / 28 with no frame. At the runner's 1280
  // viewport the index is 360 wide, so they live in the closed "Filter"
  // popover; `open` focuses #vocab-filter-narrow and presses a real Space
  // (the popovertarget path), then Escape closes it again. All is pressed at
  // rest (btn-fg on btn-bg); its text must also clear the hover fill (btn-hover
  // until T5 moves the toggle hover to row-bg-hover). ----
  { surface: "library", page: "library.html", selector: "#vocab-stat-all", state: "open",
    open: { click: "#vocab-filter-narrow" },
    expect: { heightPx: { comfortable: 32, compact: 28 }, textContrastMulti: { ratio: 4.5, extraBgSelectorVar: "btn-hover" } } },
  { surface: "library", page: "library.html", selector: "#vocab-stat-learning", state: "open",
    open: { click: "#vocab-filter-narrow" },
    expect: { heightPx: { comfortable: 32, compact: 28 }, textContrast: 4.5 } },
  // The popover itself: the one place on this page that paints panel + 1px
  // border + radius-lg (spec §3.4, §11 V25).
  { surface: "library", page: "library.html", selector: "#vocab-filter-set", state: "open",
    open: { click: "#vocab-filter-narrow" },
    expect: { borderTopWidthPx: { value: 1 }, borderRadiusPx: { radiusVar: "radius-lg" }, bgEqVar: "panel" } },
  // Keyboard round trip on the trusted path (spec §7.1): Space opens it with
  // aria-expanded true and pbpListboxPlace's fixed placement inside the
  // viewport; Escape closes it, leaves focus on the button and clears the
  // inline placement.
  { surface: "library", page: "library.html", selector: "#vocab-filter-narrow", state: "filterPopoverKeys",
    expect: { filterPopoverKeys: { set: "#vocab-filter-set" } } },
  // ---- library T4c (spec §3.1 / §3.2): the notes header's md filter field
  // and its sm colour toggles. Selectors start with ".notes-" so the runner
  // switches to the notes tab. The first toggle is All, pressed at rest. ----
  { surface: "library", page: "library.html", selector: ".notes-toolbar #notes-filter", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  { surface: "library", page: "library.html", selector: ".notes-color-filters .lib-toggle", state: "default",
    expect: { heightPx: { comfortable: 28, compact: 24 }, textContrast: 4.5 } },
  // ---- library T4e (spec §9.2). Each state runs on a scratch page in the
  // same extension context (same theme in storage), so locale injection,
  // synthetic rows and viewport sizes never leak into the shared page. Only
  // density changes geometry, so they measure "" (comfortable) and terminal
  // (compact) -- the top-level `themes` key, as for the T3 gates.
  // G3: at 900px tall the list shows 12-13 rows at a 56px pitch, >=15 at 44.
  { surface: "library", page: "library.html", selector: "#vocab-list", state: "visibleRowCount", themes: ["", "terminal"],
    expect: { visibleRowCount: { width: 1280, height: 900, comfortable: { pitch: 56, min: 12, max: 13 }, compact: { pitch: 44, min: 15 } } } },
  // G2: ArrowDown from the first row never leaves the focused row outside the
  // list region -- browsing, with the batch row in the header, and on a 360px
  // German index.
  { surface: "library", page: "library.html", selector: "#vocab-list", state: "focusRowVisible", themes: ["", "terminal"],
    expect: { focusRowVisible: { width: 1280, height: 900, steps: 20, passes: [
      { name: "browse" }, { name: "multi-select", select: true }, { name: "index-360-de", locale: "de", indexW: 360 },
    ] } } },
  // G7: nine locales x index widths x 9999-sized counts, browse and select,
  // vocabulary and notes (the notes colour row is nowrap: All + five
  // toggles): no header child past the index's edge or out of its own group
  // box, no two siblings overlapping (optical hangs excepted by category),
  // count items whole, the vocabulary batch row 64 / 56 and the notes one
  // one or two sm rows. The form each header shows -- filter row inline or
  // folded into the Filter popover, colour toggles with or without their
  // numbers -- must be the one the runner's own measurement of the wide
  // form's need calls for (user ruling 10-04: no fixed threshold, it fits or
  // it folds). indexWidths are the fixed probes across the index's range;
  // the runner adds each locale's own need -1 / +1 so both sides of every
  // switch point are walked.
  { surface: "library", page: "library.html", selector: ".vocab-list-pane", state: "listHeaderFit", themes: ["", "terminal"],
    expect: { listHeaderFit: { width: 1600, height: 900, count: 9999, indexWidths: [360, 440, 512, 520] } } },
  // G6, the toggles T3's filterScrollReset does not drive: the status toggle
  // and the notes colour toggle each return their list to the top.
  { surface: "library", page: "library.html", selector: "#vocab-stat-all", state: "filterScrollResetToggles", themes: ["", "terminal"],
    expect: { filterScrollResetToggles: true } },

  // ---- §1/§2 button + icon family: representative instances beyond the
  // defect-tagged selectors above, so the button-family assertions have
  // coverage that isn't 100% coincident with the six named defects. ----
  { surface: "options", page: "options.html", selector: "#export-settings", state: "default",
    expect: { textContrast: 4.5 } },

  // ---- Task 6: color-scheme now comes from composers/{popup,options,
  // library}-chrome.mjs (every html[data-theme] block states its own scheme,
  // :root/html.dark defaults fill the no-preset states) instead of a
  // hand-written selector list. library was the one surface with NO such
  // declaration at all before this task -- half the root cause of defect
  // 1/4 (library's own dark presets left native `.btn` text at UA
  // ButtonText resolved against the wrong scheme; see the options `.btn`
  // entry above for the coincidental-pass mechanism this closes for
  // library too). `html` always matches querySelector, so this runs once
  // per theme with no detail-pane/batch-bar setup needed. ----
  { surface: "library", page: "library.html", selector: "html", state: "default",
    expect: { colorSchemeMatchesTheme: true } },

  // ---- Task 14 (§7.6 textInset/childContainment): options preset-preview
  // summary -- user real-device report, two symptoms of the SAME root cause
  // (an id selector, #preset-preview-section > summary, zeroed the
  // summary's own horizontal padding, beating the bordered box's own class
  // rule regardless of source order). textInset catches the text-glued-to-
  // border half; childContainment catches the ::after chevron's rotated
  // bbox poking past the border with nowhere left to sit. Needs the
  // "appearance" tab active + a site-theme preset picked (scripts/ui-render-
  // audit.mjs's options-specific setup) -- the summary is otherwise
  // reachable but its whole `<details>` is `style="display:none"` until
  // then. ----
  { surface: "options", page: "options.html", selector: "#preset-preview-section > summary", state: "default",
    expect: { textInset: { h: 4, v: 2 }, childContainment: true } },

  // ---- design-uplift, preset-row redesign (user-selected Variant A,
  // 2026-08-04): .theme-preset-btn's swatch dot and selection ring, the two
  // new affordances that replaced the old bordered pill + border-drawn
  // check tick (COMPONENTS.md Appendix C). ".theme-preset-btn.active"
  // matches whichever preset the "appearance" tab click already made active
  // (runSimpleTheme's presetRowChecks branch -- shares the SAME click
  // presetPreviewChecks above needs, no second setup step). beforeExists is
  // a render check, not a contrast-audit.mjs pair-table entry, because a
  // pseudo-element's existence isn't a color relationship at all --
  // ::before is not document.querySelector-able, so this is the only layer
  // that can see it (getComputedStyle(el, "::before") via probeSelector's
  // existing --sweep measurePseudo helper). outlineContrast is a render
  // check rather than a COMPONENT_PAIR_SPEC row for the opposite reason:
  // contrast-audit.mjs only has flat per-theme palette values, no ancestor
  // walk, and the ring's real background is whatever's actually painted
  // behind it at outline-offset:2px (.theme-presets-group has no
  // background of its own, so that's .fg's -- not a fixed role name any
  // static palette lookup could name). Deliberately scoped to just this one
  // selector, not a blanket audit of the many other pre-existing
  // accent-colored outlines elsewhere in options.css/popup.css (out of
  // scope for this change -- see preset-variants-report.md). popup's own
  // .preset-btn::before has no equivalent entry here: the render-audit
  // fixture never seeds `tagPresets`, so #tag-presets never renders in this
  // harness today (a pre-existing gap, not something this task introduced;
  // recorded as a follow-up in preset-variants-report.md rather than fixed
  // here, since it requires the same tabs.query/context.route
  // fixture-tab workaround the read-only screenshot tooling needed). ----
  { surface: "options", page: "options.html", selector: ".theme-preset-btn.active", state: "default",
    expect: { beforeExists: true } },
  { surface: "options", page: "options.html", selector: ".theme-preset-btn.active", state: "default",
    expect: { outlineContrast: 3 } },

  // ---- (library redesign T4b) The #vocab-search heightEqWith
  // #vocab-group-filter entry that stood here is gone: at the runner's 1280
  // viewport the group select sits in the closed "Filter" popover, so there is
  // nothing to compare against. #vocab-search keeps its own heightPx below;
  // T6a brought the comparison back against #vocab-group-filter-btn (right
  // after that heightPx row). ----
  // Library density rung (library redesign 2026-10-03 spec §6.2, plan T1):
  // the composer's lib branch puts .btn / .btn-sm on 32/28 and 28/24, and the
  // toolbar fields follow. Per-theme rows because the sweep's controlRung
  // runs on the default theme only (comfortable): these are what proves
  // terminal and gruvbox-dark actually render the compact tier. One md
  // field, one sm text button, one sm icon button in the batch bar.
  { surface: "library", page: "library.html", selector: "#vocab-search", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  // Library redesign T6: the group filter is a listbox button now; it and
  // the search field stay on one md rung (the vocab row's two value boxes).
  { surface: "library", page: "library.html", selector: "#vocab-search", state: "default",
    expect: { heightEqWith: { selector: "#vocab-group-filter-btn", tolerancePx: 1 } } },
  { surface: "library", page: "library.html", selector: "#vocab-select-all", state: "default",
    expect: { heightPx: { comfortable: 28, compact: 24 } } },
  // Its twin in the batch row (T4d): the runner opens the batch row for this
  // check alone (needsBatchBarOpen), so the count-row entry above runs at rest.
  { surface: "library", page: "library.html", selector: "#vocab-batch-select-all", state: "default",
    expect: { heightPx: { comfortable: 28, compact: 24 } } },
  { surface: "library", page: "library.html", selector: "#vocab-batch-delete", state: "default",
    expect: { heightPx: { comfortable: 28, compact: 24 } } },
  // Sort menu button (spec §3.3): listbox.js's ghost trigger, a .btn on the
  // md rung -- the same height as the row's group listbox and toggles.
  { surface: "library", page: "library.html", selector: "#vocab-sort-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },

  // ---- Library redesign T7 (spec §4.8): the lookup row is three md controls
  // -- field, the language listbox button, the "Look up" text button -- all
  // on the md rung (32 / 28). ----
  { surface: "library", page: "library.html", selector: "#vocab-lookup-input", state: "default",
    expect: { heightEqWith: { selector: "#vocab-lookup-go", tolerancePx: 1 } } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-lang-btn", state: "default",
    expect: { heightEqWith: { selector: "#vocab-lookup-go", tolerancePx: 1 } } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-go", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },

  // ---- COMPONENTS.md §8: fused controls (design-uplift 2026-08-05, user
  // checkpoint round 4 -- "同类型的问题肯定不止这一处" after the group row was
  // rejected a third time). Two assertions per rebuilt control:
  //
  //   fusedChildrenFlat  laws 1+3 -- no passenger draws a box of its own (no
  //                      radius, no resting fill, at most the single border
  //                      side that IS the divider), and every divider drawn
  //                      inside one shell agrees on colour and width. This is
  //                      the direct regression guard for what shipped before:
  //                      the input carried --lib-input-border while the two
  //                      .btn steppers carried --lib-border, so the two seams
  //                      inside one 215px control were different colours.
  //   fusedFocusRing     law 2 -- the ring is the SHELL's, it actually
  //                      changes on :focus-within, it grows outward from the
  //                      shell's border box (non-negative outline-offset, or
  //                      a non-inset shadow), and the focused passenger draws
  //                      no outline of its own. One entry per tab stop,
  //                      because each passenger reaches the ring through a
  //                      different rule and a missed `outline: none` on any
  //                      one of them re-creates the reported defect.
  //
  // Both instances of the group unit are covered: the batch bar's (static
  // markup, library.html:112) and the detail pane's (built by
  // library-vocab.js:409). They share one recipe but have historically
  // drifted -- Finding 1 in vocab-group-inspect-report.md was precisely the
  // detail-pane copy never matching a selector the batch-bar copy did. ----
  // Batch-bar instance. focusWithin covers the input only: library-vocab.js
  // :1031/:1037 disable both steppers until a group name has been typed AND
  // (for "-") the selection is already in that group, and a disabled control
  // cannot take focus at all -- §3.1 row 9 exempts :disabled from these
  // assertions anyway. The stepper half of the recipe is asserted on the
  // detail-pane twin below, whose steppers are never disabled; the CSS is
  // one shared rule, so coverage is not lost, only relocated.
  // concentricEnds: true (independent review F1, hit-area-debt): the input
  // (first/left) and #vocab-remove-group (last/right) now round their own
  // OUTER corners to nest inside the shell (COMPONENTS.md §9.2 law 2) --
  // #vocab-add-group, the middle cell, still has to be flat on all four.
  // edgeClickable (independent review F2, hit-area-debt): hitAreaMin only
  // reads the ::before pad's COMPUTED box, which stays the same number
  // whether or not the shell's `overflow` actually lets a real pointer
  // event reach it (F1's root cause) -- this asserts a point just past each
  // stepper's own top edge resolves via elementFromPoint to that stepper,
  // not the shell. RED-verified by reverting .vocab-group-unit's overflow
  // to `hidden` (its pre-fix value): fails both points on both cells.
  { surface: "library", page: "library.html", selector: "#vocab-batch-toolbar .vocab-group-unit", state: "default",
    expect: { fusedChildrenFlat: { children: ['input[type="text"]', "#vocab-add-group", "#vocab-remove-group"], concentricEnds: true },
      edgeClickable: { children: ["#vocab-add-group", "#vocab-remove-group"] } } },
  { surface: "library", page: "library.html", selector: "#vocab-batch-toolbar .vocab-group-unit", state: "focusWithin",
    focusTarget: 'input[type="text"]', expect: { fusedFocusRing: true } },
  // Detail-pane twin. Its steppers carry no ids (library-vocab.js:418/428
  // builds them anonymously) so the passengers are addressed positionally,
  // and they are always enabled -- this is where all three tab stops get
  // exercised.
  // Same concentricEnds exception as the batch-bar instance above -- one
  // shared CSS rule (`.vocab-group-unit > input`/`:last-child`), so both
  // DOM copies pick it up identically.
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "default",
    expect: { fusedChildrenFlat: { children: ['input[type="text"]', ".vocab-group-step:nth-of-type(1)", ".vocab-group-step:nth-of-type(2)"], concentricEnds: true },
      edgeClickable: { children: [".vocab-group-step:nth-of-type(1)", ".vocab-group-step:nth-of-type(2)"] } } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "focusWithin",
    focusTarget: 'input[type="text"]', expect: { fusedFocusRing: true } },
  // The two steppers moved to fusedSegmentRing for the same reason the
  // retired sort segment's cells did: the shell's ring is now scoped to the TEXT INPUT, so tabbing
  // to a stepper must light the cell and leave the shell alone. Keeping the
  // input on fusedFocusRing is the point of the split -- a text field's focus
  // belongs on the frame around it, a button cell's belongs inside the cell,
  // and asserting both shapes from one unit is what proves the scoping
  // actually discriminates instead of just having been switched off.
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "focusWithin",
    focusTarget: ".vocab-group-step:nth-of-type(1)", expect: { fusedSegmentRing: true } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "focusWithin",
    focusTarget: ".vocab-group-step:nth-of-type(2)", expect: { fusedSegmentRing: true } },
  // ---- COMPONENTS.md §8 law 6: rest <-> focus state stability (user
  // checkpoint round 5: "底色变白、眼睛图标偏移、眼睛段看着独立不融合").
  // Focus may change border-COLOUR and add a ring. It may not move anything,
  // repaint any background, or shift the trailing icon -- measured on the
  // shell AND on each named segment, in both passes, through the same probe.
  // `fusedStateStableChildren` names the segments because the shell's own
  // rect staying put says nothing about a segment inside it moving. ----
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "focusWithin",
    focusTarget: 'input[type="text"]',
    expect: { fusedStateStable: true,
      fusedStateStableChildren: ['input[type="text"]', ".vocab-group-step:nth-of-type(1)", ".vocab-group-step:nth-of-type(2)"] } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "focusWithin",
    focusTarget: ".vocab-group-step:nth-of-type(1)",
    expect: { fusedStateStable: true,
      fusedStateStableChildren: ['input[type="text"]', ".vocab-group-step:nth-of-type(1)", ".vocab-group-step:nth-of-type(2)"] } },
  { surface: "options", page: "options.html", selector: ".key-wrap", state: "focusWithin",
    focusTarget: ".key-toggle",
    expect: { fusedStateStable: true, fusedStateStableChildren: ["input", ".key-toggle"] } },
  { surface: "options", page: "options.html", selector: ".key-wrap", state: "focusWithin",
    focusTarget: "input",
    expect: { fusedStateStable: true, fusedStateStableChildren: ["input", ".key-toggle"] } },

  // ---- Stage 4 (spec 2026-09-30-ui-fields-stage4-design §2.1 / §5.1):
  // popup's value boxes, token IDENTITY per state -- rest fill + four painted
  // --pp-field-border sides, hover fill + four --pp-field-border-hover sides,
  // focus fill + four --pp-field-border-focus sides and the bordered ring.
  // The runner reaches all of them now (it did not when this spot said
  // "static-gated only"): #main-section is unhidden by the fixture that the
  // focusWithin rows already trigger, and runSimpleTheme unhides .search-row
  // and #login-section for #search-input / #token-input. The tags field is
  // measured on its SHELL (it carries the look; #tags-input is a transparent
  // passenger), focused through the passenger. The step sizes are family
  // 14's popup leg; the token pairs are contrast-audit's pp field rows. ----
  { surface: "popup", page: "popup.html", selector: "#title-input", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "popup", page: "popup.html", selector: "#title-input", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "popup", page: "popup.html", selector: "#title-input", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "popup", page: "popup.html", selector: "#description-input", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "popup", page: "popup.html", selector: "#description-input", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "popup", page: "popup.html", selector: "#description-input", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "popup", page: "popup.html", selector: ".tags-input-wrap", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "popup", page: "popup.html", selector: ".tags-input-wrap", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "popup", page: "popup.html", selector: ".tags-input-wrap", state: "focusWithin", focusTarget: 'input[type="text"]',
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "popup", page: "popup.html", selector: "#search-input", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "popup", page: "popup.html", selector: "#search-input", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "popup", page: "popup.html", selector: "#search-input", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "popup", page: "popup.html", selector: "#token-input", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "popup", page: "popup.html", selector: "#token-input", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "popup", page: "popup.html", selector: "#token-input", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },

  // ---- COMPONENTS.md §7.3: focus-ring recipe conformance (2026-08-05
  // sweep). One entry per converged site. The two sites that need heavy
  // setup to render at all -- .theme-name-popover (only exists after the
  // disabled #save-custom-theme is enabled and clicked) and popup's
  // .regen-link (popup-ai.js only creates it after an AI response) -- are
  // gated statically in tests/ui-contract-tests.mjs instead: a text-level
  // contract there beats a render entry whose setup is longer than the rule
  // it guards. ----
  // A <select> is an input-class field; this one used to stack a 2px
  // button-style outline on top of the field recipe's focus border, putting
  // two focus languages side by side in one toolbar row. Since T6 the group
  // filter renders as listbox.js's .listbox-btn, a value box on the same
  // field recipe.
  { surface: "library", page: "library.html", selector: "#vocab-group-filter-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  // The lookup field, added 2026-08-07 by independent review F1. When the row
  // moved into the detail pane it dropped the `notes-toolbar` class, and with
  // it the ENTIRE field recipe -- border, fill, radius, appearance:none AND
  // all three focus rules -- because that recipe is scoped to
  // `.notes-toolbar input[type="search"]`. What shipped was a UA-native search
  // box wearing the platform's own 2px inset bevel and its own focus ring.
  // This one entry gates both halves at once on all 15 theme states: `bordered`
  // fails on a UA control (it draws an outline, paints no --lib-focus-ring
  // glow, and never moves its border-color), and a control that has no
  // authored border cannot pass the border-color half either.
  // Why the two heightEqWith entries on this same row did NOT see it: the row
  // is `align-items: stretch`, so the select and the button were stretched to
  // the BROKEN input's height and measured equal to it. Equality held while
  // every member of the row was wrong together -- "漏判的最简单反例" for a
  // pure-geometry gate, and the reason this row needed a materials gate too.
  { surface: "library", page: "library.html", selector: "#vocab-lookup-input", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  // ---- Stage 4 (spec 2026-09-30-ui-fields-stage4-design §5.1, checklist row;
  // COMPONENTS.md §6.2): token IDENTITY of library's value-box paints in each
  // state -- rest fill + all four sides (field-border: collapsed into the fill,
  // or terminal's pilot frame), hover fill + sides, focus fill + sides.
  // borderSidesEqVar asserts all four sides painted and equal (there is no
  // edge any more). Contrast is contrast-audit's lib field rows and family
  // 14's library leg; these rows catch a hand-written rule (or a themed twin)
  // repainting a box with a non-field token -- the pre-stage-4 shapes: search
  // fields hovered to --lib-fg-muted, selects filled with --lib-btn-bg, the
  // note editor transparent. The two focusRecipe rows just above carry the
  // focus assertions for #vocab-group-filter-btn / #vocab-lookup-input. Detail-pane
  // selectors contain "-detail-" (needsDetailOpen); the batch-bar shell is in
  // BATCH_BAR_SELECTORS (needsBatchBarOpen); `.notes-toolbar #notes-filter`
  // starts with ".notes-" so the runner opens the notes view for it. The
  // dictionary language is a listbox button since T7 (rows below); family
  // 14's library leg reads it focused, held by VALUE_BOX_FOCUS_REQUIRED.library. ----
  { surface: "library", page: "library.html", selector: "#vocab-search", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: "#vocab-search", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: "#vocab-search", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "library", page: "library.html", selector: "#vocab-group-filter-btn", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: "#vocab-group-filter-btn", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-input", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-input", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-lang-btn", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-lang-btn", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-lang-btn", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "library", page: "library.html", selector: ".notes-toolbar #notes-filter", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: ".notes-toolbar #notes-filter", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: ".notes-toolbar #notes-filter", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-note-input", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-note-input", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-note-input", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-unit", state: "focusWithin", focusTarget: 'input[type="text"]',
    expect: { bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "library", page: "library.html", selector: "#vocab-batch-toolbar .vocab-group-unit", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "library", page: "library.html", selector: "#vocab-batch-toolbar .vocab-group-unit", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "library", page: "library.html", selector: "#vocab-batch-toolbar .vocab-group-unit", state: "focusWithin", focusTarget: 'input[type="text"]',
    expect: { bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  // `borderless` (1px accent core + --{ns}-focus-ring glow) on the two
  // full-width row families. Nothing here asserts a shadow LITERAL: the glow
  // is per-theme identity (terminal blur / paper-ink flat 1px / solarized
  // translucent 2px) and the runner only requires that a non-inset shadow
  // exists and differs from the unfocused baseline -- true on all 15 theme states,
  // false the moment the rule stops firing.
  { surface: "options", page: "options.html", selector: ".tab-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "borderless" } },
  // .lib-tab carried TWO same-specificity :focus-visible rules until
  // 2026-08-06; the later one won `outline` while the earlier still supplied
  // `box-shadow`, so what shipped was a hard 2px rectangle sitting inside the
  // soft glow -- neither placement, and invisible to any check that only
  // asked "is there a ring". This entry measures the composed result.
  { surface: "library", page: "library.html", selector: ".lib-tab", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "borderless" } },
  // `bordered` on the generated .btn family itself -- the one entry that
  // proves the recipe reaches a real button through the live cascade on all
  // 15 theme states, including that `border-color` actually lands (a themed rest
  // rule out-ranking the focus rule is the failure mode this catches, and it
  // is exactly what popup's 5 bordered sites needed twins for).
  { surface: "library", page: "library.html", selector: "#vocab-lookup-go", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered" } },
  // `inset` on a list row. Outline-only by contract: .notes-hit[aria-current]
  // already paints `box-shadow: inset 0 0 0 1px` as its "you are here" edge,
  // and a focus shadow at the same specificity would replace it rather than
  // stack, silently deleting the selection cue while focused.
  { surface: "library", page: "library.html", selector: ".notes-hit-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "inset" } },
  // popup's `bordered` sites (design-uplift follow-up 2026-08-06, independent
  // review F2). These two are the reason this surface needed per-theme focus
  // twins at all: popup carries a hand-written themed override layer whose
  // RESTING rules (html[data-theme] .qbtn, html.dark .md-strip-btn, ...) set
  // border-color at HIGHER specificity than the base :focus-visible rule, so
  // the border half of the recipe rendered only on the default surface and
  // vanished under all 13 presets. The `bordered` check asserts border-color
  // actually CHANGED on focus, which is precisely the failure mode -- and it
  // asserts it per theme, which a static text contract cannot. Before this,
  // popup had zero focusRecipe entries and the C45 fix was gated by nothing
  // but the author's own specificity arithmetic.
  { surface: "popup", page: "popup.html", selector: ".qbtn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered" } },
  { surface: "popup", page: "popup.html", selector: ".md-strip-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered" } },
  // #delete-btn: the themed `.submit-bar button:focus-visible` twin C45 added
  // was deleted on 2026-09-18 (both submit-bar buttons carry class="btn", so
  // the generated .btn / .btn.danger focus recipe supplies the same tokens).
  // This probe is what stands between that deletion and a silent regression
  // if a themed resting rule on the bar ever comes back.
  { surface: "popup", page: "popup.html", selector: "#delete-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered" } },
  // `inset` CARRIED for a passenger: the vocab row's ring is drawn on
  // .notes-card-top, not on the .notes-card-head button that actually takes
  // focus -- the whole-row ring includes the padding around the head. Because the
  // focus target differs from the probed element, the runner additionally
  // requires the head to draw nothing of its own (no double ring).
  { surface: "library", page: "library.html", selector: ".vocab-card .notes-card-top", state: "focusWithin",
    focusTarget: ".notes-card-head", expect: { focusRecipe: "inset" } },
  // `.saved-theme-btn` (debt-sweep 2026-08-07): shares every OTHER rule in
  // its shared-base block with `.theme-preset-btn` -- fill, hover, `.active`
  // ring -- but the :focus-visible line at the top of that block only ever
  // named `.theme-preset-btn`, so the pill fell through to the generic
  // `.btn:focus-visible` (bordered) recipe, which is invisible on a
  // `border: none` pill (only the glow showed, no >=3:1 core -- the same
  // defect shape §7.3 exists to catch). Needs `savedThemes` seeded in
  // storage before the button exists at all; see runSimpleTheme's seed.
  { surface: "options", page: "options.html", selector: ".saved-theme-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "borderless" } },

  // The two steppers paint --lib-field-fg (the generated passenger rule,
  // stage 4 D6) on the shell's --lib-field-bg. contrast-audit's lib field rows
  // (field-fg vs field-bg / field-bg-hover, stage 4 Task 5) cover the token
  // pair; this render entry still measures the composed icon on all 15 theme
  // states.
  // (Deliberately the detail-pane pair, not #vocab-add-group/#vocab-remove-
  // group: the batch bar's two steppers render :disabled on an untouched
  // page, and the runner correctly SKIPs contrast on disabled controls --
  // pointing this at them would have produced 16 silent SKIPs dressed up as
  // coverage.)
  // iconVCenter (round 5): these two measured 2.00px ABOVE centre because
  // shared.js:112's setBtnIcon always appends an empty label span, which
  // under the old `display: inline-grid` became a second grid row
  // (grid-template-rows: 14px 0px) and re-centred the icon across both. The
  // batch-bar copies come from static single-child HTML and never showed it
  // -- same CSS, different DOM -- so only an assertion on the JS-BUILT pair
  // can catch a regression here.
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-step:nth-of-type(1)", state: "default",
    expect: { iconContrast: 3, iconVCenter: 1 } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-pane .vocab-group-step:nth-of-type(2)", state: "default",
    expect: { iconContrast: 3, iconVCenter: 1 } },

  // ---- popup's confirm popover (popup button-family campaign C3a). Until
  // this campaign popup was the only surface where the solid-danger tier was
  // hand-written per layer, and under all 13 presets it was painted from the
  // WARN family instead (`background: var(--pp-warn-fg); color:
  // var(--pp-warn-bg)`). Note what that means for gate design: the warn pair
  // measures 4.5-5.2:1 on every preset, so a contrast assertion could not
  // have caught the original defect and this trio does not pretend to -- the
  // wrong-family bug is caught statically (tests/ui-contract-tests.mjs fails
  // any hand-written rule that paints .confirm-yes). What these three DO
  // catch is the regression that a static text scan cannot see: the popover
  // is assembled by shared.js at click time out of three elements that
  // inherit colour from three different layers, so "is the text actually
  // readable on the card it lands on, in this theme" is only answerable
  // after a real cascade + real composite. .confirm-msg is the one that has
  // never had any gate at all -- it inherits the popover's own `color`,
  // which is --pp-danger by default and --pp-fg under a preset, over
  // --pp-bg; neither pair is in contrast-audit's COMPONENT_PAIR_SPEC.
  // The runner opens the real popover via #logout-link and never confirms
  // (see runSimpleTheme's popup setup). ----
  { surface: "popup", page: "popup.html", selector: ".confirm-popover .confirm-msg", state: "default",
    expect: { textContrast: 4.5 } },
  { surface: "popup", page: "popup.html", selector: ".confirm-popover .confirm-yes", state: "default",
    expect: { textContrast: 4.5 } },
  { surface: "popup", page: "popup.html", selector: ".confirm-popover .confirm-no", state: "default",
    expect: { textContrast: 4.5 } },

  // ---- popup's submit bar, the first two buttons to carry `class="btn"`
  // (campaign C4a). Both had ZERO render coverage before -- scoping found no
  // assertion of any kind on #submit-btn / .del-btn -- which is how a
  // focus-indicator gap survived on the popup's primary action across all 16
  // themes: #submit-btn's own (1,0,0) `border-color: var(--pp-accent)` (and
  // its themed twin at (1,1,1)) out-ranked `.submit-bar button:focus-visible`
  // (0,2,1), so focus produced a glow and no >=3:1 core.
  //
  // `borderless` for #submit-btn is a deliberate placement call, not the
  // family default: §7.3's second question asks whether the resting frame is
  // neutral chrome or semantic, and this one is the same accent as the fill
  // -- it IS the primary-action tier. .del-btn is `bordered` because it takes
  // the .btn family's frame, which Soft Fill collapses into the fill and
  // which therefore costs nothing to re-tint.
  //
  // heightEqWith is the §6.3 rowRungEq for this bar: the two buttons sat at
  // 28px on a hand-written `min-height` before, and the migration drops them
  // to the family's 26px md rung -- pinning them to EACH OTHER (rather than
  // to a literal 26) keeps the assertion about the thing that is actually
  // wrong when it breaks, which is one of them drifting off the rung.
  { surface: "popup", page: "popup.html", selector: "#submit-btn", state: "default",
    expect: { textContrast: 4.5, heightEqWith: { selector: ".del-btn", tolerancePx: 1 } } },
  { surface: "popup", page: "popup.html", selector: "#submit-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "borderless" } },
  // #submit-btn's own (1,0,0) base rule (background/border-color/color) used
  // to permanently outrank `.submit-bar button.saved-success` (0,2,1) and its
  // themed twin (debt-sweep 2026-08-07, F8 in the popup-buttons review) --
  // setSubmitState() added the class every save, and the button never
  // repainted on any of the 15 theme states; only textContent changed. The fix
  // folds the id into both rules (same shape as the pre-existing
  // `#submit-btn:disabled` exemption above). classState is the first check
  // in this file to drive a state via classList rather than a real
  // interaction -- there is no user gesture that reaches "just saved".
  //
  // `removeClass`/`clearDisabled` (independent review F2/F3, 2026-08-08):
  // the first version of this check only added the target class, which does
  // NOT reproduce setSubmitState()'s actual DOM mutation -- that function
  // always does `classList.remove("loading", "saved-success", "save-error")`
  // + `disabled = false` first. Skipping that meant the "rest" baseline this
  // check reads could be measuring whatever OTHER state the element had been
  // left in by an earlier check, not the idle resting cascade the fix
  // actually has to out-rank -- and with no settle wait, a read taken in the
  // same task as classList.add() could land mid-transition on `.btn`'s own
  // `transition: background ...` instead of at the target value. Both fixed:
  // the DOM mutation now mirrors setSubmitState() exactly (mirror() above),
  // and the read is taken 260ms after the class add (same settle discipline
  // focusWithin uses just below).
  //
  // save-error also gates textContrast now (independent review F1): the
  // rule used to pair --pp-danger with --pp-warn-bg, two roles that were
  // never a designed combination and measured below 4.5:1 on 9/13 presets +
  // default. Fixed to consume --pp-warn-fg/--pp-warn-bg (popup.css, both
  // out of the same pairToAA(destroy, bg, mode) call -- AA-safe by
  // construction, now a registered COMPONENT_PAIR_SPEC row). This entry is
  // what would have actually caught the original bug -- COMPONENT_PAIR_SPEC
  // only proves a NAMED token pair is safe, it has no way to know which
  // rule consumes which tokens; measuring the real rendered button is the
  // only check that traces to the actual CSS selector.
  { surface: "popup", page: "popup.html", selector: "#submit-btn", state: "classState",
    addClass: ["saved-success"], removeClass: ["loading", "saved-success", "save-error"], clearDisabled: true,
    expect: { bgChangedFromRest: true } },
  { surface: "popup", page: "popup.html", selector: "#submit-btn", state: "classState",
    addClass: ["save-error"], removeClass: ["loading", "saved-success", "save-error"], clearDisabled: true,
    expect: { bgChangedFromRest: true, textContrast: 4.5 } },
  { surface: "popup", page: "popup.html", selector: ".del-btn", state: "default",
    expect: { textContrast: 4.5 } },
  { surface: "popup", page: "popup.html", selector: ".del-btn", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered" } },

  // .qbtn stays a hand-written "equal-share strip" variant -- three of them
  // divide one 550px row, so the family's `padding: 4px 16px` would fold the
  // row in the longer locales (COMPONENTS.md §0's popup variant table). What
  // it DOES join is the height ladder, via min-height. Pinned to #submit-btn
  // rather than to a literal 26: if this ever breaks, the interesting fact is
  // "the quick row and the submit bar stopped agreeing", not "a number moved"
  // -- and a literal would also have to be re-checked by hand every time the
  // md rung moves. Measured 24.30px before the min-height landed, i.e. 1.7px
  // off #submit-btn's 26 against a 1px tolerance: this entry fails on the
  // pre-ruling geometry, which is the only reason it is worth having.
  { surface: "popup", page: "popup.html", selector: ".qbtn", state: "default",
    expect: { heightEqWith: { selector: "#submit-btn", tolerancePx: 1 } } },

  // ---- popup's suggest/AI tag chips (D6/D7, Task 5, taste-uplift batch3):
  // .stag joins the chip family (ui-components.mjs CHIP_TARGETS, popup-only
  // entry) -- geometry per COMPONENTS.md §5.1 (18px, no border -- padV 2 +
  // line-height 14), colour per §5.3/§9.1 law 8. Requires real chips to
  // exist: scripts/ui-render-audit.mjs's runSimpleTheme calls
  // fetchPinboardSuggestTags/renderAITags directly (see that file's comment
  // for why popup.js's normal boot never reaches them on this fixture) and
  // unhides #suggest-row before this file's CHECKS loop runs. Bare `.stag`
  // matches the FIRST rendered chip (popular group's "reading") -- kept in
  // its REST state on purpose (the seeded `.used` click targets `.last()`).
  { surface: "popup", page: "popup.html", selector: ".stag", state: "default",
    expect: { heightPx: { value: 18, tolerancePx: 1 }, padGteRadiusH: true, padVMin: 2,
      textContrast: 4.5, bgEqVar: "chip-bg", colorEqVar: "chip-fg" } },
  // .stag.ai: same geometry, but its text is the AI role (Task 4, D9) rather
  // than the plain chip role -- ai-chip-fg is gated against BOTH chip-bg
  // (this rest-state row) and btn-hover (contrast-audit's token-level hover
  // row; not re-proven here since .stag has no dedicated hover recipe of its
  // own to drive a render-side hover state for -- see popup.css's .stag:hover).
  { surface: "popup", page: "popup.html", selector: ".stag.ai", state: "default",
    expect: { textContrast: 4.5, colorEqVar: "ai-chip-fg" } },
  // .stag-num: the Alt+N ordinal riding the chip. D7 moved it off
  // fg-hint/opacity onto the chip's own paired text token; tabular-nums is
  // new (keeps 1-9 from jittering the chip's width as slots reassign).
  { surface: "popup", page: "popup.html", selector: ".stag .stag-num", state: "default",
    expect: { fontSizePx: { value: 11 }, fontVariantNumericContains: "tabular-nums", colorEqVar: "chip-fg" } },
  // .stag.used (T5 fix round F6): the "already inserted" state (popup.css's
  // Soft Fill law-8 comment directly above `.stag.used`) -- pinned via
  // `classState` (the same synthetic addClass mechanism
  // #submit-btn.saved-success above uses), NOT by re-selecting the runner's
  // own seeded `.used` chip (scripts/ui-render-audit.mjs toggles `.used` on
  // the LAST suggest chip before this file's CHECKS loop runs, purely to give
  // family 13 (weakTextOnFill) a real used chip to scan). classState instead
  // reapplies `.used` to the SAME first ("reading") chip the bare `.stag` row
  // above already asserts a REST state for, so the two rows are directly
  // comparable states of one element. bgEqVar doesn't apply to the fill:
  // `.used`'s background is the literal keyword `transparent` (falls through
  // to the page bg, not a resolved theme token), so backgroundAlphaMax stands
  // in for "no fill" the same way `.context-help-toggle`'s hover row above
  // uses it to assert "no filled shell".
  { surface: "popup", page: "popup.html", selector: ".stag", state: "classState", addClass: ["used"],
    expect: { backgroundAlphaMax: 0, colorEqVar: "fg-hint", textDecorationLineContains: "line-through" } },

  // ---- options field width by content kind (T6, taste-uplift-batch3, D2,
  // COMPONENTS.md §6.1). Before this batch every `.fg` text/password/number/
  // select field was a flat `width: 100%` -- at the >=1040px viewport this
  // audit runs at, that measured 790px for a plain `.fg` field and 764px
  // inside a provider `.pf` card (Step 0 measurement, task report), i.e. a
  // one-word select or a three-digit number field stretched to nearly the
  // full panel width. ui-components.mjs's formRules() now ADDS a max-width
  // ceiling per kind on top of the unchanged `width: 100%` (so a narrow
  // viewport, where the panel column is already under the cap, still gets
  // the full-width field the base rule always gave it). One representative
  // id per kind below, each already reachable from a tab this file's own
  // options branch (scripts/ui-render-audit.mjs) either visits by default
  // (general) or now switches to for this purpose (ai / ai-behavior).
  //
  // select >=240 and <= the field column (final fix wave, Ruling 29, F2):
  // the composer's `.fg select` rule is `width: max-content; min-width:
  // 240px; max-width: 100%` -- a floor, not the fixed ceiling this row used
  // to assert (batch-end review F2: a 240px fixed width hard-clipped
  // #opt-md-image-policy's ru option text with no ellipsis, since a
  // <select> computes overflow:visible and text-overflow is inert on it).
  // widthPx.min replaces widthPx.max: a select that somehow rendered
  // NARROWER than its own floor would be as real a regression as one that
  // grew wider. widthLteWith carries the OTHER half -- "never wider than
  // the column" -- compared live against its own `.fg`.
  // Stage-3b Task 2 (2026-09-24-ui-system-stage3b): this row used to be a
  // bare `.fg select`, leaning on "#opt-lang is the first `<select>` inside
  // a `.fg` in DOM order" -- true only while #opt-lang was still a plain
  // native select. This task turned #opt-lang into the row model's OWN
  // second `data-listbox` consumer (spec §3): listbox.js hides the
  // native `<select>` (`select.hidden = true`) and builds `#opt-lang-btn`
  // as its visible replacement, so the bare selector kept matching the now-
  // invisible native element and read a zero-size FAIL (`.fg select|
  // widthPx actual=null`) on every theme. Re-pointed to `#opt-ai-provider-
  // btn`'s own established shape (below) -- `#opt-lang-btn` reached via
  // `otherChecks`'s existing "#tab-general is the default active panel"
  // convention, same as the row it replaces, no new tab-click group needed.
  { surface: "options", page: "options.html", selector: "#opt-lang-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { min: 240 }, widthLteWith: { selector: ".fg:has(#opt-lang-btn)" } } },
  // .key-wrap <= its own column (password/API-key fields, fused with the eye
  // toggle -- COMPONENTS.md §8 -- the cap sits on the WRAPPER so the toggle
  // stays fused to the input's own right edge, not the field's full-width
  // box). Bare `.key-wrap` matches #opt-pinboard-token's wrap (general tab)
  // -- same selector string the two fusedStateStable entries above already
  // use, so this reuses that group's existing `#tab-general` click rather
  // than adding a third one.
  // Stage-3b Task 2: re-pinned from a literal `widthPx.max: 420` to
  // `widthLteWith` against its own `.fg` column -- the SAME re-pin Task 4
  // (ui-system-stage2, Controller ruling C, comment below) already gave
  // #fields-openai's key-wrap, for the identical reason: panel-general
  // joining the row model promoted #opt-pinboard-token's `.fg` to `.fg
  // entry-block` (spec §3), and `.entry-block > :is(input:not([type=
  // number]), .key-wrap) { max-width: none }` now reaches it too, so it
  // fills its column (measured: 790.67px on this audit's >=1040px viewport)
  // instead of capping at the old literal 420px ceiling.
  { surface: "options", page: "options.html", selector: ".key-wrap", state: "default",
    expect: { widthLteWith: { selector: ".fg:has(#opt-pinboard-token)" } } },
  // Fix round 1 (review MINOR finding 2) re-pinned the two rows below once
  // for the LEGACY (non-stage-0) `.fg select { width: max-content; min-
  // width: 240px; max-width: 100% }` / `.fg .key-wrap { max-width: 420px }`
  // rules, leaving a note for "whichever task migrates #opt-theme's panel
  // (appearance) or #dict-anki-key's panel (vocab)" to finish the job.
  // Stage-3b Task 4 is that task: both panels are now in the row model,
  // so `.entry-block > :is(input:not([type=number]), .key-wrap) {
  // max-width: none }` reaches both fields the same way it already reached
  // #opt-lang/#opt-pinboard-token (Task 2) and #fields-openai's key-wrap
  // (Task 4, ui-system-stage2) -- same re-pin, same reason, done here for
  // the last two representative ids.
  // #opt-theme -> #opt-theme-btn (listbox.js hides the native
  // <select> and builds the button as its visible replacement, the same
  // swap #opt-lang got above): widthPx.min:240 still holds (the stage-0
  // rule only lifts max-width, not the select-exception's own floor);
  // widthLteWith now compares against the button's own `.fg` column.
  { surface: "options", page: "options.html", selector: "#opt-theme-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { min: 240 }, widthLteWith: { selector: ".fg:has(#opt-theme-btn)" } } },
  // #dict-anki-key's key-wrap: same re-pin as #opt-pinboard-token's and
  // #fields-openai's key-wrap above -- a fixed max gives way to "never
  // wider than its own column" now that the wrap fills it.
  { surface: "options", page: "options.html", selector: ".key-wrap:has(#dict-anki-key)", tab: "vocab", state: "default",
    expect: { widthLteWith: { selector: ".fg:has(#dict-anki-key)" } } },
  // .fg-url (the three baseurl endpoints) and plain input[type=text] (the
  // Model field) both live on the AI Providers tab, inside #panel-ai;
  // #opt-openai-baseurl/#opt-openai-model specifically live inside
  // #fields-openai, which is `hidden` until the provider select is switched
  // to openai (options.js's updateProviderFields) -- scripts/ui-render-
  // audit.mjs's aiProviderChecks group does that switch once for these rows.
  // Task 4 (ui-system-stage2, Controller ruling C): #panel-ai is now in
  // the row model (Task 2), whose `.entry-block > :is(input:not([type=
  // number]), .key-wrap) { max-width: none }` rule (options.css) matches
  // BOTH of these at the SAME specificity as the generic per-kind tier rule
  // (`.fg input[type=text].fg-url`/`.fg input[type=text]:not(.fg-url)`,
  // retired in stage 3c -- neither selector exists in options.css any more)
  // the two literal ceilings below used to assert against -- source order
  // hands the win to the stage-0 rule, so both fields now fill their `.fg` column
  // instead of capping at a fixed px width, and the old `widthPx.max` rows
  // read FAIL across every theme (measured baseline: both render at
  // 757.33px, the #fields-openai `.pf`'s content width at this audit's
  // >=1040px viewport). Re-pinned to widthLteWith the field's OWN `.fg`
  // column (`.fg:has(#id)`, unique per id -- there is exactly one `.fg`
  // ancestor here, not a nested one) instead of a literal: the SAME "never
  // wider than the column" half `.fg select` above already asserts, just
  // against this row's own column rather than the shared General-tab
  // landmark -- this `.fg` sits inside a `.pf` provider sub-panel, a
  // DIFFERENTLY-padded (narrower) column than the General tab's, so reusing
  // the bare `.fg` selector here would compare against the wrong column.
  { surface: "options", page: "options.html", selector: "#opt-openai-baseurl", state: "default",
    expect: { widthLteWith: { selector: ".fg:has(#opt-openai-baseurl)" } } },
  { surface: "options", page: "options.html", selector: "#opt-openai-model", state: "default",
    expect: { widthLteWith: { selector: ".fg:has(#opt-openai-model)" } } },
  // The provider API-key `.key-wrap` (Task 4): the SAME stage-0 max-width:
  // none rule reaches `.key-wrap` too (it is the OTHER branch of the same
  // `:is()` list) -- #opt-openai-key's wrap is the representative instance,
  // scoped to #fields-openai so this row cannot collide with the bare
  // `.key-wrap` selector the General-tab row above already claims (first-
  // match-in-DOM-order would otherwise still land on #opt-pinboard-token,
  // never this one). The eye toggle stays fused to the input's own right
  // edge (COMPONENTS.md §8) regardless of which column width the wrap grows
  // to -- options.css's stage-0 CSS step re-declares `padding-right: 32px`
  // for `.key-wrap input` at the same specificity, source-order-last.
  { surface: "options", page: "options.html", selector: "#fields-openai .key-wrap", state: "default",
    expect: { widthLteWith: { selector: ".fg:has(#opt-openai-key)" } } },

  // ---- `.listbox` primitive (R4, ui-system-stage2 spec §3, COMPONENTS.md
  // §6.4 exception 2): the one drawn <select> this codebase allows. Two
  // consumers -- #opt-ai-provider (this tab) and #translate-target-lang
  // (Reader tab -- the density tier applies
  // there, see scripts/ui-render-audit.mjs's rung.densityComponents: a
  // `.listbox-btn` reads `var(--opt-control-h)` unconditionally, not gated
  // by the marker). The native <select> is `hidden` by the enhancer
  // (listbox.js), so a width/height row against the OLD select id
  // would read a zero-size element -- both rows below target the visible
  // `button.listbox-btn` instead. widthPx.min 240 + widthLteWith mirror the
  // `.fg select` exception row above (content-sized, never full-width);
  // hitRectMin proves the 24px hit floor on a control that is NOT icon-only
  // (family 4's automatic sweep only covers icon-only buttons).
  { surface: "options", page: "options.html", selector: "#opt-ai-provider-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { min: 240 },
      widthLteWith: { selector: ".fg:has(#opt-ai-provider-btn)" }, hitRectMin: { height: 24 } } },
  { surface: "options", page: "options.html", selector: "#translate-target-lang-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { min: 240 },
      widthLteWith: { selector: ".fg:has(#translate-target-lang-btn)" }, hitRectMin: { height: 24 } } },
  // ---- Value boxes (B+ field family 2026-09-28; stage 4, spec 2026-09-30-
  // ui-fields-stage4-design §2.1; COMPONENTS.md §6.1/§6.2/§9.1 law 9): token
  // IDENTITY of a value box's paints -- rest fill + one frame colour on all
  // four sides (collapsed into the fill, or the pilot frame), the same on
  // hover, and the one-colour focus frame -- on a plain entry-block text
  // field, a key-wrap secret, the textarea and the drawn listbox. Four sides,
  // not three plus a bottom edge: stage 4 retired the edge, and
  // borderSidesEqVar holds every side painted and equal. Contrast is
  // contrast-audit's field-* rows and family 14; these rows catch a
  // hand-written rule repainting a value box with a non-field token (the
  // stage-0 shape) or drawing one side apart (the B+ edge). ----
  { surface: "options", page: "options.html", selector: "#dict-anki-deck", tab: "vocab", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "options", page: "options.html", selector: "#dict-anki-deck", tab: "vocab", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "options", page: "options.html", selector: "#dict-anki-deck", tab: "vocab", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "options", page: "options.html", selector: "#dict-anki-key", tab: "vocab", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "options", page: "options.html", selector: "#dict-anki-key", tab: "vocab", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "options", page: "options.html", selector: "#dict-anki-key", tab: "vocab", state: "focusWithin", focusTarget: ":scope",
    expect: { borderSidesEqVar: "field-border-focus" } },
  { surface: "options", page: "options.html", selector: "#opt-custom-css", tab: "appearance", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "options", page: "options.html", selector: "#opt-custom-css", tab: "appearance", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "options", page: "options.html", selector: "#opt-custom-css", tab: "appearance", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  { surface: "options", page: "options.html", selector: "#opt-lang-btn", tab: "general", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "options", page: "options.html", selector: "#opt-lang-btn", tab: "general", state: "hover",
    expect: { bgEqVar: "field-bg-hover", borderSidesEqVar: "field-border-hover" } },
  { surface: "options", page: "options.html", selector: "#opt-lang-btn", tab: "general", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  // The sidebar search box (stage 4, spec 2026-09-30-ui-fields-stage4-design
  // §3.1 / §5.2): a value box outside .fg that joined the family at rest and
  // on focus -- and has no hover row, because it has no hover state (spec §6
  // item 3; ui-contract pins that no hover rule paints it). It sits outside
  // every .panel, so the row names a tab only to have one active.
  { surface: "options", page: "options.html", selector: "#options-search-input", tab: "general", state: "default",
    expect: { bgEqVar: "field-bg", borderSidesEqVar: "field-border" } },
  { surface: "options", page: "options.html", selector: "#options-search-input", tab: "general", state: "focusWithin", focusTarget: ":scope",
    expect: { focusRecipe: "bordered", bgEqVar: "field-bg-focus", borderSidesEqVar: "field-border-focus" } },
  // #test-gemini (Task 4): the FIRST `.btn.btn-sm` action inside #panel-ai,
  // reachable without switching the provider away from its gemini default --
  // scripts/ui-render-audit.mjs routes this row through the switchChecks
  // group (fresh page reload first, so gemini's default selection is
  // restored regardless of what the LATER aiProviderChecks group did to a
  // PRIOR theme's page). Proves the stage-0 `.btn-sm:not(.context-help-
  // toggle)` composer rung (calc(--opt-control-h - 4px) = 28 comfortable /
  // 24 compact) reaches a provider sub-panel's own action row, not just the
  // rows Task 2/3 already covered.
  { surface: "options", page: "options.html", selector: "#test-gemini", state: "default",
    expect: { heightPx: { comfortable: 28, compact: 24 } } },
  // Open state (Controller ruling C): a real keyboard Space press on the
  // focused #opt-ai-provider-btn (scripts/ui-render-audit.mjs's new "open"
  // state, next to the seedChecked machinery) exercises listbox.js's
  // onKeydown " " branch -- a DIFFERENT code path from the mouse click the
  // aiProviderChecks group's own provider switch already drives -- keeping a
  // real-keyboard assertion in the gate, not only a mouse one. Both rows
  // below share that one open popover: `.listbox-pop`'s border (spec §3's
  // popover chrome) and `.listbox-opt`'s row height (control-h, the same
  // density tier as the button).
  // borderRadiusPx (fixwave stage2): the popover shell's corner radius must
  // track this surface's live --opt-radius-lg rung (COMPONENTS.md §9), not a
  // literal px -- same theme-aware comparison insetBand.radiusVar already
  // uses for a list row's inset band, applied directly to the shell itself.
  // Stage-3b Task 2 (2026-09-24-ui-system-stage3b): selectors anchored off
  // #opt-ai-provider's own IDs instead of the bare `.listbox-pop`/
  // `.listbox-opt` classes (a `document.querySelector()`/`$eval()` "first in
  // DOM order" match used to land on #opt-ai-provider's popover/option
  // because it was the only `data-listbox` select ahead of
  // #translate-target-lang in options.html). Adding #opt-lang as a second
  // `data-listbox` select on the General tab, which precedes AI Providers in
  // the document, gave the page a SECOND `.listbox-pop`/`.listbox-opt` pair
  // that now sorts first -- the bare selectors silently matched #opt-lang's
  // own (closed) popover instead, so both the runner's tab-resolution
  // (`el.closest(".panel")`) AND runOneCheck's final measurement read the
  // wrong element (reproduced twice: "could not focus open.click target
  // #opt-ai-provider-btn", since the runner switched to #tab-general -- the
  // panel #opt-lang's popover actually belongs to -- instead of #tab-ai).
  // `#opt-ai-provider-btn + .listbox-pop` (root.append(btn, pop) in
  // listbox.js makes pop the button's own next sibling) and
  // `#opt-ai-provider-list .listbox-opt` (`list.id = \`${id}-list\``, same
  // file) are both anchored to #opt-ai-provider's own unique IDs, so they
  // stay correct no matter how many more `.listbox-pop`/`.listbox-opt`
  // instances later tabs add.
  { surface: "options", page: "options.html", selector: "#opt-ai-provider-btn + .listbox-pop", state: "open",
    open: { click: "#opt-ai-provider-btn" },
    expect: { borderTopWidthPx: { value: 1 }, borderRadiusPx: { radiusVar: "radius-lg" } } },
  { surface: "options", page: "options.html", selector: "#opt-ai-provider-list .listbox-opt", state: "open",
    open: { click: "#opt-ai-provider-btn" },
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  // ---- Library redesign T6 (spec §8.2, §9.2 last rows): the group filter is
  // a float listbox -- its popover is position: fixed in the top layer,
  // placed by pbpListboxPlace inside the viewport, so the detail pane's
  // overflow can no longer clip it. Opened by the runner's real Space press
  // (the `open` state); in the index's narrow form the button sits in the
  // Filter popover, which the runner reveals first (libRevealFilterSet).
  // Anchored to the select's own ids (`<id>-btn + .listbox-pop`,
  // `#<id>-list .listbox-opt`), same reason as the #opt-ai-provider rows. ----
  { surface: "library", page: "library.html", selector: "#vocab-group-filter-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  { surface: "library", page: "library.html", selector: "#vocab-group-filter-btn + .listbox-pop", state: "open",
    open: { click: "#vocab-group-filter-btn" },
    expect: { borderTopWidthPx: { value: 1 }, borderRadiusPx: { radiusVar: "radius-lg" }, computedPosition: "fixed", inViewport: {} } },
  { surface: "library", page: "library.html", selector: "#vocab-group-filter-list .listbox-opt", state: "open",
    open: { click: "#vocab-group-filter-btn" },
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  // ---- Library redesign T7a (spec §4.8, §8.2): the dictionary column. The
  // language list box opens in float mode like the group filter; the idle
  // "look up this word" button exists once a word is open ("-ref" in the
  // selector makes the runner open one). ----
  { surface: "library", page: "library.html", selector: "#vocab-lookup-lang-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-lang-btn + .listbox-pop", state: "open",
    open: { click: "#vocab-lookup-lang-btn" },
    expect: { borderTopWidthPx: { value: 1 }, borderRadiusPx: { radiusVar: "radius-lg" }, computedPosition: "fixed", inViewport: {} } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-lang-list .listbox-opt", state: "open",
    open: { click: "#vocab-lookup-lang-btn" },
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  { surface: "library", page: "library.html", selector: "#vocab-lookup-input", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  { surface: "library", page: "library.html", selector: "#vocab-ref-result .vocab-ref-idle", state: "default",
    expect: { textContrast: 4.5, iconContrast: 3, heightPx: { comfortable: 28, compact: 24 } } },
  // spec §9.2 (checklist :716-721 rewrite): paneFit's panes also cover the
  // dictionary column holding ANOTHER word's result. "-detail-" opens a word
  // first; the driver submits the other word and puts the column back after.
  { surface: "library", page: "library.html", selector: "#vocab-detail-pane (other word)", state: "paneFit",
    expect: { paneFit: { widths: [420, 861, 1280, 1600, 2560], tolerancePx: 1, panes: ["#vocab-detail-pane"], vocabLookupOther: "serendipity" } } },
  // ---- Library redesign T7b (spec §4.5, §9.2 G4 / G4b / G5): the word's
  // main column. The status button is the detail's one plain .btn (text +
  // icon on the sm rung); Edit groups wears the pressed fill while open. The
  // three geometry states drive LIB_SEED words at 2560x1300 and 1280x800
  // through their own drivers (scripts/ui-render-audit.mjs), default and
  // terminal only; "-detail-" in the selector opens the rich word first. ----
  { surface: "library", page: "library.html", selector: ".vocab-detail-status", state: "default",
    expect: { textContrast: 4.5, iconContrast: 3, iconVCenter: 1, heightPx: { comfortable: 28, compact: 24 } } },
  { surface: "library", page: "library.html", selector: ".vocab-detail-status", state: "focusWithin",
    focusTarget: ":scope", expect: { focusRecipe: "bordered" } },
  { surface: "library", page: "library.html", selector: '.vocab-detail-pane .vocab-edit-groups[aria-expanded="true"]', state: "default",
    expect: { bgEqVar: "btn-hover", textContrast: 4.5 } },
  { surface: "library", page: "library.html", selector: "#vocab-detail-pane", state: "displayInkTop", themes: ["", "terminal"],
    expect: { displayInkTop: { view: "vocab", sizes: [[2560, 1300], [1280, 800]],
      cases: ["cover", "曖昧", "呼吸", "constraint", "Übung"] } } },
  { surface: "library", page: "library.html", selector: "#vocab-detail-pane", state: "displayInkTop", themes: [""],
    expect: { displayInkTop: { view: "vocab", locale: "zh_CN", sizes: [[2560, 1300]], cases: ["constraint", "Übung"] } } },
  { surface: "library", page: "library.html", selector: "#vocab-detail-pane", state: "detailNegMargin", themes: ["", "terminal"],
    expect: { detailNegMargin: { sizes: [[2560, 1300], [1280, 800]], panes: ["#vocab-detail-pane"],
      cases: ["cover", "constraint"], openEditor: true } } },
  // G4b, notes half (final review #12): the excerpt jump buttons' and the
  // highlighter's cancelling margins, the title and "this page" column
  // pull-ups. notes-multi carries several excerpts (jump buttons, marks)
  // and, at 2560, the "this page" column.
  { surface: "library", page: "library.html", selector: ".notes-sheet", state: "detailNegMargin", themes: ["", "terminal"],
    expect: { detailNegMargin: { view: "notes", sizes: [[2560, 1300], [1280, 800]], panes: ["#notes-detail-pane"],
      cases: ["notes-cover", "notes-multi", "notes-solo", "notes-diacritic"] } } },
  { surface: "library", page: "library.html", selector: "#vocab-detail-pane", state: "libGeometry", themes: ["", "terminal"],
    expect: { libGeometry: { cases: [
      { width: 2560, height: 1300, term: "constraint", headPx: 72, ref: "beside", labelRightFromAxis: 96, tailGap: 32, mainPx: 840, containerPx: [1464, 4000] },
      // T8f (spec appendix 10-05, main column first): C 1366 sat in the old
      // 1280 dictionary tier with a 470px main column; it is the 1000 tier now,
      // 98px below the dictionary column's 1464 (review: not on the edge).
      { width: 1920, height: 1080, term: "constraint", headPx: 56, ref: "below", mainPx: 840, containerPx: [1000, 1464] },
      { width: 1280, height: 800, term: "constraint", headPx: 44, ref: "below", ringInside: [".vocab-detail-delete", ".vocab-note-input"], containerPx: [640, 1000] },
    ] } } },
  // ---- Library redesign T8f (spec appendix 10-05, diag-hang-order §6): every
  // hang label above its content or left of it on the content's first line,
  // by container width C -- each tier breakpoint at 1px steps (+-3), entered
  // from 200 above and below, measured in the width change's own task and
  // again once the page's observers have run; index-column and window
  // drivers (the window driver and the coarse settled pass on default only,
  // fullThemes); en / zh_CN / de x both densities. ----
  { surface: "library", page: "library.html", selector: ".lib-hang-label", state: "hangOrder", themes: ["", "terminal"],
    expect: { hangOrder: { view: "vocab", scenarios: ["constraint", "曖昧", "cover", "lookup", "editor"], indexWindows: [1600, 2560], fullThemes: [""] } } },
  { surface: "library", page: "library.html", selector: ".notes-excerpt-label", state: "hangOrder", themes: ["", "terminal"],
    expect: { hangOrder: { view: "notes", scenarios: ["days", "multi"], indexWindows: [1600, 2560], fullThemes: [""] } } },
  // The sort menu button's popover (T6b): the same panel family. Its trigger
  // is always on the filter row, never inside the Filter popover.
  { surface: "library", page: "library.html", selector: "#vocab-sort-btn + .listbox-pop", state: "open",
    open: { click: "#vocab-sort-btn" },
    expect: { borderTopWidthPx: { value: 1 }, borderRadiusPx: { radiusVar: "radius-lg" }, computedPosition: "fixed", inViewport: {} } },
  { surface: "library", page: "library.html", selector: "#vocab-sort-list .listbox-opt", state: "open",
    open: { click: "#vocab-sort-btn" },
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  // input[type=number] 96 (a handful of digits). #opt-ai-cache-duration lives
  // on the AI Behavior tab; scripts/ui-render-audit.mjs's aiBehaviorChecks
  // group clicks that tab once for this row. #opt-popup-width-custom (Popup
  // tab) is the one this batch deleted an inline `style="width:80px"` from --
  // both get the identical `.fg input[type="number"]` rule, max-width 96.
  // Re-pinned (Task 3, ui-system-stage3a-design §3, Controller ruling 1):
  // #panel-ai-behavior joined the row model in this task's Task 1, so
  // #opt-ai-cache-duration now ALSO renders through the same
  // row-model `.fg input[type=number]` height rule #opt-popup-width-
  // custom already proved below -- height tracks --opt-control-h (32
  // comfortable / 28 compact) instead of the fixed rung every non-stage-0
  // `.fg input[type=number]` renders at. Both rows now share the identical
  // expect shape; kept as two entries (one per tab, not folded into one)
  // since each still needs its own tab click to exist at all.
  { surface: "options", page: "options.html", selector: "#opt-ai-cache-duration", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { max: 96 } } },
  // #opt-popup-width-custom (Task 3, ui-system-stage0-design §4): lives
  // inside the row model (Task 2's Popup-tab row model), inline in the
  // custom radio's own label. max-width 96 is a literal (options.css's
  // stage-0 header comment lists it as one of the three named exceptions),
  // so it stays a flat widthPx bound.
  { surface: "options", page: "options.html", selector: "#opt-popup-width-custom", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { max: 96 } } },
  // Stage-3a (Task 3, ui-system-stage3a-design §3, Controller ruling 1): the
  // subordinate-indent census points -- one per DOM shape the spec's §2
  // "从属录入块"/"choice 帮助宿主进偏好行" rules introduced. Both read the SAME
  // fixed --opt-sp-7 (24px), never a density token (options.css keeps one
  // indent value in both tiers), unlike every heightPx row above.
  // `.entry-block-sub` shape: the block itself carries the padding (Reader's
  // "Model override (optional)" field, a plain entry-block-sub with no
  // context-help of its own -- picking a help-free instance isolates the
  // indent from the separate choice/field help-host padding-left overrides
  // in options.css's row-model block).
  { surface: "options", page: "options.html", selector: ".fg:has(#opt-preview-ai-model)", tab: "reader", state: "default",
    expect: { paddingLeftPx: { value: 24 } } },
  // `.pref-row-sub > label` shape: the indent lives on the label, not the row
  // div (unlike entry-block-sub above) -- #opt-urlclean-aggressive is Shape
  // E1 below (Popup tab, no help host), so this reuses that same census
  // point rather than adding a new id just for this assertion.
  { surface: "options", page: "options.html", selector: ".pref-row-sub > label:has(#opt-urlclean-aggressive)", tab: "popup", state: "default",
    expect: { paddingLeftPx: { value: 24 } } },

  // ---- `.switch` primitive (taste-uplift batch4 T1, COMPONENTS.md §6.1 /
  // §6.4 exception). Reference instance: #opt-tag-sort-by-pop on the Tags
  // tab (scripts/ui-render-audit.mjs's switchChecks group clicks #tab-tags).
  // Its storage default is ON (shared.js tagSortByPopEnabled: true), so both
  // fill rows seed `checked` explicitly instead of trusting the default.
  // Off (B', Ruling 36): a borderless 28x16 track filled with the neutral
  // --opt-border grey (contrast-audit gates `border vs panel >= 3`).
  { surface: "options", page: "options.html", selector: "#opt-tag-sort-by-pop ~ .switch-track", state: "default",
    seedChecked: { input: "#opt-tag-sort-by-pop", checked: false },
    expect: { heightPx: { value: 16 }, widthPx: { min: 28, max: 28 }, bgEqVar: "border" } },
  // On: the same track repaints to accent (contrast-audit gates `accent vs
  // panel >= 3` for the fill and `on-accent vs accent` for the thumb).
  { surface: "options", page: "options.html", selector: "#opt-tag-sort-by-pop ~ .switch-track", state: "checked",
    seedChecked: { input: "#opt-tag-sort-by-pop", checked: true },
    expect: { heightPx: { value: 16 }, bgEqVar: "accent" } },
  // Hit target: the transparent native input covers the row and overhangs
  // it 2px each way -- 24px tall on a 20px row.
  { surface: "options", page: "options.html", selector: "#opt-tag-sort-by-pop", state: "default",
    expect: { hitRectMin: { height: 24 } } },

  // ---- `.switch` rows, one per DOM shape (taste-uplift batch4 T2; the
  // reference instance above is shape D, `.fg > label`). Each shape reaches
  // the track through different containers -- a 20px `.choice-row` box, a
  // help-host label that also holds its help, a padded `.fg-stack` sub-row --
  // so each pins the same 28x16 off-state track and the 24px input hit rect. Off is seeded
  // explicitly (the ids below default off, but a storage default must not be
  // what makes the row pass). The runner's switchChecks group opens each
  // row's own tab after a fresh, theme-applied navigation.
  // Shape A (re-pinned, Task 3, ui-system-stage0-design §4): #opt-show-search
  // was "a plain choice row" (`.choice-row`) before Task 2 rebuilt the Popup
  // tab onto the stage-0 row model -- it now sits in a `.pref-row >
  // label.switch`, the FIRST row of its `.pref-group` (no hairline). The
  // container shape changed; the `.switch` primitive's own 28x16 track and
  // 24px hit rect this entry proves did not, so it stays that census point
  // under its new container instead of moving to a still-`.choice-row` id
  // elsewhere -- the stage0-pref-row-min/-rule entries near the number-field
  // block above separately cover the new row's own min-height/hairline/type.
  { surface: "options", page: "options.html", selector: "#opt-show-search ~ .switch-track", state: "default",
    seedChecked: { input: "#opt-show-search", checked: false },
    expect: { heightPx: { value: 16 }, widthPx: { min: 28, max: 28 }, bgEqVar: "border" } },
  { surface: "options", page: "options.html", selector: "#opt-show-search ~ .switch-track", state: "checked",
    seedChecked: { input: "#opt-show-search", checked: true },
    expect: { heightPx: { value: 16 }, bgEqVar: "accent" } },
  { surface: "options", page: "options.html", selector: "#opt-show-search", state: "default",
    expect: { hitRectMin: { height: 24 } } },
  // Shape C3 (census E-switch-census.md: choice row + help + indent): a
  // choice row that is also a contextual-help host, indented -- the label
  // spans the host and holds its own help between the copy and the track
  // (Ruling 36; Archive tab, "Also archive during batch save").
  { surface: "options", page: "options.html", selector: "#opt-wayback-batch ~ .switch-track", state: "default",
    seedChecked: { input: "#opt-wayback-batch", checked: false },
    expect: { heightPx: { value: 16 }, widthPx: { min: 28, max: 28 }, bgEqVar: "border" } },
  { surface: "options", page: "options.html", selector: "#opt-wayback-batch", state: "default",
    expect: { hitRectMin: { height: 24 } } },
  // Shape E1 (re-pinned, Task 3, ui-system-stage0-design §4): #opt-urlclean-
  // aggressive was "an indented `.fg-stack` sub-row" before Task 2 -- it now
  // sits in `.pref-row.pref-row-sub > label.switch`, a LATER row in its
  // `.pref-group` (so it DOES carry the 1px hairline, unlike Shape A above)
  // with its indent from `.pref-row-sub`'s own padding-left, not `.fg-stack`.
  // Same reasoning as Shape A: the container shape changed, the track/hit-
  // rect geometry did not, so this stays the indented-row census point.
  { surface: "options", page: "options.html", selector: "#opt-urlclean-aggressive ~ .switch-track", state: "default",
    seedChecked: { input: "#opt-urlclean-aggressive", checked: false },
    expect: { heightPx: { value: 16 }, widthPx: { min: 28, max: 28 }, bgEqVar: "border" } },
  { surface: "options", page: "options.html", selector: "#opt-urlclean-aggressive", state: "default",
    expect: { hitRectMin: { height: 24 } } },
  // Shape E2 (re-pinned, Task 3, ui-system-stage3a-design §3, controller
  // ruling 1 "keep the track rows"): #batch-ai-tags was "a `.fg-stack`
  // sub-row inside a group help host" before Task 1 rebuilt the Quick tab
  // onto the stage-0 row model -- it now sits in a plain `.pref-row >
  // label.switch` (no help host, no indent, the FIRST row of its
  // `.pref-group`), same reasoning as Shape A/E1 above: the container shape
  // changed, the track/hit-rect geometry this row censuses did not, so the
  // assertion values are untouched and only this comment is corrected.
  { surface: "options", page: "options.html", selector: "#batch-ai-tags ~ .switch-track", state: "default",
    seedChecked: { input: "#batch-ai-tags", checked: false },
    expect: { heightPx: { value: 16 }, widthPx: { min: 28, max: 28 }, bgEqVar: "border" } },
  { surface: "options", page: "options.html", selector: "#batch-ai-tags", state: "default",
    expect: { hitRectMin: { height: 24 } } },
  // Shape F1: a plain `.fg` that is a choice help host, no stack -- the label
  // takes its 20px min box and 2px padding from the help-host rule, not from
  // `.choice-row` (Appearance tab, "Extension pages follow the Pinboard theme
  // preset"). Its default is ON, hence the explicit off seed.
  { surface: "options", page: "options.html", selector: "#opt-popup-follow-theme ~ .switch-track", state: "default",
    seedChecked: { input: "#opt-popup-follow-theme", checked: false },
    expect: { heightPx: { value: 16 }, widthPx: { min: 28, max: 28 }, bgEqVar: "border" } },
  { surface: "options", page: "options.html", selector: "#opt-popup-follow-theme", state: "default",
    expect: { hitRectMin: { height: 24 } } },

  // ---- Stage-0 pref-row family (Task 3, spec 2026-09-23-ui-system-stage0-
  // design §4): the row model (every panel since stage 3c) Task 2 built --
  // every switch sits in `.pref-row > label.switch`, pinned at a 44px
  // (comfortable) / 36px (compact) min-height; every row after the first in
  // a non-radio `.pref-group` carries a literal 1px border-top hairline
  // (never a density token). Complements, not replaces, the re-pinned Shape
  // A/E1 entries above -- those prove the `.switch` TRACK survived the
  // container rebuild, these prove the new container's own geometry.
  // R9 (Task 3, spec 2026-09-23-ui-system-stage1-design §2.3/§3): a pref-row
  // that directly follows its section title drops its top padding and one
  // pad of min-height (32/28), so title -> first copy reads the same 12px
  // as an entry-block label. That reduced first row can no longer stand in
  // for "any" pref-row's min-height, so the entry below re-points off the
  // bare `.pref-row > label.switch` (which the audit's first-match rule
  // would now land on the shrunk row) onto `.pref-row + .pref-row >
  // label.switch` instead -- first match in DOM order is #opt-auto-close's
  // row (Popup Behavior section, same group, still the ordinary un-shrunk
  // 44/36 height). The hairline entry right after it already used the same
  // `+` combinator, so its own first match (also #opt-auto-close's row) is
  // untouched by R9. The new stage0-pref-row-first entry covers the shrunk
  // first-row shape itself: first match is #opt-show-search's row (Popup
  // Elements section, the first `.pref-row` right under
  // `h2#sec-popup-elements`).
  { surface: "options", page: "options.html", selector: '#panel-popup .pref-group:not(.pref-group-radio) > .pref-row + .pref-row > label.switch', tab: "popup", state: "default",
    expect: { minHeightPx: { comfortable: 44, compact: 36 }, fontSizePx: { comfortable: 14, compact: 13 }, hitRectMin: { height: 24 } } },
  { surface: "options", page: "options.html", selector: '#panel-popup .pref-group:not(.pref-group-radio) > .pref-row + .pref-row', tab: "popup", state: "default",
    expect: { borderTopWidthPx: { value: 1 } } },
  { surface: "options", page: "options.html", selector: '#panel-popup .settings-section > h2.section-title + .pref-group > .pref-row:first-child > label.switch', tab: "popup", state: "default",
    expect: { minHeightPx: { comfortable: 32, compact: 28 }, hitRectMin: { height: 24 } } },

  // ---- Stage-3b Task 1 pick family (spec 2026-09-24-ui-system-stage3b-
  // design §2, COMPONENTS.md §6.4 exception 3): the four radio groups
  // (bookmarks' bgsave-mode/tag-sync-mode, popup-width-preset,
  // ai-content-source) that moved from a bare `<label><input type=radio>`
  // onto `label.pick > input + .pick-text + .pick-mark`. bgsave-mode is the
  // representative group -- first `.pref-row > label.pick` in DOM order
  // inside #panel-bookmarks is opt-bgsave-merge's row, same first-match
  // discipline the switch family above already relies on.
  { surface: "options", page: "options.html", selector: "#panel-bookmarks .pref-row > label.pick", state: "default",
    expect: { minHeightPx: { comfortable: 44, compact: 36 }, hitRectMin: { height: 24 } } },
  // Unchecked mark: transparent fill (no bgEqVar to prove -- there IS no
  // background token at rest, only the ring), 20x20, --opt-border ring.
  // seedChecked pins it explicitly (same discipline as every switch-track
  // "default" entry above, not a hope that boot-time defaults leave it
  // this way) -- opt-bgsave-skip is never the page's default selection, so
  // this is also the negative control for the checked entry below.
  { surface: "options", page: "options.html", selector: "#opt-bgsave-skip ~ .pick-mark", state: "default",
    seedChecked: { input: "#opt-bgsave-skip", checked: false },
    expect: { widthPx: { min: 20, max: 20 }, heightPx: { value: 20 }, borderColorEqVar: "border" } },
  // Checked mark: accent fill. opt-bgsave-merge IS the page's real default
  // (SETTINGS_DEFAULTS bgSaveMode: "merge"), seeded anyway for the same
  // determinism reason -- a prior check in the same run must not be able to
  // leave this ambiguous.
  { surface: "options", page: "options.html", selector: "#opt-bgsave-merge ~ .pick-mark", state: "checked",
    seedChecked: { input: "#opt-bgsave-merge", checked: true },
    expect: { bgEqVar: "accent" } },
  // Stage 3c (N2): a trusted ArrowDown inside the bgsave-mode .pick group
  // moves the checked radio -- the hidden-native-input recipe keeps native
  // radio-group keyboard navigation.
  { surface: "options", page: "options.html", selector: "#opt-bgsave-merge", state: "arrowDown", tab: "bookmarks",
    expect: { arrowDown: { checked: "#opt-bgsave-skip" } } },

  // ---- Stage-3b Task 5 (2026-09-24-ui-system-stage3b): gate-closing rows
  // for storage/vocab/markdown/general, plus the two remaining new listbox
  // buttons (`#opt-theme-btn` above is already pinned by Task 4). Before this
  // task NOTHING in this file asserted heightPx on a plain `.fg.entry-block
  // input[type=text|password]` -- every existing 32/28 heightPx row is
  // either a `.listbox-btn` or an `input[type=number]`, both of which have
  // their OWN dedicated options.css rule; the shared row-model `.fg
  // :is(input[type="text"], input[type="password"], input[type="number"])
  // { height: var(--opt-control-h) }` rule (options.css) had zero live
  // coverage for its text/password branch until now.

  // #opt-md-image-policy-btn: the markdown panel's own listbox button
  // (listbox.js hides the native <select>, same swap #opt-lang/
  // #opt-theme already got) -- same shape as #opt-ai-provider-btn/
  // #translate-target-lang-btn above.
  { surface: "options", page: "options.html", selector: "#opt-md-image-policy-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { min: 240 },
      widthLteWith: { selector: ".fg:has(#opt-md-image-policy-btn)" }, hitRectMin: { height: 24 } } },
  // #obsidian-vault: markdown's entry-block field representative (a Send-to
  // card text field, `div.fg.entry-block.et-field`, inside the closed
  // "Obsidian" disclosure -- scripts/ui-render-audit.mjs's switchChecks group
  // reaches it the same way it already reaches #dict-anki-key's disclosure).
  { surface: "options", page: "options.html", selector: "#obsidian-vault", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  // #obsidian-route-btn: the one select-type Send-to field (export-
  // targets.js's `route` setting), enhanced into a listbox by
  // options.js's renderExportTargets() once its card is connected -- proves
  // a JS-BUILT (not static-HTML) select gets the same listbox-button
  // geometry as every static one above.
  { surface: "options", page: "options.html", selector: "#obsidian-route-btn", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 }, widthPx: { min: 240 },
      widthLteWith: { selector: ".fg:has(#obsidian-route-btn)" }, hitRectMin: { height: 24 } } },
  // #dict-anki-deck: vocab's entry-block field representative (Vocabulary
  // tab, "Export and integrations" disclosure -- same closed-disclosure
  // shape as #dict-anki-key's already-covered `.key-wrap` one panel field
  // over).
  { surface: "options", page: "options.html", selector: "#dict-anki-deck", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  // #opt-pinboard-token: general's entry-block field representative -- an
  // input[type=password] (the OTHER branch of the shared :is() rule
  // #obsidian-vault/#dict-anki-deck prove the input[type=text] branch of).
  // Reached via otherChecks: General is the default active tab, and
  // keyWrapChecks (immediately above in the runner, `.key-wrap` bare
  // selector -- this same field's OWN wrapper) already clicks `#tab-general`
  // right before otherChecks runs, same convention `#opt-lang-btn` relies on.
  { surface: "options", page: "options.html", selector: "#opt-pinboard-token", state: "default",
    expect: { heightPx: { comfortable: 32, compact: 28 } } },
  // Storage's `.pick.pick-box` category rows (renderStoragePanel(), Task 2 of
  // this same 3b batch): first `.pref-row > label.pick.pick-box` in DOM order
  // inside `#storage-cats`, same first-match discipline the bookmarks `.pick`
  // row above already relies on. Row geometry comes from the SAME generic
  // row-model `.pref-row > label { min-height: var(--opt-row-min-h) }`
  // rule `#panel-bookmarks .pref-row > label.pick` proves -- this is coverage
  // for a SECOND pick-box family (storage's cache categories) on a THIRD
  // panel, not a new CSS rule. Storage/vocab/markdown have no other
  // `.pick.pick-box` family (spec 2026-09-24-ui-system-stage3b-design §3);
  // general's own one (the backup-import preview's `#backup-section-*`
  // checkboxes) sits behind an actual JSON-import preview render with no
  // reachable trigger in this harness's page setup, so it is not pinned here
  // -- flagged for the controller rather than forced (task-5-report.md).
  // The FIRST storage row is a title-led R9 row (the group sits right under
  // the Storage Management title, inside `#storage-cats`; final whole-stage
  // review S1 widened R9 to that wrapper), so its label carries
  // `--opt-row-min-h - --opt-row-pad-y` = 32/28 -- this row is the pin for
  // S1's storage half. The second category row is the plain 44/36 pick-box
  // geometry the bookmarks row proves; anchored by position so a first-match
  // shift cannot silently swap the two contracts.
  { surface: "options", page: "options.html", selector: "#storage-cats .pref-row > label.pick.pick-box", tab: "storage", state: "default",
    expect: { minHeightPx: { comfortable: 32, compact: 28 }, hitRectMin: { height: 24 } } },
  { surface: "options", page: "options.html", selector: "#storage-cats .pref-row:nth-child(2) > label.pick.pick-box", tab: "storage", state: "default",
    expect: { minHeightPx: { comfortable: 44, compact: 36 }, hitRectMin: { height: 24 } } },
];

// Hand-copied literal `data-theme` values, verified at authoring time with:
//   grep -o '\[data-theme="[a-z0-9-]*"\]' library.css options.css popup.css
// (all three files emit the identical 14-value set) -- NOT parsed/imported
// at runtime, per the independence rule at the top of this file. This is the
// same umbrella-vs-variant split scripts/qa-drive.mjs:809-826 documents: 8
// fixed presets (dracula/github-light/gruvbox-dark/modern-card/nord-night/
// paper-ink/rose-pine/terminal) + 3 adaptive umbrellas (flexoki/solarized/
// catppuccin), each of which expands to a light+dark variant = 14 real
// data-theme strings. "13 套主题" (CLAUDE.md) counts pilot *files*
// (docs/theme-surface/pilots/*.tokens.json) -- flexoki is ONE pilot file
// with a `modes.dark` block that still renders TWO selectors, so the
// rendered-selector count is 14, not 13; both numbers are correct, they're
// just counting different things. On top of the 14: "" is the undecorated
// default-light surface (no data-theme attribute). There is no bare-dark
// state on any surface any more: the no-preset+dark combination resolves to
// data-theme="flexoki-dark" on popup, options and library alike
// (popup-theme-early.js / options-theme-early.js, theme model 2026-08-25,
// batch 2 D6), which the "flexoki-dark" entry below already covers; the
// popup's former hand-maintained `html.dark` block was retired with it.
export const THEMES = [
  "",                  // default light -- no data-theme attribute
  "catppuccin-latte", "catppuccin-mocha",
  "dracula",
  "flexoki-light", "flexoki-dark",
  "github-light",
  "gruvbox-dark",
  "modern-card",
  "nord-night",
  "paper-ink",
  "rose-pine",
  "solarized-light", "solarized-dark",
  "terminal",
];
