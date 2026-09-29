#!/bin/sh
# Deploy the ATOMIC control plane + self-hosted git to any Linux box (a Hetzner CX22 is plenty).
#
#   ./deploy-workspaced.sh root@yourbox.example      # install over ssh
#   ./deploy-workspaced.sh --stage /tmp/staged       # lay the same tree out locally (no ssh)
#
# Then front port 8791 with your TLS proxy (caddy/nginx) and hand out the owner token.
#
# ── WHY EVERY MODULE, NOT JUST THE DAEMON ────────────────────────────────────────────────────────
# This script used to `scp` atomic-workspaced.mjs alone. That file imports ./atomic-oidc.mjs and
# ./atomic-git-acl.mjs as SIBLINGS, so the installed daemon could not start at all: it died on
# ERR_MODULE_NOT_FOUND before it ever bound a port, and nothing in the repo noticed because every
# test ran it from the source tree where the siblings happen to be there. The whole module set now
# lands in ONE directory, and `--stage` exists so the suite can start the daemon from the installed
# layout rather than from the checkout.
#
# ── WHY ONE UNIX USER ────────────────────────────────────────────────────────────────────────────
# `git` owns the repositories, the generated authorized_keys, the audit log, the hooks and the CA
# key, and the control plane runs AS `git`. Two accounts (one for the daemon, one for sshd's forced
# command) meant every repository the daemon created was owned by an account that does not serve
# it — a permissions failure that only shows up on a real box. Gitea makes the same choice for the
# same reason.
set -eu

LIB=/usr/local/lib/atomic
BIN=/usr/local/bin
ETC=/etc/atomic
SRV=/srv/atomic
HOME_GIT=/home/git
HERE="$(cd "$(dirname "$0")" && pwd)"

MODULES="atomic-workspaced.mjs atomic-git-acl.mjs atomic-git-cert.mjs atomic-git-shell.mjs atomic-oidc.mjs"

# ---------------------------------------------------------------- staging (local, no ssh)
# Lays out exactly the tree the remote install produces, under $2, without needing root or a box.
# The suite starts the daemon from here to prove the INSTALLED layout resolves its own imports.
if [ "${1:-}" = "--stage" ]; then
  DEST="${2:?usage: deploy-workspaced.sh --stage <dir>}"
  mkdir -p "$DEST$LIB/hooks" "$DEST$BIN"
  for m in $MODULES; do
    install -m 0644 "$HERE/$m" "$DEST$LIB/$m"
  done
  chmod 0755 "$DEST$LIB/atomic-git-shell.mjs"
  install -m 0755 "$HERE/hooks/pre-receive.mjs" "$DEST$LIB/hooks/pre-receive.mjs"
  # A wrapper script, not a symlink: sshd's ForceCommand wants one stable executable path, and a
  # wrapper survives being copied as well as linked.
  cat > "$DEST$BIN/atomic-git-shell" <<WRAP
#!/bin/sh
export ATOMIC_GIT_CA_PUB=$ETC/ssh-ca.pub
exec /usr/bin/env node $LIB/atomic-git-shell.mjs "\$@"
WRAP
  chmod 0755 "$DEST$BIN/atomic-git-shell"
  echo "Staged the install layout under $DEST"
  exit 0
fi

HOST="${1:?usage: deploy-workspaced.sh user@host   |   deploy-workspaced.sh --stage <dir>}"

# Ship the modules and the unit into a staging directory first, then move them into place with the
# right owner in one privileged step.
ssh "$HOST" "mkdir -p /tmp/atomic-deploy/hooks"
for m in $MODULES; do
  scp -q "$HERE/$m" "$HOST:/tmp/atomic-deploy/$m"
done
scp -q "$HERE/hooks/pre-receive.mjs" "$HOST:/tmp/atomic-deploy/hooks/pre-receive.mjs"
scp -q "$HERE/atomic-workspaced.service" "$HOST:/tmp/atomic-deploy/atomic-workspaced.service"

