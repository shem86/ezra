// Jev client (turn-routing plan, docs/specs/jev-turn-routing-plan.md §5): a
// plain fetch against TypeSafe's one System One endpoint — the ADR-0002
// Voyage precedent, a small contract judged cheaper than an SDK review.
//
// Every failure is a JevError and never an answer. The router maps a throw to
// its fallback tier and records the kind; a malformed body quietly read as a
// "no" would route wrongly with nothing in the trace to say why. The model is
// pinned (not `jev-latest`) for the same reason the WhatsApp client version
// is: a silent upstream swap would change routing without a deploy.

import { z } from 'zod';

export const DEFAULT_JEV_MODEL = 'jev-1.14.0';

const systemOneUrl = 'https://api.typesafe.ai/v1/systemone';
// Phase 1 measured p95 ≤ 369 ms; the deadline bounds the serial delay a slow
// Jev can add before the turn's first model call.
const defaultTimeoutMs = 1_500;

export type JevQuestion =
  | {
      readonly type: 'noul';
      readonly instructions: string;
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | {
      readonly type: 'choice';
      readonly instructions: string;
      readonly criteria: Readonly<Record<string, string>>;
    };

export type JevQuestions = Readonly<Record<string, JevQuestion>>;

const noulAnswerSchema = z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) });
const choiceAnswerSchema = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()),
});

export type JevAnswer = z.infer<typeof noulAnswerSchema> | z.infer<typeof choiceAnswerSchema>;

const responseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({ input_tokens: z.number() }),
});

export interface JevResponse {
  /** The versioned id that answered — may differ from an alias sent. */
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  /** Billable tokens (output is free). */
  readonly inputTokens: number;
}

export type JevErrorKind = 'timeout' | 'network' | 'http' | 'malformed';

export class JevError extends Error {
  readonly kind: JevErrorKind;
  readonly status: number | undefined;

  constructor(kind: JevErrorKind, message: string, status?: number) {
    super(`jev ${kind}: ${message}`);
    this.name = 'JevError';
    this.kind = kind;
    this.status = status;
  }
}

export interface JevClientOptions {
  /** From Config (src/ops/config.ts) — never read env here. */
  readonly apiKey: string;
  readonly model?: string;
  readonly timeoutMs?: number;
  /** Injectable for unit tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
}

export interface JevClient {
  ask(state: unknown, questions: JevQuestions): Promise<JevResponse>;
}

export function makeJevClient(options: JevClientOptions): JevClient {
  const fetchFn = options.fetchFn ?? fetch;
  const model = options.model ?? DEFAULT_JEV_MODEL;
  // Error text copies verbatim into traces (T31's documented limit), so key
  // material is scrubbed from anything a failure carries — including a body
  // or transport message that echoes it back.
  const scrub = (text: string): string => text.replaceAll(options.apiKey, '[redacted]');

  return {
    async ask(state, questions) {
      let response: Response;
      try {
        response = await fetchFn(systemOneUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({ model, state, questions }),
          signal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && error.name === 'TimeoutError') {
          throw new JevError('timeout', 'no response within the deadline');
        }
        throw new JevError('network', scrub(error instanceof Error ? error.message : String(error)));
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new JevError('http', `HTTP ${response.status} — ${scrub(body.slice(0, 200))}`, response.status);
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw new JevError('malformed', 'response body is not JSON');
      }
      const parsed = responseSchema.safeParse(raw);
      if (!parsed.success) {
        throw new JevError('malformed', 'response does not match the System One schema');
      }

      const answers: Record<string, JevAnswer> = {};
      for (const [id, question] of Object.entries(questions)) {
        answers[id] = parseAnswer(id, question, parsed.data.answers[id]);
      }
      return { model: parsed.data.model, answers, inputTokens: parsed.data.usage.input_tokens };
    },
  };
}

function parseAnswer(id: string, question: JevQuestion, raw: unknown): JevAnswer {
  if (question.type === 'noul') {
    const answer = noulAnswerSchema.safeParse(raw);
    if (!answer.success) throw new JevError('malformed', `no valid noul answer for "${id}"`);
    return answer.data;
  }
  const answer = choiceAnswerSchema.safeParse(raw);
  if (!answer.success || !(answer.data.choice in question.criteria)) {
    throw new JevError('malformed', `no valid choice answer for "${id}"`);
  }
  return answer.data;
}
