// Self-tests for scripts/runtime-messages-source.mjs and scripts/sync-runtime-messages.mjs.
// Node only, 0 slice anchors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTERNAL_RUNTIME_SENDERS, RUNTIME_MESSAGES } from '../scripts/runtime-messages-source.mjs';
import {
  syncRuntimeMessages,
  validateRuntimeMessagesCatalog,
} from '../scripts/sync-runtime-messages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, '.qa-scan', 'package.json'));
const espree = require('espree');

const SAMPLE_MESSAGES = Object.freeze([
  Object.freeze({
    key: 'msg_rpc_one',
    wire: 'msg_rpc_one',
    discriminator: 'type',
    transport: 'runtime',
    responseMode: 'async',
    responder: 'worker.js',
    observers: Object.freeze([]),
    senders: Object.freeze(['sender.js']),
  }),
  Object.freeze({
    key: 'msg_rpc_two',
    wire: 'msg_rpc_two',
    discriminator: 'type',
    transport: 'runtime',
    responseMode: 'async',
    responder: 'worker.js',
    observers: Object.freeze([]),
    senders: Object.freeze(['sender.js']),
  }),
  Object.freeze({
    key: 'msg_tab_cmd',
    wire: 'msg_tab_cmd',
    discriminator: 'type',
    transport: 'tabs',
    responseMode: 'sync',
    responder: 'tab.js',
    observers: Object.freeze([]),
    senders: Object.freeze(['worker.js']),
  }),
  Object.freeze({
    key: 'msg_broadcast',
    wire: 'msg_broadcast',
    discriminator: 'type',
    transport: 'runtime',
    responseMode: 'none',
    responder: null,
    observers: Object.freeze(['observer.js']),
    senders: Object.freeze(['worker.js']),
  }),
]);

