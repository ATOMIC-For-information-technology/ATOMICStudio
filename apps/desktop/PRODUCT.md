# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences, served by **one core with two personalities** — not by one UI trying to please both (position taken by Mohamed, 2026-08-06):
- **Builder Mode** — for non-coders (the founding use case, and the product's own primary user, who has zero coding experience). What they want is chat, preview, deploy, and never seeing code: zero-jargon language, safety by default, never a raw stack trace.
- **Developer Mode** — for professional developers. What they want is speed, shortcuts, keyboard control, git and debugging, at full density with no dumbing-down.

The earlier premise — one interface serving both equally — is **rejected**: the two audiences want close to two different products, and a single UI ends up serving neither. The shared core (agent, index, memory, safety, preview) is identical; the surface differs. **Both modes ship as of 2026-08-09** (`src/shared/mode.ts` is the single table of what each one shows; the main-process menu reads the same table, so nothing hidden stays reachable by menu or shortcut). Builder Mode hides rather than closes — open files and unsaved typing survive a round trip. The choice is a status-bar chip, Settings ▸ Mode, and a one-time dismissible line; it is stored in the main process, so a second window and the shared menu bar can never disagree with it.

## Product Purpose

An AI-native IDE (Electron desktop app) that lets someone describe a change in plain English and get a real, reviewable code edit — with an AI agent that plans, edits, and verifies its own work, a live multi-device preview (desktop/iPhone/iPad + real iOS Simulator), and click-to-edit-in-the-running-app. Success is a working change landing safely, with the user never seeing an unrecoverable mistake.

## Positioning

Positioned directly against Cursor, Windsurf, Replit, Bolt.new, v0, and Lovable (competitor pain points researched and documented in `ROADMAP.md`, July 2026), with a mechanism those tools don't have:
- **Zero metering** — no credit anxiety; free-tier model access + bring-your-own-key, not a quota that evaporates mid-task.
- **Can't hurt you** — every edit is a reviewable diff by default (not autopilot), a snapshot/undo system independent of the user's real git, and an explicit Plan mode that proposes without touching disk.
- **Self-healing** — runtime errors in the live preview are caught and auto-repaired so a non-coder never sees a stack trace.
- **Full-stack + model-agnostic** — not locked to one backend (unlike Lovable/Supabase) or frontend-only (unlike v0).
- **Calm, stable UI** — deliberately does not rearrange itself on the user week to week, unlike the churn competitors are criticized for.

## Operating Context

Runs as a local-first Electron desktop app (macOS primary/verified; Windows readiness work done but not yet run on real Windows hardware). Optionally connects to "ATOMIC Cloud" or a self-hosted workspace server (`server/atomic-workspaced.mjs`) for remote/cloud dev workspaces — opt-in, not required for core use. AI provider is user-selectable (cloud providers via API key, or a fully local/air-gapped Ollama model with zero outbound traffic).

## Capabilities and Constraints

- Monaco-based editor, file tree, tabs, multi-device live preview, click-to-edit in the running app, an AI agent with staged-diff approval (Build mode auto-applies with undo; Plan mode proposes only), self-healing auto-fix, project-wide semantic index for cross-file awareness and Search Everywhere.
- Air-Gapped Mode: a real, working toggle that collapses all AI providers to local-only and blocks outbound AI traffic entirely.
- No user-account/login system exists yet (confirmed 2026-08-05) — only per-provider API keys and an optional per-forge personal-access-token field. Real multi-provider login (Google/GitHub/email) is a known, explicitly deferred future capability, not yet built.
- **Git is forge-neutral, and self-hosted comes first (built 2026-08-31; GitLab added 2026-09-06).**
  The Git panel talks to a `Forge` - a source of repositories - and ships three: a self-hosted
  **ATOMIC Server**, **GitHub**, and **GitLab** (gitlab.com or a company's own instance, which are
  the same v4 API and therefore one implementation, not two).
  Self-hosted is listed first and "Clone from URL..." is always available, so a bare
  repo reached over `ssh://` needs no forge at all. Clone/push/pull take a plain URL and have no
  idea which forge produced it. The self-hosted path stores **no token**: its data plane is stock
  sshd, so the user's own SSH key is the credential and Studio never reads or forwards it.
  **A token now reaches only the host it belongs to (2026-09-06).** The `GIT_ASKPASS` bridge routes
  by the host git names in its own prompt, so a push to GitLab presents the GitLab token and not
  whichever one happened to be stored. With a single token configured the previous behaviour is
  kept, which is what lets GitHub Enterprise and self-hosted GitLab keep working unconfigured; with
  two or more, an unrecognised host is refused rather than guessed, because guessing sends one
  forge's credential to another's server.
  In the editor: real staging (staged and unstaged are separate lists, because
  `git status --porcelain` is positional and the old code trimmed that away), branches with
  ahead/behind, fetch, merge, and conflict resolution driven by `shared/conflicts.ts` - which
  understands diff3's `|||||||` base section, so ancestor code never survives a "resolve".
  A commit containing conflict markers is refused before it can reach a shared branch.
  The self-hosted server is now **built** (`server/`, completed 2026-09-05): bare-repo hosting,
  a role ACL, a mandatory pre-receive gate and server-side push verification, with a REST control
  plane that never touches a pack file. See the two entries below.
- **The self-hosted git server is real, and its identity is a certificate (completed 2026-09-05).**
  `server/` is a zero-dependency reference implementation: bare repositories served by **stock
  sshd** through a forced command that speaks exactly three git verbs, a role table
  (`admin · manager · lead · dev · viewer`) enforced server-side, a mandatory `pre-receive` gate,
  and a REST control plane for lifecycle only. A signed-in seat receives a **short-lived SSH
  certificate** whose principals carry the person and the role, so there is no `authorized_keys`
  file to keep in step and revoking someone takes effect immediately rather than at expiry — the
  certificate's key id carries a revocation counter that a deleted member's certificate can never
  match again, which is also what stops a reused username inheriting the previous holder's access.
  Studio wires that certificate into every SSH and git operation (clone, fetch, pull, push) and
  **never reads, stores or transmits a private key** — it names the key to `ssh`, nothing more.
  What the push gate refuses: conflict markers, hardcoded secrets, oversized blobs, force-pushing
  or deleting a protected branch, and commits wearing someone else's name. It inspects **every
  object the push introduces**, not the diff between the old and new tips, so adding a credential
  in one commit and deleting it in the next does not get it through; a push too large to verify
  within the configured bound is refused rather than partially checked. Deliberately **not** built:
  any typecheck or build step on the server, which would turn a git server into a CI runner.
- **Publishing a folder uses the server's own API on a managed seat (2026-09-05).** "Publish this
  folder…" turns a plain directory into a repository. On your **own** box that is literally
  `ssh <host> git init --bare <dir>`, and Studio shows you the command before running it. On a
  **company-managed** server it is an authenticated `POST /v1/repos` instead, because the shared
  git account there has no shell to run a command in — and the confirm screen says so rather than
  showing a command that would be refused. Creation on that path is atomic (two people racing for
  the same name produce one repository and one clear refusal, never two), installs the push gate
  or fails, and grants a scoped creator access to what they just made — or refuses with a reason,
  rather than handing back a repository they cannot clone.
- **Source Control is a focused sidebar view, not a stack of forms (rebuilt 2026-09-02).** It lives
  in the LEFT sidebar as an activity-bar view (the branch icon, ⌘⇧G, View ▸ Source Control) — VS
  Code's slot, and the tall narrow column a change list and a pinned commit box want; the bottom
  panel no longer has a Git tab. It is VS Code's Source Control *interaction model* over ATOMIC's
  own engine: a 22px header (branch
  picker, ahead/behind, refresh / fetch / pull / push-or-publish, overflow), attention strips only
  when they apply (merge in progress, no remote, git-ignored folder), a **pinned commit composer**
  (⌘Enter commits; a disabled Commit says why, in words; "Commit all" is a separate explicit menu
  entry and never the default), and ONE windowed list of Staged / Changes / Merge Conflicts /
  History rows with full keyboard operation - arrows, Shift-range, ⌘-click, Enter for the diff,
  Space to stage or unstage, ⌘Enter to open, Backspace to discard (confirmed, and recoverable
  through Undo), a context menu, and Stage-all / Unstage-all on the section headers. The diff pane
  is **exact**: a staged row shows index↔HEAD, an unstaged row shows working-tree↔index, an
  untracked file shows the whole file, a conflicted file reports its remaining hunks and hands off
  to the editor - and an `MM` file appears in both lists with a different diff under each. Status
  is read with **one git process** per refresh (`status --porcelain=v2 --branch -z`, so renames,
  unusual filenames, upstream and divergence are exact), through a coordinator that debounces
  watcher bursts, keeps one request in flight and drops stale results; branches, history and
  remotes are loaded only when opened and cached behind the `.git` files that define them. A
  thousand changed files mount about thirty rows, and counts say when git's output was cut off.
  Cloning and server setup live in the empty state and the overflow menu. The row list is scoped
  to the opened folder; a commit that would also include files staged elsewhere in the repository
  says so beside the count.

- **Insight is a workspace view with four destinations (rebuilt 2026-09-03).** It left the bottom
  panel — which keeps the short, continuously-updating tools (Activity, Problems, Changes,
  Workspaces, Terminal) — for the editor area, where Extensions and Settings already live. It is not
  a file: no path, no dirty indicator, no save, no Monaco. **Overview** answers is-my-work-saved,
  is-it-shippable, what-next and what-is-this, with ONE verdict rather than the three competing
  scores it replaced. **Review** runs five checks — security, dependencies, run doctor, design,
  tests/debt — as one workflow, each with six honest states in which *not checked* can never be
  mistaken for *passed*, and each stating what it actually read. **Code Map** holds everything
  rebuildable from the code and git history (entry points, modules, dependencies, related-file
  search, and behind disclosure: drift, fragile files, cycles, unused files, ownership, cross-repo).
  **Memory** holds what reading the code could never tell you — goals, rules, forbidden changes,
  decisions — with AI history and Development Replay beneath it. Decisions are a memory KIND, not a
  separate product: the main process already folded `decisions.json` into the memory list, so the
  old separate section was the same rows twice; old records are still read, and nothing was
  migrated or discarded. Loading is staged per destination (Overview costs four IPC calls, not the
  fourteen the drawer fired on open) behind a generation guard, so a fast project switch cannot
  show the previous project's findings. Every analysis engine and every pure fold is reused
  unchanged, and no IPC channel was added.
- **The Explorer is a real IDE file tree, with a real file-icon theme (rebuilt 2026-09-02).**
  VS Code's Explorer geometry and interaction model over ATOMIC's palette: 22px rows, a 16px icon
  slot, 8px indents, square full-bleed rows, and header actions (New File, New Folder, Refresh,
  Collapse All) that stay hidden until hover. Keyboard-first — arrows, →/← to expand and collapse
  or step to the parent, Enter/Space to open, F2 to rename inline, ⌫ for the existing safe delete,
  type-to-jump, and a right-click context menu. The tree is a **normalised model**: listings are
  cached per folder, read only when a folder opens, projected into a windowed row list (about
  thirty mounted rows for a 20,000-row projection), and invalidated per-folder by the file
  watcher, so expansion, selection and focus survive a refresh and stale reads can never overwrite
  current data. **`node_modules`, `dist`, `build` and `out` are now VISIBLE** and collapsed, like
  every other IDE — the Explorer has its own VS Code-style exclusion list (`.git`, `.svn`, `.hg`,
  `.DS_Store`, `Thumbs.db`), kept separate from the stricter list the indexing, security and
  delete-preview scans still use. Git status shows as a trailing decoration from ONE snapshot per
  change, never a git command per row. Symlinks are identified and never followed.
- **File-icon themes are DATA, and that is the whole extension story for them.** The bundled
  default is **Seti**, vendored from VS Code's `theme-seti` extension at a pinned commit (Seti UI
  © 2014 Jesse Weed, MIT; upstream notices kept verbatim beside the assets) — a local WOFF and a
  generated mapping module, so **no icon is ever fetched at runtime**. The importer for further
  themes accepts theme JSON with local SVG/PNG/font assets only, and refuses — by name, with a
  reason — anything carrying scripts, commands, activation events, contribution points, absolute
  or traversing asset paths, remote URLs, or more assets than the limit. **This is not a VS Code
  extension host and does not claim to be one:** a `.vsix` still does not install, exactly as the
  line below says.
