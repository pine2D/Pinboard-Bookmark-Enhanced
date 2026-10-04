// docs/theme-surface/composers/ui-components.mjs
//
// SINGLE SOURCE for the `@generated:ui-components` region's structural CSS
// recipes (button/chip/danger/form-field geometry + state feedback) and the
// spacing adapter that maps px semantics onto each surface's --{ns}-sp-*
// scale. Authority: docs/theme-surface/COMPONENTS.md — every recipe here is
// a direct transcription of that doc's fenced ```css blocks, parameterized
// by `ns` ("pp" | "opt" | "lib").
//
// tools/recipe-lint.mjs statically checks this file (both its literal
// source text and its rendered output). tests/render-audit-checklist.mjs is
// a SEPARATE, hand-written render oracle — never generate it from this file
// (see that file's own header for why: a checklist mechanically derived
// from the recipe would pass by construction and couldn't catch a recipe
// bug).
//
// Task 8 scope: this file is complete and fully checked by recipe-lint, but
// tools/apply-ui-themes.mjs's three new SURFACES entries call
// renderComponents(ns, []) — i.e. no families active — so the three CSS
// files' @generated:ui-components regions stay empty (placeholder comment
// only) after this lands. Task 9 flips families on one at a time by editing
// ACTIVE_COMPONENT_FAMILIES in apply-ui-themes.mjs, deleting the
// hand-written rules each family supersedes in the same commit.

import { PRIMARY_HOVER_FG_MIX } from "./_ui-derive.mjs";
// `.btn.primary:hover`'s `color-mix(...)` percentage, derived from the SAME
// constant _ui-derive.mjs's on-accent derivation reads (finalizeUiControlRoles)
// and contrast-audit.mjs's "on-accent vs primary-hover" gate checks against --
// one source, three consumers, so the recipe's emitted percentage can never
// drift out of step with what the contrast math actually assumes.
const PRIMARY_HOVER_ACCENT_PCT = Math.round((1 - PRIMARY_HOVER_FG_MIX) * 100);

// -----------------------------------------------------------------------
// Spacing adapter (COMPONENTS.md "记号约定"): recipes declare padding/gap in
// px semantics; this maps each px value to the surface token of EQUAL
// numeric value. Never translate --sp-N *names* across surfaces — the three
// scales don't line up rung-for-rung (popup/options are 7-step 2/4/6/8/12/
// 16/24, library is 10-step 2/4/8/12/16/24/32/48/64/96 -- sp-0 is its
// hairline, added 2026-09-06 when nine hand rules turned out to borrow the
// value; sp-6..9 are the layout rungs of the 2026-10-03 library redesign). A
// px value with no matching rung on a given surface falls back to a literal
// px (library has no 6 rung).
export const SPACING = {
  pp: {
    2: "var(--pp-sp-1)", 4: "var(--pp-sp-2)", 6: "var(--pp-sp-3)",
    8: "var(--pp-sp-4)", 12: "var(--pp-sp-5)", 16: "var(--pp-sp-6)", 24: "var(--pp-sp-7)",
  },
  opt: {
    2: "var(--opt-sp-1)", 4: "var(--opt-sp-2)", 6: "var(--opt-sp-3)",
    8: "var(--opt-sp-4)", 12: "var(--opt-sp-5)", 16: "var(--opt-sp-6)", 24: "var(--opt-sp-7)",
  },
  lib: {
    2: "var(--lib-sp-0)", 4: "var(--lib-sp-1)", 8: "var(--lib-sp-2)", 12: "var(--lib-sp-3)",
    16: "var(--lib-sp-4)", 24: "var(--lib-sp-5)", 32: "var(--lib-sp-6)", 48: "var(--lib-sp-7)",
    64: "var(--lib-sp-8)", 96: "var(--lib-sp-9)",
  },
};
export const sp = (ns, px) => SPACING[ns][px] ?? `${px}px`;

// Per-surface token NAME differences for the same role. popup spells the two
// control-frame roles with a `-bd` suffix (--pp-btn-bd; the input-bd twin is
// no longer a CSS variable since stage 4 -- popup's value boxes read
// --pp-field-border through FIELD_TARGETS) --
// COMPONENTS.md §9.1 law 1 states this explicitly ("popup 用自己的 -bd 后缀"),
// and those are the names popup-chrome.mjs emits per theme. A recipe that
// spelled `--pp-btn-border` would reference a token no theme defines: not a
// silent wrong colour but a hard ui-token-coverage failure, which is the good
// outcome -- still, the recipe has to ask for the name that exists. Roles with
// no entry here fall through unchanged.
const TOKEN_ALIAS = {
  pp: { "btn-border": "btn-bd" },
  opt: {},
  lib: {},
};
const v = (ns, role) => `var(--${ns}-${TOKEN_ALIAS[ns][role] ?? role})`;

// Motion token per surface (COMPONENTS.md "记号约定": options/library share
// --motion-state, popup has its own --pp-motion-state).
const MOTION = { pp: "var(--pp-motion-state)", opt: "var(--motion-state)", lib: "var(--motion-state)" };
const motion = ns => MOTION[ns];

// -----------------------------------------------------------------------
// Tiny rule-group builder. A "rule" is one CSS block; recipes group related
// rules (base + :hover/:active/:focus-visible/:disabled + chrome variants
// like .ghost) so tools/recipe-lint.mjs can enforce COMPONENTS.md §7.1's
// "paired consumption law" (any rule declaring background/background-color
// must have a color declaration to pair with) without re-deriving CSS
// cascade/specificity from scratch. `pairColorWith` is set explicitly (not
// inferred from the selector string) when a rule's color legitimately comes
// from a DIFFERENT rule in the same recipe that the same element also
// matches (e.g. .btn.ghost has no color of its own — it inherits .btn's).
//
// `media` wraps the rule in one grouping at-rule (the .switch family's
// forced-colors fallback is the only user). Consecutive rules sharing the
// same `media` string are emitted inside ONE @media block, so the rendered
// region reads like hand-written CSS rather than one @media per rule.
function rule(selector, decls, { pairColorWith = null, media = null } = {}) {
  return { selector, decls, pairColorWith, media };
}
function stringifyRule({ selector, decls }, indent = "") {
  const body = decls.map(([prop, value]) => `${indent}  ${prop}: ${value};`).join("\n");
  return `${indent}${selector} {\n${body}\n${indent}}`;
}
function stringifyRules(rules) {
  const out = [];
  for (let i = 0; i < rules.length;) {
    const media = rules[i].media;
    if (!media) { out.push(stringifyRule(rules[i])); i++; continue; }
    const group = [];
    while (i < rules.length && rules[i].media === media) group.push(rules[i++]);
    out.push(`@media ${media} {\n${group.map(r => stringifyRule(r, "  ")).join("\n")}\n}`);
  }
  return out.join("\n");
}