function makeSyntheticRepo(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pbp-runtime-msgs-'));
  const files = {
    'shared.js': '// shared header\nfunction noop() {}\n',
    'sender.js': [
      'async function sendBoth() {',
      '  await chrome.runtime.sendMessage({ type: PBP_RUNTIME_MESSAGES.msg_rpc_one });',
      '  await chrome.runtime.sendMessage({ type: "msg_rpc_two" });',
      '}',
    ].join('\n'),
    'worker.js': [
      'function handleMsg(message, sender, sendResponse) {',
      '  if (message?.type === "msg_rpc_one" || message?.type === "msg_rpc_two") {',
      '    Promise.resolve({ ok: true }).then(sendResponse);',
      '    return true;',
      '  }',
      '}',
      'chrome.runtime.onMessage.addListener(handleMsg);',
      'function notifyAll(tabId) {',
      '  chrome.tabs.sendMessage(tabId, { type: "msg_tab_cmd", action: "save" });',
      '  chrome.runtime.sendMessage({ type: PBP_RUNTIME_MESSAGES.msg_broadcast });',
      '}',
    ].join('\n'),
    'tab.js': [
      'chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {',
      '  if (message?.type !== "msg_tab_cmd" || !["save", "later"].includes(message.action)) return;',
      '  sendResponse({ ok: true });',
      '});',
    ].join('\n'),
    'observer.js': [
      'chrome.runtime.onMessage.addListener((message) => {',
      '  if (message?.type === "msg_broadcast") console.warn("synced");',
      '});',
    ].join('\n'),
    ...overrides,
  };
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

test('live catalog invariants and live repository --check pass with zero errors', () => {
  // 最简单漏判反例：目录与真实仓库某条新消息漏对账，或某处 listener 误写成 async 却无人阻断。
  assert.deepEqual(validateRuntimeMessagesCatalog(RUNTIME_MESSAGES, EXTERNAL_RUNTIME_SENDERS), []);
  assert.equal(RUNTIME_MESSAGES.length, 43);
  const res = syncRuntimeMessages({ root: ROOT, write: false, espreeModule: espree });
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.equal(res.messageCount, 43);
});

test('catalog validation rejects duplicate keys, broadcast responders and dual responder+observer', () => {
  const dup = validateRuntimeMessagesCatalog([SAMPLE_MESSAGES[0], SAMPLE_MESSAGES[0]], []);
  assert.ok(dup.some((e) => /duplicate message key/.test(e)));

  const badBroadcast = validateRuntimeMessagesCatalog([
    { ...SAMPLE_MESSAGES[3], responder: 'worker.js' },
  ], []);
  assert.ok(badBroadcast.some((e) => /responder: null/.test(e)));

  const dualRole = validateRuntimeMessagesCatalog([
    { ...SAMPLE_MESSAGES[0], observers: ['worker.js'] },
  ], []);
  assert.ok(dualRole.some((e) => /both responder and observer/.test(e)));
});

test('drift detection fails --check and heals cleanly under --write', () => {
  const dir = makeSyntheticRepo();
  try {
    // Missing @generated region initially -> --check fails.
    const before = syncRuntimeMessages({
      root: dir,
      write: false,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(before.ok, false);
    assert.match(before.errors.join('\n'), /@generated:runtime-messages/);

    // --write generates the region and passes all AST gates.
    const written = syncRuntimeMessages({
      root: dir,
      write: true,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(written.ok, true, written.errors.join('\n'));
    assert.deepEqual(written.updatedFiles, ['shared.js']);
    assert.match(readFileSync(join(dir, 'shared.js'), 'utf8'), /const PBP_RUNTIME_MESSAGES = Object\.freeze\(/);

    // Subsequent --check passes with zero changes.
    const after = syncRuntimeMessages({
      root: dir,
      write: false,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(after.ok, true, after.errors.join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AST parity rejects unknown senders, orphan onMessage branches, dead catalog entries and dynamic payloads', () => {
  // 1. Unknown sent message type + dynamic payload.
  const dirUnknown = makeSyntheticRepo({
    'sender.js': [
      'async function sendBad(raw) {',
      '  await chrome.runtime.sendMessage({ type: "msg_rpc_one" });',
      '  await chrome.runtime.sendMessage({ type: "msg_rpc_two" });',
      '  await chrome.runtime.sendMessage({ type: "unregistered_wire" });',
      '  await chrome.runtime.sendMessage(raw);',
      '}',
    ].join('\n'),
  });
  try {
    const res = syncRuntimeMessages({
      root: dirUnknown,
      write: true,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /unregistered message \{ type: "unregistered_wire" \}/);
    assert.match(res.errors.join('\n'), /cannot be statically resolved/);
  } finally {
    rmSync(dirUnknown, { recursive: true, force: true });
  }

  // 2. Orphan onMessage branch + missing declared sender.
  const dirOrphan = makeSyntheticRepo({
    'sender.js': 'chrome.runtime.sendMessage({ type: "msg_rpc_one" });\n',
    'observer.js': [
      'chrome.runtime.onMessage.addListener((message) => {',
      '  if (message?.type === "msg_broadcast" || message?.type === "orphan_branch") return;',
      '});',
    ].join('\n'),
  });
  try {
    const res = syncRuntimeMessages({
      root: dirOrphan,
      write: true,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /unregistered discriminator \{ type: "orphan_branch" \}/);
    assert.match(res.errors.join('\n'), /"msg_rpc_two" lists sender sender\.js/);
  } finally {
    rmSync(dirOrphan, { recursive: true, force: true });
  }
});

test('MV3 onMessage channel rules reject async listeners, missing return true on async RPCs, and return true on observers', () => {
  // 最简单漏判反例：mv3.md 第 31 行「onMessage 监听器不能是 async 函数、异步响应必须 return true、广播观察者不得 return true」仅靠人工审阅而无静态拦截。
  const dirAsync = makeSyntheticRepo({
    'observer.js': [
      'chrome.runtime.onMessage.addListener(async (message) => {',
      '  if (message?.type === "msg_broadcast") await Promise.resolve();',
      '});',
    ].join('\n'),
  });
  try {
    const res = syncRuntimeMessages({
      root: dirAsync,
      write: true,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /callback must not be async/);
  } finally {
    rmSync(dirAsync, { recursive: true, force: true });
  }

  const dirBadChannels = makeSyntheticRepo({
    'worker.js': [
      'function handleMsg(message, sender, sendResponse) {',
      '  if (message?.type === "msg_rpc_one" || message?.type === "msg_rpc_two") {',
      '    Promise.resolve({ ok: true }).then(sendResponse);',
      '  }',
      '}',
      'chrome.runtime.onMessage.addListener(handleMsg);',
      'chrome.tabs.sendMessage(1, { type: "msg_tab_cmd", action: "save" });',
      'chrome.runtime.sendMessage({ type: "msg_broadcast" });',
    ].join('\n'),
    'observer.js': [
      'chrome.runtime.onMessage.addListener((message) => {',
      '  if (message?.type === "msg_broadcast") return true;',
      '});',
    ].join('\n'),
  });
  try {
    const res = syncRuntimeMessages({
      root: dirBadChannels,
      write: true,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /async-response onMessage responder must return true/);
    assert.match(res.errors.join('\n'), /passive\/broadcast onMessage observer must NOT return true/);
  } finally {
    rmSync(dirBadChannels, { recursive: true, force: true });
  }
});

test('AST no-second-copy gate blocks hand-written message arrays and maps outside @generated region', () => {
  const dirDup = makeSyntheticRepo({
    'extra.js': 'const DUP = ["msg_rpc_one", "msg_rpc_two", "msg_tab_cmd", "msg_broadcast"];\n',
  });
  try {
    const res = syncRuntimeMessages({
      root: dirDup,
      write: true,
      messages: SAMPLE_MESSAGES,
      externalSenders: [],
      espreeModule: espree,
    });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /extra\.js:1: hand-written second copy of runtime message names/);
  } finally {
    rmSync(dirDup, { recursive: true, force: true });
  }
});
