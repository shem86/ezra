// Jev client contract (turn-routing plan Phase 2): request shape, answer
// validation, and failure classification against a stubbed fetch — the real
// wire is exercised on demand by spikes/jev-turn-route-probe.ts (never live
// calls in CI). Every failure must surface as a JevError, never as an answer:
// the caller maps it to a fallback tier, and a malformed body silently read
// as "no" would route wrongly with nothing in the trace to say why.

import { describe, expect, it } from 'vitest';
import { JevError, makeJevClient, type JevQuestions } from '../../src/agent/jev-client.js';

const apiKey = 'apikey_test_0123456789abcdef';

const questions: JevQuestions = {
  billing: { type: 'noul', instructions: 'Is `message` about billing?' },
  tone: {
    type: 'choice',
    instructions: 'What is the tone of `message`?',
    criteria: { calm: 'A neutral or polite message', angry: 'An upset or hostile message' },
  },
};

function okBody(): unknown {
  return {
    model: 'jev-1.14.0',
    answers: {
      billing: { type: 'noul', noul: 0.91 },
      tone: {
        type: 'choice',
        choice: 'calm',
        confidence: 0.7,
        probabilities: { calm: 0.85, angry: 0.15 },
      },
    },
    usage: { input_tokens: 120, output_tokens: 12 },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function failureOf(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(JevError);
    return error as JevError;
  }
  throw new Error('expected the call to fail');
}

describe('makeJevClient', () => {
  it('posts the pinned model, the state, and the questions with bearer auth', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const client = makeJevClient({
      apiKey,
      fetchFn: async (url, init) => {
        captured = { url: String(url), init: init! };
        return json(okBody());
      },
    });

    const state = { message: 'חויבתי פעמיים החודש' };
    await client.ask(state, questions);

    expect(captured?.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(captured?.init.method).toBe('POST');
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${apiKey}`,
    );
    const body = JSON.parse(captured?.init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('jev-1.14.0');
    expect(body.state).toEqual(state);
    expect(body.questions).toEqual(questions);
  });

  it('honors an explicit model pin', async () => {
    let model: unknown;
    const client = makeJevClient({
      apiKey,
      model: 'jev-1.13.0',
      fetchFn: async (_url, init) => {
        model = (JSON.parse(init?.body as string) as Record<string, unknown>).model;
        return json(okBody());
      },
    });
    await client.ask({}, questions);
    expect(model).toBe('jev-1.13.0');
  });

  it('returns the answering model, typed answers, and billable usage', async () => {
    const client = makeJevClient({ apiKey, fetchFn: async () => json(okBody()) });

    const response = await client.ask({}, questions);

    expect(response.model).toBe('jev-1.14.0');
    expect(response.answers.billing).toEqual({ type: 'noul', noul: 0.91 });
    expect(response.answers.tone).toMatchObject({ type: 'choice', choice: 'calm' });
    expect(response.inputTokens).toBe(120);
  });

  it('classifies a non-2xx as http with its status', async () => {
    const client = makeJevClient({
      apiKey,
      fetchFn: async () => json({ detail: 'rate limited' }, 429),
    });

    const error = await failureOf(client.ask({}, questions));

    expect(error.kind).toBe('http');
    expect(error.status).toBe(429);
    expect(error.message).toContain('rate limited');
  });

  it('classifies an exceeded deadline as timeout', async () => {
    const client = makeJevClient({
      apiKey,
      timeoutMs: 5,
      fetchFn: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    });

    const error = await failureOf(client.ask({}, questions));

    expect(error.kind).toBe('timeout');
  });

  it('classifies a transport failure as network', async () => {
    const client = makeJevClient({
      apiKey,
      fetchFn: async () => {
        throw new TypeError('fetch failed');
      },
    });

    const error = await failureOf(client.ask({}, questions));

    expect(error.kind).toBe('network');
    expect(error.message).toContain('fetch failed');
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>bad gateway</html>', { status: 200 })],
    [
      'an asked question with no answer',
      () => json({ ...(okBody() as object), answers: { billing: { type: 'noul', noul: 0.5 } } }),
    ],
    [
      'an answer of the wrong type',
      () =>
        json({
          ...(okBody() as object),
          answers: {
            billing: { type: 'choice', choice: 'x', confidence: 1, probabilities: { x: 1 } },
            tone: (okBody() as { answers: { tone: unknown } }).answers.tone,
          },
        }),
    ],
    [
      'a noul outside [0, 1]',
      () =>
        json({
          ...(okBody() as object),
          answers: {
            billing: { type: 'noul', noul: 1.4 },
            tone: (okBody() as { answers: { tone: unknown } }).answers.tone,
          },
        }),
    ],
    [
      'a choice outside the asked options',
      () =>
        json({
          ...(okBody() as object),
          answers: {
            billing: { type: 'noul', noul: 0.2 },
            tone: { type: 'choice', choice: 'excited', confidence: 0.9, probabilities: {} },
          },
        }),
    ],
  ])('classifies %s as malformed — never as an answer', async (_label, respond) => {
    const client = makeJevClient({ apiKey, fetchFn: async () => respond() });

    const error = await failureOf(client.ask({}, questions));

    expect(error.kind).toBe('malformed');
  });

  it('keeps the API key out of every error, even one whose body echoes it', async () => {
    const failures: Array<() => Promise<Response>> = [
      async () => json({ detail: `invalid key ${apiKey}` }, 401),
      async () => new Response(`not json ${apiKey}`, { status: 200 }),
      async () => {
        throw new TypeError(`connect failed for Bearer ${apiKey}`);
      },
    ];
    for (const fetchFn of failures) {
      const client = makeJevClient({ apiKey, fetchFn });
      const error = await failureOf(client.ask({}, questions));
      expect(error.message).not.toContain(apiKey);
      expect(String(error.stack)).not.toContain(apiKey);
    }
  });
});
