#!/usr/bin/env node
// Generates and checks `@generated:runtime-messages` (`PBP_RUNTIME_MESSAGES`) in
// `shared.js` from `scripts/runtime-messages-source.mjs`, and enforces AST-level
// runtime messaging contracts across all root `*.js` files:
//   1. Bidirectional 1:1 parity between catalog entries, `sendMessage` senders,
//      and `onMessage.addListener` handlers (no unknown or orphan messages).
//   2. MV3 `onMessage` listener discipline (`.claude/rules/mv3.md`):
//      - `onMessage.addListener` callback must NEVER be `async`.
//      - `responseMode: "async"` responder must contain `return true` and use `sendResponse`.
//      - `responseMode: "sync"` responder must NOT `return true` and must use `sendResponse`.
//      - Passive observers (`observers`, including all `responseMode: "none"` broadcasts)
//        must NEVER `return true` or reference `sendResponse`.
//   3. No hand-written second copy of the runtime message table (>= 4 wire names).
//
// Usage:
//   node scripts/sync-runtime-messages.mjs --check   (default, read-only)
//   node scripts/sync-runtime-messages.mjs --write   (updates shared.js)

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXTERNAL_RUNTIME_SENDERS, RUNTIME_MESSAGES } from './runtime-messages-source.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SELF_DIR, '..');

const START_MARKER = '// @generated:runtime-messages start (catalog)';
const END_MARKER = '// @generated:runtime-messages end (catalog)';
const SECTION_HEADER = [
  '// ===================== Runtime message catalog =====================',
  '// Single source of truth: scripts/runtime-messages-source.mjs',
  '// Regenerate with: node scripts/sync-runtime-messages.mjs --write',
].join('\n');

function loadEspree(root) {
  const req = createRequire(join(root, '.qa-scan', 'package.json'));
  return req('espree');
}

export function renderRuntimeMessagesBlock(messages = RUNTIME_MESSAGES) {
  const lines = [
    START_MARKER,
    'const PBP_RUNTIME_MESSAGES = Object.freeze({',
  ];
  for (const spec of messages) {
    lines.push(`  ${spec.key}: ${JSON.stringify(spec.wire)},`);
  }
  lines.push('});');
  lines.push(END_MARKER);
  return lines.join('\n');
}

export function validateRuntimeMessagesCatalog(
  messages = RUNTIME_MESSAGES,
  externalSenders = EXTERNAL_RUNTIME_SENDERS,
) {
  const errors = [];
  if (!Array.isArray(messages) || messages.length === 0) {
    return ['RUNTIME_MESSAGES must be a non-empty array'];
  }
  const seenKeys = new Set();
  const seenWires = new Set();
  const identRe = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

  for (const spec of messages) {
    if (!spec || typeof spec !== 'object') {
      errors.push('RUNTIME_MESSAGES entry must be an object');
      continue;
    }
    if (typeof spec.key !== 'string' || !identRe.test(spec.key)) {
      errors.push(`invalid message key: ${JSON.stringify(spec.key)}`);
    }
    if (typeof spec.wire !== 'string' || !spec.wire) {
      errors.push(`invalid message wire name for ${spec.key}`);
    }
    if (spec.key !== spec.wire) {
      errors.push(`message key "${spec.key}" must match wire "${spec.wire}"`);
    }
    if (seenKeys.has(spec.key)) errors.push(`duplicate message key: ${spec.key}`);
    if (seenWires.has(spec.wire)) errors.push(`duplicate message wire: ${spec.wire}`);
    seenKeys.add(spec.key);
    seenWires.add(spec.wire);

    if (!['type', 'action'].includes(spec.discriminator)) {
      errors.push(`${spec.wire}: invalid discriminator "${spec.discriminator}"`);
    }
    if (!['runtime', 'tabs'].includes(spec.transport)) {
      errors.push(`${spec.wire}: invalid transport "${spec.transport}"`);
    }
    if (!['async', 'sync', 'none'].includes(spec.responseMode)) {
      errors.push(`${spec.wire}: invalid responseMode "${spec.responseMode}"`);
    }
    if (!Array.isArray(spec.senders) || spec.senders.length === 0) {
      errors.push(`${spec.wire}: senders must be a non-empty array`);
    } else if (new Set(spec.senders).size !== spec.senders.length) {
      errors.push(`${spec.wire}: duplicate file in senders`);
    }
    if (!Array.isArray(spec.observers)) {
      errors.push(`${spec.wire}: observers must be an array`);
    } else if (new Set(spec.observers).size !== spec.observers.length) {
      errors.push(`${spec.wire}: duplicate file in observers`);
    }

    if (spec.responseMode === 'none') {
      if (spec.responder !== null) {
        errors.push(`${spec.wire}: responseMode "none" must have responder: null`);
      }
      if (!spec.observers || spec.observers.length === 0) {
        errors.push(`${spec.wire}: broadcast message must list at least one observer`);
      }
    } else {
      if (typeof spec.responder !== 'string' || !spec.responder.endsWith('.js')) {
        errors.push(`${spec.wire}: responseMode "${spec.responseMode}" requires a single *.js responder`);
      } else if (spec.observers && spec.observers.includes(spec.responder)) {
        errors.push(`${spec.wire}: ${spec.responder} cannot be both responder and observer`);
      }
    }
  }

  if (!Array.isArray(externalSenders)) {
    errors.push('EXTERNAL_RUNTIME_SENDERS must be an array');
  } else {
    const extIds = new Set();
    for (const ext of externalSenders) {
      if (!ext?.id || extIds.has(ext.id)) {
        errors.push(`invalid or duplicate EXTERNAL_RUNTIME_SENDERS id: ${ext?.id}`);
      }
      extIds.add(ext?.id);
    }
  }
  return errors;
}