// -----------------------------------------------------------------------
// §1 + §3: button family (structural geometry + state-feedback recipe,
// COMPONENTS.md §1.2/§1.3/§3.2 — the two sections share one recipe, §3.2
// says so explicitly).
//
// popup joined this family in the popup button-family campaign (C4a),
// retiring §0's "popup 没有 .btn 族" exemption. It is emitted for pp exactly
// as for the other two -- the exemption was about popup having six one-off
// button recipes with no shared class, not about popup wanting a different
// geometry. What is NOT claimed here: adding the class to a given popup
// button is a per-button migration with its own layout consequences, so the
// hand-written recipes that have not been migrated yet keep their own rules
// and simply never match `.btn`.
function btnRules(ns) {
  return [
    rule(".btn", [
      ["display", "inline-flex"],
      ["align-items", "center"],
      ["justify-content", "center"],
      ["gap", sp(ns, 4)],
      ["padding", `${sp(ns, 4)} ${sp(ns, 16)}`],
      ["font-size", "12px"],
      ["line-height", "16px"],
      ["font-family", "inherit"],
      // <a class="btn"> (shortcut / library / settings links) must not carry
      // the UA underline; options.html used to patch each one inline.
      ["text-decoration", "none"],
      ["cursor", "pointer"],
      // Soft Fill (COMPONENTS.md §9 law 1): the resting border-color collapses INTO
      // the fill. --{ns}-btn-border IS --{ns}-btn-bg for every theme except
      // the ones whose pilot restores a real frame (terminal). border-width
      // stays 1px so the collapse costs zero layout shift, and :hover /
      // :focus-visible / .danger still paint a real edge on top of it.
      ["border", `1px solid ${v(ns, "btn-border")}`],
      ["border-radius", `var(--${ns}-radius-md)`],
      ["background", `var(--${ns}-btn-bg)`],
      ["color", `var(--${ns}-btn-fg)`],
      ["transition", `background ${motion(ns)}, border-color ${motion(ns)}, color ${motion(ns)}, box-shadow ${motion(ns)}`],
    ]),
    rule(".btn:hover:not(:disabled)", [["background", `var(--${ns}-btn-hover)`]], { pairColorWith: ".btn" }),
    // Not transitioned — §3.1 decision #1/#2: press must read instantly.
    rule(".btn:active:not(:disabled)", [["transform", "scale(0.97)"]]),
    // §7.3 `bordered` placement (2026-08-06 focus-language unification). The
    // .btn family's resting frame is CHROME (--{ns}-btn-border, which Soft
    // Fill collapses into the fill), so focus re-tints that frame and adds
    // the surface's glow instead of stacking a hard rectangle outside it.
    // Both values are consumed as tokens, never expanded: --{ns}-focus-ring's
    // SHAPE is per-theme identity (terminal's phosphor blur, paper-ink's flat
    // 1px, solarized's 2px translucent), and inlining it would flatten 13
    // presets into one look.
    rule(".btn:focus-visible", [
      ["outline", "none"],
      ["border-color", `var(--${ns}-focus-bd)`],
      ["box-shadow", `var(--${ns}-focus-ring)`],
    ]),
    // :disabled opacity intentionally drops contrast — WCAG 1.4.3 exempts
    // disabled controls; render oracle must skip this state (§3.4).
    rule(".btn:disabled", [["opacity", "0.45"], ["cursor", "not-allowed"]]),
    rule(".btn-sm", [["padding", `${sp(ns, 2)} ${sp(ns, 8)}`], ["font-size", "11px"], ["line-height", "14px"]]),
    // Ghost chrome — a third shell orthogonal to the rung, not a new family.
    // No color of its own: relies on .btn's (an element with class="btn
    // ghost" matches both selectors; .btn supplies color).
    rule(".btn.ghost", [["background", "transparent"], ["border-color", "transparent"]], { pairColorWith: ".btn" }),
    rule(".btn.ghost:hover:not(:disabled)", [
      ["background", `color-mix(in srgb, var(--${ns}-fg) 6%, var(--${ns}-bg))`],
    ], { pairColorWith: ".btn" }),
    // Ghost's `border-color: transparent` is (0,2,0) and is emitted AFTER
    // `.btn:focus-visible` (also (0,2,0)), so source order alone would hand
    // the resting transparent frame the win during focus and leave the
    // bordered placement with nothing but its glow. Restated at (0,3,0) so
    // the outcome is decided by specificity, not by where in this file the
    // rules happen to sit (COMPONENTS.md §8.6: "别赌源序").
    rule(".btn.ghost:focus-visible", [["border-color", `var(--${ns}-focus-bd)`]], { pairColorWith: ".btn" }),
    // Tonal chrome -- the affirmative action that REPEATS down a list (tag
    // governance's "Merge into X" on every row). A filled accent primary is
    // capped at one per view; stacking five of them reads as five competing
    // calls to action, so the repeated one takes the chip pair instead. Both
    // colour pairs it can show are already token-audited for every surface:
    // chip-fg/chip-bg and chip-fg/btn-hover (contrast-audit
    // COMPONENT_PAIR_SPEC), so this adds no new colour role.
    // border-color collapses into the fill like every Soft Fill control
    // (COMPONENTS.md §9.1 law 1).
    rule(".btn.tonal", [
      ["background", `var(--${ns}-chip-bg)`],
      ["border-color", `var(--${ns}-chip-bg)`],
      ["color", `var(--${ns}-chip-fg)`],
      ["font-weight", "600"],
    ]),
    // `.btn:hover:not(:disabled)` (0,3,0) already wins the background, but it
    // sets no border-color, so the resting chip-bg frame would survive as a
    // lighter ring around the hover fill. Restated at (0,4,0).
    rule(".btn.tonal:hover:not(:disabled)", [
      ["background", `var(--${ns}-btn-hover)`],
      ["border-color", `var(--${ns}-btn-hover)`],
    ], { pairColorWith: ".btn.tonal" }),
    // Same source-order trap as .btn.ghost above: `.btn.tonal` (0,2,0) is
    // emitted after `.btn:focus-visible` (0,2,0) and would keep its chip-bg
    // frame during focus. Decided by specificity, not by file position.
    rule(".btn.tonal:focus-visible", [["border-color", `var(--${ns}-focus-bd)`]], { pairColorWith: ".btn.tonal" }),
    // Primary chrome -- the one committing action of a flow (apply an import,
    // save a note). At most one per view; a repeated affirmative action takes
    // `.tonal` instead. Filled accent, frame collapsed into the fill (§9.1 law 1).
    ...(ns === "pp" ? [] : [
      rule(".btn.primary", [
        ["background", `var(--${ns}-accent)`],
        ["border-color", `var(--${ns}-accent)`],
        ["color", `var(--${ns}-on-accent)`],
        ["font-weight", "600"],
      ]),
      // (0,4,0): beats `.btn:hover:not(:disabled)` (0,3,0), which would otherwise
      // repaint a filled accent button with the neutral btn-hover fill.
      rule(".btn.primary:hover:not(:disabled)", [
        ["background", `color-mix(in srgb, var(--${ns}-accent) ${PRIMARY_HOVER_ACCENT_PCT}%, var(--${ns}-fg))`],
        ["border-color", `color-mix(in srgb, var(--${ns}-accent) ${PRIMARY_HOVER_ACCENT_PCT}%, var(--${ns}-fg))`],
      ], { pairColorWith: ".btn.primary" }),
      rule(".btn.primary:focus-visible", [["border-color", `var(--${ns}-focus-bd)`]], { pairColorWith: ".btn.primary" }),
    ]),
    // Options density rung (COMPONENTS.md §1.1 two tiers): the options button
    // family reads the density tokens; the help toggle keeps its 24px icon
    // target and the legacy sm rung. Library takes its own branch below;
    // popup stays on the legacy 26/20 rung.
    ...(ns === "opt" ? [
      rule(".btn:not(.context-help-toggle)", [
        ["height", "var(--opt-control-h)"],
        ["padding", "0 var(--opt-control-pad-x)"],
        ["font-size", "var(--opt-text-body)"],
        ["line-height", "calc(var(--opt-control-h) - 2px)"],
      ]),
      rule(".btn-sm:not(.context-help-toggle)", [
        ["height", "calc(var(--opt-control-h) - 4px)"],
        ["padding", `0 ${sp(ns, 8)}`],
        // Density-tracking, not a fixed 13px: comfortable body is 14px so
        // this reads 13px there (one step under the primary .btn face);
        // compact body is 13px so this reads 12px, still one step under --
        // the old literal 13px only matched the compact tier and left
        // .btn-sm the SAME size as .btn under comfortable density.
        ["font-size", "calc(var(--opt-text-body) - 1px)"],
        ["line-height", "calc(var(--opt-control-h) - 6px)"],
      ]),
    ] : []),
    // Library density rung (library redesign 2026-10-03 spec §6.2): the same
    // two tiers as options, read from the --lib-* density tokens
    // (html[data-density="compact"] is written on library.html by
    // options-theme-early.js too). Plain `.btn` / `.btn-sm`, emitted after
    // the base rules above so the same specificity resolves by order inside
    // this one generated region -- library has no help toggle to exclude.
    // box-sizing is load-bearing: library has no global `*` rule, and its two
    // <a class="btn btn-sm"> links are content-box under the UA, so a bare
    // height would render them 2px taller than every <button>.
    ...(ns === "lib" ? [
      rule(".btn", [
        ["box-sizing", "border-box"],
        ["height", "var(--lib-control-h)"],
        ["padding", "0 var(--lib-control-pad-x)"],
        ["font-size", "var(--lib-text-body)"],
        ["line-height", "calc(var(--lib-control-h) - 2px)"],
      ]),
      rule(".btn-sm", [
        ["box-sizing", "border-box"],
        ["height", "calc(var(--lib-control-h) - 4px)"],
        ["padding", "0 var(--lib-control-pad-x-sm)"],
        ["font-size", "calc(var(--lib-text-body) - 1px)"],
        ["line-height", "calc(var(--lib-control-h) - 6px)"],
      ]),
    ] : []),
  ];
}

