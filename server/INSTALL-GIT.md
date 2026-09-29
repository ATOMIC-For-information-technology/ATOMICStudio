# Self-hosted git for ATOMIC Studio

Bare repositories on your own box, reached over **stock sshd**. No third-party
service, no daemon in the data path, and nothing to trust that you did not install.

## What the pieces are

| File | Runs where | Job |
| --- | --- | --- |
| `atomic-git-acl.mjs` | server | Who may read/write which repo. One source of truth. |
| `atomic-git-cert.mjs` | server | Reads and **verifies** the SSH certificate sshd accepted. |
| `atomic-git-shell.mjs` | server, as a forced command | The **only** thing an authenticated developer may run. |
| `hooks/pre-receive.mjs` | server, inside each bare repo | Refuses bad pushes before any ref moves. |
| `atomic-oidc.mjs` | server | Verifies company sign-in tokens. Zero dependencies, fails closed. |
| `atomic-workspaced.mjs` | server, `127.0.0.1:8791` | Control plane: create repos, manage members and keys, issue certificates. |

**The architecture rule, unchanged: REST is only the control plane, stock sshd is
the data plane.** The daemon never touches a pack file, and if it is down, clone
and push keep working — only new certificate issuance stops.

## Install

`./deploy-workspaced.sh root@yourbox.example` does everything below. Run
`./deploy-workspaced.sh --stage /tmp/x` first if you want to see the exact tree it
produces without touching a server.

On first installation the owner access key is generated on the server and stored in
`/etc/atomic-workspaced.env` (mode 0600). Retrieve it through your administrator session;
the deployment command does not print it. Re-running deployment preserves that entire
configuration file, including the owner key, custom SSH host and OIDC settings, and preserves
the existing CA. It restarts the control plane and checks that systemd reports it active.
Review configuration changes separately when upgrading an older installation.

```sh
# 1. ONE unprivileged account owning the data plane and the control plane alike.
#    /bin/bash, NOT /usr/sbin/nologin: sshd runs a forced command THROUGH the user's
#    login shell, so nologin refuses every git operation. Safety comes from the forced
#    command plus no-pty, which is how Gitea and GitHub do it too.
useradd --system --create-home --home-dir /home/git --shell /bin/bash git

# 2. ALL the code, in ONE directory. atomic-workspaced.mjs imports atomic-oidc.mjs,
#    atomic-git-acl.mjs and atomic-git-cert.mjs as SIBLINGS: installing the daemon on
#    its own makes it die on ERR_MODULE_NOT_FOUND before it ever binds a port.
install -d -m 0755 /usr/local/lib/atomic /usr/local/lib/atomic/hooks
install -m 0644 atomic-workspaced.mjs atomic-git-acl.mjs atomic-git-cert.mjs atomic-oidc.mjs /usr/local/lib/atomic/
install -m 0755 atomic-git-shell.mjs  /usr/local/lib/atomic/
install -m 0755 hooks/pre-receive.mjs /usr/local/lib/atomic/hooks/
printf '#!/bin/sh\nexport ATOMIC_GIT_CA_PUB=/etc/atomic/ssh-ca.pub\nexec /usr/bin/env node /usr/local/lib/atomic/atomic-git-shell.mjs "$@"\n' \
  > /usr/local/bin/atomic-git-shell && chmod 0755 /usr/local/bin/atomic-git-shell

# 3. data, owned by `git`. 2770 on the repository root is SETGID, so every object git
#    writes inherits the group and stays readable if a second account is added later.
install -d -m 0750 -o git -g git /srv/atomic
install -d -m 2770 -o git -g git /srv/atomic/git
install -d -m 0700 -o git -g git /home/git/.ssh
touch /home/git/.ssh/authorized_keys /srv/atomic/git-audit.log
chown git:git /home/git/.ssh/authorized_keys /srv/atomic/git-audit.log
chmod 0600 /home/git/.ssh/authorized_keys
chmod 0640 /srv/atomic/git-audit.log

# 4. the SSH certificate authority (see "Company sign-in" below).
install -d -m 0755 /etc/atomic
ssh-keygen -t ed25519 -N '' -C atomic-ssh-ca -f /etc/atomic/ssh-ca
chown git:git /etc/atomic/ssh-ca /etc/atomic/ssh-ca.pub
chmod 0600 /etc/atomic/ssh-ca      # private half: only the signer reads it
chmod 0644 /etc/atomic/ssh-ca.pub  # public half: sshd trusts it, not a secret
```