function unwrapChain(node) {
  return node?.type === 'ChainExpression' ? node.expression : node;
}

function propName(prop) {
  if (!prop || prop.computed) return null;
  if (prop.key?.type === 'Identifier') return prop.key.name;
  if (prop.key?.type === 'Literal' && typeof prop.key.value === 'string') return prop.key.value;
  return null;
}

function memberTail(node) {
  const n = unwrapChain(node);
  if (!n || n.type !== 'MemberExpression' || n.computed) return null;
  if (n.property?.type !== 'Identifier') return null;
  return { object: unwrapChain(n.object), property: n.property.name };
}

function isChromeRoot(node) {
  const n = unwrapChain(node);
  if (!n) return false;
  if (n.type === 'Identifier' && n.name === 'chrome') return true;
  const tail = memberTail(n);
  return !!(
    tail &&
    tail.property === 'chrome' &&
    tail.object?.type === 'Identifier' &&
    (tail.object.name === 'globalThis' || tail.object.name === 'window' || tail.object.name === 'self')
  );
}

// Returns "runtime" | "tabs" if callee is `chrome.runtime.sendMessage` or `chrome.tabs.sendMessage`.
function matchSendMessageCallee(callee) {
  const m1 = memberTail(callee);
  if (!m1 || m1.property !== 'sendMessage') return null;
  const m2 = memberTail(m1.object);
  if (!m2 || !isChromeRoot(m2.object)) return null;
  if (m2.property === 'runtime' || m2.property === 'tabs') return m2.property;
  return null;
}

function isOnMessageAddListener(callee) {
  const m1 = memberTail(callee);
  if (!m1 || m1.property !== 'addListener') return false;
  const m2 = memberTail(m1.object);
  if (!m2 || m2.property !== 'onMessage') return false;
  const m3 = memberTail(m2.object);
  return !!(m3 && m3.property === 'runtime' && isChromeRoot(m3.object));
}

function walkAst(node, visitor, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (visitor(node, parent) === false) return;
  for (const [key, val] of Object.entries(node)) {
    if (key === 'parent' || key === 'loc' || key === 'range' || key.startsWith('__')) continue;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item.type === 'string') walkAst(item, visitor, node);
      }
    } else if (val && typeof val.type === 'string') {
      walkAst(val, visitor, node);
    }
  }
}

function isFunctionNode(node) {
  return (
    node?.type === 'FunctionDeclaration' ||
    node?.type === 'FunctionExpression' ||
    node?.type === 'ArrowFunctionExpression'
  );
}

function paramIdentName(param) {
  if (!param) return null;
  if (param.type === 'Identifier') return param.name;
  if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') return param.left.name;
  return null;
}

