import type { Transport, TransportState } from './types.js';

// Standalone transport runner core (T13): command parsing and execution,
// kept pure/injected so the interactive loop is unit-testable against a
// fake transport. No LLM, no DB writes — this layer exists to drill the
// transport and its monitoring before any agent sits on top (M2 gate).

export type RunnerCommand =
  | { kind: 'help' }
  | { kind: 'status' }
  | { kind: 'send'; to: string; text: string }
  | { kind: 'reconnect' }
  | { kind: 'quit' }
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'unknown'; input: string };

export const USAGE = [
  'commands:',
  '  send <jid> <text…>   manual test send (human-like delay jitter)',
  '                       jid looks like 123…@s.whatsapp.net or 123…-456…@g.us',
  '  reconnect            force a socket reconnect',
  '  status               last known transport state',
  '  help                 this text',
  '  quit                 disconnect and exit',
].join('\n');

export function parseRunnerCommand(line: string): RunnerCommand {
  const trimmed = line.trim();
  if (trimmed === '') return { kind: 'empty' };
  const [word, ...rest] = trimmed.split(/\s+/);
  switch (word?.toLowerCase()) {
    case 'help':
      return { kind: 'help' };
    case 'status':
      return { kind: 'status' };
    case 'reconnect':
      return { kind: 'reconnect' };
    case 'quit':
    case 'exit':
      return { kind: 'quit' };
    case 'send': {
      const [to, ...words] = rest;
      if (!to || !to.includes('@') || words.length === 0) {
        return { kind: 'invalid', message: `usage: send <jid> <text…>\n${USAGE}` };
      }
      return { kind: 'send', to, text: words.join(' ') };
    }
    default:
      return { kind: 'unknown', input: trimmed };
  }
}

// Bot-pattern hygiene: a manual test send should not leave the socket at
// machine speed. Window mirrors human type-then-send latency.
export const HUMAN_SEND_DELAY = { minMs: 1_500, maxMs: 4_500 } as const;

export function computeHumanSendDelay(random: () => number): number {
  return Math.floor(
    HUMAN_SEND_DELAY.minMs + random() * (HUMAN_SEND_DELAY.maxMs - HUMAN_SEND_DELAY.minMs),
  );
}

export interface RunnerDeps {
  transport: Transport;
  out: (line: string) => void;
  /** Test seams; default to a real timer and Math.random. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface Runner {
  /** Executes one input line; resolves false when the loop should end. */
  handleLine(line: string): Promise<boolean>;
}

export function createRunner(deps: RunnerDeps): Runner {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const out = deps.out;

  let lastState: TransportState | 'never-connected' = 'never-connected';
  deps.transport.onStateChange((state) => {
    lastState = state;
  });

  return {
    async handleLine(line: string): Promise<boolean> {
      const command = parseRunnerCommand(line);
      switch (command.kind) {
        case 'empty':
          return true;
        case 'help':
          out(USAGE);
          return true;
        case 'status':
          out(`transport state: ${lastState}`);
          return true;
        case 'invalid':
          out(command.message);
          return true;
        case 'unknown':
          out(`unknown command: ${command.input}\n${USAGE}`);
          return true;
        case 'send': {
          const delay = computeHumanSendDelay(random);
          out(`sending in ${String(delay)}ms (human-like jitter)…`);
          await sleep(delay);
          try {
            const receipt = await deps.transport.send({
              conversationId: command.to,
              text: command.text,
            });
            out(`sent ✓ message id ${receipt.messageId}`);
          } catch (error) {
            out(`send failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return true;
        }
        case 'reconnect':
          out('forcing reconnect…');
          try {
            await deps.transport.forceReconnect();
            out('reconnected ✓');
          } catch (error) {
            out(`reconnect failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          return true;
        case 'quit':
          return false;
      }
    },
  };
}
