// Dev-time case filter for the browser suites that load it. The runner passes
// ?pbp_only=<name part>[,<name part>...] (from PBP_ONLY=... in the environment,
// see .qa-scan/run-test.mjs); a case runs only if its name contains one of the
// parts (case-insensitive). Without the parameter every case runs and nothing
// else changes. The counters tell the runner when a filtered page is finished:
// every call counts as seen (run or not), and a started case counts as pending
// until its done callback is called.
(function () {
  let parts = [];
  try {
    parts = (new URLSearchParams(location.search).get("pbp_only") || "")
      .split(",").map((part) => part.trim().toLowerCase()).filter(Boolean);
  } catch (_) {}
  const state = window.__pbpCases = { filtered: parts.length > 0, seen: 0, ran: 0, pending: 0 };
  // Returns null when the case is filtered out, otherwise the done callback.
  window.pbpCaseGate = function (name) {
    state.seen++;
    if (state.filtered && !parts.some((part) => String(name).toLowerCase().includes(part))) return null;
    state.ran++;
    state.pending++;
    let finished = false;
    return function done() { if (!finished) { finished = true; state.pending--; } };
  };
})();