ssh "$HOST" "set -eu
  # 1. one service account, owning the data plane and the control plane alike.
  #    /bin/bash, NOT nologin: sshd runs a forced command THROUGH the login shell.
  id -u git >/dev/null 2>&1 || useradd --system --create-home --home-dir $HOME_GIT --shell /bin/bash git

  # 2. the code, all of it, in one directory so relative imports resolve.
  install -d -m 0755 $LIB $LIB/hooks
  for m in $MODULES; do install -m 0644 /tmp/atomic-deploy/\$m $LIB/\$m; done
  chmod 0755 $LIB/atomic-git-shell.mjs
  install -m 0755 /tmp/atomic-deploy/hooks/pre-receive.mjs $LIB/hooks/pre-receive.mjs
  printf '#!/bin/sh\\nexport ATOMIC_GIT_CA_PUB=$ETC/ssh-ca.pub\\nexec /usr/bin/env node $LIB/atomic-git-shell.mjs \"\\\$@\"\\n' > $BIN/atomic-git-shell
  chmod 0755 $BIN/atomic-git-shell

  # 3. data. 2770 on the repo root: setgid, so every object git writes inherits the group and a
  #    repository stays readable if a second service account is ever added.
  install -d -m 0750 -o git -g git $SRV
  install -d -m 2770 -o git -g git $SRV/git
  install -d -m 0700 -o git -g git $HOME_GIT/.ssh
  touch $HOME_GIT/.ssh/authorized_keys $SRV/git-audit.log
  chown git:git $HOME_GIT/.ssh/authorized_keys $SRV/git-audit.log
  chmod 0600 $HOME_GIT/.ssh/authorized_keys
  chmod 0640 $SRV/git-audit.log

  # 4. the SSH certificate authority. The private half is readable ONLY by the account that signs
  #    with it; the public half is what sshd trusts and is not a secret.
  install -d -m 0755 $ETC
  if [ ! -f $ETC/ssh-ca ]; then
    ssh-keygen -q -t ed25519 -N '' -C atomic-ssh-ca -f $ETC/ssh-ca
  fi
  chown git:git $ETC/ssh-ca $ETC/ssh-ca.pub
  chmod 0600 $ETC/ssh-ca
  chmod 0644 $ETC/ssh-ca.pub

  # An upgrade must not revoke the saved owner token or overwrite custom host/OIDC settings.
  if [ ! -f /etc/atomic-workspaced.env ]; then
    umask 077
    cat > /etc/atomic-workspaced.env << ENV
ATOMIC_WS_TOKEN=\$(openssl rand -hex 24)
ATOMIC_WS_ROOT=$SRV
ATOMIC_WS_HOST=127.0.0.1
ATOMIC_WS_SSH_HOST=\$(hostname -f)
ATOMIC_WS_SSH_USER=git
ATOMIC_GIT_ROOT=$SRV/git
ATOMIC_GIT_AUTHORIZED_KEYS=$HOME_GIT/.ssh/authorized_keys
ATOMIC_GIT_SHELL_BIN=$BIN/atomic-git-shell
ATOMIC_GIT_HOOK=$LIB/hooks/pre-receive.mjs
ATOMIC_GIT_CA_KEY=$ETC/ssh-ca
ATOMIC_GIT_CA_PUB=$ETC/ssh-ca.pub
ATOMIC_GIT_EPOCHS=$SRV/identity-epochs.json
ENV
  fi
  chown git:git /etc/atomic-workspaced.env
  chmod 0600 /etc/atomic-workspaced.env

  install -m 0644 /tmp/atomic-deploy/atomic-workspaced.service /etc/systemd/system/atomic-workspaced.service
  rm -rf /tmp/atomic-deploy

  # 5. sshd: trust the CA, and give the shared account nothing but the forced command.
  #    ExposeAuthInfo is what lets atomic-git-shell read the certificate sshd accepted;
  #    PermitUserEnvironment no is what stops a client naming itself through the environment.
  if ! grep -q 'ATOMIC managed' /etc/ssh/sshd_config; then
    cat >> /etc/ssh/sshd_config << SSHD

# --- ATOMIC managed: certificate auth for the shared git account ---
TrustedUserCAKeys $ETC/ssh-ca.pub
Match User git
    AuthenticationMethods publickey
    ForceCommand $BIN/atomic-git-shell
    ExposeAuthInfo yes
    PermitTTY no
    AllowAgentForwarding no
    AllowTcpForwarding no
    X11Forwarding no
    PermitTunnel no
    PermitUserEnvironment no
SSHD
    sshd -t && { systemctl reload ssh 2>/dev/null || systemctl reload sshd; }
  fi

  systemctl daemon-reload
  systemctl enable atomic-workspaced
  systemctl restart atomic-workspaced
  systemctl is-active --quiet atomic-workspaced
  systemctl --no-pager status atomic-workspaced | head -5
"
echo ""
echo "Deployed. Owner access key is stored on the server in /etc/atomic-workspaced.env."
echo "Existing server configuration and owner access key were preserved."
echo "Point Studio's ATOMIC server at: https://<your-tls-proxy-for>:8791"