// -----------------------------------------------------------------------
// §2: .btn-ic (icon inside a button). The ONLY family popup participates in
// this campaign. options/library share one recipe (gap comes from the host
// .btn's flex gap); popup's hosts aren't flex containers, so it keeps its
// own baseline-compensation + margin-right variant (§2.1).
function btnIcRules(ns) {
  if (ns === "pp") {
    return [
      rule(".btn-ic", [
        ["display", "inline-flex"], ["align-items", "center"],
        ["vertical-align", "-3px"], ["margin-right", sp(ns, 4)],
      ]),
      rule(".btn-ic svg", [["display", "block"]]),
    ];
  }
  return [
    rule(".btn-ic", [["display", "inline-flex"], ["align-items", "center"]]),
    rule(".btn-ic svg", [["display", "block"]]),
  ];
}

// -----------------------------------------------------------------------
// §4: danger operations, two tiers.
//
// The SOLID tier (.confirm-popover .confirm-yes) is emitted for all three
// surfaces. popup's exemption in §0 ("popup 的 .confirm-popover 是
// warn-on-warn ... §4 的危险两档不适用于 popup") described the state of the
// code, not a design position: under all 13 presets popup painted its
// confirm button `background: var(--pp-warn-fg); color: var(--pp-warn-bg)`,
// so the button that performs an irreversible delete signalled "notice"
// rather than "danger". No gate could see it -- the warn pair measures
// 4.5-5.2:1 on every theme, so contrast was never the problem. Retiring the
// exemption is the popup button-family campaign's C3a.
//
// The QUIET tier is emitted for all three too, as of C4a: it is defined ON
// `.btn.danger`, so it was held back only while popup had no `.btn` class at
// all -- popup.html's Delete button now carries `class="btn danger"` and
// consumes it. (This comment said "options+library-only" for one commit too
// long; a single source whose prose contradicts its own emitted bytes is the
// exact failure mode CLAUDE.md's "文本 grep 覆盖判定必被注释击穿" is about.)
function dangerRules(ns) {
  const solid = [
    // Solid tier -- the only allowed full-strength red. Self-paired.
    rule(".confirm-popover .confirm-yes", [
      ["background", `var(--${ns}-danger)`],
      ["color", `var(--${ns}-on-danger)`],
      ["border-color", `var(--${ns}-danger)`],
    ]),
    // Hover keeps the background and adds an inset ring -- no color change,
    // so no background/color pairing to check here.
    rule(".confirm-popover .confirm-yes:hover", [
      ["box-shadow", `inset 0 0 0 1px var(--${ns}-on-danger)`],
    ]),
  ];
  return [
    rule(".btn.danger", [
      ["color", `var(--${ns}-danger-quiet-fg)`],
      ["border-color", `color-mix(in srgb, var(--${ns}-danger) 55%, var(--${ns}-border))`],
    ]),
    rule(".btn.danger:hover:not(:disabled)", [
      ["background", `color-mix(in srgb, var(--${ns}-danger) 8%, var(--${ns}-btn-bg))`],
    ], { pairColorWith: ".btn.danger" }),
    rule(".btn.danger.ghost", [
      ["border-color", "transparent"], ["background", "transparent"],
    ], { pairColorWith: ".btn.danger" }),
    rule(".btn.danger.ghost:hover:not(:disabled)", [
      ["background", `color-mix(in srgb, var(--${ns}-danger) 8%, var(--${ns}-bg))`],
      ["border-color", `color-mix(in srgb, var(--${ns}-danger) 45%, transparent)`],
    ], { pairColorWith: ".btn.danger" }),
    // Focus wins the frame for the WHOLE .btn family, danger tiers included:
    // `.btn.danger` (0,2,0) and `.btn.danger.ghost` (0,3,0) are emitted after
    // the btn family's `:focus-visible`, so without these two the quiet-danger
    // edge would out-rank the focus border and a focused delete button would
    // show glow-only. The tier is not lost — it still reads through
    // --{ns}-danger-quiet-fg on the label and the danger hover fill — and a
    // focus indicator that means the same thing everywhere beats one that
    // silently degrades on exactly the buttons with the worst consequences.
    rule(".btn.danger:focus-visible", [["border-color", `var(--${ns}-focus-bd)`]], { pairColorWith: ".btn.danger" }),
    // `:not(:disabled)` here is a SPECIFICITY lever, not a state filter (a
    // :disabled element cannot match :focus-visible in the first place).
    // `.btn.danger.ghost:hover:not(:disabled)` above is (0,5,0) and is the
    // only hover rule in this family that touches border-color, so a (0,4,0)
    // focus patch lost the border whenever a ghost-danger button was hovered
    // AND focused -- i.e. exactly when a pointer user tabs to the delete
    // button they are already pointing at. Now (0,5,0) and emitted after it.
    rule(".btn.danger.ghost:focus-visible:not(:disabled)", [["border-color", `var(--${ns}-focus-bd)`]], { pairColorWith: ".btn.danger" }),
    ...solid,
  ];
}

// -----------------------------------------------------------------------
// §5: chip / badge geometry. Concrete selectors are named in COMPONENTS.md
// Appendix C (C8/C9/C10) — the only chip sites this campaign already
// committed to. popup's C11 (`.tag-item`) is explicitly "记账" (bookkeeping
// only; Task 9 decides whether it's in scope), so it's deliberately absent
// from CHIP_TARGETS rather than guessed at here. `.vocab-status-chip` is
// Appendix A3's open design question ("chip family or plain text?") — not
// listed here for the same reason. `.stag` (popup suggest/AI tag chips,
// D6/D7, taste-uplift batch3 Task 5) is a SEPARATE site from C11's
// `.tag-item` bookkeeping chip and is now in scope on its own decision.
//
// CHIP_GEOM holds only the two values every chip target genuinely shares
// (COMPONENTS.md §5.1 laws 1/3: vertical padding >= 2px, line-height pins the
// row-box height). Horizontal padding and font-size are NOT cross-target
// invariants — Appendix C gives each target its own regulation value (C8
// keeps its container-inherited font-size, C9's padding is 8px not 10px,
// C10's font-size stays 10px) — so those live per-entry on CHIP_TARGETS.
// recipe-lint re-derives law 2 from padV/lineHeight instead of trusting a
// canned radius, so a future edit here that breaks it fails loudly.
export const CHIP_GEOM = { padV: 2, lineHeight: 14 };
export const CHIP_TARGETS = [
  // C8: padding 2px 10px, radius-full; font-size NOT emitted (§5.2/C8: "字号仍继承容器").
  { ns: "lib", selector: ".vocab-group-chip", radius: "full", pressable: false, padH: 10 },
  // Tag governance's tag chips (2026-09 review-queue redesign). `selectable`:
  // the chip is the FACE of a visually hidden radio/checkbox
  // (<label class="tag-gov-chip"><input><span class="tag-gov-chip-face">), so
  // it rests NEUTRAL and only takes the chip pair when its input is checked --
  // a row of tags where every one is accent-tinted has no selected state left
  // to show. Geometry is the family's: 2px/10px, 14px line box, radius-full.
  { ns: "opt", selector: ".tag-gov-chip-face", radius: "full", pressable: false, selectable: true, padH: 10, fontSize: "12px" },
  // popup's suggested/AI tag chips (D6/D7, taste-uplift batch3 Task 5). Not
  // `pressable`/`selectable`: `.stag` is a plain <button>, never carries
  // `aria-pressed` (its "used" state is `.disabled` + a `.used` class, not a
  // toggle), so the family's `[aria-pressed]` hover/focus/active variants
  // would never match it -- those states stay hand-written in popup.css next
  // to the rest of the roving-toolbar keyboard contract they share a DOM node
  // with. padH 10 keeps CHIP_GEOM's 18px row (no border) at the pill's
  // effective radius (D6: stays 18px, not the sm 20px rung); fontSize 12px
  // preserves the chip's existing text size (§5.2 lets 11-12px float in the
  // chip rung) -- the batch's only font-size change is the ordinal's 11px,
  // which stays hand-written on `.stag-num`, never in this recipe.
  { ns: "pp", selector: ".stag", radius: "full", pressable: false, padH: 10, fontSize: "12px" },
];

