# Contributing to ATOMIC Studio

Thanks for helping build ATOMIC Studio! Whether you fix a typo or build a new framework adapter, you're welcome here.

## Ways to help

| You like… | Try this |
|---|---|
| Quick wins | Anything labelled [`good first issue`](https://github.com/ATOMIC-For-information-technology/ATOMICStudio/labels/good%20first%20issue) |
| Frontend | Extend click-to-edit to Angular, Solid or Astro (`packages/inspector-plugin`) |
| Cross-platform | Run Studio on Windows or Linux and fix what breaks |
| Languages | Translate the UI |
| Writing | Improve docs, add an example project, write a tutorial |

Not sure where to start? Say hi in [Discussions](https://github.com/ATOMIC-For-information-technology/ATOMICStudio/discussions) and tell us what you enjoy.

## Development setup

```bash
git clone https://github.com/ATOMIC-For-information-technology/ATOMICStudio.git
cd ATOMICStudio
npm install
npm run dev            # launches the desktop app
```

Open `examples/hello-vite`, press **Run preview**, and try click-to-edit. No API key is needed for development: the test suites use a built-in mock AI provider.

## Before you open a pull request

```bash
cd apps/desktop
npm run typecheck      # TypeScript, main + renderer
npm run test:agent     # headless agent checks (mock AI, zero cost)
npm run test:ui        # drives the real app window end to end
cd ../.. && npm run test:gitserver   # self-hosted Git service
```

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach.
2. Keep PRs focused — one change per PR is easier to review.
3. Describe **what** changed and **why**, with a screenshot or GIF for UI changes.

## Ground rules

These are the promises the product makes — please keep them:

- Local projects work offline, with no account.
- The AI never writes to disk without a reviewable diff and a restore point.
- API keys and filesystem access never reach the renderer.
- Never commit secrets, `.env` files or build output.

Be kind — see our [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree your contributions are licensed under the Apache License 2.0.
