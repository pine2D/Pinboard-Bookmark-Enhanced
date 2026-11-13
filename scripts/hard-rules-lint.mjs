#!/usr/bin/env node
// Mechanical gates for two high-consequence rules in `.claude/rules/storage-sync.md`
// and `CLAUDE.md` (roadmap §7.2):
//   1. `chrome.storage.sync` writes (`set` / `remove` / `clear`) must check
//      `chrome.runtime.lastError` when using callbacks, and must never fire an
//      unawaited/unhandled Promise or sit outside `try/catch` inside a void
//      event listener callback when using MV3's Promise API.
//   2. Credentials (API keys, tokens, capability webhook URLs, private keys)
//      must never be hardcoded in tracked files or assigned non-empty string
//      defaults on `API_KEY_FIELDS` / `exportTargets` secret slots.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(SELF_DIR, "..");

const require = createRequire(import.meta.url);
const espree = require(join(DEFAULT_ROOT, ".qa-scan/node_modules/espree"));

const SYNC_WRITE_METHODS = new Set(["set", "remove", "clear"]);
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".zip", ".gz", ".tar", ".pdf", ".mp4", ".webm", ".mp3", ".wav",
]);

const CREDENTIAL_PATTERNS = Object.freeze([
  {
    id: "openai-or-anthropic-prefixed-key",
    re: /\bsk-(?:proj|ant-api\d*|or-v1)-[A-Za-z0-9_-]{24,}\b/g,
  },
  {
    id: "long-sk-api-key",
    re: /\bsk-[A-Za-z0-9]{32,}\b/g,
  },
  {
    id: "google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "github-pat",
    re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
  },
  {
    id: "github-fine-grained-pat",
    re: /\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
  },
  {
    id: "notion-secret",
    re: /\b(?:ntn|secret)_[A-Za-z0-9]{32,}\b/g,
  },
  {
    id: "slack-token",
    re: /\bxox[baprs]-[0-9]{10,}-[A-Za-z0-9-]{16,}\b/g,
  },
  {
    id: "slack-webhook-url",
    re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]{8,}\/B[A-Z0-9]{8,}\/[A-Za-z0-9]{16,}/g,
  },
  {
    id: "discord-webhook-url",
    re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/[0-9]{15,}\/[A-Za-z0-9_-]{30,}/g,
  },
  {
    id: "aws-access-key-id",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: "telegram-bot-token",
    re: /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/g,
  },
  {
    id: "private-key-pem",
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
  },
]);

function parseJs(source, filename) {
  for (const sourceType of filename.endsWith(".mjs") ? ["module", "script"] : ["script", "module"]) {
    try {
      return espree.parse(source, { ecmaVersion: "latest", sourceType, loc: true });
    } catch (_) {
      // try fallback sourceType
    }
  }
  throw new Error(`Failed to parse ${filename}`);
}

function walkAst(node, visitor, parent = null, ancestors = []) {
  if (!node || typeof node.type !== "string") return;
  visitor(node, parent, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "range" || key.startsWith("__")) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item.type === "string") walkAst(item, visitor, node, nextAncestors);
      }
    } else if (value && typeof value.type === "string") {
      walkAst(value, visitor, node, nextAncestors);
    }
  }
}

function unwrapChain(node) {
  return node && node.type === "ChainExpression" ? node.expression : node;
}

function propName(memberNode) {
  if (!memberNode || memberNode.type !== "MemberExpression") return null;
  if (!memberNode.computed && memberNode.property.type === "Identifier") {
    return memberNode.property.name;
  }
  if (memberNode.computed && memberNode.property.type === "Literal" && typeof memberNode.property.value === "string") {
    return memberNode.property.value;
  }
  return null;
}

function isChromeRoot(node) {
  const n = unwrapChain(node);
  if (!n) return false;
  if (n.type === "Identifier" && n.name === "chrome") return true;
  if (n.type === "MemberExpression" && propName(n) === "chrome") {
    const obj = unwrapChain(n.object);
    return obj && obj.type === "Identifier" && (obj.name === "globalThis" || obj.name === "self" || obj.name === "window");
  }
  return false;
}

function isChromeStorageSyncExpr(node) {
  const n = unwrapChain(node);
  if (!n || n.type !== "MemberExpression") return false;
  if (propName(n) !== "sync") return false;
  const storageObj = unwrapChain(n.object);
  if (!storageObj || storageObj.type !== "MemberExpression" || propName(storageObj) !== "storage") return false;
  return isChromeRoot(storageObj.object);
}