function buildFileIndex(ast) {
  const functionsByName = new Map();
  const callsByName = new Map();

  walkAst(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name) {
      if (!functionsByName.has(node.id.name)) functionsByName.set(node.id.name, []);
      functionsByName.get(node.id.name).push(node);
    } else if (
      node.type === 'VariableDeclarator' &&
      node.id?.type === 'Identifier' &&
      isFunctionNode(node.init)
    ) {
      if (!functionsByName.has(node.id.name)) functionsByName.set(node.id.name, []);
      functionsByName.get(node.id.name).push(node.init);
    } else if (node.type === 'CallExpression') {
      const callee = unwrapChain(node.callee);
      if (callee?.type === 'Identifier') {
        if (!callsByName.has(callee.name)) callsByName.set(callee.name, []);
        callsByName.get(callee.name).push(node);
      }
    }
  });

  return { functionsByName, callsByName };
}

function findLocalConstInit(fnNode, identName) {
  let found = null;
  let reassigned = false;
  const body = fnNode?.body;
  if (!body || body.type !== 'BlockStatement') return null;

  walkAst(body, (node) => {
    if (node !== body && isFunctionNode(node)) return false;
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === identName) {
      if (found !== null) reassigned = true;
      found = node.init || null;
    } else if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier' && node.left.name === identName) {
      reassigned = true;
    }
    return undefined;
  });

  return reassigned ? null : found;
}

function resolveCatalogMember(node, catalogKeyMap) {
  const tail = memberTail(node);
  if (!tail || tail.object?.type !== 'Identifier' || tail.object.name !== 'PBP_RUNTIME_MESSAGES') {
    return null;
  }
  return catalogKeyMap.get(tail.property) ?? null;
}

function resolveScalarWires(expr, ctx, depth = 0) {
  if (!expr || depth > 5) return null;
  const n = unwrapChain(expr);
  if (n.type === 'Literal' && typeof n.value === 'string') {
    return [n.value];
  }
  const memberWire = resolveCatalogMember(n, ctx.catalogKeyMap);
  if (memberWire !== null) {
    return [memberWire];
  }
  if (n.type === 'ConditionalExpression') {
    const left = resolveScalarWires(n.consequent, ctx, depth + 1);
    const right = resolveScalarWires(n.alternate, ctx, depth + 1);
    if (!left || !right) return null;
    return [...new Set([...left, ...right])];
  }
  if (n.type === 'Identifier' && ctx.enclosingFn) {
    const pIdx = ctx.enclosingFn.params.findIndex((p) => paramIdentName(p) === n.name);
    if (pIdx >= 0 && ctx.enclosingName) {
      const callSites = ctx.fileIndex.callsByName.get(ctx.enclosingName) || [];
      if (callSites.length === 0) return null;
      const out = [];
      for (const site of callSites) {
        const arg = site.arguments[pIdx];
        const callerCtx = { ...ctx, enclosingFn: site.__enclosingFn || null, enclosingName: site.__enclosingName || null };
        const resolved = resolveScalarWires(arg, callerCtx, depth + 1);
        if (!resolved || resolved.length === 0) return null;
        out.push(...resolved);
      }
      return [...new Set(out)];
    }
    const localInit = findLocalConstInit(ctx.enclosingFn, n.name);
    if (localInit) {
      return resolveScalarWires(localInit, ctx, depth + 1);
    }
  }
  return null;
}

function resolveMessageObjectPayloads(expr, ctx, depth = 0) {
  if (!expr || depth > 5) return null;
  const n = unwrapChain(expr);

  if (n.type === 'ObjectExpression') {
    let typeProp = null;
    let actionProp = null;
    const spreads = [];
    for (const prop of n.properties) {
      if (prop.type === 'SpreadElement') {
        spreads.push(prop.argument);
        continue;
      }
      const k = propName(prop);
      if (k === 'type') typeProp = prop.value;
      else if (k === 'action') actionProp = prop.value;
    }

    if (typeProp) {
      const wires = resolveScalarWires(typeProp, ctx, depth + 1);
      return wires ? wires.map((wire) => ({ discriminator: 'type', wire })) : null;
    }

    if (spreads.length > 0) {
      const fromSpread = [];
      for (const sp of spreads) {
        const resolved = resolveMessageObjectPayloads(sp, ctx, depth + 1);
        if (resolved && resolved.length > 0) fromSpread.push(...resolved);
      }
      if (fromSpread.length > 0) return fromSpread;
    }

    if (actionProp) {
      const wires = resolveScalarWires(actionProp, ctx, depth + 1);
      return wires ? wires.map((wire) => ({ discriminator: 'action', wire })) : null;
    }

    return null;
  }

  if (n.type === 'Identifier' && ctx.enclosingFn) {
    const pIdx = ctx.enclosingFn.params.findIndex((p) => paramIdentName(p) === n.name);
    if (pIdx >= 0 && ctx.enclosingName) {
      const callSites = ctx.fileIndex.callsByName.get(ctx.enclosingName) || [];
      if (callSites.length === 0) return null;
      const out = [];
      for (const site of callSites) {
        const arg = site.arguments[pIdx];
        const callerCtx = { ...ctx, enclosingFn: site.__enclosingFn || null, enclosingName: site.__enclosingName || null };
        const resolved = resolveMessageObjectPayloads(arg, callerCtx, depth + 1);
        if (!resolved || resolved.length === 0) return null;
        out.push(...resolved);
      }
      return out;
    }
    const localInit = findLocalConstInit(ctx.enclosingFn, n.name);
    if (localInit) {
      return resolveMessageObjectPayloads(localInit, ctx, depth + 1);
    }
  }

  return null;
}