- **Extensions ARE installable (built 2026-08-06), via MCP connectors.** An extension is a folder with an `atomic-extension.json`, installed from a local folder, an https GitHub URL, or a curated registry ATOMIC publishes. `kind: 'mcp'` registers an MCP server whose tools the agent can call. The safety model is the app's existing one, not a new one: a connector arrives **disabled**, its tool list is shown before it is enabled, **each tool is approved individually**, every call is audited, and Air-Gapped Mode disables all of it. Installing from a URL states in plain words that it runs someone else's code with the user's file permissions.
- **Not supported, deliberately: VS Code `.vsix` extensions.** Implementing a slice of that API would mean most `.vsix` files install and then half-work — the "never claim what the app can't back up" rule applies hardest here. If it is ever done, it ships as a stated compatibility list, never as "VS Code extensions work". **The 2026-09-02 Source Control rebuild does not move this line:** it borrows VS Code's *interaction model* (row geometry, keyboard rules, the pinned composer) and nothing else — no `vscode` API surface, no activation events, no contribution points, no SCM-provider extension API. What stays extension-ready is ATOMIC's own seam: the `Forge` interface behind the clone sheet and the remote strip, which is where a third source of repositories would plug in.
- **Themes (built 2026-08-18) — eight built-in, plus VS Code colour-theme `.json` import.** `src/shared/theme.ts` is the engine: a theme is authored as a ~20-value seed and the full ~90-token workbench map is derived by rule, including every status text colour, which is walked away from its surface until it measures 4.5:1 — so a theme cannot be authored below the contrast floor. One theme paints all three engines (workbench CSS custom properties, Monaco, xterm's sixteen ANSI slots). The picker is VS Code's `Preferences: Color Theme` quick pick, previewing live on arrow-key and restoring on Escape; ⌘K ⌘T, the command palette, View ▸ Appearance, or the Extensions view. **Importing a VS Code colour theme is data, not code, and does not weaken the `.vsix` line above:** a `.json` colour theme is a list of hex values, nothing in it executes, and the importer states plainly when a file is a manifest rather than a theme instead of half-applying it. A theme pack installed as an extension (`kind: 'theme'`) is rejected if it also carries a `command`.
- **The workbench wears VS Code's geometry (2026-08-18).** 35px title bar with a centred command centre, 48px activity rail with the 2px active edge, 22px section headers, 35px tabs whose active tab is the editor surface continuing upward under a 1px accent, 22px list rows, 22px status bar, 2px control radius, square chrome, themed scrollbars/selection/caret. Two documented divergences from VS Code: the focus ring stays 2px (a contrast finding this repo already fixed) and shadows keep an offset (DESIGN.md's Altitude Rule). The Extensions view is VS Code's shape — search, collapsible sections with counts, icon-tile rows, and a detail page in the editor area with per-tool approval — over this product's real model: MCP connectors, colour themes, Studio's own built-in features, and the curated registry. Nothing in it implies a `.vsix` will install. **The bottom panel spans the editor area only (2026-09-02)** — VS Code's default panel alignment — so the Explorer and the agent dock run the full height of the window beside it rather than being cut off at whatever is open at the bottom; the integrated terminal lists its shells down its own right-hand edge, with per-shell kill and an overflow menu carrying only actions this app has (no shell profiles, no split panes, because it has neither).
- **Project Memory (built 2026-08-06) — infrastructure, not a feature.** Every project keeps durable knowledge that survives restarts: goals, decisions, conventions, design and business rules, known bugs, debt, important files, previous AI decisions, preferences, forbidden changes, pending work and ideas. The agent loads the *relevant* parts before every task via budgeted retrieval (never a dump), and can write to memory itself while working. It is stored per project in app data and, optionally, as a committed `ATOMIC-MEMORY.md` so a team shares it. **The boundary that keeps it honest:** the semantic index holds what is derivable from code and can be rebuilt; memory holds only what re-reading the repo could never tell you.
- **AI Build Receipt (built 2026-08-09) — the signature feature.** Every run ends with measurements rather than a paragraph: the files it changed with per-file line and **byte** deltas, how many syntax checks ran and passed, wall-clock duration, tokens spent *by that run*, a read-first confidence figure, a screenshot of the change working, and a **restore point that undoes the entire run in one click**. Deliberately absent: performance and bundle deltas — measuring either honestly needs the project's build and a benchmark, and a number the app cannot stand behind would undermine every number beside it.
- **The agent can use the app it just built.** `preview_click` / `preview_type` / `preview_snap` drive the live preview, and a finished run hands back a receipt: the summary plus a screenshot of the change actually working. This is the deliberate answer to competitors that narrate what an agent did — Studio shows it.
- **Local models are first-party, and stay that way (decided 2026-08-05).** On-device models run through Ollama, which the user installs separately: Studio detects it, states what's installed, offers the install command when it's missing, can start its server, and streams `ollama pull` — for **0 MB** added to the app, since the runtime is external and weights live in `~/.ollama`. Bundling a runtime (node-llama-cpp) would add ~80–150 MB plus per-platform native binaries on top of an app that is already 816 MB (675 MB of that being Electron/Chromium, which is not ours to shrink). Shipping this as a GitHub-pulled extension was considered and rejected: there is no extension host, building one is a project in itself, and running third-party code inside an IDE that edits the user's files is a supply-chain risk the product's safety promise can't casually take on.