function chipRules(ns) {
  const out = [];
  for (const target of CHIP_TARGETS.filter(t => t.ns === ns)) {
    const { selector, radius, pressable, selectable, padH, fontSize } = target;
    const decls = [
      ["display", "inline-flex"],
      ["align-items", "center"],
      // padH routed through sp() too (Minor fix): today's output is unchanged
      // (lib padH=10/opt padH=10 have no matching rung, lib padH=8 resolves to
      // var(--lib-sp-2) which IS 8px) — this just stops a future padH edit from
      // silently bypassing the adapter contract.
      ["padding", `${sp(ns, CHIP_GEOM.padV)} ${sp(ns, padH)}`],
    ];
    if (fontSize) decls.push(["font-size", fontSize]); // C8 deliberately omits this — inherits container
    decls.push(
      ["line-height", `${CHIP_GEOM.lineHeight}px`],
      ["border-radius", `var(--${ns}-radius-${radius})`],
      // A selectable chip rests on the Soft Fill control pair (btn-bg/btn-fg),
      // not a bespoke fg-tinted panel: btn-bg/btn-fg (and its btn-hover
      // partner below) are token-audited on every theme by contrast-audit,
      // while a fg-tint-of-panel is not a token pair at all -- it fell to
      // 4.39:1 on solarized-dark (base fg/panel there is only 4.86:1, and any
      // further fg-tint erodes that margin below 4.5). Reusing the already-
      // audited pair removes the failure mode instead of re-tuning a bespoke
      // mix percentage per theme.
      ["background", selectable ? `var(--${ns}-btn-bg)` : `var(--${ns}-chip-bg)`],
      ["color", selectable ? `var(--${ns}-btn-fg)` : `var(--${ns}-chip-fg)`],
    );
    out.push(rule(selector, decls));
    if (pressable) {
      out.push(rule(`${selector}[aria-pressed]:hover`, [["background", `var(--${ns}-btn-hover)`]], { pairColorWith: selector }));
      out.push(rule(`${selector}[aria-pressed]:active`, [["transform", "scale(0.97)"]]));
      // §7.3 `bordered`: a pressable chip keeps a 1px frame at rest so the
      // pressed/focused edge costs no reflow (§9 law 1) -- that frame IS the
      // focus core, same as the .btn family's.
      out.push(rule(`${selector}[aria-pressed]:focus-visible`, [
        ["outline", "none"],
        ["border-color", `var(--${ns}-focus-bd)`],
        ["box-shadow", `var(--${ns}-focus-ring)`],
      ]));
    }
    if (selectable) {
      out.push(rule(`input:hover:not(:disabled) + ${selector}`, [
        ["background", `var(--${ns}-btn-hover)`],
      ], { pairColorWith: selector }));
      // The hover rule above is (0,3,1); a bare `input:checked + face` is only
      // (0,2,1) and would LOSE to it, flashing a checked chip back to neutral
      // under the pointer. The second selector restates the checked look at
      // (0,4,1) so specificity decides it, not source order (§8.6 "别赌源序").
      out.push(rule(`input:checked + ${selector}, input:checked:hover:not(:disabled) + ${selector}`, [
        ["background", `var(--${ns}-chip-bg)`],
        ["color", `var(--${ns}-chip-fg)`],
        ["font-weight", "600"],
      ]));
      // §7.3 `borderless` placement, same as the .fg checkbox: the chip paints
      // no frame, so a 1px accent core carries legibility and the token glow
      // carries the family resemblance.
      out.push(rule(`input:focus-visible + ${selector}`, [
        ["outline", `1px solid var(--${ns}-accent)`],
        ["outline-offset", "2px"],
        ["box-shadow", `var(--${ns}-focus-ring)`],
      ]));
    }
  }
  return out;
}

