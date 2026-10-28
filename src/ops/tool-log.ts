// [tool] log line: one per tool execution, so a turn's tool path can be read
// from `docker logs` without a prod DB query. Wraps the composed runTool body
// (inside the transactional step — never a workflow body, which must stay
// deterministic). A retried step logs again; a journaled step on replay does
// not run, so does not.
//
// Unlike tracing spans (metadata only), this carries truncated args and the
// result's first line: household conversation data, the same class the
// [inbound] line already logs. Operational credentials never flow through
// tool args or results (the boundary lives in config/deps wiring).

import type { ToolCall, ToolResult } from '../agent/context.js';
import type { Queryable } from '../memory/store.js';

type RunToolFn = (db: Queryable, call: ToolCall, conversationId: string) => Promise<ToolResult>;

const ARGS_CHARS = 200;
const RESULT_CHARS = 120;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n');
  return newline === -1 ? text : text.slice(0, newline);
}

export function withToolCallLog(runTool: RunToolFn, log: (line: string) => void): RunToolFn {
  return async function loggedRunTool(db, call, conversationId) {
    const head = `[tool] chat=${conversationId} ${call.name} args=${truncate(
      JSON.stringify(call.args) ?? 'undefined',
      ARGS_CHARS,
    )}`;
    try {
      const result = await runTool(db, call, conversationId);
      const outcome = result.parked ? 'parked' : 'ok';
      log(`${head} → ${outcome}: ${truncate(firstLine(result.content), RESULT_CHARS)}`);
      return result;
    } catch (err) {
      log(`${head} → error: ${truncate(String(err), RESULT_CHARS)}`);
      throw err;
    }
  };
}
