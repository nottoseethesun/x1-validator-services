/**
 * @file eslint-rules/no-secret-logging.js
 * @description
 * An ESLint rule that flags console calls passed a value whose name
 * suggests a secret: an api key, a private key, a password or
 * passphrase, a token, a credential, or anything called a secret. Text
 * written out in full is allowed, since it can't carry a secret's value.
 * The security pass, eslint-security.config.js, runs it.
 */

/** Names that suggest a secret. */
const SENSITIVE =
  /api.?key|private.?key|pass.?phrase|password|secret|token|credential/i;

/**
 * Decides whether an expression refers to a value with a secret's name:
 * a variable, a property, or such a value inside a template or a
 * concatenation.
 * @param {object} node  The expression's syntax-tree node.
 * @returns {boolean}
 */
function isSensitive(node) {
  if (node.type === "Identifier") {
    return SENSITIVE.test(node.name);
  }
  if (node.type === "MemberExpression") {
    return isSensitive(node.property);
  }
  if (node.type === "TemplateLiteral") {
    return node.expressions.some(isSensitive);
  }
  if (node.type === "BinaryExpression") {
    return isSensitive(node.left) || isSensitive(node.right);
  }
  return false;
}

/**
 * Decides whether a call is a method call on `console`.
 * @param {object} node  The call's syntax-tree node.
 * @returns {boolean}
 */
function isConsoleCall(node) {
  const callee = node.callee;
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    callee.object.name === "console"
  );
}

/** @type {import("eslint").Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow logging values whose names suggest a secret",
    },
    schema: [],
    messages: {
      secret:
        'Do not log "{{name}}": its name suggests a secret, such as an ' +
        "api key or a password.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isConsoleCall(node)) {
          return;
        }
        for (const argument of node.arguments) {
          if (argument.type !== "Literal" && isSensitive(argument)) {
            context.report({
              node: argument,
              messageId: "secret",
              data: { name: context.sourceCode.getText(argument) },
            });
          }
        }
      },
    };
  },
};