## Brand Commitments

Name: **ATOMIC Studio**. Part of the ATOMIC Group product family (atomic.limited). "ATOMIC Cloud" is the named paid tier ($9/mo flat, "Zero-Surprise Billing" — the AI pauses at a spend cap instead of running past it; positioned explicitly against competitors' opaque/surprise billing).

## Evidence on Hand

- `FEATURES.md` — full shipped-feature list, each marked test-covered (69 UI test steps + headless checks as of 2026-08, zero-API-cost via a mock provider in CI).
- `ROADMAP.md` — sourced competitor pain-point research (Cursor, Windsurf, Replit, Bolt.new, v0, Lovable; July 2026) mapped 1:1 to this product's answers.
- `DEVLOG.md` — dated, ongoing engineering log; every entry states what was verified (typecheck/build/test suite) before being called done.
- Recently shipped and verified this session: a "Mission Control" redesign of the AI agent's side panel (reviewed by an independent multi-lens pass covering architecture, accessibility, and adversarial bug-hunting; Critical/High findings fixed), a VS Code-style left activity bar (Explorer/Search/Extensions/CLI/Settings/Profile), and the workbench-geometry + theme-engine work described above (typecheck + build clean; verified on screen across all eight themes).

## Product Principles

1. **Never fake a signal.** No UI element claims something the app can't actually back up — established discipline, enforced throughout `DEVLOG.md` and this session's own design review.
2. **Safety is the default, not an opt-in.** Diff-approval, undo, Plan mode, and snapshotting exist so a non-coder can never be hurt by an unreviewed change.
3. **Serve non-coders and professionals as equals.** Simplicity for one audience must never come at the cost of real capability for the other.
4. **Calm over churn.** The UI does not rearrange itself gratuitously; changes are deliberate and tested, not weekly novelty.
5. **Zero metering, zero surprise cost.** No credit-anxiety UX pattern anywhere in the product.

## Accessibility & Inclusion

No formally adopted standard (e.g. WCAG level) is recorded yet — undecided, not absent by intent. A recent accessibility review of the Agent Panel surfaced and fixed real gaps (keyboard-inaccessible controls, missing `aria-expanded`/`aria-modal`, reduced-motion coverage) — that bar (keyboard-operable, screen-reader-honest, motion-respecting) is the working standard until a formal one is confirmed.
