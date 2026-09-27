// Options density tiers, derived -- never hand-listed -- from the pilots'
// ui.density (COMPONENTS.md §11), expanded from pilot slugs to runtime
// data-theme targets through options-theme-early.js's own
// PBP_OPTIONS_ADAPTIVE_MAP. One reader for two consumers:
// tests/ui-contract-tests.mjs pins PBP_OPTIONS_DENSITY_MAP to it, and
// scripts/ui-render-audit.mjs judges every options control against the tier
// its theme resolves to.
//
// Every failure below is a SETUP failure (throws), not a soft fallback (fix
// round 1, task-2-review): a caller that cannot trust this table -- a pilot
// declaring an unrecognised ui.density, an adaptive-map entry that doesn't
// expand to a real [light, dark] pair, PBP_OPTIONS_ADAPTIVE_MAP no longer
// parsing, or `densityOf()` asked about a theme this table has never heard
// of -- must stop, not silently degrade to "comfortable" and hide a real
// compact-tier regression. Both consumers let these propagate uncaught.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

export function readOptionsDensity(root) {
  const pilotDir = resolve(root, "docs/theme-surface/pilots");
  const pilotFiles = readdirSync(pilotDir).filter((f) => f.endsWith(".tokens.json"));
  if (!pilotFiles.length) {
    throw new Error(`readOptionsDensity: no *.tokens.json pilots found under ${pilotDir}`);
  }
  const pilots = pilotFiles.map((f) => [f.replace(/\.tokens\.json$/, ""), JSON.parse(readFileSync(resolve(pilotDir, f), "utf8"))]);
  const early = readFileSync(resolve(root, "options-theme-early.js"), "utf8");
  const adaptiveSrc = early.match(/PBP_OPTIONS_ADAPTIVE_MAP\s*=\s*(\{[^;]*\});/);
  if (!adaptiveSrc) {
    throw new Error("readOptionsDensity: PBP_OPTIONS_ADAPTIVE_MAP definition not found in options-theme-early.js");
  }
  let adaptiveMap;
  try {
    adaptiveMap = runInNewContext("(" + adaptiveSrc[1] + ")", {});
  } catch (e) {
    throw new Error(`readOptionsDensity: PBP_OPTIONS_ADAPTIVE_MAP failed to parse: ${e.message}`);
  }
  // An umbrella slug expands to its [light, dark] targets; any other slug is
  // already its own data-theme target. A key present in the map but not
  // expanding to a real pair (typo, one-element array, a blank string) would
  // otherwise silently fall through to treating the BARE slug as its own
  // target -- the exact inert-key shape tests/ui-contract-tests.mjs's own
  // "unreachable" check exists to catch on the OTHER side of this map.
  const expandTargets = (slug) => {
    if (!Object.prototype.hasOwnProperty.call(adaptiveMap, slug)) return [slug];
    const pair = adaptiveMap[slug];
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every((t) => typeof t === "string" && t)) {
      throw new Error(`readOptionsDensity: PBP_OPTIONS_ADAPTIVE_MAP[${JSON.stringify(slug)}] did not expand to a [light, dark] pair of non-empty strings`);
    }
    return pair;
  };
  // ui.density is optional -- undefined/absent means comfortable, the
  // surface's own default. A pilot declaring anything OTHER than "compact"
  // or omitting the key entirely is not a value this table knows what to do
  // with (a typo like "Compact"/"cozy" would otherwise silently read as
  // comfortable and never surface as a compact tier anywhere).
  for (const [slug, tokens] of pilots) {
    const density = tokens && tokens.ui && tokens.ui.density;
    if (density !== undefined && density !== "compact") {
      throw new Error(`readOptionsDensity: pilot "${slug}" declares ui.density=${JSON.stringify(density)} -- only "compact" or an omitted key (comfortable) is a known value`);
    }
  }
  const compactTargets = [...new Set(
    pilots.filter(([, t]) => t.ui && t.ui.density === "compact").flatMap(([slug]) => expandTargets(slug)),
  )].sort();
  const compact = new Set(compactTargets);
  const reachableTargets = new Set(pilots.flatMap(([slug]) => expandTargets(slug)));
  return {
    compactTargets,
    reachableTargets,
    // "" (no theme selected) is the surface's own default -- always
    // comfortable, and not itself a pilot-derived target -- so it is a known
    // case rather than an unknown one. Anything else must be one of the
    // reachable data-theme targets above; densityOf() throws rather than
    // guessing "comfortable" for a typo'd or retired theme name.
    densityOf: (theme) => {
      if (theme === "") return "comfortable";
      if (!reachableTargets.has(theme)) {
        throw new Error(`readOptionsDensity: densityOf() received an unknown theme ${JSON.stringify(theme)} -- known runtime targets: ${[...reachableTargets].sort().join(", ")}`);
      }
      return compact.has(theme) ? "compact" : "comfortable";
    },
  };
}