Then the unit (`atomic-workspaced.service` — `User=git`, `Group=git`,
`ExecStart=/usr/bin/node /usr/local/lib/atomic/atomic-workspaced.mjs`,
`ReadWritePaths=/srv/atomic /home/git/.ssh`) with:

```sh
ATOMIC_WS_TOKEN=$(openssl rand -hex 32)
ATOMIC_WS_ROOT=/srv/atomic
ATOMIC_GIT_ROOT=/srv/atomic/git
ATOMIC_GIT_AUTHORIZED_KEYS=/home/git/.ssh/authorized_keys
ATOMIC_GIT_SHELL_BIN=/usr/local/bin/atomic-git-shell
ATOMIC_GIT_HOOK=/usr/local/lib/atomic/hooks/pre-receive.mjs
ATOMIC_GIT_CA_KEY=/etc/atomic/ssh-ca
ATOMIC_GIT_CA_PUB=/etc/atomic/ssh-ca.pub
ATOMIC_GIT_EPOCHS=/srv/atomic/identity-epochs.json
ATOMIC_WS_SSH_HOST=git.company.internal
ATOMIC_WS_SSH_USER=git
```

**Why one Unix account.** The control plane creates the bare repositories that sshd's
forced command then serves, writes the generated `authorized_keys`, appends the audit
log, installs hooks and signs with the CA key. Splitting that across two accounts means
every repository the daemon creates is owned by an account that does not serve it — a
permissions failure that only appears on a real box.

Bind the daemon to `127.0.0.1` (the default) and put a TLS proxy in front of it.
Port 22 is the only thing that needs to face the team.

## Certificate authentication (recommended)

With OIDC configured (below), the control plane signs a short-lived certificate for each
signed-in seat and **`authorized_keys` is no longer needed at all**. Tell sshd to trust
the CA and to hand every login to the forced command:

```sshd_config
TrustedUserCAKeys /etc/atomic/ssh-ca.pub

Match User git
    AuthenticationMethods publickey
    ForceCommand /usr/local/bin/atomic-git-shell
    ExposeAuthInfo yes
    PermitTTY no
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitUserEnvironment no
```

The forced-command wrapper explicitly exports the trusted CA public-key path. SSH sessions
do not inherit the control plane's systemd `EnvironmentFile`; configuring the CA only there
leaves the Git authentication path unable to verify certificates. If you install the CA at
a custom location, update both the wrapper and sshd's trusted-CA setting.

### How the certified name and role reach the forced command

This is the part that is easy to get wrong, so it is spelled out.

1. **Authorisation to the shared account.** sshd matches a certificate's *principals*
   against the account being logged into. Every certificate therefore carries the login
   account (`git`) as a principal, alongside `<name>` and exactly one `role:<role>`. That
   is why **no `AuthorizedPrincipalsFile` is needed** — and why there is no per-person
   file to keep in step, which was the whole reason for moving to certificates.

2. **Identity into the process.** `ForceCommand` takes no `%`-tokens, so the name cannot
   arrive in `argv` the way it did under `authorized_keys`. `ExposeAuthInfo yes` makes
   sshd write the credential it accepted to a file and name it in `$SSH_USER_AUTH`. sshd
   writes that file *after* authentication succeeds; the client never chooses its contents.

3. **Re-verification.** `atomic-git-cert.mjs` parses the certificate wire format and
   **verifies the CA signature itself** before believing a single field. This is not
   belt-and-braces theatre: `$SSH_USER_AUTH` is an environment variable naming a path, and
   `ssh-keygen -L` *decodes* a certificate without checking who signed it. A certificate
   carries its own CA public key — which is public — so anyone can build one that prints
   your CA's fingerprint. Comparing fingerprints would prove nothing at all.

4. **Nothing from the client's environment.** `ATOMIC_GIT_USER` and `ATOMIC_GIT_ROLE` are
   *outputs* of `atomic-git-shell` (passed down to the pre-receive hook) and are deleted on
   entry. Do not add `ATOMIC_*` to `AcceptEnv`, and leave `PermitUserEnvironment no`.

Missing, malformed, expired, wrong-CA, wrong-principal or role-tampered certificates all
**fail closed**, with a message the client sees verbatim.

### Revocation is immediate, not eventual

Each certificate's key id is `atomic:<name>:<epoch>`. `<epoch>` is a counter in
`identity-epochs.json` (`{"alice": 0, "bob": 2}`), bumped by `DELETE /v1/team/<name>`.
`atomic-git-shell` refuses any certificate whose epoch is not the current one, so:

- **offboarding** takes effect at once rather than at `CERT_TTL`; and
- **reusing a name** cannot revive the previous holder — their still-valid certificate is
  one epoch behind, and their `authorized_keys` line was regenerated away by the same call.