const SCOPE_NODE_TYPES = new Set([
  "Program",
  "BlockStatement",
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "CatchClause",
]);

function isFunctionOrProgram(node) {
  return Boolean(
    node && (
      node.type === "Program" ||
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    )
  );
}

function collectPatternIdentifiers(pattern, out = []) {
  if (!pattern) return out;
  if (pattern.type === "Identifier") {
    out.push(pattern);
  } else if (pattern.type === "AssignmentPattern") {
    collectPatternIdentifiers(pattern.left, out);
  } else if (pattern.type === "RestElement") {
    collectPatternIdentifiers(pattern.argument, out);
  } else if (pattern.type === "ArrayPattern") {
    for (const el of pattern.elements || []) collectPatternIdentifiers(el, out);
  } else if (pattern.type === "ObjectPattern") {
    for (const prop of pattern.properties || []) {
      if (prop.type === "Property") collectPatternIdentifiers(prop.value, out);
      else if (prop.type === "RestElement") collectPatternIdentifiers(prop.argument, out);
    }
  }
  return out;
}

function buildScopeMap(ast) {
  const scopeMap = new Map();
  const ensureScope = (node) => {
    let map = scopeMap.get(node);
    if (!map) {
      map = new Map();
      scopeMap.set(node, map);
    }
    return map;
  };

  walkAst(ast, (node, _parent, ancestors) => {
    if (SCOPE_NODE_TYPES.has(node.type)) ensureScope(node);

    if (isFunctionNode(node)) {
      const fnScope = ensureScope(node);
      if (node.id && node.id.type === "Identifier" && ancestors.length > 0) {
        for (let i = ancestors.length - 1; i >= 0; i--) {
          if (SCOPE_NODE_TYPES.has(ancestors[i].type)) {
            const outer = ensureScope(ancestors[i]);
            if (!outer.has(node.id.name)) outer.set(node.id.name, { name: node.id.name, decl: node });
            break;
          }
        }
      }
      for (const param of node.params || []) {
        for (const id of collectPatternIdentifiers(param)) {
          if (!fnScope.has(id.name)) fnScope.set(id.name, { name: id.name, decl: id });
        }
      }
    } else if (node.type === "CatchClause" && node.param) {
      const catchScope = ensureScope(node);
      for (const id of collectPatternIdentifiers(node.param)) {
        if (!catchScope.has(id.name)) catchScope.set(id.name, { name: id.name, decl: id });
      }
    } else if (node.type === "VariableDeclaration") {
      const isVar = node.kind === "var";
      let targetScopeNode = ancestors[0];
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const anc = ancestors[i];
        if (isVar ? isFunctionOrProgram(anc) : SCOPE_NODE_TYPES.has(anc.type)) {
          targetScopeNode = anc;
          break;
        }
      }
      const scope = ensureScope(targetScopeNode);
      for (const decl of node.declarations || []) {
        for (const id of collectPatternIdentifiers(decl.id)) {
          if (!scope.has(id.name)) scope.set(id.name, { name: id.name, decl: id });
        }
      }
    }
  });

  return scopeMap;
}

function resolveBinding(name, ancestors, scopeMap) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const map = scopeMap.get(ancestors[i]);
    if (map && map.has(name)) return map.get(name);
  }
  return null;
}

function exprEvaluatesToSyncStorage(expr, ancestors, scopeMap, syncBindings) {
  const n = unwrapChain(expr);
  if (!n) return false;
  if (isChromeStorageSyncExpr(n)) return true;
  if (n.type === "CallExpression") {
    const callee = unwrapChain(n.callee);
    return Boolean(callee && callee.type === "Identifier" && callee.name === "getSettingsStorage");
  }
  if (n.type === "AwaitExpression") {
    return exprEvaluatesToSyncStorage(n.argument, ancestors, scopeMap, syncBindings);
  }
  if (n.type === "ConditionalExpression") {
    return (
      exprEvaluatesToSyncStorage(n.consequent, ancestors, scopeMap, syncBindings) ||
      exprEvaluatesToSyncStorage(n.alternate, ancestors, scopeMap, syncBindings)
    );
  }
  if (n.type === "LogicalExpression") {
    return (
      exprEvaluatesToSyncStorage(n.left, ancestors, scopeMap, syncBindings) ||
      exprEvaluatesToSyncStorage(n.right, ancestors, scopeMap, syncBindings)
    );
  }
  if (n.type === "SequenceExpression" && n.expressions.length > 0) {
    return exprEvaluatesToSyncStorage(
      n.expressions[n.expressions.length - 1],
      ancestors,
      scopeMap,
      syncBindings
    );
  }
  if (n.type === "Identifier") {
    const binding = resolveBinding(n.name, ancestors, scopeMap);
    return Boolean(binding && syncBindings.has(binding));
  }
  return false;
}

