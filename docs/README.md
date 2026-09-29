# ATOMIC Studio Documentation

This folder contains product specifications and the engineering architecture for ATOMIC Studio.

## Architecture guide

Start with [architecture/README.md](architecture/README.md). It explains the system boundaries, runtime processes, data flows, security model, deployment shape, and the distinction between the shipped local-first implementation and the proposed scalable cloud architecture.

- [Frontend architecture](architecture/frontend.md) — renderer composition, state ownership, IPC usage, accessibility, and UI testing.
- [Backend architecture](architecture/backend.md) — Electron main process, workspace control plane, SSH/Git data planes, API conventions, reliability, and observability.
- [Database schema](architecture/database-schema.md) — current file stores, target PostgreSQL schema, relationships, indexes, retention, and migration strategy.

## Design principles

Architecture changes must preserve these invariants:

1. Local projects work without an account or cloud service.
2. The renderer never receives filesystem privileges, API keys, or raw credentials.
3. Plan mode cannot write or spend; accepted edits have a restore point.
4. REST controls workspace lifecycle; SSH remains the remote editing data plane.
5. User-visible capability claims must be backed by working behavior and verification.

Product requirements remain in `apps/desktop/PRODUCT.md`; visual tokens and component rules remain in `apps/desktop/DESIGN.md`. When architecture changes shipped behavior, update those documents.
