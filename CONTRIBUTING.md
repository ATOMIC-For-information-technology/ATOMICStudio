# Contributing to ATOMIC Studio

Thanks for helping build ATOMIC Studio!

## How to contribute

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach.
2. Fork the repo and create a branch: `git checkout -b my-change`.
3. `npm install`, then `npm run dev` to run the app.
4. Run the tests before opening a PR:
   - `npm run test:agent --workspace apps/desktop`
   - `npm run test:ui --workspace apps/desktop`
   - `npm run test:gitserver`
5. Open a pull request describing **what** changed and **why**.

## Ground rules

- Keep the core promises: local projects work offline with no account; the AI never writes to disk without an approvable diff; API keys never reach the renderer.
- Never commit secrets, `.env` files, or build output.
- Be kind. Harassment or disrespect isn't tolerated.

By contributing, you agree your contributions are licensed under the Apache License 2.0.