function collectSyncBindings(ast, scopeMap) {
  const syncBindings = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    walkAst(ast, (node, _parent, ancestors) => {
      if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && node.init) {
        const binding = resolveBinding(node.id.name, ancestors, scopeMap);
        if (binding && !syncBindings.has(binding) && exprEvaluatesToSyncStorage(node.init, ancestors, scopeMap, syncBindings)) {
          syncBindings.add(binding);
          changed = true;
        }
      } else if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
        const binding = resolveBinding(node.left.name, ancestors, scopeMap);
        if (binding && !syncBindings.has(binding) && exprEvaluatesToSyncStorage(node.right, ancestors, scopeMap, syncBindings)) {
          syncBindings.add(binding);
          changed = true;
        }
      }
    });
  }
  return syncBindings;
}

function isFunctionNode(node) {
  return Boolean(
    node && (
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression"
    )
  );
}

function containsLastErrorRead(fnNode) {
  let found = false;
  walkAst(fnNode.body, (n) => {
    if (found) return;
    if (n.type === "MemberExpression" && propName(n) === "lastError") {
      found = true;
    }
  });
  return found;
}

function isEventListenerRegistrationCall(callNode) {
  if (!callNode || callNode.type !== "CallExpression") return false;
  const callee = unwrapChain(callNode.callee);
  if (!callee || callee.type !== "MemberExpression") return false;
  const m = propName(callee);
  return m === "addEventListener" || m === "addListener";
}

function isPromiseConsumed(callNode, ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const anc = ancestors[i];
    const child = i === ancestors.length - 1 ? callNode : ancestors[i + 1];
    if (isFunctionNode(anc)) {
      return anc.type === "ArrowFunctionExpression" && anc.body === child;
    }
    if (anc.type === "AwaitExpression") return true;
    if (anc.type === "ReturnStatement") return true;
    if (anc.type === "MemberExpression") {
      const m = propName(anc);
      const grand = i > 0 ? ancestors[i - 1] : null;
      if ((m === "catch" || m === "then") && grand && grand.type === "CallExpression" && grand.callee === anc) {
        if (m === "catch") return true;
        if (m === "then" && grand.arguments.length >= 2) return true;
      }
    }
    if (anc.type === "ArrayExpression") {
      const grand = i > 0 ? ancestors[i - 1] : null;
      if (grand && grand.type === "CallExpression") {
        const gc = unwrapChain(grand.callee);
        if (
          gc &&
          gc.type === "MemberExpression" &&
          gc.object.type === "Identifier" &&
          gc.object.name === "Promise" &&
          (propName(gc) === "all" || propName(gc) === "allSettled")
        ) {
          return true;
        }
      }
    }
    if (anc.type === "VariableDeclarator" && anc.init === child) return true;
    if (anc.type === "AssignmentExpression" && anc.right === child) return true;
    if (anc.type === "ExpressionStatement") return false;
  }
  return false;
}

function hasInlineCatchHandler(callNode, ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const anc = ancestors[i];
    if (isFunctionNode(anc)) return false;
    if (anc.type === "MemberExpression" && propName(anc) === "catch") {
      const grand = i > 0 ? ancestors[i - 1] : null;
      if (grand && grand.type === "CallExpression" && grand.callee === anc) return true;
    }
  }
  return false;
}

function isInsideTryBlockOfEnclosingFn(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const anc = ancestors[i];
    if (isFunctionNode(anc)) return false;
    if (anc.type === "TryStatement") {
      const child = ancestors[i + 1];
      if (anc.block === child) return true;
    }
  }
  return false;
}

/**
 * Checks all root runtime `*.js` files (or injected `{ [filename]: source }` map)
 * for `chrome.storage.sync.{set,remove,clear}` error-handling discipline.
 * @param {{ root?: string, files?: Record<string, string> }} [options]
 * @returns {{ errors: string[], checkedCalls: number }}
 */
