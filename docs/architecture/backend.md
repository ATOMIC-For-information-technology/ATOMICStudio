# Backend Architecture

## Local backend

`apps/desktop/src/main` is the trusted local backend. `index.ts` owns Electron lifecycle and IPC registration; feature modules own focused capabilities such as files, Git, workspaces, providers, memory, policy, and the agent loop. `src/shared` must remain IO-free because both Node and web TypeScript projects compile it.

Main-process rules:

- Validate all renderer input and constrain paths to the selected project root.
- Route writes through `fs-service` so snapshot and undo guarantees remain intact.
- Keep API keys in `keyvault`; return only availability flags to the renderer.
- Run the agent queue serially and gate commands through the safe-command policy.
- Store per-window resources by `webContents.id`; reserve module singletons for truly app-wide state.

## Remote platform

The reference server is `server/atomic-workspaced.mjs`. Its production evolution should remain a modular service with these internal modules:

| Module | Responsibilities |
|---|---|
| Identity | Bearer/OIDC validation, SSH certificate issuance, revocation epochs |
| Authorization | Team roles, repository scopes, protected-branch policy |
| Workspace | Create, start, stop, keepalive, delete, health |
| Repository | Catalog, create, recoverable delete, ACL integration |
| Snapshot | Schedule, create, list, restore, retention |
| Billing | Entitlements and subscription link/state; never card data |
| Audit | Append-only security and administrative events |

REST remains the lifecycle control plane. File reads/writes, terminals, previews, and Git traffic stay on SSH/Git protocols. This keeps the server API small and lets company-hosted workspaces use the same desktop editing engine.

### The data plane's identity (2026-09-05)

The shared `git` account authenticates with **SSH certificates**, not `authorized_keys`. The
control plane runs the CA; `sshd` gets `TrustedUserCAKeys` plus `ForceCommand` and
`ExposeAuthInfo yes`, and `atomic-git-shell` reads the certified name and role out of the
certificate sshd accepted — re-verifying the CA signature itself, because `$SSH_USER_AUTH`
is only a path in an environment variable and a certificate carries its own (public) CA key.
Client-supplied `ATOMIC_GIT_*` variables are deleted on entry; they are outputs of the forced
command, never inputs. Full reasoning in `server/INSTALL-GIT.md`.

Two consequences worth stating at this level:

- **Repository creation is a control-plane operation, never a remote command.** The shared
  account has no shell, so `ssh <host> git init --bare` is refused. Relaxing the forced
  command's allow-list to permit it would trade the entire data-plane security model for one
  REST call. The desktop uses `POST /v1/repos` on a managed seat and the SSH path only on a
  standalone/BYO server; the two are chosen by `identityRequired()` and never blended.
- **Revocation is a counter, not a wait.** Each certificate's key id carries the member's
  revocation epoch. Deleting a member bumps it, so old certificates stop verifying at once and
  a reused name cannot inherit the previous holder's access.

### Mutating-endpoint invariants

Beyond the `Idempotency-Key` convention below, `POST /v1/repos` is the reference for what a
create must do, and each item was a defect first:

- **Atomic.** Build in a temporary directory and `rename` into place. `existsSync` + `git init`
  is check-then-act: two concurrent callers both saw nothing, both created, and the second
  silently adopted the first's repository.
- **Mandatory side effects are mandatory.** The pre-receive hook install throws and rolls the
  creation back. Swallowing that failure produces a repository with no push gate — no secret
  scan, no blob limit, no protected branches — and nothing ever reports it.
- **Authorisation is transactional.** A role scoped by a `repos` list is granted the new name as
  part of the create, or refused with a policy code (`NO_MEMBER_RECORD`) before anything is
  built. Creating a repository the caller cannot then read is the worst of the three outcomes.
- **Filtering uses the verified identity.** `identityOf()` is the single answer to "who is
  calling"; a second, credential-specific helper resolved OIDC callers to an empty name and
  showed every OIDC seat an empty catalogue regardless of role.

## API conventions

All endpoints use `/v1`, JSON, bearer or OIDC authentication, and `x-atomic-proto: 1`. Rate
limiting is **per caller** (credential hash + source address) with a separate global ceiling; a
single shared bucket let one client exhaust the budget for the whole team. Return a stable error body: `{ "error": { "code": "WORKSPACE_NOT_FOUND", "message": "...", "requestId": "..." } }`. Mutating requests should accept `Idempotency-Key`; repeated creates return the original resource. Use cursor pagination for collections once needed.

Core resources include `/v1/me`, `/v1/team`, `/v1/repos`, `/v1/keys/:member`, `/v1/cert`, and `/v1/workspaces`. Workspace subresources include `start`, `stop`, `keepalive`, and `snapshots/:snapshotId/restore`.

## Async work and reliability

Provisioning, snapshot creation, deletion cleanup, and webhooks should enqueue jobs in PostgreSQL first; workers claim jobs with `FOR UPDATE SKIP LOCKED`. Use bounded exponential backoff, record attempts, and dead-letter terminal failures. Start/stop and delete operations must be idempotent. Health checks should separate API health, database readiness, worker lag, and host capacity.

## Observability and deployment

Emit structured logs with request ID, actor ID, workspace ID, action, duration, and result—never tokens, keys, prompts, or source code. Track request latency/error rate, provisioning duration, worker lag, SSH connection failures, active workspaces, disk pressure, and snapshot failures. Alert on sustained authentication failures, queue age, capacity thresholds, and audit-write failures.

Deploy the API and workers as separate processes behind TLS. PostgreSQL is the authority for shared metadata; object storage holds snapshots; workspace hosts mount isolated volumes and expose SSH only through a controlled network path. Back up and regularly restore-test both PostgreSQL and snapshot metadata.