`DELETE /v1/team/<name>` does all three things (drop the row, rewrite `authorized_keys`,
bump the epoch). It used to do only the first, which left a departed member's SSH key
working indefinitely — and, if the name was later reused, pointed that stale forced-command
line at the *new* person.

## Add a teammate

```sh
# invite (returns a REST token exactly once) …
curl -sX POST localhost:8791/v1/team -H "Authorization: Bearer $TOKEN" \
     -d '{"name":"alice","role":"dev","repos":["studio"]}'

# … then, ONLY on a server not using certificates, give their SSH key git access
curl -sX POST localhost:8791/v1/keys/alice -H "Authorization: Bearer $TOKEN" \
     -d '{"key":"ssh-ed25519 AAAA... alice@laptop","repos":["*"]}'

curl -sX POST localhost:8791/v1/repos -H "Authorization: Bearer $TOKEN" \
     -d '{"name":"studio"}'
```

`authorized_keys` is **generated, never hand-edited** — every line carries a forced
command naming its owner plus `no-pty,no-port-forwarding,no-agent-forwarding,
no-X11-forwarding,no-user-rc`. It is rewritten atomically, because a truncated
`authorized_keys` locks the whole team out, and it is regenerated on **every** membership
change including deletion.

## Creating repositories

`POST /v1/repos` is the **only** supported way to create one on a managed server, and the
desktop app uses it. The shared `git` account has no shell, so `ssh git@host git init
--bare …` is refused by the forced command — deliberately. Relaxing the allow-list to
permit it would hand every seat arbitrary remote execution to save one REST call.

The endpoint:

- **is atomic.** The repository is built in a temporary directory and `rename`d into place,
  so concurrent creates of the same name have exactly one winner and the losers get `409`.
  `existsSync` + `git init` was a check-then-act race in which the second caller silently
  adopted the first's repository.
- **is idempotent.** Send `Idempotency-Key: <uuid>`; a retry replays the original response.
- **installs the pre-receive hook, or fails.** A repository without it has no push gate at
  all — no secret scan, no blob limit, no protected branches, no author verification — and
  nothing would ever say so. A failed hook install rolls the creation back.
- **grants the creator access transactionally.** A `lead` or `dev` is scoped by their
  `repos` list, so the new name is added to it as part of the create. A caller with no team
  record is refused with `403 NO_MEMBER_RECORD` rather than handed a repository they cannot
  clone.

Standalone/BYO servers (your own box, your own shell, no control plane) keep the
`ssh … git init --bare` path. The desktop chooses between the two by whether the seat is
managed, and never blends them.

## Point Studio at it

Studio has a **Settings → Git server** tab; use it. On a managed seat the tab is read-only
and the catalogue comes from the control plane, server-filtered to what you may see.

Or use **Clone from URL…** with
`ssh://git@git.company.internal/srv/atomic/git/studio.git` — and mind the port: on a
non-default SSH port the URL must carry it (`ssh://git@host:2222/…`). `/v1/repos` returns
the correct URL per repository; prefer it over rebuilding one by hand.

## Roles

| Role | Reads | Writes | Creates repos | May push `main` |
| --- | --- | --- | --- | --- |
| `admin` | everything | everything | yes | yes |
| `manager` | **everything** | never | no | no |
| `lead` | scoped by `repos` | scoped by `repos` | yes (scoped, granted on create) | yes |
| `dev` | scoped by `repos` | scoped by `repos` | yes (scoped, granted on create) | no |
| `viewer` | scoped by `repos` | never | no | no |

Under certificates the role comes from the **certificate**, signed by the CA; `members.json`
still supplies the `repos` scope. Under `authorized_keys` both come from `members.json`.

A member with **no `repos` field sees nothing**. That is deliberate: an admin who forgets
the field should find a teammate locked out, not silently granted the whole server.
`manager` is the one exception, and it is a grant rather than an oversight: the role exists
to see everything and it never writes.

An unrecognised role name — including a miscased one like `Lead` — grants **nothing**.
There is no fallback to the weakest role, because a typo should lock one person out rather
than quietly hand access to every misconfigured entry.

## Company sign-in (optional, but required for certificates)

Without this section the server works as it always has: static bearer tokens and
`authorized_keys`. With it, Studio seats sign in against your own Keycloak and the server
issues **short-lived SSH certificates** instead of trusting a permanent key.