function annotateEnclosingFunctions(ast) {
  function visit(node, fnNode, fnName) {
    if (!node || typeof node.type !== 'string') return;
    node.__enclosingFn = fnNode;
    node.__enclosingName = fnName;

    let nextFn = fnNode;
    let nextName = fnName;
    if (node.type === 'FunctionDeclaration') {
      nextFn = node;
      nextName = node.id?.name || null;
    } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && isFunctionNode(node.init)) {
      node.init.__enclosingFn = node.init;
      node.init.__enclosingName = node.id.name;
      for (const [k, v] of Object.entries(node.init)) {
        if (k === 'parent' || k === 'loc' || k === 'range') continue;
        if (Array.isArray(v)) {
          for (const item of v) if (item && typeof item.type === 'string') visit(item, node.init, node.id.name);
        } else if (v && typeof v.type === 'string') {
          visit(v, node.init, node.id.name);
        }
      }
      return;
    } else if (isFunctionNode(node)) {
      nextFn = node;
      nextName = node.id?.name || null;
    }

    for (const [k, v] of Object.entries(node)) {
      if (k === 'parent' || k === 'loc' || k === 'range' || k.startsWith('__')) continue;
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item.type === 'string') visit(item, nextFn, nextName);
      } else if (v && typeof v.type === 'string') {
        visit(v, nextFn, nextName);
      }
    }
  }
  visit(ast, null, null);
}

function isMessageFieldAccess(node, msgParam, fieldName) {
  const tail = memberTail(node);
  return !!(
    tail &&
    tail.property === fieldName &&
    tail.object?.type === 'Identifier' &&
    tail.object.name === msgParam
  );
}

function exprChecksMessageType(expr, msgParam) {
  let found = false;
  walkAst(expr, (n) => {
    if (isMessageFieldAccess(n, msgParam, 'type')) {
      found = true;
      return false;
    }
    return undefined;
  });
  return found;
}

