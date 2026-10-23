// Additive icon changes may be narrowed only from proven JavaScript consumers.
// Use the same installed parser/scope analyzer as script-graph-lint. If these
// development tools are absent, planning still works via conservative fallback.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../.qa-scan/package.json', import.meta.url));
let parserTools;
function tools() {
  if (parserTools === undefined) {
    try { parserTools = { parser: require('espree'), scope: require('eslint-scope') }; }
    catch { parserTools = null; }
  }
  return parserTools;
}

function owner(path) {
  if (/^popup(?:[.-]|$)/.test(path)) return 'popup';
  if (/^options(?:[.-]|$)/.test(path)) return 'options';
  if (/^library(?:[.-]|$)/.test(path)) return 'library';
  if (/^(?:md-|reader-)/.test(path)) return 'md-preview';
  if (/^pinboard-/.test(path)) return 'pinboard';
  if (path === 'background.js') return 'background';
  return null;
}

function literalKeys(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return [node.value];
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return [node.quasis[0].value.cooked];
  if (node?.type === 'ConditionalExpression') {
    const left = literalKeys(node.consequent), right = literalKeys(node.alternate);
    return left && right ? [...new Set([...left, ...right])] : null;
  }
  return null;
}

function scripts(consumer) {
  if (!/\.html?$/.test(consumer.path)) return [{ source: consumer.source, sourceType: null }];
  const result = [];
  // Consume comments before script blocks, so examples inside HTML comments
  // remain inert. JavaScript contents are subsequently parsed, never searched.
  const blocks = /<!--[\s\S]*?-->|<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/script\s*>/gi;
  for (const block of consumer.source.matchAll(blocks)) {
    if (block[1] === undefined) continue;
    const attrs = new Map();
    for (const match of block[1].matchAll(/([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+)))?/g)) {
      attrs.set(match[1].toLowerCase(), match[2] ?? match[3] ?? match[4] ?? '');
    }
    if (attrs.has('src')) continue;
    const type = (attrs.get('type') || '').toLowerCase().trim();
    if (type && !['module', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type)) continue;
    result.push({ source: block[2], sourceType: type === 'module' ? 'module' : 'script' });
  }
  return result;
}

function parse(source, sourceType, parser, scope) {
  let failure;
  for (const type of sourceType ? [sourceType] : ['script', 'module']) {
    try {
      const ast = parser.parse(source, { ecmaVersion: 'latest', sourceType: type, range: true });
      const manager = scope.analyze(ast, { ecmaVersion: 2024, sourceType: type, optimistic: true });
      return { ast, globals: new Set(manager.globalScope.through.map(ref => ref.identifier)) };
    } catch (error) { failure = error; }
  }
  throw failure;
}

export function iconConsumers(keys, consumers) {
  const wanted = new Set(keys), references = [], reasons = [];
  const parser = tools();
  if (!parser) return { surfaces: [], references, uncertain: true, reasons: [{ path: null, reason: 'icon parser unavailable' }] };
  for (const consumer of consumers) {
    const used = new Set();
    const uncertain = reason => {
      if (!reasons.some(item => item.path === consumer.path && item.reason === reason)) reasons.push({ path: consumer.path, reason });
    };
    try {
      for (const script of scripts(consumer)) {
        const { ast, globals } = parse(script.source, script.sourceType, parser.parser, parser.scope);
        const handled = new Set();
        const isGlobal = (node, name) => node?.type === 'Identifier' && node.name === name && globals.has(node);
        const consume = values => {
          if (!values) { uncertain('dynamic icon key'); return; }
          for (const key of values) if (wanted.has(key)) used.add(key);
        };
        function visit(node, parent) {
          if (!node || typeof node.type !== 'string') return;
          if (node.type === 'MemberExpression' && isGlobal(node.object, 'PBP_ICONS')) {
            handled.add(node.object);
            consume(node.computed ? literalKeys(node.property) : [node.property.name]);
          } else if (node.type === 'CallExpression' && isGlobal(node.callee, 'setBtnIcon')) {
            handled.add(node.callee);
            consume(literalKeys(node.arguments[1]));
          } else if (isGlobal(node, 'PBP_ICONS') || isGlobal(node, 'setBtnIcon')) {
            // A typeof guard only tests availability. Other bare references
            // can escape through aliases, destructuring or unknown functions.
            if (!handled.has(node) && !(parent?.type === 'UnaryExpression' && parent.operator === 'typeof')) uncertain('icon API escapes static analysis');
          }
          for (const value of Object.values(node)) {
            if (Array.isArray(value)) { for (const child of value) if (child?.type) visit(child, node); }
            else if (value?.type) visit(value, node);
          }
        }
        visit(ast, null);
      }
    } catch { uncertain('consumer JavaScript could not be parsed'); }
    if (used.size) {
      const surface = owner(consumer.path);
      references.push({ path: consumer.path, keys: [...used], surface });
      if (!surface) uncertain('icon consumer has no registered surface');
    }
  }
  return { surfaces: [...new Set(references.map(row => row.surface).filter(Boolean))], references, uncertain: reasons.length > 0, reasons };
}
