// The per-process environment of the CI font emulation (scripts/ci-fonts.conf),
// shared by scripts/ui-render-audit.mjs and scripts/options-help-render-audit.mjs.
// Dev-only, like everything under scripts/ (release.sh never packages it).
//
// One module instead of a copy in each audit (round 3 of the follow-up batch):
// the isolation dir, its cleanup on every way out, the parity probe's
// environment and the "Reproduce" command that must mirror that environment
// are four pieces that have to agree with each other, and two copies had
// already needed the same fix twice.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// The CI emulation must not depend on the developer's OWN fontconfig.
// scripts/ci-fonts.conf includes the host's /etc/fonts/conf.d, and that
// directory's 50-user.conf pulls in $XDG_CONFIG_HOME/fontconfig/{conf.d,
// fonts.conf} (default ~/.config/fontconfig) -- a personal hintstyle,
// subpixel order or family preference there would silently change what the
// "CI" run rasterises (a global `<match target="font">` assign even
// overrides conf.d's per-font rules that CI keeps, e.g. 25-wqy-zenhei.conf's
// hintnone + rgba none for WenQuanYi). So, with FONTCONFIG_FILE set, the
// browser (and the fc-match parity probe) get XDG_CONFIG_HOME pointed at an
// empty temp dir. The two legacy per-user files 50-user.conf also reads,
// ~/.fonts.conf and ~/.fonts.conf.d, hang off $HOME and cannot be redirected
// that way, so their presence stops the run instead of being half-honoured.
// A pin of hintstyle/rgba after the include was rejected for the same
// per-font reason: it would clobber the WenQuanYi rule CI has. What is left
// host-dependent is the host conf.d itself and 51-local.conf's
// /etc/fonts/local.conf (the ci-fonts.conf header says so).
//
// `tag` is the calling audit's log prefix. Returns null when FONTCONFIG_FILE
// is not set (CI, and every default run): nothing to isolate.
export function isolatedFontconfigEnv(tag) {
  if (!process.env.FONTCONFIG_FILE) return null;
  const legacy = [join(homedir(), ".fonts.conf"), join(homedir(), ".fonts.conf.d")].filter((p) => existsSync(p));
  if (legacy.length) {
    console.error(
      `[${tag}] FONTCONFIG_FILE is set but legacy per-user fontconfig exists (${legacy.join(", ")}). ` +
      `/etc/fonts/conf.d/50-user.conf reads it through $HOME, which this script cannot isolate the way it isolates ` +
      `$XDG_CONFIG_HOME/fontconfig, so the CI emulation would silently include your personal settings. ` +
      `Move it under ~/.config/fontconfig (isolated automatically) or out of the way, then rerun.`
    );
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), "pbp-ci-fonts-xdg-"));
  removeOnAnyExit(dir);
  return { dir, env: { ...process.env, XDG_CONFIG_HOME: dir } };
}

// The isolation dir goes on every way out, not only a normal exit (round 3):
// Node skips "exit" listeners when a signal kills the process, so an
// interrupted audit (Ctrl-C, `kill`, a closed terminal) used to leave
// /tmp/pbp-ci-fonts-xdg-* behind. On SIGINT / SIGTERM / SIGHUP the dir is
// removed first, then:
//   - if nothing else listens to that signal, the default action is restored
//     and the signal re-raised, so the process still dies OF the signal (its
//     parent sees 128+n, as before);
//   - while a browser is open, Playwright has its own handlers for the same
//     three signals (close the browser; exit 130 on SIGINT). Those then own
//     what happens next -- re-raising here would read as Playwright's
//     "second Ctrl-C" and kill the browser without closing it.
const EXIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
function removeOnAnyExit(dir) {
  const remove = () => rmSync(dir, { recursive: true, force: true });
  process.on("exit", remove);
  for (const signal of EXIT_SIGNALS) {
    const onSignal = () => {
      remove();
      if (process.listenerCount(signal) === 1) {
        process.off(signal, onSignal);
        process.kill(process.pid, signal);
      }
    };
    process.on(signal, onSignal);
  }
}

// The parity probe's own environment: the isolated one with the locale
// pinned. fontconfig takes its default language from FC_LANG, else the
// LC_CTYPE locale (LC_ALL > LC_CTYPE > LANG), and "Microsoft YaHei" is a
// family the conf does not have, so fc-match falls back to the best font for
// THAT language: under zh_CN.UTF-8 (or FC_LANG=ja) a correctly loaded conf
// answers WenQuanYi Zen Hei, not DejaVu Sans, and the check blamed an XML
// comment for it. Pinned to C.UTF-8 with every LC_* / LANGUAGE / FC_LANG
// dropped (measured: DejaVu Sans under the conf, msyh.ttc without it,
// whatever the parent locale). Only the probe: the browser keeps the
// inherited locale, and a zh_CN run rasterised the same 184 help probes
// pixel for pixel. PROBE_DROPPED is the single source of that rule for both
// the probe and the Reproduce command below.
const PROBE_DROPPED = "LC_[A-Za-z0-9_]+|LANGUAGE|FC_LANG";
const PROBE_DROPPED_RE = new RegExp(`^(?:${PROBE_DROPPED})$`);
export function parityProbeEnv(env) {
  const out = Object.fromEntries(Object.entries(env).filter(([k]) => !PROBE_DROPPED_RE.test(k)));
  out.LANG = "C.UTF-8";
  return out;
}

// The fc-match probe, as a shell command that rebuilds exactly the probe's
// environment in whatever shell it is pasted into (round 3, M): every
// variable PROBE_DROPPED matches is unset -- all LC_*, LANGUAGE, FC_LANG,
// found by the same pattern at paste time rather than a fixed list -- LANG is
// C.UTF-8, and XDG_CONFIG_HOME is a fresh empty dir, like the isolation.
export function parityReproduceCommand(confPath) {
  return `env $(env | sed -nE 's/^(${PROBE_DROPPED})=.*/-u \\1/p') LANG=C.UTF-8 XDG_CONFIG_HOME="$(mktemp -d)" FONTCONFIG_FILE="${confPath}" fc-match "Microsoft YaHei"`;
}