// -----------------------------------------------------------------------
// §6: form controls. The `.fg` field recipe ships to OPTIONS ONLY. Two of the
// three surfaces have no `class="fg"` anywhere: popup never had one, and
// library turned out not to have one
// either -- `grep -c 'class="fg' library.html` is 0, no library JS ever adds
// the token, and ui-vocabulary.json registers `fg` under the options surface
// alone. Emitting the family for either of them ships CSS that can never
// match anything (library.css carried five such rules from 2026-08-05 until
// this guard landed).
//
// library's value boxes (stage 4, spec 2026-09-30 §3.3) take the COLOUR half
// from FIELD_TARGETS.lib like popup's: the toolbar search fields, the
// lookup-language select and .xp-dict-lang (plus the per-theme chevron),
// listbox.js's .listbox-btn, the .vocab-group-unit shell and its
// passengers, and the note editor. Their
// SHAPE half stays hand-written in library.css -- including the sm 20px
// toolbar rung §6.4 records as a user decision (the .fg recipe's md 26px would
// grow the sticky batch bar by 7px), the focus-ring glow with its z-index
// lift and the forced-colors outline, none of which this recipe expresses.
//
// COST OF THE ASYMMETRY -- keep this note: `.fg` is now an options-only
// vocabulary word. If library.html or popup.html ever grows a `class="fg"`
// wrapper it silently gets nothing. The fix then is to widen this guard (and
// settle the rung question first), never to hand-copy the recipe into the
// hand-written region.
//
// `.fg select`'s chevron background-image and `.fg textarea`'s monospace
// stack are explicitly page-level hand-maintained exceptions (§6.1), never
// emitted here.
//
// The field family (spec 2026-09-28-ui-fields-bplus-design §3, reshaped by
// spec 2026-09-30-ui-fields-stage4-design §2.1): fill / frame / hover / focus
// / placeholder / typed text read the --opt-field-* roles (_ui-derive.mjs
// deriveFieldRoles), and this recipe's single `border-radius:
// var(--opt-radius-md)` is the whole shape -- one radius on all four
// corners, one frame colour on all four sides, no bottom edge. The B+ shape
// half that options.css used to re-split it with (a >=3:1 bottom edge, md md
// sm sm corners) is retired; the .listbox-btn, a <button> outside FIELD_SEL,
// states the same md radius in its own hand-written rule.
//
// popup (stage 4 Task 6) and library (Task 7) take the COLOUR half of the
// same field language from FIELD_TARGETS (defined after this function, next
// to fieldTargetRules): per-surface typed selectors, no `class="fg"`, the
// shape half hand-written in their own CSS.
function formRules(ns) {
  // The five value-box kinds this recipe paints, named one by one in every
  // rule -- base AND state (stage 4, spec 2026-09-30-ui-fields-stage4-design
  // §2.1; factory-assessment §5.3). A bare `.fg input:hover` / `:focus` also
  // reached the radio / checkbox overlays inside .fg (.pick, .switch): they
  // took the field fill, the field focus frame and `outline: none`.
  // Hover excludes the box's focus trigger and :disabled in ONE :not() list,
  // so a typed input hover is (0,4,1) and a select / textarea hover (0,3,1):
  // the hand-written key-wrap focus frame (options.css, (0,5,1)) stays
  // strictly above every hover that can paint a key-wrap input, and the
  // static-freeze scan in tests/ui-contract-tests.mjs keeps its (0,3,1)
  // threshold. Focus keeps today's :focus trigger (spec §2.1 table).
  const FIELD_KINDS = ['input[type="text"]', 'input[type="password"]', 'input[type="number"]', "select", "textarea"];
  const fieldList = (state = "") => FIELD_KINDS.map((kind) => `.fg ${kind}${state}`).join(", ");
  const FIELD_SEL = fieldList();
  const out = [];
  if (ns === "opt") {
    out.push(
      rule(FIELD_SEL, [
        ["width", "100%"],
        ["padding", `${sp(ns, 4)} ${sp(ns, 8)}`],
        ["font-size", "13px"],
        ["line-height", "16px"],
        ["font-family", "inherit"],
        ["border", `1px solid var(--${ns}-field-border)`],
        ["border-radius", `var(--${ns}-radius-md)`],
        ["background-color", `var(--${ns}-field-bg)`],
        // Typed text: --opt-field-fg, = fg except where fg sits within
        // FIELD_TEXT_PLACEHOLDER_MIN (1.4:1) of the placeholder ink
        // (_ui-derive.mjs deriveFieldRoles, ruling R13).
        ["color", `var(--${ns}-field-fg)`],
        ["-webkit-appearance", "none"],
        ["appearance", "none"],
        ["box-shadow", "none"],
        ["transition", `border-color ${motion(ns)} ease, background-color ${motion(ns)} ease, box-shadow ${motion(ns)} ease`],
      ]),
      // Field width by CONTENT KIND (taste-uplift-batch3, T6/D2; COMPONENTS.md
      // §6.1's tier table). Stage 3c: every options text/secret field is an
      // entry block that fills its column; the 420/520/320 caps retired.
      // What is left is three kinds:
      //   select        >=240, FLOOR not ceiling -- see the dedicated rule
      //                        below, which does NOT keep the base `width:
      //                        100%` (batch-end review F2 fix-forward: a
      //                        <select> computes `overflow: visible` on its
      //                        own box, so `text-overflow` is inert on it --
      //                        a FIXED 240px width, the batch's first cut at
      //                        this tier, hard-clipped the selected value
      //                        with no ellipsis affordance at all once a
      //                        locale's option text ran past ~204px usable
      //                        space (#opt-md-image-policy ru ~495px,
      //                        #translate-target-lang ru 324px, de/fr in
      //                        between). A native <select> ordinarily sizes
      //                        to its longest OPTION and never has this
      //                        problem; `width: max-content` restores that
      //                        native sizing behaviour instead of fighting
      //                        it, `min-width: 240px` keeps the floor this
      //                        tier always promised (a one-word select
      //                        still reads as a deliberately-sized control,
      //                        not a stray full-width one), and `max-width:
      //                        100%` keeps the "never wider than the
      //                        column" ceiling the other kinds get for
      //                        free from the unchanged base `width: 100%`.
      //   input[number]  96 -- a handful of digits (popup width, cache
      //                        duration in minutes)
      //   textarea      (unchanged, no cap) -- prompt templates are prose,
      //                        capping their width would just wrap more.
      rule(`.fg select`, [["width", "max-content"], ["min-width", "240px"], ["max-width", "100%"]]),
      rule(`.fg input[type="number"]`, [["max-width", "96px"]]),
      rule(fieldList(":hover:not(:focus, :disabled)"), [
        ["background-color", `var(--${ns}-field-bg-hover)`],
        ["border-color", `var(--${ns}-field-border-hover)`],
      ], { pairColorWith: FIELD_SEL }),
      rule(fieldList(":focus"), [
        ["outline", "none"],
        ["background-color", `var(--${ns}-field-bg-focus)`],
        ["border-color", `var(--${ns}-field-border-focus)`],
      ], { pairColorWith: FIELD_SEL }),
      rule(fieldList(":focus-visible"), [
        ["box-shadow", `var(--${ns}-focus-ring)`],
      ]),
      // Placeholder ink (spec §3): the UA default (#757575) never followed the
      // theme -- 2.18:1 on nord-night's old panel-coloured fields, 1.87:1 on
      // its field-bg. --opt-field-placeholder is derived >= 4.5:1 on the rest
      // and hover fills.
      rule(`.fg input::placeholder, .fg textarea::placeholder`, [
        ["color", `var(--${ns}-field-placeholder)`],
      ]),
    );
  }
  if (ns !== "opt") out.push(...fieldTargetRules(ns));
  // Unscoped and therefore emitted on ALL THREE surfaces -- it is the whole
  // of popup's §6 share, and library's checkboxes consume it too. It must
  // stay outside the `.fg` guard above.
  out.push(rule('input[type="checkbox"], input[type="radio"]', [["accent-color", `var(--${ns}-accent)`]]));
  if (ns === "opt") {
    // §7.3 `borderless`: a checkbox paints no frame of its own (the tick is
    // UA-drawn from accent-color), so the 1px accent core carries legibility
    // and the token glow carries the family resemblance. The core is NOT
    // optional -- the glow alone is too faint on light surfaces.
    out.push(rule('.fg input[type="checkbox"]:focus-visible', [
      ["outline", `1px solid var(--${ns}-accent)`],
      ["outline-offset", "2px"],
      ["box-shadow", `var(--${ns}-focus-ring)`],
    ]));
  }
  // §6.1 toolbar-scoped field variant (sm rung, matches the row's .btn-sm
  // height: the shell's 1px border + this input's calc(control-h - 6px) =
  // 28 / 24 since the library density rung, plan T1). Concrete selector per
  // COMPONENTS.md Appendix C3 — the only named
  // target this campaign (library.css:834, "本战役排期"); options has no
  // equivalent named in Appendix C, so this only emits for lib.
  //
  // Selector widened from ".vocab-batch-bar input[type=text]" to
  // ".vocab-group-unit input[type=text]" (vocab-group-inspect-report.md
  // 2026-08-05 Finding 1): the batch bar's own group input is already
  // wrapped in .vocab-group-unit, so this is a pure broadening, not a
  // retarget -- but the detail pane renders the SAME input+stepper unit
  // (library-vocab.js: "same input+stepper family as the batch bar") scoped
  // to #vocab-detail, outside .vocab-batch-bar entirely, and never matched
  // the old selector at all. The hand-written border/background/focus-
  // visible recipe at library.css:969-980 gets the identical widening in the
  // same commit -- see that file for why the detail-pane input rendered with
  // zero styling (Finding 1's actual bug: no border, no radius, a double
  // focus ring) rather than just the wrong size.
  if (ns === "lib") {
    out.push(rule('.vocab-group-unit input[type="text"]', [
      ["height", "calc(var(--lib-control-h) - 6px)"],
      ["padding", "0 var(--lib-control-pad-x-sm)"],
      ["font-size", "calc(var(--lib-text-body) - 1px)"],
      ["line-height", "calc(var(--lib-control-h) - 6px)"],
    ]));
  }
  return out;
}

