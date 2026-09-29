# ATOMIC Studio

**The AI-native development environment for non-coders and pros.**
Describe what you want, see it running live, click any element to change it — and approve every change before it touches your files.

Built by [ATOMIC Limited](https://atomic.limited). Open source under Apache 2.0. **Contributors welcome.**

---

## Why ATOMIC Studio is different

- **Click-to-edit live preview** — click any element in your running app (React, Next.js, Vue, Svelte, plain HTML), describe the change, and the AI edits the source.
- **Trust by default** — every AI change is a reviewable diff. Plan mode is read-only. Every save has one-click undo and a full session timeline.
- **Self-healing preview** — runtime errors are captured and repaired automatically. Non-coders never see a stack trace.
- **Model freedom** — Claude, OpenAI, Gemini, Groq, Kimi, Ollama (local), or the free ATOMIC Hub. Your keys stay on your machine.
- **Your-server workspaces** — turn any SSH box (AWS, Hetzner, office server) into a dev environment. Your code never has to leave your infrastructure.
- **Plain-English everything** — explain any project, any terminal error, any Git diff.

See [FEATURES.md](FEATURES.md) for the full list and [ROADMAP.md](ROADMAP.md) for what's next.

## Quick start

Requirements: Node.js 20+, macOS / Windows / Linux.

```bash
git clone https://github.com/ATOMIC-For-information-technology/ATOMICStudio.git
cd ATOMICStudio
npm install
npm run dev
```

Build a desktop app: `npm run build` (packaging via electron-builder in `apps/desktop`).

## Repository layout

| Path | What's inside |
|---|---|
| `apps/desktop` | The Electron + Next.js desktop app (editor, preview, AI agent) |
| `packages/inspector-plugin` | Click-to-edit inspector for live previews |
| `server` | Self-hosted workspace + Git control plane |
| `examples` | Sample projects used by tests and demos |
| `docs` | Architecture guides — start at [docs/README.md](docs/README.md) |

## Contributing

We'd love your help — bug reports, features, docs, translations. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get started, then open an issue or pull request.

## Security

Please don't report security issues in public issues. Email **security@atomic.limited** instead.

## License

[Apache License 2.0](LICENSE) © 2026 ATOMIC Limited. "ATOMIC" and "ATOMIC Studio" are trademarks of ATOMIC Limited.
