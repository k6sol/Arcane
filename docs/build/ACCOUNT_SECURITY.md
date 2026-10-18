# Account service

Arcane accounts use Supabase Auth for verified identity and Stripe for hosted payment entry. These service integrations require deployment configuration; local code and fixture checks do not establish live sign-in or payment acceptance.

The account storage layer encrypts browser session payloads and private identity fields using AES-256-GCM with purpose and record identity bound as authenticated data. Browser identifiers are random and only keyed hashes are stored. Session writes use version checks, absolute expiry and explicit deletion. Encryption keys must be independent, randomly generated server secrets and kept outside source control. A missing or changed key must not silently discard existing records.

The identity adapter authenticates the exact access token through Supabase's `GET /user` before using its subject, issuer, audience, expiry or assurance claims. Email must be verified. User-editable metadata does not grant an admin role. Provider response bodies, passwords and tokens must never enter application logs or public error messages.

Account routes will enforce enrolled two-step verification before device approval, checkout and account access. Owner administration additionally requires a recent second-factor check. The owner is bootstrapped from private deployment configuration after verified email and MFA; the repository contains no owner email or pre-authorized public account. Social-provider registrations, mail delivery, MFA recovery and payment acceptance need their own live checks before public launch.

Use TLS, encrypted production storage and backups, restricted service credentials and audited access. Encryption protects specific boundaries; it is not a guarantee against every possible data leak.

References: [Supabase Auth API](https://github.com/supabase/auth/blob/master/openapi.yaml), [MFA enforcement](https://supabase.com/docs/guides/auth/auth-mfa), [server-validated users](https://supabase.com/docs/reference/javascript/auth-getuser), [Stripe Checkout](https://docs.stripe.com/payments/checkout).