// -----------------------------------------------------------------------
// Stage 4 (spec 2026-09-30-ui-fields-stage4-design §2.1 / §4): the COLOUR half
// of popup's and library's value boxes. One registry per surface, the same
// shape as CHIP_TARGETS; formRules(ns) emits one rule per non-null field for
// "pp" / "lib" (options keeps its own `.fg` recipe above). The SHAPE half --
// height, padding, radius, width, border-width / border-style -- stays
// hand-written in popup.css / library.css, and a hand rule on one of these
// boxes may not declare any colour (tests/ui-contract-tests.mjs): the
// generated region sits BEFORE the hand-written one, so a same-specificity
// hand colour would win by source order (the stage-3c lesson).
//
// Entry: { id, rest, hover, focus, placeholder, passenger, chevron }, each a
// selector-list string or null. rest / hover / focus are PARALLEL lists --
// item i of each names the same box -- and every selector is typed (an
// input's [type], a textarea, or a shell class), so a checkbox or radio can
// never pick up a field fill (the options `.fg input:hover` debt, 5.3).
//   rest        -> background-color field-bg, border-color field-border,
//                  color field-fg
//   hover       -> background-color field-bg-hover, border-color field-border-hover
//   focus       -> background-color field-bg-focus, border-color field-border-focus
//   placeholder -> color field-placeholder
//   passenger   -> color field-fg (the transparent, frameless core of a
//                  fused shell; its own border/background stay hand-written)
//   chevron     -> background-image field-chevron (library selects, Task 7)
//
// The state ladder (ruling R1; binds pp AND lib): every entry climbs
// rest < hover < focus by SPECIFICITY alone, box by box (spec §2.1: focus
// strictly above hover for the same box, never by source order -- the
// pointer can rest on a box the keyboard focuses). hover = rest + :hover,
// its exclusions (the focus trigger, :disabled) wrapped in :where() so they
// add nothing; focus = rest + its trigger + a counted :not(:disabled). A
// disabled control cannot take focus, and a shell <div> is never :disabled,
// so that guard never changes what matches -- it is specificity ballast (the
// same device as `.secret-field` on popup's eye rules). ui-contract checks
// rest < hover < focus pairwise over EVERY entry of this registry, pp and
// lib alike. (options' .fg recipe keeps its own mutually exclusive form --
// hover excludes the focus trigger, COMPONENTS.md §6.1.)
//
// Triggers (spec §2.1 table): the plain boxes use :focus / :not(:focus);
// the two popup fused units use the SHELL's :focus-within / :not(:focus-
// within), so the eye or a tag chip holding focus keeps the unit out of its
// hover paint, and the pointer over the eye keeps the token field in it.
// No :has() on popup (the tags list toggles `.ac-open` by class for the same
// reason, popup-tags.js). Library keeps its shipped triggers: .xp-dict-lang
// :focus-visible, and the group unit's `:has(> input[type="text"]:focus)`
// (its one :has() precedent), whose hover also excludes a disabled input.
export const FIELD_TARGETS = Object.freeze({
  pp: Object.freeze([
    // #url-input, #title-input, #description-input. The child combinator is
    // load-bearing: `.field > input` must not reach #tags-input, which sits
    // inside .tags-input-wrap (a passenger of pp-tags below).
    Object.freeze({
      id: "pp-text",
      rest: '.field > input[type="text"], .field > textarea',
      hover: '.field > input[type="text"]:hover:where(:not(:focus, :disabled)), .field > textarea:hover:where(:not(:focus, :disabled))',
      focus: '.field > input[type="text"]:focus:not(:disabled), .field > textarea:focus:not(:disabled)',
      placeholder: '.field > input[type="text"]::placeholder, .field > textarea::placeholder',
      passenger: null,
      chevron: null,
    }),
    // #search-input (11px, the quick-actions strip; spec §3.2).
    Object.freeze({
      id: "pp-search",
      rest: 'input[type="text"].search-field',
      hover: 'input[type="text"].search-field:hover:where(:not(:focus, :disabled))',
      focus: 'input[type="text"].search-field:focus:not(:disabled)',
      placeholder: 'input[type="text"].search-field::placeholder',
      passenger: null,
      chevron: null,
    }),
    // #token-input: the input carries the look and the eye sits inside it,
    // so the state lives on the .secret-field shell (options' .key-wrap
    // shape). Both types: the eye flips password <-> text (shared.js).
    Object.freeze({
      id: "pp-secret",
      rest: '.login-body .secret-field > input[type="password"], .login-body .secret-field > input[type="text"]',
      hover: '.login-body .secret-field:hover:where(:not(:focus-within)) > input[type="password"]:where(:not(:disabled)), .login-body .secret-field:hover:where(:not(:focus-within)) > input[type="text"]:where(:not(:disabled))',
      focus: '.login-body .secret-field:focus-within > input[type="password"]:not(:disabled), .login-body .secret-field:focus-within > input[type="text"]:not(:disabled)',
      placeholder: '.login-body .secret-field > input[type="password"]::placeholder, .login-body .secret-field > input[type="text"]::placeholder',
      passenger: null,
      chevron: null,
    }),
    // .tags-input-wrap: the shell carries the look (COMPONENTS.md §8), the
    // #tags-input core is a transparent, frameless passenger.
    Object.freeze({
      id: "pp-tags",
      rest: ".tags-input-wrap",
      hover: ".tags-input-wrap:hover:where(:not(:focus-within, :disabled))",
      focus: ".tags-input-wrap:focus-within:not(:disabled)",
      placeholder: '.tags-input-wrap > input[type="text"]::placeholder',
      passenger: '.tags-input-wrap > input[type="text"]',
      chevron: null,
    }),
  ]),
  // library (stage 4 Task 7, spec §3.3), on the same ladder as pp. Colour
  // half only: every entry's shape (height, padding, radius, the sm toolbar
  // rung, the focus glow and its z-index lift, the forced-colors outline)
  // stays hand-written in library.css, keyed on fieldRingSelectors (the
  // entry's focus selector, :focus -> :focus-visible).
  lib: Object.freeze([
    // #vocab-search, #vocab-lookup-input, #notes-filter. Focus on :focus.
    Object.freeze({
      id: "lib-toolbar-search",
      rest: '.notes-toolbar input[type="search"], .vocab-lookup-bar input[type="search"]',
      hover: '.notes-toolbar input[type="search"]:hover:where(:not(:focus, :disabled)), .vocab-lookup-bar input[type="search"]:hover:where(:not(:focus, :disabled))',
      focus: '.notes-toolbar input[type="search"]:focus:not(:disabled), .vocab-lookup-bar input[type="search"]:focus:not(:disabled)',
      placeholder: '.notes-toolbar input[type="search"]::placeholder, .vocab-lookup-bar input[type="search"]::placeholder',
      passenger: null,
      chevron: null,
    }),
    // listbox.js's value-box button (library redesign T6, spec §8.4): the
    // group filter and the dictionary lookup language. Its ghost face
    // (.listbox-trigger, the sort menu button) is a .btn and never an entry
    // here. Focus on :focus-visible, the shipped listbox trigger (options').
    Object.freeze({
      id: "lib-listbox",
      rest: ".listbox-btn",
      hover: ".listbox-btn:hover:where(:not(:focus-visible, :disabled))",
      focus: ".listbox-btn:focus-visible:not(:disabled)",
      placeholder: null,
      passenger: null,
      chevron: null,
    }),
    // The detail pane's note editor (library-vocab.js); it used to inherit
    // the pane's paint (transparent).
    Object.freeze({
      id: "lib-note",
      rest: ".vocab-note-input",
      hover: ".vocab-note-input:hover:where(:not(:focus, :disabled))",
      focus: ".vocab-note-input:focus:not(:disabled)",
      placeholder: ".vocab-note-input::placeholder",
      passenger: null,
      chevron: null,
    }),
    // The fused group unit, batch bar + detail pane (COMPONENTS.md §8): the
    // shell is the value box; the text input and the two stepper cells are
    // passengers (transparent, borderless, --lib-field-fg ink). The trigger
    // is the shipped :has() precedent -- the unit's TEXT ENTRY holding focus,
    // not :focus-within, which a stepper cell would also fire -- and a
    // disabled input (a batch mutation running) takes no hover either. A
    // <span> is never :disabled, so the focus rule's :not(:disabled) is pure
    // specificity ballast (see the ladder note above).
    Object.freeze({
      id: "lib-group-unit",
      rest: ".vocab-group-unit",
      hover: '.vocab-group-unit:hover:where(:not(:has(> input[type="text"]:focus), :has(> input:disabled)))',
      focus: '.vocab-group-unit:has(> input[type="text"]:focus):not(:disabled)',
      placeholder: '.vocab-group-unit > input[type="text"]::placeholder',
      passenger: '.vocab-group-unit > input[type="text"], .vocab-group-unit > .vocab-group-step',
      chevron: null,
    }),
  ]),
});

