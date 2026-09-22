# Security policy

## Scope

TravelOps Copilot is a controlled local demonstration with a deterministic v1 baseline
and an optional v2 DeepSeek adapter. A local development key is needed only
when a developer explicitly enables v2 live-model testing; it must never enter
Git, CI logs, browser code, screenshots, issue text, or chat. The project does
not need payment credentials, identity documents, or a production CRM
connection. Do not add real customer data, secrets, or booking credentials to
this repository.

The Netlify v3 free-public-source adapter needs no API key, account, card, or payment credential. It only sends a validated destination to the read-only Chinese Wikivoyage and Chinese Wikipedia endpoints. Free-text notes and ticket requests are rejected before retrieval.

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
  time. It never treats a public-source result as verified price, opening hours,
  routing, booking availability, or safety information.
- v3 functions have a conservative per-IP Netlify rate limit and short cache.
  These protect free source sites from repeated requests; they are not an
  authentication system. No provider Key or billing credential is used.
- This proof of concept is not a booking, medical, payment, or identity system.
