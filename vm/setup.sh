#!/usr/bin/env bash
# Sets up the Dev Workspace builder on a fresh Ubuntu 22.04/24.04 VM (Oracle,
# a college machine, anything). Run once, as a user with sudo:
#
#   sudo bash vm/setup.sh
#
# Then fill /etc/devws-builder.env and: sudo systemctl enable --now devws-builder
# In XCEED's server/.env set DEVWS_RUNNER=poll and Pull & Deploy.
#
# What it installs: Node 22, yarn, git, Docker, cloudflared, and a service
# account "devws" that runs the builder. It creates the preview accounts
# xpreview1..xpreview4 and lets devws run only the commands previews need as
# root (useradd is not needed: the accounts exist).
set -euo pipefail

if [[ $EUID -ne 0 ]]; then echo "Run with sudo"; exit 1; fi
HERE="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL=/opt/devws-builder

apt-get update -y
apt-get install -y ca-certificates curl git iptables gnupg

# Node 22 + yarn
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
npm install -g yarn@1

# Docker (for the preview's throwaway MongoDB)
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi

# cloudflared (the preview's https link)
if ! command -v cloudflared >/dev/null; then
  ARCH=$(dpkg --print-architecture)
  curl -fsSL -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}.deb"
  dpkg -i /tmp/cloudflared.deb
fi

# The builder's own account.
id -u devws >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash devws
usermod -aG docker devws

# Preview accounts, one per slot. No login shell, nothing in their home.
for i in 1 2 3 4; do
  id -u "xpreview$i" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "xpreview$i"
done

# devws may run exactly these as root / as the preview accounts, nothing else.
cat > /etc/sudoers.d/devws-builder <<'EOF'
Defaults:devws !requiretty
devws ALL=(xpreview1,xpreview2,xpreview3,xpreview4) NOPASSWD: ALL
devws ALL=(root) NOPASSWD: /usr/sbin/iptables, /usr/sbin/ip6tables, /usr/bin/pkill, /usr/bin/chown, /usr/bin/rm, /usr/sbin/useradd
EOF
chmod 440 /etc/sudoers.d/devws-builder
visudo -c

# The program itself.
mkdir -p "$INSTALL"
cp -r "$HERE/run.js" "$HERE/package.json" "$HERE/src" "$INSTALL/"
chown -R devws:devws "$INSTALL"

if [[ ! -f /etc/devws-builder.env ]]; then
  install -m 600 -o devws -g devws "$HERE/vm/builder.env.example" /etc/devws-builder.env
fi
install -m 644 "$HERE/vm/devws-builder.service" /etc/systemd/system/devws-builder.service
systemctl daemon-reload

echo
echo "Done. Next:"
echo "  1. sudo nano /etc/devws-builder.env   (XCEED_URL, DEVWS_WORKER_SECRET, ORG_TOKEN)"
echo "  2. sudo systemctl enable --now devws-builder"
echo "  3. In XCEED server/.env: DEVWS_RUNNER=poll, then Pull & Deploy"
echo "  Logs: journalctl -u devws-builder -f"