export function checkSyncWriteErrorHandling(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const fileMap = options.files || Object.fromEntries(
    readdirSync(root)
      .filter((name) => name.endsWith(".js"))
      .sort()
      .map((name) => [name, readFileSync(join(root, name), "utf8")])
  );

  const errors = [];
  let checkedCalls = 0;

  for (const [filename, source] of Object.entries(fileMap)) {
    const ast = parseJs(source, filename);
    const scopeMap = buildScopeMap(ast);
    const syncBindings = collectSyncBindings(ast, scopeMap);

    walkAst(ast, (node, _parent, ancestors) => {
      if (node.type !== "CallExpression") return;
      const callee = unwrapChain(node.callee);
      if (!callee || callee.type !== "MemberExpression") return;
      const method = propName(callee);
      if (!method || !SYNC_WRITE_METHODS.has(method)) return;

      const receiver = unwrapChain(callee.object);
      const isDirectSync = isChromeStorageSyncExpr(receiver);
      const receiverBinding = receiver && receiver.type === "Identifier"
        ? resolveBinding(receiver.name, ancestors, scopeMap)
        : null;
      const isAliasSync = Boolean(receiverBinding && syncBindings.has(receiverBinding));
      if (!isDirectSync && !isAliasSync) return;

      checkedCalls++;
      const line = node.loc ? node.loc.start.line : 0;
      const args = node.arguments || [];
      const minCbIndex = method === "clear" ? 0 : 1;
      const lastArg = args.length > minCbIndex ? args[args.length - 1] : null;

      if (lastArg && isFunctionNode(lastArg)) {
        if (!containsLastErrorRead(lastArg)) {
          errors.push(
            `${filename}:${line}: callback passed to sync storage .${method}() must check chrome.runtime.lastError (.claude/rules/storage-sync.md)`
          );
        }
        return;
      }

      if (!isPromiseConsumed(node, ancestors)) {
        errors.push(
          `${filename}:${line}: unawaited/unhandled Promise from sync storage .${method}() — await inside try/catch, return to caller, or chain .catch()`
        );
        return;
      }

      if (!hasInlineCatchHandler(node, ancestors) && !isInsideTryBlockOfEnclosingFn(ancestors)) {
        let enclosingFnIdx = -1;
        for (let i = ancestors.length - 1; i >= 0; i--) {
          if (isFunctionNode(ancestors[i])) {
            enclosingFnIdx = i;
            break;
          }
        }
        if (enclosingFnIdx > 0) {
          const fnParent = ancestors[enclosingFnIdx - 1];
          if (isEventListenerRegistrationCall(fnParent)) {
            errors.push(
              `${filename}:${line}: awaited sync storage .${method}() inside event listener callback has no try/catch — quota or rate-limit rejection will become an unhandled rejection`
            );
          }
        }
      }
    });
  }

  return { errors, checkedCalls };
}

function extractApiKeyFieldsFromShared(sharedSource) {
  const ast = parseJs(sharedSource, "shared.js");
  const fields = new Set();
  walkAst(ast, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "Identifier" &&
      node.id.name === "API_KEY_FIELDS" &&
      node.init
    ) {
      walkAst(node.init, (child) => {
        if (child.type === "Literal" && typeof child.value === "string" && child.value) {
          fields.add(child.value);
        }
      });
    }
  });
  return fields;
}

