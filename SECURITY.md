# Security policy

Never place provider API keys in `apps/editor`, a Vite environment variable, a world bundle, or exported game code. Keys belong in the compiler process environment or an operating-system secret store. `VITE_*` values are public browser configuration.

Compiler request schemas strip unknown fields before persistence, provider adapters receive secrets out of band, and error/event records must not include authorization headers or raw credentials. Treat uploaded GLB, image, texture, and catalog inputs as untrusted; validate size, media type, referenced resources, and decoded structure before publishing a bundle. Filesystem/S3 world keys accept only bounded safe IDs, positive versions, safe integer coordinates, exact SHA-256 hashes, and known reference extensions.

Configure `WAVESPEED_WEBHOOK_SECRET` only in the compiler process. WaveSpeed callbacks are rejected when the secret is absent, the timestamp is stale, or the raw-body signature is invalid. URI chunks are checked against their declared byte length and SHA-256 before schema parsing; unsafe schemes and path traversal are rejected during bundle/asset validation.

This repository is alpha software. Security support currently covers the latest commit on `main`; no stable-version support window has been declared.

Report vulnerabilities privately through the repository's **Security → Report a vulnerability** flow so GitHub opens a private security advisory. Do not open a public issue for an unpatched vulnerability, and do not include live credentials or unnecessary third-party personal data in reports. If the private reporting button is unavailable, contact a repository administrator without transmitting an exploit or secret until a private channel is agreed.
