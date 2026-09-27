// Options density tiers, derived -- never hand-listed -- from the pilots'
// ui.density (COMPONENTS.md §11), expanded from pilot slugs to runtime
// data-theme targets through options-theme-early.js's own
// PBP_OPTIONS_ADAPTIVE_MAP. One reader for two consumers:
// tests/ui-contract-tests.mjs pins PBP_OPTIONS_DENSITY_MAP to it, and
// scripts/ui-render-audit.mjs judges every options control against the tier
// its theme resolves to.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

export function readOptionsDensity(root) {
  const pilotDir = resolve(root, "docs/theme-surface/pilots");
  const pilots = readdirSync(pilotDir)
    .filter((f) => f.endsWith(".tokens.json"))
    .map((f) => [f.replace(/\.tokens\.json$/, ""), JSON.parse(readFileSync(resolve(pilotDir, f), "utf8"))]);
  const early = readFileSync(resolve(root, "options-theme-early.js"), "utf8");
  const adaptiveSrc = early.match(/PBP_OPTIONS_ADAPTIVE_MAP\s*=\s*(\{[^;]*\});/);
  const adaptiveMap = adaptiveSrc ? runInNewContext("(" + adaptiveSrc[1] + ")", {}) : {};
  // An umbrella slug expands to its [light, dark] targets; any other slug is
  // already its own data-theme target.
  const expandTargets = (slug) => (Object.prototype.hasOwnProperty.call(adaptiveMap, slug) ? adaptiveMap[slug] : [slug]);
  const compactTargets = [...new Set(
    pilots.filter(([, t]) => t.ui && t.ui.density === "compact").flatMap(([slug]) => expandTargets(slug)),
  )].sort();
  const compact = new Set(compactTargets);
  return {
    adaptiveMapFound: !!adaptiveSrc,
    compactTargets,
    reachableTargets: new Set(pilots.flatMap(([slug]) => expandTargets(slug))),
    densityOf: (theme) => (compact.has(theme) ? "compact" : "comfortable"),
  };
}