```sh
ATOMIC_WS_OIDC_ISSUER=https://id.company.internal/realms/atomic
ATOMIC_WS_OIDC_AUDIENCE=atomic-studio
ATOMIC_WS_OIDC_GROUPS=groups
ATOMIC_WS_OIDC_ROLES='{"eng-admins":"admin","eng-leads":"lead","eng":"dev","delivery":"manager"}'
ATOMIC_GIT_CA_KEY=/etc/atomic/ssh-ca
ATOMIC_GIT_CA_PUB=/etc/atomic/ssh-ca.pub
ATOMIC_GIT_CERT_TTL=8h
```

`POST /v1/cert` with `{"publicKey":"ssh-ed25519 AAAA…"}` returns a certificate whose key id
is `atomic:<name>:<epoch>` and whose principals are `git`, `<name>` and `role:<role>`.

An OIDC caller's identity comes from `preferred_username`, and it is the **same name** the
git ACL scopes by — so a person must exist in `members.json` to be given repositories, even
though their role comes from their groups. `/v1/repos` filters on that verified identity;
it previously resolved OIDC callers through a static-token lookup that could not match
them, so every OIDC seat saw an empty catalogue whatever its role.

The static owner token keeps working alongside OIDC, deliberately — an identity provider
outage must not lock an administrator out of their own server.

**The token's `alg` is never trusted.** Only asymmetric algorithms are accepted and the key
type must match, so neither `{"alg":"none"}` nor an `HS256` token signed with the public key
verifies. `server/atomic-oidc.mjs` carries the reasoning.

The CA must be **ed25519**. `atomic-git-cert.mjs` verifies its signatures with node's own
crypto and supports that one CA algorithm; anything else is refused rather than waved
through on a fingerprint comparison that proves nothing.

### Migrating an install that predates roles (2026-09-01)

The old names still work and are mapped, so nothing needs changing to keep serving:

    owner  ->  admin        editor ->  dev        viewer -> viewer

**One behaviour did change.** Before roles, anyone with write access could push straight to
`main`. An `editor` now maps to `dev`, and a dev is refused on protected branches. Anyone
who legitimately pushes to `main` needs `lead`:

```sh
# in members.json, for each such person
-  {"name":"alice","role":"editor","repos":["*"]}
+  {"name":"alice","role":"lead","repos":["*"]}
```

## What a push is refused for

**Content** — conflict markers (git's own `--check`, the same detector Studio uses at commit
time), hardcoded secrets, and blobs over `ATOMIC_GIT_MAX_BLOB` (10 MB default).

**History** — deleting or force-pushing a protected branch (`ATOMIC_GIT_PROTECTED`, default
`refs/heads/main,refs/heads/master`), and commits attributed to an address that is not one
of the pusher's verified `emails`.

**Everything new is inspected, not just the final tree.** Secrets are scanned on the *added
lines of every new commit*, and blob sizes over *every new object*. Adding a credential in
one commit and deleting it in the next does not help: the diff between the old and new tips
is empty, but the blob is in the pack forever and anyone who clones can read it. The gate
used to look only at that tip-to-tip diff.

**A push larger than the bound is refused, never half-checked.** Author verification used to
stop after 200 commits, which made "pad the push" a working bypass. It now verifies the whole
set, and a push over `ATOMIC_GIT_MAX_PUSH_COMMITS` (2000) or `ATOMIC_GIT_MAX_PUSH_OBJECTS`
(50000) is refused with a message telling you to push in smaller pieces.

There is deliberately **no typecheck or build here.** That needs a toolchain on the box and
turns a git server into a CI runner — a much larger thing to operate.

## Test it

```sh
npm run test:gitserver     # 45 checks
```

Most of it needs no network and no daemon: the suite points `GIT_SSH_COMMAND` at a two-line
script that exports `SSH_ORIGINAL_COMMAND` and execs the forced command — exactly what sshd
does — so a real `git clone` and `git push` travel the real gate, hooks and all.

The certificate checks go further and start a **real, unprivileged `sshd`** on a loopback
port with `TrustedUserCAKeys`, `ExposeAuthInfo` and `ForceCommand` configured exactly as
above, then clone and push through it with an issued certificate. That trio working together
is not something a unit test can reach. If no `sshd` binary is present, the suite reports
that check as skipped rather than passed.

## Member identity validation

New member names must contain 1–60 letters, digits, dots, underscores or hyphens, matching
the names supported by SSH access and member revocation. Invalid names are rejected instead
of silently shortened. Only documented roles and the legacy `owner`/`editor` aliases are accepted.

Certificate validity ends at its expiry timestamp. A malformed revocation ledger, including
an invalid individual counter, refuses authentication/issuance rather than treating that
identity as never revoked. A missing ledger still represents a fresh installation with epoch zero.
