# Security policy

## Scope

TravelOps Copilot is a controlled local demonstration with a deterministic v1 baseline
and an optional v2 DeepSeek adapter. A local development key is needed only
when a developer explicitly enables v2 live-model testing; it must never enter
Git, CI logs, browser code, screenshots, issue text, or chat. The project does
not need payment credentials, identity documents, or a production CRM
connection. Do not add real customer data, secrets, or booking credentials to
this repository.

The optional Netlify v3 live-retrieval adapter uses a separate `TAVILY_API_KEY`.
It must exist only in Netlify's server-side function environment, never in
`netlify.toml`, browser JavaScript, GitHub, chat, screenshots, logs, or API
responses. The route only sends destination and selected interests to the
provider; free-text notes and ticket requests are rejected before retrieval.

## Reporting a vulnerability

Please use the repository's private security-advisory feature if it is enabled.
If it is not available, open a minimal issue that contains no exploit details,
keys, personal information, or screenshots of private systems; a maintainer can
then arrange a private follow-up.

## Local development safeguards

- `.env`, SQLite runtime files, and common virtual-environment folders are
  ignored by Git. Commit only `.env.example`.
- v2 uses a server-side environment variable and returns only safe model
  metadata; it never returns an API key, authorization header, raw provider
  error body, or complete provider prompt.
- `TRAVELOPS_PUBLIC_DEMO_MODE=true` rejects mock-CRM reads, writes, and
  automatic ticket creation. Keep it enabled on unauthenticated public hosts;
  this is a bounded demo safeguard, not a substitute for production access control.
- Do not place API keys in GitHub Actions secrets for this demo's default CI.
  CI exercises a fake provider only; any paid live-model smoke test should be
  manually triggered in a controlled local environment with synthetic data.
- The bundled knowledge data is explicitly marked as example data. Replace it
  only with public, licensed, or properly de-identified material.
- v3 returns only a sanitized `https` URL, title, short snippet and retrieval
  time. It never treats a search result as verified price, opening hours,
  routing, booking availability, or safety information.
- v3 functions have a conservative per-IP Netlify rate limit and short cache,
  but those controls are not a global quota or authentication system. Keep the
  site private while testing a personal provider Key; add a durable global
  quota/rate limit before making live retrieval broadly public.
- This proof of concept is not a booking, medical, payment, or identity system.
