import type { Rule } from 'eslint';

// DBOS workflow bodies must be deterministic: on crash recovery the body is
// re-executed and every step result is replayed from the journal, so any value
// that can differ between runs (clock, randomness, env, live I/O) makes the
// replay diverge from the original execution. Those belong inside steps.
// (Architecture decision 3; SPEC "custom determinism rule".)
//
// A function body counts as a workflow when it is:
//  - a class member decorated @DBOS.workflow() (legacy decorator form);
//  - passed to DBOS.registerWorkflow — inline or as a same-file reference;
//  - returned from a factory named make*Workflow (the src DI pattern: the
//    body lives in src, registration happens in the composing caller).
// Callbacks handed to a step wrapper (runStep/registerStep/runTransaction/
// registerTransaction) are exempt — that is where nondeterminism belongs.

type AnyNode = Rule.Node;

interface LooseNode {
  type: string;
  parent?: LooseNode;
  name?: string;
  id?: { type?: string; name?: string } | null;
  body?: LooseNode;
  callee?: LooseNode;
  object?: LooseNode;
  property?: LooseNode;
  arguments?: LooseNode[];
  decorators?: { expression: unknown }[];
}

const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const stepWrapperNames = new Set(['runStep', 'registerStep', 'runTransaction', 'registerTransaction']);
const factoryNamePattern = /^make\w*Workflow$/;

function isWorkflowDecorator(decorator: { expression: unknown }): boolean {
  const expr = decorator.expression as {
    type?: string;
    callee?: unknown;
  };
  // Matches both @DBOS.workflow and @DBOS.workflow(...).
  const target = (expr?.type === 'CallExpression' ? expr.callee : expr) as {
    type?: string;
    object?: { type?: string; name?: string };
    property?: { type?: string; name?: string };
  };
  return (
    target?.type === 'MemberExpression' &&
    target.object?.type === 'Identifier' &&
    target.object.name === 'DBOS' &&
    target.property?.type === 'Identifier' &&
    target.property.name === 'workflow'
  );
}

function isRegisterWorkflowCall(node: LooseNode | undefined): boolean {
  return (
    node?.type === 'CallExpression' &&
    node.callee?.type === 'MemberExpression' &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'DBOS' &&
    node.callee.property?.type === 'Identifier' &&
    node.callee.property.name === 'registerWorkflow'
  );
}

/** Name a function is known by: its own id, or the variable it is assigned to. */
function functionName(fn: LooseNode): string | null {
  if (fn.id?.type === 'Identifier' && fn.id.name) return fn.id.name;
  if (fn.parent?.type === 'VariableDeclarator' && fn.parent.id?.type === 'Identifier') {
    return fn.parent.id.name ?? null;
  }
  return null;
}

/** Callback handed to a step wrapper (any receiver: DBOS, a datasource, deps). */
function isStepWrapperArg(fn: LooseNode): boolean {
  const parent = fn.parent;
  return (
    parent?.type === 'CallExpression' &&
    (parent.arguments ?? []).includes(fn) &&
    parent.callee?.type === 'MemberExpression' &&
    parent.callee.property?.type === 'Identifier' &&
    stepWrapperNames.has(parent.callee.property.name ?? '')
  );
}

/** First argument of DBOS.registerWorkflow, written inline. */
function isInlineRegisterArg(fn: LooseNode): boolean {
  return isRegisterWorkflowCall(fn.parent) && fn.parent?.arguments?.[0] === fn;
}

/** Returned from a make*Workflow factory (return statement or concise arrow body). */
function isReturnedFromFactory(fn: LooseNode): boolean {
  let enclosing: LooseNode | undefined;
  if (fn.parent?.type === 'ReturnStatement') {
    for (let n = fn.parent.parent; n; n = n.parent) {
      if (functionTypes.has(n.type)) {
        enclosing = n;
        break;
      }
    }
  } else if (fn.parent?.type === 'ArrowFunctionExpression' && fn.parent.body === fn) {
    enclosing = fn.parent;
  }
  if (!enclosing) return false;
  const name = functionName(enclosing);
  return name !== null && factoryNamePattern.test(name);
}

