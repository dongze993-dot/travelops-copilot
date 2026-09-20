# Security policy

## Scope

TravelOps Copilot is a local, deterministic portfolio demo. It does not need
an LLM provider key, payment credential, identity document, or production CRM
connection. Do not add real customer data, secrets, or booking credentials to
this repository.

## Reporting a vulnerability

Please use the repository's private security-advisory feature if it is enabled.
If it is not available, open a minimal issue that contains no exploit details,
keys, personal information, or screenshots of private systems; a maintainer can
then arrange a private follow-up.

## Local development safeguards

- `.env`, SQLite runtime files, and common virtual-environment folders are
  ignored by Git. Commit only `.env.example`.
- The bundled knowledge data is explicitly marked as example data. Replace it
  only with public, licensed, or properly de-identified material.
- This proof of concept is not a booking, medical, payment, or identity system.
