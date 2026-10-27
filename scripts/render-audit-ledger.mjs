// Known-failures reconciliation for scripts/ui-render-audit.mjs, kept pure so
// tests/audit-render-ledger-tests.mjs can drive it without a browser.
//
// tests/render-audit-known-failures.json registers rows that fail today on
// purpose (a gate committed before its fix, plan 2026-10-27 batch 0.1). An
// entry must leave the ledger in the commit that fixes it, or the ledger
// quietly keeps excusing a regression of the same row later. So:
//   resolved -- a registered key this run MEASURED and that passed (an OK
//               row with that exact key, no FAIL row for it). Exact, so it
//               holds in a shard or a scoped run too, and it fails the gate.
//   stale    -- a registered key this run did not see failing at all and
//               did not resolve (its check was renamed or removed, or its
//               row never ran). Only a whole-matrix run can say that, so a
//               sliced run (shard / scope filters) reports none; advisory.
// A key whose row came back SETUP (unmeasured) is neither: it is held out of
// stale under its surface|theme|selector|state| prefix, because a SETUP row
// renames its check (hoverApplied / hoverUnfocused / ...).

export function ledgerKey(r) {
  return `${r.surface}|${r.theme}|${r.selector}|${r.state}|${r.check}`;
}

export function reconcileKnownFailures(results, known, { sliced = false } = {}) {
  const registered = (key) => Object.prototype.hasOwnProperty.call(known, key);
  const fails = results.filter((r) => r.status === "FAIL");
  const setupRows = results.filter((r) => r.status === "SETUP");
  const warnings = fails.filter((r) => registered(ledgerKey(r)));
  const violations = fails.filter((r) => !registered(ledgerKey(r)));
  const failing = new Set(fails.map(ledgerKey));
  const resolved = [...new Set(results.filter((r) => r.status === "OK").map(ledgerKey))]
    .filter((key) => registered(key) && !failing.has(key));
  const setupPrefixes = [...new Set(setupRows.map((r) => `${r.surface}|${r.theme}|${r.selector}|${r.state}|`))];
  const unmeasuredKnown = Object.keys(known).filter((key) => !failing.has(key) && !resolved.includes(key) &&
    setupPrefixes.some((prefix) => key.startsWith(prefix)));
  const stale = sliced ? [] : Object.keys(known).filter((key) => !failing.has(key) && !resolved.includes(key) &&
    !unmeasuredKnown.includes(key));
  return { warnings, violations, resolved, stale, unmeasuredKnown, setupRows };
}
