# Private ATOMIC Server — $149/month flat

A dedicated box running the full ATOMIC Workspaces stack for ONE company:
unlimited workspaces, unlimited teammates, your data on your hardware,
managed by ATOMIC.

## What it is
The exact same zero-dependency control plane (`atomic-workspaced.mjs`) +
stock sshd data plane that powers ATOMIC Cloud — on hardware reserved for
you (recommended: Hetzner AX41 or your own rack).

## Install (ATOMIC ops, ~10 minutes)
1. `./deploy-workspaced.sh root@customer-box` — installs node service +
   systemd unit + generates the OWNER key.
2. Front `127.0.0.1:8791` with caddy (`caddy reverse-proxy --from
   ws.customer.com --to 127.0.0.1:8791`) for TLS.
3. Hand the owner key to the customer admin; they invite their team from
   Studio (Workspaces → Team) with edit or view-only roles.
4. Optional: set `ATOMIC_WS_SUBSCRIBE_LINK` for self-serve seat upgrades,
   and drop `enterprise-policy.json` into each seat's Studio for managed
   AI/export rules.

## Included in the flat price
- Unlimited workspaces & team members (admin/manager/lead/dev/viewer roles)
- 30-min idle auto-suspend, 7-day trash recovery, snapshots/restore
- Audit trail + fraud webhook + confidential-AI enforcement
- Nightly encrypted off-box backups (ops runbook) and updates by ATOMIC