/** Class member carrying the legacy @DBOS.workflow decorator. */
function isDecoratedWorkflowMember(fn: LooseNode): boolean {
  const parent = fn.parent;
  return (
    (parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') &&
    Array.isArray(parent.decorators) &&
    parent.decorators.some(isWorkflowDecorator)
  );
}

export const noNondeterminismInWorkflow: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban clock reads, randomness, env reads, and direct I/O inside DBOS workflow bodies (recovery replay must be deterministic). Covers @DBOS.workflow members, DBOS.registerWorkflow arguments and references, and make*Workflow factory returns.',
    },
    messages: {
      clockRead:
        'Clock read inside a DBOS workflow body — recovery replay will diverge. Take time inside a step and pass it in.',
      randomness:
        'Math.random inside a DBOS workflow body — recovery replay will diverge. Generate randomness inside a step.',
      envRead:
        'process.env read inside a DBOS workflow body — config enters via workflow input or deps (loaded once in src/ops/config.ts).',
      directIo:
        'Direct I/O inside a DBOS workflow body — wrap it in a step so the result is journaled and replayed exactly-once.',
    },
    schema: [],
  },
  create(context) {
    // Names registered by reference may appear after the function body in
    // source order, so reference-form violations defer to Program:exit.
    const registeredNames = new Set<string>();
    const deferred: Array<{ node: AnyNode; messageId: string; enclosingNames: string[] }> = [];

    const classify = (node: AnyNode, messageId: string): void => {
      const enclosingNames: string[] = [];
      for (let n = (node as unknown as LooseNode).parent; n; n = n.parent) {
        if (!functionTypes.has(n.type)) continue;
        // Nearest function boundary wins: a step callback inside a workflow
        // is exempt no matter what encloses it.
        if (isStepWrapperArg(n)) return;
        if (isInlineRegisterArg(n) || isReturnedFromFactory(n) || isDecoratedWorkflowMember(n)) {
          context.report({ node, messageId });
          return;
        }
        const name = functionName(n);
        if (name !== null) enclosingNames.push(name);
      }
      if (enclosingNames.length > 0) {
        deferred.push({ node, messageId, enclosingNames });
      }
    };

    return {
      CallExpression(node) {
        const loose = node as unknown as LooseNode;
        if (isRegisterWorkflowCall(loose) && loose.arguments?.[0]?.type === 'Identifier') {
          registeredNames.add(loose.arguments[0].name ?? '');
        }

        const callee = node.callee;
        if (callee.type === 'MemberExpression' && !callee.computed) {
          const { object, property } = callee;
          if (object.type === 'Identifier' && property.type === 'Identifier') {
            if (object.name === 'Date' && property.name === 'now') {
              classify(node, 'clockRead');
              return;
            }
            if (object.name === 'fs') {
              classify(node, 'directIo');
              return;
            }
          }
        }
        if (callee.type === 'Identifier' && callee.name === 'fetch') {
          classify(node, 'directIo');
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date') {
          classify(node, 'clockRead');
        }
      },
      MemberExpression(node) {
        if (node.computed) return;
        if (node.object.type !== 'Identifier' || node.property.type !== 'Identifier') return;
        if (node.object.name === 'Math' && node.property.name === 'random') {
          classify(node, 'randomness');
        }
        if (node.object.name === 'process' && node.property.name === 'env') {
          classify(node, 'envRead');
        }
      },
      'Program:exit'() {
        for (const { node, messageId, enclosingNames } of deferred) {
          if (enclosingNames.some((name) => registeredNames.has(name))) {
            context.report({ node, messageId });
          }
        }
      },
    };
  },
};
