import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { prefixSelectors } from "../docs/theme-surface/composers/compose-theme.mjs";

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const equal = (actual, expected, message) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures.push(`${message}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

const css = `/* braces in comments must not become rules: { } */
:root { --label: "base;{value}"; }
:where(.card, .tile), [data-label="x,y"] {
  content: "a;{b}";
  background-image: url("data:image/svg+xml;utf8,<svg>{x;y}</svg>");
  --payload: { alpha: beta; gamma: delta; };
}
@media (min-width: 40rem) {
  .inside:is(.x, .y), .other { color: rgb(1, 2, 3); }
}
@supports selector(:has(> .child, + .peer)) {
  .supported:where(.a, .b) { display: grid; }
}
@font-face { font-family: "Theme, UI"; src: url("theme;ui.woff2"); }
@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }
`;

let syntax;
try {
  syntax = await import("../docs/theme-surface/tools/css-syntax.mjs");
} catch (error) {
  failures.push(`shared CSS syntax module must load: ${error.message}`);
}

if (syntax) {
  equal(
    syntax.splitSelectorList(':where(.card, .tile), [data-label="x,y"], .plain'),
    [':where(.card, .tile)', '[data-label="x,y"]', '.plain'],
    "selector lists split only on top-level commas",
  );
  equal(
    syntax.splitSelectorList(".joined/**/.class, .descendant /* keep gap */ .child"),
    [".joined.class", ".descendant .child"],
    "comments are removed without inventing selector whitespace",
  );

  const rules = syntax.parseStyleRules(css);
  equal(
    rules.flatMap((rule) => rule.selectors),
    [
      ":root",
      ":where(.card, .tile)",
      '[data-label="x,y"]',
      ".inside:is(.x, .y)",
      ".other",
      ".supported:where(.a, .b)",
    ],
    "style-rule parsing recurses through grouping at-rules but skips descriptor/keyframe bodies",
  );

  const complexRule = rules.find((rule) => rule.selectorText.startsWith(":where"));
  equal(
    syntax.parseDeclarations(complexRule?.body || "").map((decl) => decl.raw),
    [
      'content: "a;{b}"',
      'background-image: url("data:image/svg+xml;utf8,<svg>{x;y}</svg>")',
      "--payload: { alpha: beta; gamma: delta; }",
    ],
    "declarations preserve semicolons and braces inside component values",
  );
  equal(
    syntax.parseDeclarations("--Brand-Color: #abc; COLOR: red;").map(({ property }) => property),
    ["--Brand-Color", "color"],
    "custom property names remain case-sensitive while ordinary properties normalize",
  );

  equal(
    [...syntax.declarationValueMap(`