function listTrackedFiles(root) {
  const out = execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * Scans runtime JS/MJS ASTs for hardcoded non-empty secret defaults and all
 * tracked text files for leaked real-world API keys, PATs, webhook capability
 * URLs, and private keys.
 * @param {{ root?: string, runtimeFiles?: Record<string, string>, trackedFiles?: Record<string, string>, apiKeyFields?: Iterable<string> }} [options]
 * @returns {{ errors: string[], scannedFiles: number }}
 */
export function checkCredentialLiterals(options = {}) {
  const root = options.root || DEFAULT_ROOT;
  const errors = [];

  let apiKeyFields;
  if (options.apiKeyFields) {
    apiKeyFields = new Set(options.apiKeyFields);
  } else {
    const sharedSource = options.runtimeFiles && options.runtimeFiles["shared.js"]
      ? options.runtimeFiles["shared.js"]
      : readFileSync(join(root, "shared.js"), "utf8");
    apiKeyFields = extractApiKeyFieldsFromShared(sharedSource);
  }
  if (apiKeyFields.size === 0) {
    errors.push("shared.js: could not extract API_KEY_FIELDS for credential literal check");
    return { errors, scannedFiles: 0 };
  }

  const schemaGenerators = ["scripts/settings-schema.mjs", "scripts/ai-providers-source.mjs"]
    .filter((rel) => existsSync(join(root, rel)))
    .map((rel) => [rel, readFileSync(join(root, rel), "utf8")]);

  const runtimeFiles = options.runtimeFiles || Object.fromEntries([
    ...readdirSync(root)
      .filter((n) => n.endsWith(".js"))
      .sort()
      .map((n) => [n, readFileSync(join(root, n), "utf8")]),
    ...schemaGenerators,
  ]);

  const propKeyName = (propNode) => {
    if (!propNode || propNode.type !== "Property" || propNode.computed) return null;
    if (propNode.key.type === "Identifier") return propNode.key.name;
    if (propNode.key.type === "Literal" && typeof propNode.key.value === "string") return propNode.key.value;
    return null;
  };

  for (const [filename, source] of Object.entries(runtimeFiles)) {
    const ast = parseJs(source, filename);
    walkAst(ast, (node) => {
      if (node.type === "Property" && !node.computed) {
        const key = propKeyName(node);
        if (key && apiKeyFields.has(key) && node.value.type === "Literal" && typeof node.value.value === "string" && node.value.value !== "") {
          const line = node.loc ? node.loc.start.line : 0;
          errors.push(`${filename}:${line}: secret field "${key}" must not have a hardcoded non-empty literal value`);
        }
        if (key === "exportTargets" && node.value.type === "ObjectExpression") {
          for (const targetProp of node.value.properties || []) {
            const targetId = propKeyName(targetProp);
            if (!targetId || targetProp.value.type !== "ObjectExpression") continue;
            const secretSubKeys = targetId === "webhook" ? new Set(["token", "url"]) : new Set(["token"]);
            for (const subProp of targetProp.value.properties || []) {
              const subKey = propKeyName(subProp);
              if (subKey && secretSubKeys.has(subKey) && subProp.value.type === "Literal" && typeof subProp.value.value === "string" && subProp.value.value !== "") {
                const line = subProp.loc ? subProp.loc.start.line : 0;
                errors.push(`${filename}:${line}: exportTargets.${targetId}.${subKey} must not have a hardcoded non-empty literal value`);
              }
            }
          }
        }
      } else if (node.type === "AssignmentExpression" && node.left.type === "MemberExpression") {
        const key = propName(node.left);
        if (key && apiKeyFields.has(key) && node.right.type === "Literal" && typeof node.right.value === "string" && node.right.value !== "") {
          const line = node.loc ? node.loc.start.line : 0;
          errors.push(`${filename}:${line}: secret field "${key}" must not be assigned a hardcoded non-empty literal value`);
        }
      }
    });
  }

  const trackedEntries = options.trackedFiles
    ? Object.entries(options.trackedFiles)
    : listTrackedFiles(root)
        .filter((rel) => !rel.startsWith("vendor/") && !BINARY_EXTS.has(extname(rel).toLowerCase()))
        .map((rel) => [rel, readFileSync(join(root, rel), "utf8")]);

  for (const [rel, content] of trackedEntries) {
    const lines = content.split("\n");
    for (let idx = 0; idx < lines.length; idx++) {
      const lineText = lines[idx];
      for (const { id, re } of CREDENTIAL_PATTERNS) {
        re.lastIndex = 0;
        const match = re.exec(lineText);
        if (match) {
          const token = match[0];
          const redacted = token.length > 12 ? `${token.slice(0, 8)}...${token.slice(-4)}` : `${token.slice(0, 4)}...`;
          errors.push(`${rel}:${idx + 1}: potential hardcoded credential (${id}: ${redacted})`);
        }
      }
    }
  }

  return { errors, scannedFiles: trackedEntries.length };
}

export function runHardRulesLint(root = DEFAULT_ROOT) {
  const syncRes = checkSyncWriteErrorHandling({ root });
  const credRes = checkCredentialLiterals({ root });
  return {
    errors: [...syncRes.errors, ...credRes.errors],
    checkedCalls: syncRes.checkedCalls,
    scannedFiles: credRes.scannedFiles,
  };
}

function main() {
  const { errors, checkedCalls, scannedFiles } = runHardRulesLint(DEFAULT_ROOT);
  if (errors.length > 0) {
    for (const err of errors) console.error(`[hard-rules] ERROR: ${err}`);
    process.exit(1);
  }
  console.log(
    `[hard-rules] OK — ${checkedCalls} sync storage write call(s) and ${scannedFiles} tracked file(s) passed`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
