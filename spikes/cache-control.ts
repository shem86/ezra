import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

// T7 (SPEC Phase-0 gate): prove `cache_control` works through AI SDK Core
// provider passthrough — second identical-prefix call must report
// cache_read_input_tokens > 0. On failure the pre-authorized escape hatch
// (@anthropic-ai/sdk for the model-call step only) must be decided before M4.
//
// Run twice with: node --env-file=.env spikes/cache-control.ts
// Spike code — env reads and direct I/O are fine here, banned in src/.

// The stable prefix must exceed the model's minimum cacheable length
// (Haiku-class: 2048 tokens), and must be byte-identical across calls.
const rule = (i: number) =>
  `Rule ${i}: The household assistant tracks shared lists, reminders, and calendar ` +
  `entries for the family; it answers in the language the family member used, whether ` +
  `Hebrew or English, and it never invents facts it has not read from its stores.\n`;

const stablePrefix =
  'You are the household assistant. Apply the following rules in order.\n' +
  Array.from({ length: 120 }, (_, i) => rule(i + 1)).join('');

interface CallReport {
  cacheWriteTokens: number;
  cacheReadTokens: number;
  usage: unknown;
  anthropic: unknown;
}

async function ask(question: string): Promise<CallReport> {
  const result = await generateText({
    model: anthropic('claude-haiku-4-5'),
    // The system prompt is the cacheable prefix, so it travels as a system
    // message (providerOptions can't attach to the plain `system` option).
    allowSystemInMessages: true,
    messages: [
      {
        role: 'system',
        content: stablePrefix,
        providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
      },
      { role: 'user', content: question },
    ],
  });
  const details = result.usage.inputTokenDetails;
  return {
    cacheWriteTokens: details?.cacheWriteTokens ?? 0,
    cacheReadTokens: details?.cacheReadTokens ?? 0,
    usage: result.usage,
    anthropic: result.providerMetadata?.anthropic,
  };
}

// Different questions on purpose: this proves PREFIX caching, not
// whole-request identity.
const first = await ask('In one sentence: what do you do?');
console.log('call 1:', JSON.stringify(first));
const second = await ask('In one sentence: who do you serve?');
console.log('call 2:', JSON.stringify(second));

if (second.cacheReadTokens > 0) {
  console.log(`PASS: second call read ${second.cacheReadTokens} tokens from cache`);
} else {
  console.log('FAIL: cache_read_input_tokens is 0 — escape-hatch decision needed before M4');
  process.exitCode = 1;
}
