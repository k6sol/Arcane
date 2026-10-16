// Test-only refusals for passive labs that never intend a native connection or provider probe. Injecting these keeps
// an accidental future connect or diagnostics probe from reaching createCodexService's default native factory or
// discoverProviders (installed CLIs). Unit fixtures import the emitted ./native-fixture-refusal.js.
// No discovery, process or grant.
export const NATIVE_FIXTURE_REFUSAL_MESSAGE = 'Test fixture: native Codex connections are refused.';

/** codexConnect replacement: always rejects before any native lookup or process start. */
export async function refuseNativeCodex(..._ignored: unknown[]): Promise<never> {
  throw new Error(NATIVE_FIXTURE_REFUSAL_MESSAGE);
}

/** probe replacement: an empty provider list, never native discovery. */
export async function noProviderProbe(..._ignored: unknown[]): Promise<[]> {
  return [];
}
