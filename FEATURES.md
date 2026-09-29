# ATOMIC Studio — Features & Benefits

*The AI-native software development environment for non-coders and pros. Every feature below is **shipped and test-covered** (48 UI steps + 51 headless checks, zero API cost via a mock provider). Nothing here is a mockup.*

---

## The editor you work in
| Feature | What it does | Why it matters |
|---|---|---|
| Monaco editor (offline) | Real VS Code editor engine, bundled fully offline | Familiar, fast, no CDN/network dependency |
| Tabs + file tree | Open files in tabs; create/rename/delete in the explorer | The IDE basics, non-coder friendly |
| ⌘S save + one-click Undo | Save snapshots every change | Nothing is lost; every save is reversible |
| ⌘K inline edit | Select code, describe a change, AI rewrites *just that selection* | Cursor's headline feature — with a review-before-save gate |
| Tab autocomplete | Ghost-text suggestions as you type (toggleable) | Optional, provider-agnostic, off when no key |
| ⌘P Search Everywhere | Jump to any file/function/import from the background index | Instant navigation, no disk scan |

## The live preview + click-to-edit (nobody else has this)
| Feature | What it does | Why it matters |
|---|---|---|
| Multi-device preview | Your running app in Desktop/iPhone/iPad frames + real iOS Simulator | See it everywhere at once |
| Click-to-edit | Click any element in the live app → describe a change → AI edits the source | React, Next.js, Vue, Svelte — zero setup |
| Static-site preview | Any HTML folder previews via a built-in live-reload server | "Any website folder just works" |
| Self-healing auto-fix | Runtime errors in the preview are captured and auto-repaired | Non-coders never see a stack trace |

## The AI agent (the trust story)
| Feature | What it does | Why it matters |
|---|---|---|
| Diff-approval by default | Every file change is a reviewable diff; nothing writes to disk unseen | The opposite of "Turbo/YOLO" autopilot |
| Plan mode | Read-only: proposes changes without touching anything | Human-in-the-loop before edits |
| Verify-after-apply | Syntax-checks every file the AI wrote, right after Apply | Catches "the AI said done but broke it" |
| Session Undo Timeline | Every change this session, rewind to any point | The recovery panel Cursor lacks |
| Background agents | Queue work; it keeps running with the panel closed; status-bar chip + toast | Fire-and-forget, always visible |
| Conversation memory | Follow-ups continue the same chat; ⌘⇧-style New chat resets | No re-explaining |
| Project Explainer + Tech-Debt Radar | One-click plain-English project explanation + debt signals | Instant onboarding to any codebase |
| Smart Terminal | "Explain" any command output/error in plain English | Logs become human language |
| Git Supercharge | AI-drafted commit messages, PR descriptions, release notes | From a real `git diff` |
| 8 AI providers + free hub | ATOMIC Hub (free Groq), Groq, Claude, OpenAI, Gemini, Kimi, Ollama | Model freedom, never metered by us |

## Codespaces — the two-tier platform
| Feature | What it does | Why it matters |
|---|---|---|
| Your-server workspaces | Provision a dev environment on *any* SSH box (AWS/Hetzner/office) | Free, unlimited, code never leaves your machine |
| ATOMIC Cloud workspaces | Ready-to-go cloud machine, **$9/mo flat — never metered** | No credits, no surprise bills, ever |
| Snapshots + restore | Named restore points on either tier | Nothing unrecoverable |
| Port forwarding | `ssh -N -L` any workspace port to localhost | Preview server apps locally |
| Workspace secrets | Keychain-stored, injected at runtime, never in the repo | Replaces raw `.env` risk |
| Auto-suspend + wake | Idle workspaces sleep, wake on open | What makes $9 flat profitable |
| Git timeline | Visual commit history + per-commit file lists | See the project's story |

## Enterprise & trust
| Feature | What it does | Why it matters |
|---|---|---|
| Team roles | Owner / editor / viewer with real enforcement; viewer = read-only | Real collaboration control |
| Enterprise policy | One managed file forces AI allowlist + confidential + export rules | IT governs every seat; renderer can't bypass |
| Confidential AI mode | Server code only goes to company-approved AI providers | Data-residency answer for regulated teams |
| Export blocking + audit | Copy/export of protected code refused + logged; fraud webhook | Provable governance |
| Private ATOMIC Server | The whole stack on a dedicated box, $149/mo flat | Unlimited seats/workspaces on your hardware |
| Everything in the OS keychain | Every key/token/secret encrypted, never in files | Security by construction |

## Workflow tools
Multi-tab terminal · Docker compose (Up/Down/ps) · Problems panel (preview/AI/dev-server errors + Fix-with-AI) · Command palette (⌘⇧P) · Multi-window (⌘N, independent dev servers) · tabbed Settings (AI / API Keys / Editor / Extensions / About) · New-project templates.

---

*Full engineering history in `DEVLOG.md`. The 37-feature "AI-native OS" vision and where each item stands: `VISION-SCORECARD.md`. Community-sourced next bets: `IDEAS.md`.*
