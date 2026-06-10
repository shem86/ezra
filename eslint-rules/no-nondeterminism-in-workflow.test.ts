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
});