function extractListenerChecksFromFunction(
  fnNode,
  msgParam,
  catalogKeyMap,
  fileIndex,
  visitedFns = new Set(),
  initialTypeGuarded = false,
) {
  if (!fnNode || !msgParam || visitedFns.has(fnNode)) return [];
  visitedFns.add(fnNode);

  const found = [];
  const ctx = { catalogKeyMap, fileIndex, enclosingFn: fnNode, enclosingName: null };

  function walkWithGuard(node, inTypeGuardedCondition = false) {
    if (!node || typeof node.type !== 'string') return;
    if (node !== fnNode && isFunctionNode(node)) {
      // Still inspect nested callbacks/IIFEs inside the listener that close over `msgParam`
      // unless they shadow `msgParam`.
      const shadows = node.params.some((p) => paramIdentName(p) === msgParam);
      if (shadows) return;
    }

    if (node.type === 'IfStatement') {
      const testHasType = exprChecksMessageType(node.test, msgParam);
      walkWithGuard(node.test, inTypeGuardedCondition || testHasType);
      walkWithGuard(node.consequent, inTypeGuardedCondition || testHasType);
      if (node.alternate) walkWithGuard(node.alternate, inTypeGuardedCondition);
      return;
    }

    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node.operator)) {
      for (const field of ['type', 'action']) {
        if (field === 'action' && inTypeGuardedCondition) continue;
        let other = null;
        if (isMessageFieldAccess(node.left, msgParam, field)) other = node.right;
        else if (isMessageFieldAccess(node.right, msgParam, field)) other = node.left;
        if (other) {
          const wires = resolveScalarWires(other, ctx);
          if (wires) {
            for (const wire of wires) found.push({ discriminator: field, wire });
          }
        }
      }
    } else if (node.type === 'SwitchStatement') {
      for (const field of ['type', 'action']) {
        if (isMessageFieldAccess(node.discriminant, msgParam, field)) {
          for (const sc of node.cases) {
            if (!sc.test) continue;
            const wires = resolveScalarWires(sc.test, ctx);
            if (wires) {
              for (const wire of wires) found.push({ discriminator: field, wire });
            }
          }
        }
      }
    } else if (node.type === 'CallExpression') {
      const callee = unwrapChain(node.callee);
      const tail = memberTail(callee);
      // e.g. ["PBP_ASK_ARCHIVE_SYNCED", "PBP_ASK_ARCHIVE_DIRTY"].includes(message?.type)
      if (
        tail &&
        tail.property === 'includes' &&
        tail.object?.type === 'ArrayExpression' &&
        node.arguments.length === 1 &&
        isMessageFieldAccess(node.arguments[0], msgParam, 'type')
      ) {
        for (const el of tail.object.elements) {
          const wires = resolveScalarWires(el, ctx);
          if (wires) {
            for (const wire of wires) found.push({ discriminator: 'type', wire });
          }
        }
      }
      // Follow direct delegation `helper(message)` in the same file (e.g. md-dict.js `refreshed(message)`).
      if (
        callee?.type === 'Identifier' &&
        node.arguments.length >= 1 &&
        node.arguments[0]?.type === 'Identifier' &&
        node.arguments[0].name === msgParam
      ) {
        const targets = fileIndex.functionsByName.get(callee.name) || [];
        for (const targetFn of targets) {
          const targetMsgParam = paramIdentName(targetFn.params[0]);
          if (targetMsgParam) {
            found.push(
              ...extractListenerChecksFromFunction(
                targetFn,
                targetMsgParam,
                catalogKeyMap,
                fileIndex,
                visitedFns,
                inTypeGuardedCondition,
              ),
            );
          }
        }
      }
    }

    for (const [k, v] of Object.entries(node)) {
      if (k === 'parent' || k === 'loc' || k === 'range' || k.startsWith('__')) continue;
      if (Array.isArray(v)) {
        for (const item of v) if (item && typeof item.type === 'string') walkWithGuard(item, inTypeGuardedCondition);
      } else if (v && typeof v.type === 'string') {
        walkWithGuard(v, inTypeGuardedCondition);
      }
    }
  }

  walkWithGuard(fnNode.body, initialTypeGuarded);
  return found;
}

function inspectListenerChannel(fnNode) {
  let returnsTrue = false;
  if (fnNode.body?.type === 'BlockStatement') {
    walkAst(fnNode.body, (node) => {
      if (node !== fnNode.body && isFunctionNode(node)) return false;
      if (node.type === 'ReturnStatement' && node.argument?.type === 'Literal' && node.argument.value === true) {
        returnsTrue = true;
      }
      return undefined;
    });
  } else if (fnNode.body?.type === 'Literal' && fnNode.body.value === true) {
    returnsTrue = true;
  }

  const sendRespParam = paramIdentName(fnNode.params[2]);
  let usesSendResponse = false;
  if (sendRespParam && fnNode.body) {
    walkAst(fnNode.body, (node, parent) => {
      if (node.type !== 'Identifier' || node.name !== sendRespParam) return undefined;
      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return undefined;
      if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand) return undefined;
      usesSendResponse = true;
      return undefined;
    });
  }

  return { returnsTrue, usesSendResponse };
}

function syncSharedJsContent(src, messages) {
  const rendered = renderRuntimeMessagesBlock(messages);
  const startIdx = src.indexOf(START_MARKER);
  const endIdx = src.indexOf(END_MARKER);

  if (startIdx >= 0 && endIdx > startIdx) {
    const replaceEnd = endIdx + END_MARKER.length;
    const next = src.slice(0, startIdx) + rendered + src.slice(replaceEnd);
    return { next, changed: next !== src, regionStart: startIdx, regionEnd: startIdx + rendered.length };
  }

  if (startIdx >= 0 || endIdx >= 0) {
    throw new Error('shared.js has malformed @generated:runtime-messages markers');
  }

  const trimmed = src.replace(/\s*$/, '');
  const prefix = `${trimmed}\n\n${SECTION_HEADER}\n`;
  const next = `${prefix}${rendered}\n`;
  return { next, changed: true, regionStart: prefix.length, regionEnd: prefix.length + rendered.length };
}

