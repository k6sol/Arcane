import { StudioTestError } from '../../../packages/studio-test-controller/src/index.js';

export const STUDIO_TEST_OWNED_CLOSE_MS = 5000;
interface CloseClient { close(): Promise<void> }
interface CloseTransport extends CloseClient { onclose?: () => void }
export interface StudioTestOwnedClose { readonly physicalClosed: Promise<void>; close(): Promise<void> }

/** Fresh host-owned SDK objects only. Install before Client.connect so the SDK
 * chains this callback into its own pending-request and client-close handling.
 * A resolved SDK close, process exit code or delivered signal is not this event. */
export function createStudioTestOwnedClose(client: CloseClient, transport: CloseTransport): Readonly<StudioTestOwnedClose> {
  if (transport.onclose !== undefined) throw new StudioTestError('FENCED');
  const closeClient = client.close.bind(client), closeTransport = transport.close.bind(transport);
  let observedClose!: () => void;
  const physicallyClosed = new Promise<void>(resolve => { observedClose = resolve; });
  // This callback cannot throw. Protocol.connect preserves it before installing
  // its own callback; StdioClientTransport invokes it from the child's close event.
  transport.onclose = () => { observedClose(); };
  let pending: Promise<void> | null = null;
  const join = async (): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failed = false, failure: unknown;
    const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), STUDIO_TEST_OWNED_CLOSE_MS); });
    const cleanup = (async () => {
      try { await closeClient(); } catch (error) { failed = true; failure = error; }
      try { await closeTransport(); } catch (error) { if (!failed) { failed = true; failure = error; } }
    })();
    // Both promises remain observed even if the bounded caller returns first.
    // A late close event cannot turn a returned refusal into a successful close.
    const joined = cleanup.then(async () => { await physicallyClosed; return 'closed' as const; });
    try {
      const result = await Promise.race([joined, deadline]);
      if (failed) throw failure;
      if (result !== 'closed') throw new StudioTestError('FENCED');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  return Object.freeze({ physicalClosed: physicallyClosed, close(): Promise<void> { return pending ??= join(); } });
}

/** Failed initialization retains its original error identity after bounded
 * owned cleanup. Cleanup failure never substitutes a different connect result. */
export async function closeAfterStudioTestConnectFailure(owned: Pick<StudioTestOwnedClose, 'close'>, error: unknown): Promise<never> {
  try { await owned.close(); } catch { /* Original connect failure remains authoritative. */ }
  throw error;
}
