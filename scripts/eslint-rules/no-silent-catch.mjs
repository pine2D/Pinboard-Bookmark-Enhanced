// Local ESLint rule: a catch must leave a trace.
//
// Reports two shapes:
//   1. try { ... } catch (e) { ... }  where the block neither throws, nor calls
//      a console method, nor reads the catch binding (also `catch { }`).
//   2. promise.catch(<function literal>)  with the same three conditions, where
//      the binding is the callback's first parameter. A callback that is not a
//      function literal (`.catch(handler)`) is never reported.
//
// Opt-out: a comment containing `swallow-ok: <reason>` inside the catch block
// or the callback. The reason must not be empty.
//
// "Reads the binding" is answered by ESLint's scope analysis, so a nested
// function that uses it counts, and an inner variable of the same name that
// shadows it does not.

const CONSOLE_METHODS = new Set(["warn", "error", "info", "debug", "log"]);
const FUNCTION_TYPES = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);

function isConsoleCall(node) {
  const c = node.callee;
  return (
    node.type === "CallExpression" &&
    c.type === "MemberExpression" &&
    c.object.type === "Identifier" &&
    c.object.name === "console" &&
    ((!c.computed && c.property.type === "Identifier" && CONSOLE_METHODS.has(c.property.name)) ||
      (c.computed && c.property.type === "Literal" && CONSOLE_METHODS.has(c.property.value)))
  );
}

// Walks `root` once. A console call counts anywhere inside (a trace written
// from a timer or a nested handler is still a trace). A throw counts only
// when it is not inside a nested function, since that one does not rethrow.
function scan(root, visitorKeys) {
  const found = { console: false, throws: false };
  (function walk(node, nested) {
    if (node.type === "ThrowStatement" && !nested) found.throws = true;
    if (isConsoleCall(node)) found.console = true;
    const keys = visitorKeys[node.type] || [];
    const nextNested = nested || (node !== root && FUNCTION_TYPES.has(node.type));
    for (const key of keys) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const c of child) if (c && typeof c.type === "string") walk(c, nextNested);
      } else if (child && typeof child.type === "string") {
        walk(child, nextNested);
      }
    }
  })(root, false);
  return found;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow a catch that neither throws, logs, nor reads the error" },
    schema: [],
    messages: {
      silentCatch:
        "Silent catch: rethrow, console.warn the error, read it, or add a `// swallow-ok: <reason>` comment.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    const keys = sourceCode.visitorKeys;

    function hasExemption(node) {
      return sourceCode
        .getCommentsInside(node)
        .some((c) => /swallow-ok:\s*\S/.test(c.value));
    }

    // Variables declared by `declarer` (a function or catch clause) whose
    // identifier sits inside `paramNode`; true when any of them is referenced.
    function paramUsed(declarer, paramNode) {
      if (!paramNode) return false;
      return sourceCode.getDeclaredVariables(declarer).some(
        (v) =>
          v.defs.some((d) => d.name && d.name.range[0] >= paramNode.range[0] && d.name.range[1] <= paramNode.range[1]) &&
          v.references.length > 0,
      );
    }

    return {
      CatchClause(node) {
        const f = scan(node.body, keys);
        if (f.throws || f.console || paramUsed(node, node.param) || hasExemption(node.body)) return;
        context.report({ node, messageId: "silentCatch" });
      },
      CallExpression(node) {
        const c = node.callee;
        if (c.type !== "MemberExpression") return;
        const isCatch =
          (!c.computed && c.property.type === "Identifier" && c.property.name === "catch") ||
          (c.computed && c.property.type === "Literal" && c.property.value === "catch");
        if (!isCatch) return;
        const fn = node.arguments[0];
        if (!fn || (fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionExpression")) return;
        const f = scan(fn.body, keys);
        if (f.throws || f.console || paramUsed(fn, fn.params[0]) || hasExemption(fn)) return;
        context.report({ node: fn, messageId: "silentCatch" });
      },
    };
  },
};