function fieldTargetRules(ns) {
  const out = [];
  for (const t of FIELD_TARGETS[ns] ?? []) {
    out.push(rule(t.rest, [
      ["background-color", `var(--${ns}-field-bg)`],
      ["border-color", `var(--${ns}-field-border)`],
      ["color", `var(--${ns}-field-fg)`],
    ]));
    out.push(rule(t.hover, [
      ["background-color", `var(--${ns}-field-bg-hover)`],
      ["border-color", `var(--${ns}-field-border-hover)`],
    ], { pairColorWith: t.rest }));
    out.push(rule(t.focus, [
      ["background-color", `var(--${ns}-field-bg-focus)`],
      ["border-color", `var(--${ns}-field-border-focus)`],
    ], { pairColorWith: t.rest }));
    if (t.placeholder) out.push(rule(t.placeholder, [["color", `var(--${ns}-field-placeholder)`]]));
    if (t.passenger) out.push(rule(t.passenger, [["color", `var(--${ns}-field-fg)`]]));
    if (t.chevron) out.push(rule(t.chevron, [["background-image", `var(--${ns}-field-chevron)`]]));
  }
  return out;
}

// -----------------------------------------------------------------------
// §6.4 `.switch` exception: the one drawn boolean control (taste-uplift
// batch4, D1/D3/D5/D6). OPTIONS ONLY -- the switch replaces persistent
// settings checkboxes, and only options has those (popup's three form-state
// checkboxes and library's none are out of scope, batch4 plan D4).
//
// DOM contract (D5): label.switch > input[type=checkbox] + span.switch-text
// + span.switch-track. The native input stays the FIRST child and is never
// display:none -- it is laid over the whole label at opacity 0, so it keeps
// focus, Space-to-toggle, form semantics and the `input:disabled + span`
// dimming (which lands on .switch-text, the input's next sibling). The
// track is drawn from sibling state (`input:<state> ~ .switch-track`), the
// same shape as the .tag-gov-chip-face recipe above. No aria-checked: the
// native checkbox already exposes checked state.
//
// Geometry (B' -- user ruling 36, after the density study; supersedes
// D3's 32x20 framed track): track 28x16, BORDERLESS, thumb 12 inset 2px on
// every side, travel 12px (28 - 12 - 2x2px inset). Borderless because the
// old 1px frame + 1px inset split rounded unevenly on high-DPR device
// pixels and read as a thumb sitting high; a single 2px inset has no split.
// The label keeps a 20px min-height (the sm rung the old track height used
// to impose), and the input overhangs it by 2px top and bottom, so on a
// 20px row the hit target is 24px tall (§1.1 icon-hit floor). These are component-
// geometry literals, not spacing; the one spacing value (the text-help
// gap) goes through sp().
//
// Layout: the text and any inline help toggle (details.context-help moved
// INSIDE the label, between text and track) pack from the start; the
// track takes `margin-left: auto`, an alignment margin (not a spacing
// literal), so it lands at the row end whatever sits before it.
//
// Colour (state -> token -> contrast-audit row that backs it):
//   off track   bg --opt-border   on the panel   `border vs panel` >=3 (min 3.20 terminal)
//   off thumb   --opt-panel       on the track   same pair, symmetric (min 3.20)
//   on track    bg --opt-accent   on the panel   `accent vs panel` >=3 (min 3.53 solarized-dark)
//   on thumb    --opt-on-accent   on the track   `on-accent vs accent` >=4.5 (min 4.51 modern-card)
//   disabled    btn-bg track, fg-hint thumb + text (WCAG 1.4.3/1.4.11 exempt)
// Hover changes nothing but the cursor: fill and thumb position are the
// state cues, and a hover tint on a border-grey track would need a new
// derived role with no gate behind it. The thumb shadow is alpha black, so
// it is theme-agnostic (a lift cue, not a colour pair). The thumb paints
// `currentColor` and the TRACK carries `color`, so every fill rule pairs
// with a colour in the same rule (§7.1 paired-consumption law) and a state
// only ever has to swap the track's two properties.
function switchRules(ns) {
  if (ns !== "opt") return [];
  const INPUT = ".switch > input[type=\"checkbox\"]";
  return [
    rule(".switch", [
      ["display", "flex"],
      ["align-items", "center"],
      ["justify-content", "flex-start"],
      // The row keeps the sm rung the old 20px track used to set on its own:
      // a 16px track no longer props a one-line row up to 20px.
      ["min-height", "20px"],
      ["gap", sp(ns, 6)],
      ["position", "relative"],
      ["cursor", "pointer"],
    ]),
    rule(INPUT, [
      ["position", "absolute"],
      ["top", "-2px"],
      ["bottom", "-2px"],
      ["left", "0"],
      ["right", "0"],
      ["width", "100%"],
      ["height", "calc(100% + 4px)"],
      ["margin", "0"],
      ["opacity", "0"],
      ["cursor", "pointer"],
    ]),
    rule(".switch > input[type=\"checkbox\"]:disabled", [["cursor", "default"]]),
    rule(".switch-text", [["flex", "0 1 auto"], ["min-width", "0"]]),
    rule(".switch-track", [
      ["position", "relative"],
      ["flex", "none"],
      ["margin-left", "auto"],
      ["width", "28px"],
      ["height", "16px"],
      ["border", "0"],
      ["border-radius", `var(--${ns}-radius-full)`],
      ["background", `var(--${ns}-border)`],
      ["color", `var(--${ns}-panel)`],
      ["transition", `background ${motion(ns)}, color ${motion(ns)}`],
    ]),
    rule(".switch-track::before", [
      ["content", "\"\""],
      ["position", "absolute"],
      ["top", "2px"],
      ["left", "2px"],
      ["width", "12px"],
      ["height", "12px"],
      ["border-radius", `var(--${ns}-radius-full)`],
      ["background", "currentColor"],
      ["box-shadow", "0 1px 2px rgba(0, 0, 0, 0.28), 0 0 0 0.5px rgba(0, 0, 0, 0.06)"],
      ["transition", `transform ${motion(ns)}`],
    ], { pairColorWith: ".switch-track" }),
    rule(`.switch > input:checked ~ .switch-track`, [
      ["background", `var(--${ns}-accent)`],
      ["color", `var(--${ns}-on-accent)`],
    ]),
    rule(`.switch > input:checked ~ .switch-track::before`, [["transform", "translateX(12px)"]]),
    // §7.3 `borderless` placement, identical to .tag-gov-chip-face and the
    // .fg checkbox: the ring is drawn on the TRACK because the input that
    // actually holds focus is transparent.
    rule(`.switch > input:focus-visible ~ .switch-track`, [
      ["outline", `1px solid var(--${ns}-accent)`],
      ["outline-offset", "2px"],
      ["box-shadow", `var(--${ns}-focus-ring)`],
    ]),
    // Disabled (WCAG 1.4.3/1.4.11 exempt): neutral fill, hint-tier thumb and
    // text. The second selector restates it at (0,4,1) so a disabled-AND-
    // checked switch loses the accent by specificity, not source order; the
    // thumb keeps its translated position, so state stays legible.
    // The borderless recipe (B') dropped the track's frame, and btn-bg reads
    // close to panel on several themes (1.00-1.23:1) -- disabled never
    // receives focus, so an inset ring here cannot clash with the focus
    // ring, and it restores the same >=3:1 edge the resting `border vs
    // panel` contrast-audit row already gates (Ruling 37 fix round).
    rule(`.switch > input:disabled ~ .switch-track, .switch > input:disabled:checked ~ .switch-track`, [
      ["background", `var(--${ns}-btn-bg)`],
      ["color", `var(--${ns}-fg-hint)`],
      ["box-shadow", `inset 0 0 0 1px var(--${ns}-border)`],
      ["cursor", "default"],
    ]),
    rule(`.switch > input:disabled ~ .switch-text`, [["color", `var(--${ns}-fg-hint)`]]),
    // Forced colors (Windows High Contrast): author backgrounds are flattened
    // to system colours, so a drawn track would lose its on/off fill. Hand
    // the job back to the native checkbox -- visible, in flow, system-drawn
    // -- and drop the track.
    rule(INPUT, [
      ["position", "static"],
      ["width", "auto"],
      ["height", "auto"],
      ["opacity", "1"],
    ], { media: "(forced-colors: active)" }),
    rule(".switch-track", [["display", "none"]], { media: "(forced-colors: active)" }),
  ];
}

