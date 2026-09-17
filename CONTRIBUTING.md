# Contributing

Thanks for helping improve Gemini Agent Bridge.

## Before you start

- Use Node.js 22.5.0 or later.
- Install no credentials in the repository. API keys belong only in a local CCR provider configuration and must never appear in commits, fixtures, issue reports, or logs.
- Read the dedicated-gateway limitation in the [README](./README.md) before changing routes: universal `/v1/*` bridge routes cannot coexist with fallthrough to another CCR provider.

## Local checks

From the repository root, run:

```sh
npm test
npm run check
```

Add or update focused tests for behavior changes. Keep test fixtures free of live credentials and external network dependencies.

## Pull requests

- Keep each pull request small and explain the user-visible behavior it changes.
- Preserve the Anthropic-compatible request and response behavior unless the pull request explicitly documents an intentional compatibility change.
- Update the README and `config.example.json` whenever configuration, model mapping, tools, storage, or operational behavior changes.
- Do not commit generated databases, logs, dependencies, local profiles, or `.env` files.

Use GitHub Issues for reproducible bugs and feature proposals. For a security vulnerability, follow [SECURITY.md](./SECURITY.md) instead of opening a public issue.