:root { --Brand-Color: #abc; color: red; }
:root { color: blue; }
@media print { :root { color: black; } }
`, ":root")],
    [["--Brand-Color", "#abc"], ["color", "blue"]],
    "selector value maps apply source order without leaking declarations from another at-rule context",
  );

  const contextual = syntax.declarationMap(`
.same { color: red; }
@media print { .same { color: black; } }
@supports (display: grid) { .same { display: grid; } }
`);
  equal(
    [...contextual].map(([key, declarations]) => ({
      ...syntax.parseRuleKey(key),
      declarations,
    })),
    [
      { context: [], selector: ".same", declarations: ["color: red"] },
      { context: ["@media print"], selector: ".same", declarations: ["color: black"] },
      { context: ["@supports (display: grid)"], selector: ".same", declarations: ["display: grid"] },
    ],
    "declaration maps keep identical selectors in different at-rule contexts distinct",
  );

  // ---- selectorSpecificity: the one Selectors-4 engine (stage 4 T0) ----
  // Each case pins one scoring rule with the simplest selector the old
  // cascade-lint engine (flat :is()/:where()/:has(), SUMMED :not(a, b)) or a
  // naive scanner gets wrong; the real pinboard-themes.js selectors are the
  // ones that engine mis-scored.
  check(typeof syntax.selectorSpecificity === "function" && typeof syntax.cmpSpecificity === "function" &&
    typeof syntax.closeOfBracket === "function",
  "css-syntax.mjs must export selectorSpecificity, cmpSpecificity and closeOfBracket (the shared specificity engine)");
  if (typeof syntax.selectorSpecificity === "function") {
    const SPECIFICITY_CASES = [
      ['.fg :is(input[type="text"], input[type="password"], input[type="number"], textarea)', [0, 2, 1], ":is() adds its most specific argument, not a flat pseudo-class"],
      ['.fg :is(input[type="text"], textarea):hover:not(:focus)', [0, 4, 1], ":is() max + two pseudo-classes"],
      [":not(.a, #b)", [1, 0, 0], ":not(a, b) takes the max of its arguments, never their sum"],
      ["body#pinboard li:not(.pin-ac li)", [1, 1, 3], ":not() with a complex argument scores the whole argument"],
      [".x:where(.a .b) p::before", [0, 1, 2], ":where() adds nothing"],
      [":where(#a) .b", [0, 1, 0], ":where() drops even an id"],
      ['.vocab-group-unit:has(> input[type="text"]:focus)', [0, 3, 1], ":has() scores its relative selector; the leading combinator adds nothing"],
      ["#main_column:has(#left_toc)", [2, 0, 0], ":has() carries an id argument into a"],
      [":is(:not(#a), .b)", [1, 0, 0], "functional pseudo-classes nest"],
      ['html[data-theme] .field > input[type="text"]', [0, 3, 2], "combinators add nothing; attribute selectors are b"],
      ["a + b ~ c", [0, 0, 3], "sibling combinators add nothing"],
      [".a /* note */ .b", [0, 2, 0], "a comment inside the selector scores nothing"],
      ["*", [0, 0, 0], "the universal selector adds nothing"],
      ["*.a", [0, 1, 0], "the universal selector adds nothing inside a compound"],
      ["a::picker(select)", [0, 0, 2], "a functional pseudo-element is one c; its argument adds nothing"],
      ["p:before", [0, 0, 2], "legacy single-colon pseudo-elements are c, not b"],
      [".fg input::placeholder", [0, 1, 2], "::placeholder is a pseudo-element"],
      ['[data-x="a]b"].c', [0, 2, 0], "a quoted ] does not end an attribute selector"],
      [':not([data-x=")"])', [0, 1, 0], "a quoted ) does not end a functional pseudo-class"],
      ["li:nth-child(2n+1 of .a, #b)", [1, 1, 1], ":nth-child(... of S) adds one pseudo-class plus the max of S"],
      ["li:nth-child(odd)", [0, 1, 1], ":nth-child() without of S is one pseudo-class"],
      [".a\\:hover", [0, 1, 0], "an escaped colon stays inside the class name"],
      ["#\\31 23 .b", [1, 1, 0], "a hex escape swallows one trailing space"],
      ["A:IS(.x)", [0, 1, 1], "pseudo-class names are case-insensitive"],
      ["#opt-custom-css.over-limit", [1, 1, 0], "id plus class"],
    ];
    for (const [selector, expected, why] of SPECIFICITY_CASES) {
      equal(syntax.selectorSpecificity(selector), expected, `selectorSpecificity(${JSON.stringify(selector)}): ${why}`);
    }
    for (const bad of [".a, .b", "", "  ", undefined]) {
      let threw = false;
      try { syntax.selectorSpecificity(bad); } catch (error) { threw = error instanceof TypeError; }
      check(threw, `selectorSpecificity(${JSON.stringify(bad)}) must throw a TypeError: a selector list, an empty or a non-string input has no single specificity`);
    }
    check(syntax.cmpSpecificity([1, 0, 0], [0, 99, 99]) > 0 && syntax.cmpSpecificity([0, 1, 0], [0, 0, 99]) > 0 &&
      syntax.cmpSpecificity([0, 2, 1], [0, 2, 1]) === 0 && syntax.cmpSpecificity([0, 2, 0], [0, 2, 1]) < 0,
    "cmpSpecificity compares a, then b, then c (one id beats any number of classes)");
    const bracketed = ':is(.a, [x=")"]) .b';
    equal(syntax.closeOfBracket(bracketed, 3), bracketed.indexOf(") .b"),
      "closeOfBracket skips quoted brackets and returns the index of the matching close");
  }
}

// ---- One specificity engine (stage 4 T0) ----
// The two consumers import it, and no factory tool, test or script grows a
// private copy again: cascade-lint's specificityOf/cmpSpec and ui-contract's
// selectorSpecificity/cmpSpecificity/closeOfBracket disagreed on
// :is()/:has()/:not(a, b) (8 distinct pinboard-themes.js selectors when they
// were merged). The scan knows the names engines have carried here;
// variables that merely HOLD a score (`const fwSpec = selectorSpecificity(FW)`)
// never match it.
const root = resolve(import.meta.dirname, "..");
const engineHome = resolve(root, "docs/theme-surface/tools/css-syntax.mjs");
const ENGINE_DECL_RE = /(?:\bfunction\s+|\b(?:const|let|var)\s+)(selectorSpecificity|specificityOf|cmpSpec|cmpSpecificity|compareSpecificity|closeOfBracket)\s*(?:=|\()/g;
const scriptFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (entry.name === "node_modules") return [];
  const path = resolve(dir, entry.name);
  if (entry.isDirectory()) return scriptFiles(path);
  return /\.m?js$/.test(entry.name) ? [path] : [];
});
const privateEngines = ["docs/theme-surface", "tests", "scripts"]
  .flatMap((dir) => scriptFiles(resolve(root, dir)))
  .filter((file) => file !== engineHome)
  .flatMap((file) => [...readFileSync(file, "utf8").matchAll(ENGINE_DECL_RE)].map((m) => `${relative(root, file)}: ${m[1]}`));
equal(privateEngines, [],
  "selector specificity has one engine: import selectorSpecificity / cmpSpecificity / closeOfBracket from docs/theme-surface/tools/css-syntax.mjs instead of redefining them");
const ENGINE_IMPORT_RE = /import\s*\{[^}]*\bselectorSpecificity\b[^}]*\}\s*from\s*["'][^"']*css-syntax\.mjs["']/;
for (const consumer of ["docs/theme-surface/tools/cascade-lint.mjs", "tests/ui-contract-tests.mjs"]) {
  check(ENGINE_IMPORT_RE.test(readFileSync(resolve(root, consumer), "utf8")),
    `${consumer} must import selectorSpecificity from css-syntax.mjs`);
}

const prefixed = prefixSelectors(css, "html.pbp-dark");
check(
  prefixed.includes('html.pbp-dark :where(.card, .tile), html.pbp-dark [data-label="x,y"] {'),
  `mode prefixing must preserve commas inside selector functions and attributes:\n${prefixed}`,
);
check(
  prefixed.includes("@media (min-width: 40rem) {\n  html.pbp-dark .inside:is(.x, .y), html.pbp-dark .other {"),
  `mode prefixing must recurse into @media rule lists:\n${prefixed}`,
);
check(
  prefixed.includes("@supports selector(:has(> .child, + .peer)) {\n  html.pbp-dark .supported:where(.a, .b) {"),
  `mode prefixing must recurse into @supports without splitting its prelude:\n${prefixed}`,
);
check(
  prefixed.includes('@font-face { font-family: "Theme, UI"; src: url("theme;ui.woff2"); }'),
  "mode prefixing must leave descriptor at-rules unchanged",
);
check(
  prefixed.includes("@keyframes pulse { from { opacity: 0; } to { opacity: 1; } }"),
  "mode prefixing must leave keyframe selectors unchanged",
);

if (failures.length) {
  console.error(failures.map((message) => `FAIL ${message}`).join("\n"));
  process.exit(1);
}

console.log("theme CSS syntax tests ok");