// -----------------------------------------------------------------------
// Pick row (COMPONENTS.md §6.4 exception 3, stage-3b Task 1, R11): options-
// only primitive for radio groups -- and, via the `.pick-box` modifier, a
// checkbox list Task 2 wires up -- built on the same "hidden native input
// covers the row, a CSS-drawn face carries the visible state cue" technique
// as `.switch` above. Unlike `.switch` (fill = the whole state cue), the
// mark stays a ring at rest and only fills + draws an L-shaped checkmark
// border when checked -- the user picked this shape (scratchpad design "B",
// docs/superpowers/.../scratchpad/radio/index.html) specifically because
// bookmarks' bgsave-mode/tag-sync-mode rows, popup-width's custom-number
// row, and ai-content-source's help-annotated rows all carry copy too long
// for a segmented control, and ai-content-source shares a `.pref-group` with
// a `.switch` row and needs the same row height.
//
// DOM (options.js reads it unchanged -- same `input[name=...]:checked` +
// `change`-listener + reset-flow contract the plain `<input type=radio>`
// labels had before this task):
//   label.pick
//     input[type=radio|checkbox]  <- opacity-hidden, absolutely covers the
//                                    row (same technique as .switch's
//                                    input), still focusable/keyboard-
//                                    operable (arrow-key group navigation
//                                    is native UA behaviour, not anything
//                                    this recipe or options.js implements)
//     span.pick-text              <- copy; may be followed by an inline
//                                    control (popup-width's custom number
//                                    input, lifted onto its own stacking
//                                    context below) before the mark
//     span.pick-mark              <- 20x20 face; circle at rest (radio) or
//                                    `.pick-box`'s rounded square (checkbox)
//
// Colour: the paired-color law (§7.1) needs a `color` declaration wherever
// a rule backgrounds something. `.pick-mark`'s resting `background:
// transparent` self-pairs with a `color: --opt-on-accent` declared on that
// SAME rule -- unused while resting (the ring's visible edge is `border`,
// not `color`), but it is what `.pick-mark::after`'s checkmark border draws
// via `currentColor`, inherited down from the mark exactly the way
// `.switch-track`'s `color` feeds `.switch-track::before`'s `background:
// currentColor` thumb above. The checked-state rule then only has to touch
// `background`/`border-color` (pairColorWith points back at the base rule,
// which still declares that `color`) -- color itself never needs to change
// between states, since the checkmark is invisible (opacity 0) until
// checked regardless of what colour it would be.
function pickRules(ns) {
  if (ns !== "opt") return [];
  const INPUT = ".pick > input[type=\"radio\"], .pick > input[type=\"checkbox\"]";
  return [
    rule(".pick", [
      ["display", "flex"],
      ["align-items", "center"],
      ["gap", sp(ns, 12)],
      ["position", "relative"],
      ["cursor", "pointer"],
      ["min-height", "var(--opt-row-min-h)"],
    ]),
    rule(INPUT, [
      ["position", "absolute"],
      ["inset", "0"],
      ["width", "100%"],
      ["height", "100%"],
      ["margin", "0"],
      ["opacity", "0"],
      ["cursor", "pointer"],
    ]),
    rule(".pick-text", [["flex", "0 1 auto"], ["min-width", "0"]]),
    // The popup-width custom row's inline number input sits after
    // .pick-text, still inside the label. A <label> only forwards a click
    // to its associated control when the click's target is the label
    // itself or a non-interactive descendant (HTML labeled-control
    // activation behaviour) -- a nested labelable element like this number
    // input is never forwarded, spec-guaranteed regardless of the rule
    // below. What the rule below fixes is hit-testing: the hidden radio's
    // `inset: 0` covers the WHOLE row including the number input's own box,
    // so without lifting the input onto its own stacking context, a real
    // click aimed at the field would hit-test to the invisible radio
    // instead and never reach the field at all.
    rule(".pick > input:not([type=\"radio\"]):not([type=\"checkbox\"])", [
      ["position", "relative"],
      ["z-index", "1"],
    ]),
    rule(".pick-mark", [
      ["margin-left", "auto"],
      ["flex", "none"],
      ["width", "20px"],
      ["height", "20px"],
      ["border-radius", `var(--${ns}-radius-full)`],
      ["border", `1px solid ${v(ns, "border")}`],
      ["background", "transparent"],
      ["color", `var(--${ns}-on-accent)`],
      ["position", "relative"],
      ["transition", `background ${motion(ns)}, border-color ${motion(ns)}`],
    ]),
    rule(".pick-box > .pick-mark", [["border-radius", `var(--${ns}-radius-sm)`]]),
    rule(".pick-mark::after", [
      ["content", "\"\""],
      ["position", "absolute"],
      ["left", "6px"],
      ["top", "2px"],
      ["width", "5px"],
      ["height", "10px"],
      ["border", "solid currentColor"],
      ["border-width", "0 2px 2px 0"],
      ["transform", "rotate(45deg)"],
      ["opacity", "0"],
    ]),
    rule(".pick > input:checked ~ .pick-mark", [
      ["background", `var(--${ns}-accent)`],
      ["border-color", `var(--${ns}-accent)`],
    ], { pairColorWith: ".pick-mark" }),
    rule(".pick > input:checked ~ .pick-mark::after", [["opacity", "1"]]),
    rule(".pick:hover > .pick-mark", [["border-color", `var(--${ns}-fg-muted)`]]),
    rule(".pick > input:focus-visible ~ .pick-mark", [
      ["outline", "none"],
      ["box-shadow", `var(--${ns}-focus-ring)`],
    ]),
    // Disabled: the unchecked mark dims its border; a disabled-AND-checked mark
    // (no producer today -- options-backup.js and renderStoragePanel force
    // checked=false when disabled) fills with the hint role and a bg tick
    // instead of drawing a hint tick on an accent fill.
    rule(".pick > input:disabled ~ .pick-text, .pick > input:disabled:not(:checked) ~ .pick-mark", [
      ["color", `var(--${ns}-fg-hint)`],
      ["border-color", `var(--${ns}-fg-hint)`],
    ]),
    rule(".pick > input:disabled:checked ~ .pick-mark", [
      ["background", `var(--${ns}-fg-hint)`],
      ["border-color", `var(--${ns}-fg-hint)`],
      ["color", `var(--${ns}-bg)`],
    ]),
    rule(".pick > input:disabled", [["cursor", "default"]]),
    // Forced colors (Windows High Contrast): same handoff as .switch --
    // author backgrounds are flattened, so a drawn mark would lose its
    // on/off fill. Hand the job back to the native radio/checkbox --
    // visible, in flow, system-drawn -- and drop the mark.
    rule(INPUT, [
      ["position", "static"],
      ["width", "auto"],
      ["height", "auto"],
      ["opacity", "1"],
    ], { media: "(forced-colors: active)" }),
    rule(".pick-mark", [["display", "none"]], { media: "(forced-colors: active)" }),
  ];
}

// -----------------------------------------------------------------------
const FAMILY_BUILDERS = { btn: btnRules, btnIc: btnIcRules, danger: dangerRules, chip: chipRules, form: formRules, switch: switchRules, pick: pickRules };
export const FAMILIES = Object.keys(FAMILY_BUILDERS);

// Rules for one (ns, family) — exported so recipe-lint can run its static
// checks (paired-color law, chip geometry law) against structured data
// instead of re-parsing the stringified CSS.
export function familyRules(ns, family) {
  const build = FAMILY_BUILDERS[family];
  if (!build) throw new Error(`ui-components: unknown family "${family}"`);
  return build(ns);
}

const PLACEHOLDER = "/* populated per-family in later tasks */";

// renderComponents(ns, families) — the recipe API. `families` defaults to
// every family (this is what recipe-lint checks: the FULL recipe source,
// not whatever apply-ui-themes.mjs currently has switched on). An empty
// array (what apply-ui-themes.mjs's Task-8-era SURFACES entries pass)
// yields just the placeholder comment, keeping the generated regions empty
// until Task 9 flips families on.
export function renderComponents(ns, families = FAMILIES) {
  const blocks = families.map(f => stringifyRules(familyRules(ns, f))).filter(Boolean);
  return blocks.length ? blocks.join("\n\n") : PLACEHOLDER;
}
