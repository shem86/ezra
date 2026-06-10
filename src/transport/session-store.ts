import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { useMultiFileAuthState } from 'baileys';

// Baileys session state is a live "message anyone as you" credential
// (architecture decision 1). This store owns its on-disk lifecycle:
// - lives in a configurable writable dir, gitignored, NEVER in backups;
// - recovery from loss or corruption is re-pair via QR, never restore —
//   a stale Signal ratchet desyncs encryption (decision 8);
// - creds writes are serialized: concurrent creds.update events otherwise
//   interleave multi-file writes and can tear creds.json (OpenClaw lesson).

type AuthState = Awaited<ReturnType<typeof useMultiFileAuthState>>;

export interface SessionStore {
  /** True once pairing credentials exist on disk. */
  isPaired(): boolean;
  loadAuthState(): Promise<AuthState>;
  /** Deletes all session state — the prelude to a fresh QR pairing. */
  clear(): Promise<void>;
}

export function createSessionStore(deps: { dir: string }): SessionStore {
  const credsPath = join(deps.dir, 'creds.json');
  // Promise chain serializing every creds write; errors are surfaced to the
  // caller of the failing save but don't wedge the queue.
  let saveQueue: Promise<void> = Promise.resolve();

  function assertCredsReadable(): void {
    if (!existsSync(credsPath)) return;
    try {
      JSON.parse(readFileSync(credsPath, 'utf8'));
    } catch (err) {
      throw new Error(
        `WhatsApp session state at ${deps.dir} is corrupt. Recovery is re-pair, ` +
          'never restore: clear the session dir and run the pairing flow again ' +
          '(docs/pairing.md).',
        { cause: err },
      );
    }
  }

  return {
    isPaired(): boolean {
      return existsSync(credsPath);
    },

    async loadAuthState(): Promise<AuthState> {
      await mkdir(deps.dir, { recursive: true, mode: 0o700 });
      assertCredsReadable();
      const { state, saveCreds } = await useMultiFileAuthState(deps.dir);
      const serializedSaveCreds = (): Promise<void> => {
        const save = saveQueue.then(() => saveCreds());
        saveQueue = save.catch(() => undefined);
        return save;
      };
      return { state, saveCreds: serializedSaveCreds };
    },

    async clear(): Promise<void> {
      await rm(deps.dir, { recursive: true, force: true });
    },
  };
}
