# EU/NL operator checklist

Engineering controls are not legal advice. Complete this checklist for every exact model revision before enabling paid Studio or Cheap generation.

## Provider review

- Record provider, exact model ID and immutable revision; reject `latest` aliases.
- Download/read the current provider terms and upstream model terms; store the SHA-256 fingerprint and review timestamp.
- Confirm NL/EU territory, commercial use, output ownership/use, required notices, prohibited content and attribution.
- Record retention, training use and zero-data-retention settings.
- Record the real unit price used by the hard cost estimator.
- Set `acceptedAt`, permitted territories and `enabled` only after the review.
- Keep Hunyuan3D-family models blocked in the EU unless a future exact license is separately approved.
- Do not substitute SAM3 for local SAM2 without an explicit reviewed restricted-model profile.

Run `pnpm provider:check -- --profile studio`. A nonzero exit is a release blocker, not a warning.

## Secrets and execution

- Put keys only in `apps/compiler-service/.env.local` or an OS secret store; never use `VITE_*`.
- Install Blender 5.1 separately and point `WORLDENGINE_BLENDER_EXECUTABLE` to it.
- Install the reviewed SAM2 package/checkpoint separately; record repository commit and checkpoint SHA-256 as the policy revision.
- Verify `/health` reports every selected profile `operational: true`, `configured: true`, and Studio worker available.
- Do not expose the compiler service beyond trusted LAN/origins without authentication and TLS.

## Paid smoke gate

The default command is a non-billable dry-run:

```bash
pnpm test:providers:live -- --profile studio --mesh-provider tripo --max-cost-usd 25
```

The live command is intentionally harder to invoke:

```bash
WORLDENGINE_LIVE_PROVIDER_TEST=I_ACCEPT_BILLABLE_PROVIDER_CALLS \
pnpm test:providers:live -- --profile studio --mesh-provider tripo --max-cost-usd 25 --execute
```

Run it manually only after terms review. Never put the live opt-in or provider secrets in CI. Archive the job events, costs, exact model records and immutable outputs.

## Open-source release

- Apache-2.0 covers project-authored TypeScript packages and the SAM2 wrapper script, not external weights/services/assets.
- The separately installed Blender worker script is GPL-3.0-or-later; keep it process-separated from the Apache core and distribute its source/license with any binary distribution that includes it.
- Do not include WorldClaw figures, sample assets, prompts, repository code or Tencent branding.
- Do not bundle Blender, SAM2 weights, Tripo/Meshy outputs or third-party assets unless their licenses independently permit redistribution.
- Preserve asset provenance and notices in exported bundles.
- Obtain trademark clearance and counsel-led patent freedom-to-operate review before a commercial launch.

The repository can be open-sourced with these boundaries, but that statement is an engineering release posture, not counsel's approval.
