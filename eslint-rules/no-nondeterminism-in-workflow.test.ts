import { describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { noNondeterminismInWorkflow } from './no-nondeterminism-in-workflow.js';

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: 2023,
    sourceType: 'module',
  },
});

// Wrap a statement in a @DBOS.workflow method body.
const inWorkflow = (body: string) => `
class Flows {
  @DBOS.workflow()
  static async run(input: string) {
    ${body}
    return input;
  }
}
`;

describe('no-nondeterminism-in-workflow', () => {
  it('flags nondeterminism inside workflow bodies, allows it elsewhere', () => {
    ruleTester.run('no-nondeterminism-in-workflow', noNondeterminismInWorkflow, {
      valid: [
        // Nondeterminism OUTSIDE workflows is fine (steps are where I/O lives).
        'const t = Date.now();',
        'const d = new Date();',
        'const r = Math.random();',
        'const k = process.env.HOME;',
        'await fetch("https://example.com");',
        `
        class Flows {
          @DBOS.step()
          static async now() {
            return Date.now();
          }
        }
        `,
        // Deterministic workflow body is clean.
        inWorkflow('const x = input.length;'),
      ],
      invalid: [
        {
          code: inWorkflow('const t = Date.now();'),
          errors: [{ messageId: 'clockRead' }],
        },
        {
          code: inWorkflow('const d = new Date();'),
          errors: [{ messageId: 'clockRead' }],
        },
        {
          code: inWorkflow('const r = Math.random();'),
          errors: [{ messageId: 'randomness' }],
        },
        {
          code: inWorkflow('const k = process.env.HOME;'),
          errors: [{ messageId: 'envRead' }],
        },
        {
          code: inWorkflow('await fetch("https://example.com");'),
          errors: [{ messageId: 'directIo' }],
        },
        {
          code: inWorkflow('await fs.readFile("/etc/hosts");'),
          errors: [{ messageId: 'directIo' }],
        },
        {
          // Nested helper functions inside the workflow body are still covered.
          code: inWorkflow('const f = () => Date.now(); f();'),
          errors: [{ messageId: 'clockRead' }],
        },
      ],
    });
  });

  it('covers the functional API: registerWorkflow args, references, and make*Workflow factories', () => {
    ruleTester.run('no-nondeterminism-in-workflow', noNondeterminismInWorkflow, {
      valid: [
        // Nondeterminism inside a step callback within a workflow is the
        // sanctioned escape hatch — journaled, replayed exactly-once.
        `
        DBOS.registerWorkflow(async function turn(input: string) {
          const t = await DBOS.runStep(() => Date.now(), { name: 'now' });
          return t + input.length;
        });
        `,
        `
        function makeTurnWorkflow(deps: Deps) {
          return async function turn(input: string) {
            const rows = await deps.dataSource.runTransaction(async () => Date.now());
            return rows;
          };
        }
        `,
        // A factory not matching the make*Workflow convention is plain code.
        'function makeHelper() { return () => Date.now(); }',
        // A named function that is never registered as a workflow is plain code.
        'async function helper() { return Date.now(); }',
        // Deterministic functional workflow bodies are clean.
        `
        function makeDrainWorkflow(deps: Deps) {
          return async function drain(conversationId: string) {
            const pending = await deps.readPending(conversationId);
            return pending.length;
          };
        }
        `,
      ],
      invalid: [
        {
          // Inline function passed to DBOS.registerWorkflow.
          code: `
          DBOS.registerWorkflow(async function turn(input: string) {
            return Date.now() + input.length;
          });
          `,
          errors: [{ messageId: 'clockRead' }],
        },
        {
          // Named function registered by reference (registration follows the
          // declaration, the usual layout).
          code: `
          async function turnFn(input: string) {
            return Math.random() + input.length;
          }
          const turn = DBOS.registerWorkflow(turnFn, { name: 'turn' });
          `,
          errors: [{ messageId: 'randomness' }],
        },
        {
          // Workflow body produced by a make*Workflow factory (the src DI
          // pattern: the factory lives in src, registration in the caller).
          code: `
          export function makeDrainWorkflow(deps: Deps) {
            return async function drain(conversationId: string) {
              const cutoff = new Date();
              return deps.readPending(conversationId, cutoff);
            };
          }
          `,
          errors: [{ messageId: 'clockRead' }],
        },
        {
          // Arrow factory with a concise-body arrow workflow.
          code: 'const makeTickWorkflow = (deps: Deps) => async () => process.env.TZ;',
          errors: [{ messageId: 'envRead' }],
        },
        {
          // Nested helper closures inside a registered body are still covered.
          code: `
          async function turnFn(input: string) {
            const stamp = () => Date.now();
            return stamp() + input.length;
          }
          DBOS.registerWorkflow(turnFn);
          `,
          errors: [{ messageId: 'clockRead' }],
        },
      ],
    });
  });
});