export function syncRuntimeMessages({
  root = DEFAULT_ROOT,
  write = false,
  messages = RUNTIME_MESSAGES,
  externalSenders = EXTERNAL_RUNTIME_SENDERS,
  espreeModule = null,
} = {}) {
  const errors = validateRuntimeMessagesCatalog(messages, externalSenders);
  if (errors.length > 0) {
    return { ok: false, errors, updatedFiles: [] };
  }

  const espree = espreeModule || loadEspree(root);
  const updatedFiles = [];
  const sharedPath = join(root, 'shared.js');
  let sharedSrc = readFileSync(sharedPath, 'utf8');
  let regionBounds = { regionStart: -1, regionEnd: -1 };

  try {
    const synced = syncSharedJsContent(sharedSrc, messages);
    regionBounds = { regionStart: synced.regionStart, regionEnd: synced.regionEnd };
    if (synced.changed) {
      if (write) {
        writeFileSync(sharedPath, synced.next, 'utf8');
        sharedSrc = synced.next;
        updatedFiles.push('shared.js');
      } else {
        errors.push('shared.js @generated:runtime-messages region is missing or out of date (run: node scripts/sync-runtime-messages.mjs --write)');
      }
    }
  } catch (err) {
    errors.push(err.message || String(err));
    return { ok: false, errors, updatedFiles };
  }

  const byId = new Map(); // `${discriminator}:${wire}` -> spec
  const wireSet = new Set();
  const catalogKeyMap = new Map();
  for (const spec of messages) {
    byId.set(`${spec.discriminator}:${spec.wire}`, spec);
    wireSet.add(spec.wire);
    catalogKeyMap.set(spec.key, spec.wire);
  }

  const externalByMatch = new Map();
  for (const ext of externalSenders) {
    externalByMatch.set(`${ext.file}|${ext.extensionIdIdent}|${ext.payload}`, ext);
  }
  const seenExternalIds = new Set();

  const observedSenders = new Map(); // `${discriminator}:${wire}` -> Set<file>
  const observedListeners = new Map(); // `${discriminator}:${wire}` -> Set<file>

  const rootJsFiles = readdirSync(root)
    .filter((f) => f.endsWith('.js'))
    .sort();

  for (const file of rootJsFiles) {
    const src = file === 'shared.js' ? sharedSrc : readFileSync(join(root, file), 'utf8');
    let ast;
    try {
      ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'script', loc: true, range: true });
    } catch (err) {
      errors.push(`${file}: failed to parse JS (${err.message})`);
      continue;
    }

    annotateEnclosingFunctions(ast);
    const fileIndex = buildFileIndex(ast);

    // 1. Scan sendMessage calls, onMessage.addListener calls, and second-copy literals.
    walkAst(ast, (node) => {
      const [start, end] = node.range || [-1, -1];
      const insideGenerated =
        file === 'shared.js' &&
        regionBounds.regionStart >= 0 &&
        start >= regionBounds.regionStart &&
        end <= regionBounds.regionEnd;

      // ---- No second copy gate ----
      if (!insideGenerated && node.type === 'ArrayExpression') {
        const hits = new Set();
        for (const el of node.elements) {
          if (el?.type === 'Literal' && typeof el.value === 'string' && wireSet.has(el.value)) {
            hits.add(el.value);
          }
        }
        if (hits.size >= 4) {
          errors.push(
            `${file}:${node.loc.start.line}: hand-written second copy of runtime message names (${[...hits].slice(0, 5).join(', ')}) — derive from scripts/runtime-messages-source.mjs / PBP_RUNTIME_MESSAGES`,
          );
        }
      } else if (!insideGenerated && node.type === 'ObjectExpression') {
        const hits = new Set();
        for (const prop of node.properties) {
          if (prop.type !== 'Property') continue;
          const k = propName(prop);
          if (k && wireSet.has(k)) hits.add(k);
          if (prop.value?.type === 'Literal' && typeof prop.value.value === 'string' && wireSet.has(prop.value.value)) {
            hits.add(prop.value.value);
          }
        }
        if (hits.size >= 4) {
          errors.push(
            `${file}:${node.loc.start.line}: hand-written second copy of runtime message map (${[...hits].slice(0, 5).join(', ')}) — derive from scripts/runtime-messages-source.mjs / PBP_RUNTIME_MESSAGES`,
          );
        }
      }

      if (node.type !== 'CallExpression') return undefined;

      // ---- sendMessage gate ----
      const sendTransport = matchSendMessageCallee(node.callee);
      if (sendTransport) {
        const line = node.loc.start.line;
        // Cross-extension 2-arg call: chrome.runtime.sendMessage(EXTENSION_ID, "payload")
        if (
          sendTransport === 'runtime' &&
          node.arguments.length >= 2 &&
          node.arguments[0]?.type === 'Identifier' &&
          node.arguments[1]?.type === 'Literal' &&
          typeof node.arguments[1].value === 'string'
        ) {
          const extKey = `${file}|${node.arguments[0].name}|${node.arguments[1].value}`;
          const ext = externalByMatch.get(extKey);
          if (!ext) {
            errors.push(
              `${file}:${line}: unregistered cross-extension runtime.sendMessage(${node.arguments[0].name}, ${JSON.stringify(node.arguments[1].value)})`,
            );
          } else {
            seenExternalIds.add(ext.id);
          }
          return undefined;
        }

        const payloadArg = sendTransport === 'tabs' ? node.arguments[1] : node.arguments[0];
        const ctx = {
          catalogKeyMap,
          fileIndex,
          enclosingFn: node.__enclosingFn || null,
          enclosingName: node.__enclosingName || null,
        };
        const resolved = resolveMessageObjectPayloads(payloadArg, ctx);
        if (!resolved || resolved.length === 0) {
          errors.push(
            `${file}:${line}: ${sendTransport}.sendMessage payload cannot be statically resolved to a registered message discriminator`,
          );
          return undefined;
        }

        for (const { discriminator, wire } of resolved) {
          const id = `${discriminator}:${wire}`;
          const spec = byId.get(id);
          if (!spec) {
            errors.push(
              `${file}:${line}: ${sendTransport}.sendMessage dispatches unregistered message { ${discriminator}: ${JSON.stringify(wire)} }`,
            );
            continue;
          }
          if (spec.transport !== sendTransport) {
            errors.push(
              `${file}:${line}: message "${wire}" uses ${sendTransport}.sendMessage, but catalog declares transport "${spec.transport}"`,
            );
          }
          if (!spec.senders.includes(file)) {
            errors.push(
              `${file}:${line}: ${file} sends "${wire}" without being listed in senders[] of scripts/runtime-messages-source.mjs`,
            );
          }
          if (!observedSenders.has(id)) observedSenders.set(id, new Set());
          observedSenders.get(id).add(file);
        }
        return undefined;
      }

      // ---- onMessage.addListener gate ----
      if (isOnMessageAddListener(node.callee)) {
        const line = node.loc.start.line;
        const handlerArg = node.arguments[0];
        let fnNode = null;
        if (isFunctionNode(handlerArg)) {
          fnNode = handlerArg;
        } else if (handlerArg?.type === 'Identifier') {
          const candidates = fileIndex.functionsByName.get(handlerArg.name) || [];
          if (candidates.length === 1) fnNode = candidates[0];
        }

        if (!fnNode) {
          errors.push(
            `${file}:${line}: chrome.runtime.onMessage.addListener must pass an inline function or a uniquely named local function`,
          );
          return undefined;
        }

        // MV3 rule (.claude/rules/mv3.md): listener MUST NOT be async.
        if (fnNode.async === true) {
          errors.push(
            `${file}:${line}: chrome.runtime.onMessage.addListener callback must not be async (.claude/rules/mv3.md: return true keeps the channel open; async returns a Promise)`,
          );
        }

        const msgParam = paramIdentName(fnNode.params[0]);
        const checks = extractListenerChecksFromFunction(fnNode, msgParam, catalogKeyMap, fileIndex);
        if (checks.length === 0) {
          errors.push(
            `${file}:${line}: chrome.runtime.onMessage.addListener checks no message discriminators`,
          );
          return undefined;
        }

        const { returnsTrue, usesSendResponse } = inspectListenerChannel(fnNode);
        let actsAsAsyncResponder = false;
        let actsAsSyncResponder = false;
        let actsOnlyAsObserver = true;

        for (const { discriminator, wire } of checks) {
          const id = `${discriminator}:${wire}`;
          const spec = byId.get(id);
          if (!spec) {
            errors.push(
              `${file}:${line}: onMessage listener checks unregistered discriminator { ${discriminator}: ${JSON.stringify(wire)} }`,
            );
            actsOnlyAsObserver = false;
            continue;
          }

          const isResponder = spec.responder === file;
          const isObserver = spec.observers.includes(file);
          if (!isResponder && !isObserver) {
            errors.push(
              `${file}:${line}: ${file} handles "${wire}" in onMessage without being listed as responder or observer in scripts/runtime-messages-source.mjs`,
            );
          }
          if (isResponder) {
            actsOnlyAsObserver = false;
            if (spec.responseMode === 'async') actsAsAsyncResponder = true;
            else if (spec.responseMode === 'sync') actsAsSyncResponder = true;
          }
          if (!observedListeners.has(id)) observedListeners.set(id, new Set());
          observedListeners.get(id).add(file);
        }

        if (actsOnlyAsObserver) {
          if (returnsTrue) {
            errors.push(
              `${file}:${line}: passive/broadcast onMessage observer must NOT return true (holds sender message port open in MV3)`,
            );
          }
          if (usesSendResponse) {
            errors.push(
              `${file}:${line}: passive/broadcast onMessage observer must NOT call sendResponse`,
            );
          }
        } else {
          if (actsAsAsyncResponder && !returnsTrue) {
            errors.push(
              `${file}:${line}: async-response onMessage responder must return true to keep the MV3 reply channel open`,
            );
          }
          if (actsAsAsyncResponder && !usesSendResponse) {
            errors.push(
              `${file}:${line}: async-response onMessage responder never references sendResponse`,
            );
          }
          if (actsAsSyncResponder && returnsTrue) {
            errors.push(
              `${file}:${line}: synchronous onMessage responder must NOT return true`,
            );
          }
          if (actsAsSyncResponder && !usesSendResponse) {
            errors.push(
              `${file}:${line}: synchronous onMessage responder must call sendResponse`,
            );
          }
        }
      }
      return undefined;
    });
  }

  // 2. Reverse completeness: every catalog sender, responder, observer, and external sender must exist in AST.
  for (const spec of messages) {
    const id = `${spec.discriminator}:${spec.wire}`;
    const actualSenders = observedSenders.get(id) || new Set();
    for (const expectedSender of spec.senders) {
      if (!actualSenders.has(expectedSender)) {
        errors.push(
          `scripts/runtime-messages-source.mjs: "${spec.wire}" lists sender ${expectedSender}, but no matching ${spec.transport}.sendMessage was found in ${expectedSender}`,
        );
      }
    }

    const actualListeners = observedListeners.get(id) || new Set();
    const expectedListeners = [
      ...(spec.responder ? [spec.responder] : []),
      ...spec.observers,
    ];
    for (const expectedListener of expectedListeners) {
      if (!actualListeners.has(expectedListener)) {
        errors.push(
          `scripts/runtime-messages-source.mjs: "${spec.wire}" lists listener ${expectedListener}, but no matching onMessage branch was found in ${expectedListener}`,
        );
      }
    }
  }

  for (const ext of externalSenders) {
    if (!seenExternalIds.has(ext.id)) {
      errors.push(
        `scripts/runtime-messages-source.mjs: external sender "${ext.id}" (${ext.file}) was not found in AST`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    updatedFiles,
    messageCount: messages.length,
  };
}

function main(argv) {
  const unknown = argv.filter((a) => a !== '--check' && a !== '--write');
  if (unknown.length > 0 || (argv.includes('--check') && argv.includes('--write'))) {
    console.error('Usage: node scripts/sync-runtime-messages.mjs [--check | --write]');
    process.exit(2);
  }
  const write = argv.includes('--write');
  const res = syncRuntimeMessages({ write });
  if (!res.ok) {
    for (const err of res.errors) {
      console.error(`[runtime-messages] ${err}`);
    }
    process.exit(1);
  }
  if (write) {
    console.log(
      res.updatedFiles.length > 0
        ? `[runtime-messages] synced ${res.updatedFiles.join(', ')} (${res.messageCount} messages)`
        : `[runtime-messages] already in sync (${res.messageCount} messages)`,
    );
  } else {
    console.log(`[runtime-messages] OK — ${res.messageCount} messages synced, MV3 onMessage & AST parity verified`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
