import type { Rule } from 'eslint';

// DBOS workflow bodies must be deterministic: on crash recovery the body is
// re-executed and every step result is replayed from the journal, so any value
// that can differ between runs (clock, randomness, env, live I/O) makes the
// replay diverge from the original execution. Those belong inside @DBOS.step.
// (Architecture decision 3; SPEC "custom determinism rule".)

type AnyNode = Rule.Node;

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

function insideWorkflowBody(node: AnyNode): boolean {
  for (let n = node.parent; n; n = n.parent) {
    const candidate = n as unknown as { type: string; decorators?: { expression: unknown }[] };
    if (
      (candidate.type === 'MethodDefinition' || candidate.type === 'PropertyDefinition') &&
      Array.isArray(candidate.decorators) &&
      candidate.decorators.some(isWorkflowDecorator)
    ) {
      return true;
    }
  }
  return false;
}

export const noNondeterminismInWorkflow: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ban clock reads, randomness, env reads, and direct I/O inside @DBOS.workflow bodies (recovery replay must be deterministic).',
    },
    messages: {
      clockRead:
        'Clock read inside a @DBOS.workflow body — recovery replay will diverge. Take time inside a @DBOS.step and pass it in.',
      randomness:
        'Math.random inside a @DBOS.workflow body — recovery replay will diverge. Generate randomness inside a @DBOS.step.',
      envRead:
        'process.env read inside a @DBOS.workflow body — config enters via workflow input or deps (loaded once in src/ops/config.ts).',
      directIo:
        'Direct I/O inside a @DBOS.workflow body — wrap it in a @DBOS.step so the result is journaled and replayed exactly-once.',
    },
    schema: [],
  },
  create(context) {
    const report = (node: AnyNode, messageId: string): void => {
      if (insideWorkflowBody(node)) {
        context.report({ node, messageId });
      }
    };
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && !callee.computed) {
          const { object, property } = callee;
          if (object.type === 'Identifier' && property.type === 'Identifier') {
            if (object.name === 'Date' && property.name === 'now') {
              report(node, 'clockRead');
              return;
            }
            if (object.name === 'fs') {
              report(node, 'directIo');
              return;
            }
          }
        }
        if (callee.type === 'Identifier' && callee.name === 'fetch') {
          report(node, 'directIo');
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date') {
          report(node, 'clockRead');
        }
      },
      MemberExpression(node) {
        if (node.computed) return;
        if (node.object.type !== 'Identifier' || node.property.type !== 'Identifier') return;
        if (node.object.name === 'Math' && node.property.name === 'random') {
          report(node, 'randomness');
        }
        if (node.object.name === 'process' && node.property.name === 'env') {
          report(node, 'envRead');
        }
      },
    };
  },
};
