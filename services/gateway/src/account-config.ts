/** Server-only account configuration. Public app builds contain no owner identities or credentials. */
export interface AccountsConfig {
  providerUrl: string;
  publishableKey: string;
  sessionKey: string;
  bootstrapEmail: string | null;
  providers: ('google' | 'apple')[];
}

export function readAccountsConfig(env: Record<string, string | undefined>): AccountsConfig | null {
  if (!env.SUPABASE_URL && !env.SUPABASE_PUBLISHABLE_KEY && !env.ACCOUNTS_SESSION_KEY && !env.ADMIN_BOOTSTRAP_EMAIL) return null;
  const fail = (name: string): never => { throw new Error('Invalid account configuration: ' + name); };
  let url: URL;
  try { url = new URL(env.SUPABASE_URL ?? ''); } catch { return fail('SUPABASE_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) fail('SUPABASE_URL must be an exact https origin');
  const key = env.SUPABASE_PUBLISHABLE_KEY ?? '';
  if (!/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) fail('use a Supabase publishable key, never a secret or service-role key');
  const sessionKey = env.ACCOUNTS_SESSION_KEY ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(sessionKey) || Buffer.from(sessionKey, 'base64url').length !== 32 || Buffer.from(sessionKey,'base64url').toString('base64url') !== sessionKey) fail('ACCOUNTS_SESSION_KEY must be 32 random bytes encoded as base64url');
  const email = env.ADMIN_BOOTSTRAP_EMAIL?.trim().toLowerCase() || null;
  if (email && (email.length > 254 || !/^[^\s@<>"']+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email))) fail('ADMIN_BOOTSTRAP_EMAIL');
  const providers = (env.ACCOUNT_SOCIAL_PROVIDERS ?? 'google,apple').split(',').filter(Boolean);
  if (providers.some(value => value !== 'google' && value !== 'apple') || new Set(providers).size !== providers.length) fail('ACCOUNT_SOCIAL_PROVIDERS');
  return {providerUrl:url.origin,publishableKey:key,sessionKey,bootstrapEmail:email,providers:providers as AccountsConfig['providers']};
}
