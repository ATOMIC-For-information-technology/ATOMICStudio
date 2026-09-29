<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/atomic-logo-dark.svg">
  <img src="docs/brand/atomic-logo.svg" alt="ATOMIC" width="220">
</picture>

# ATOMIC Studio

**The AI-native development environment for non-coders and pros.**<br>
Click any element in your live app, describe the change in plain English, approve the diff.

[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-2563eb.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-16a34a.svg)](CONTRIBUTING.md)
[![Good first issues](https://img.shields.io/github/issues/ATOMIC-For-information-technology/ATOMICStudio/good%20first%20issue?label=good%20first%20issues&color=01A1FA)](https://github.com/ATOMIC-For-information-technology/ATOMICStudio/labels/good%20first%20issue)
[![Discussions](https://img.shields.io/github/discussions/ATOMIC-For-information-technology/ATOMICStudio?color=001536)](https://github.com/ATOMIC-For-information-technology/ATOMICStudio/discussions)
[![Stars](https://img.shields.io/github/stars/ATOMIC-For-information-technology/ATOMICStudio?style=social)](https://github.com/ATOMIC-For-information-technology/ATOMICStudio/stargazers)

[**Quick start**](#-quick-start) · [**Contribute**](#-contributing) · [**Roadmap**](ROADMAP.md)

<br>

<img src=".github/assets/click-to-edit.gif" alt="Click an element in the live app, describe the change, and ATOMIC Studio edits the real source" width="860">

</div>

<br>

## ✨ Why ATOMIC Studio

Most AI coding tools start from the code. ATOMIC Studio starts from **the thing you can see**: your running app.

| | |
|---|---|
| 🎯 **Click-to-edit live preview** | Click any element in your running app (React, Next.js, Vue, Svelte, plain HTML), describe the change, and the AI edits the exact source line. |
| 🛡️ **Trust by default** | Every AI change is a reviewable diff with a confidence score and a build receipt. Plan mode is read-only. One click undoes anything. |
| 🩹 **Self-healing preview** | Runtime errors are captured and repaired automatically — non-coders never see a stack trace. |
| 🔑 **Your model, your keys** | Claude, OpenAI, Gemini, Groq, Kimi, Ollama (fully local) or the free ATOMIC Hub. Keys stay in your OS keychain. |
| 🖥️ **Your servers** | Turn any SSH box (AWS, Hetzner, office server) into a workspace. Your code never has to leave your infrastructure. |
| 💬 **Plain English everywhere** | Explain any project, any terminal error, any Git diff. |

<br>

<p align="center"><img src=".github/assets/how-it-works.png" alt="How it works: click any element, describe the change, approve and it's live" width="100%"></p>

## 📸 A closer look

<table>
  <tr>
    <td width="50%"><img src=".github/assets/05-select.jpg" alt="Selected element with a plain-English instruction"><br><b>Click-to-edit.</b> Select anything in the live preview — Studio finds the component and line for you.</td>
    <td width="50%"><img src=".github/assets/06-applied.jpg" alt="The change applied live"><br><b>Instant, real edits.</b> The source file changes and the preview hot-reloads. One click to undo.</td>
  </tr>
  <tr>
    <td><img src=".github/assets/08-agent.jpg" alt="AI agent mission with steps, confidence and build receipt"><br><b>An agent that shows its work.</b> Reads before it writes, logs every step, scores its confidence.</td>
    <td><img src=".github/assets/07-devices.jpg" alt="iPhone, iPad and desktop previews side by side"><br><b>Every screen at once.</b> iPhone, iPad and desktop previews side by side — plus the real iOS Simulator.</td>
  </tr>
  <tr>
    <td><img src=".github/assets/03-editor.jpg" alt="Monaco code editor"><br><b>A real editor when you want it.</b> Monaco (the VS Code engine), bundled fully offline.</td>
    <td><img src=".github/assets/02-providers.jpg" alt="AI provider keys in settings"><br><b>Bring any model.</b> Paste a key once — or run offline with Ollama in Air-Gapped Mode.</td>
  </tr>
</table>

## 🚀 Quick start

Requirements: **Node.js 20+** on macOS, Windows or Linux.

```bash
git clone https://github.com/ATOMIC-For-information-technology/ATOMICStudio.git
cd ATOMICStudio
npm install
npm run dev
```

Open one of the sample projects in `examples/` and press **Run preview** — then click something.<br>
Build a desktop app with `npm run build` (packaged by electron-builder in `apps/desktop`).

> **No API key?** Pick **ATOMIC Hub (free)** in Settings → AI, or run a local model with Ollama.

## 🏗️ Architecture

<p align="center"><img src=".github/assets/architecture.png" alt="Architecture: renderer, Electron main, AI providers, your project, your servers" width="100%"></p>

| Path | What's inside |
|---|---|
| [`apps/desktop`](apps/desktop) | The Electron + Next.js desktop app — editor, live preview, AI agent |
| [`packages/inspector-plugin`](packages/inspector-plugin) | The click-to-edit inspector injected into live previews |
| [`server`](server) | Self-hosted workspace control plane + Git service |
| [`examples`](examples) | Sample projects used by the tests and demos |
| [`docs`](docs) | Architecture guides — start at [`docs/README.md`](docs/README.md) |

## 🤝 Contributing

ATOMIC Studio is built in the open and **we'd love your help** — you don't need to be an expert.

**Great places to start**

- 🟢 Pick a [**good first issue**](https://github.com/ATOMIC-For-information-technology/ATOMICStudio/labels/good%20first%20issue)
- 🧩 Extend click-to-edit to a new framework (Angular, Solid, Astro…)
- 🪟🐧 Try Studio on **Windows or Linux** and report what breaks
- 🌍 Translate the interface (Arabic, French, Spanish, …)
- 📚 Improve docs, add an example project, record a tutorial

**How it works:** fork → branch → `npm run typecheck` + the tests in [CONTRIBUTING.md](CONTRIBUTING.md) → open a pull request. Every PR gets a review from the core team.

Questions or ideas? Start a thread in [**Discussions**](https://github.com/ATOMIC-For-information-technology/ATOMICStudio/discussions).

<a href="https://github.com/ATOMIC-For-information-technology/ATOMICStudio/graphs/contributors"><img src="https://contrib.rocks/image?repo=ATOMIC-For-information-technology/ATOMICStudio" alt="Contributors"></a>

## 🔒 Security

Please don't report security issues in public issues — email **security@atomic.limited** instead. See [SECURITY.md](SECURITY.md).

## 📄 License

[Apache License 2.0](LICENSE) © 2026 ATOMIC Limited. "ATOMIC" and "ATOMIC Studio" are trademarks of ATOMIC Limited.

<div align="center"><br>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/brand/atomic-mark-dark.svg">
  <img src="docs/brand/atomic-mark.svg" alt="" width="44">
</picture>
<br><sub>If ATOMIC Studio helps you, <b>give it a ⭐</b> — it helps other developers find it.</sub>
</div>
