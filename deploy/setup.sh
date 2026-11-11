#!/usr/bin/env bash
# One-time server setup for an Ubuntu server (Oracle Cloud "Always Free").
# Safe to run again: every step checks what is already done.
#
# On the server, as the default "ubuntu" user:
#   bash setup.sh <public address>      e.g.  bash setup.sh 129-150-1-2.sslip.io
#
# It stops (and tells you what to do) at two points the first time:
#   1. after printing a GitHub "deploy key" to add to your repository
#   2. after creating /etc/ai-lead/env for you to fill in
# Run it again after each one.
set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" || "$DOMAIN" == http* || "$DOMAIN" == */* ]]; then
  echo "Usage: bash setup.sh <public address without https://>, e.g. 129-150-1-2.sslip.io"
  exit 1
fi

REPO="${REPO:-git@github.com:fayemirabelsemira/ai-lead-system.git}"
APP_USER=ailead
APP_DIR=/opt/ai-lead-system
ENV_DIR=/etc/ai-lead
ENV_FILE=$ENV_DIR/env

step() { printf '\n==> %s\n' "$*"; }
as_app() { sudo -u "$APP_USER" -H "$@"; }

step "System packages"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates gnupg \
  debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

step "Swap (small servers need it for npm install)"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

step "Node.js 24"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

step "Caddy (HTTPS in front of the app)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
    sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
    sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

step "Firewall: allow web traffic (80, 443)"
# Oracle's Ubuntu images block everything except SSH in iptables.
for port in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$port" -m state --state NEW -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 1 -p tcp --dport "$port" -m state --state NEW -j ACCEPT
  fi
done
sudo netfilter-persistent save

step "App user"
if ! id "$APP_USER" >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
fi

step "GitHub access (read-only deploy key)"
KEY=/home/$APP_USER/.ssh/id_ed25519
if ! sudo test -f "$KEY"; then
  as_app mkdir -p "/home/$APP_USER/.ssh"
  as_app chmod 700 "/home/$APP_USER/.ssh"
  as_app ssh-keygen -t ed25519 -N "" -C "ai-lead-server" -f "$KEY" >/dev/null
fi
sudo test -f "/home/$APP_USER/.ssh/known_hosts" && sudo grep -q github.com "/home/$APP_USER/.ssh/known_hosts" ||
  ssh-keyscan -t ed25519 github.com 2>/dev/null | as_app tee -a "/home/$APP_USER/.ssh/known_hosts" >/dev/null

if ! as_app git ls-remote "$REPO" >/dev/null 2>&1; then
  echo
  echo "GitHub does not know this server yet. Add this key to your repository:"
  echo "  GitHub -> ai-lead-system -> Settings -> Deploy keys -> Add deploy key"
  echo "  Title: oracle-server   (leave 'Allow write access' UNTICKED)"
  echo
  sudo cat "$KEY.pub"
  echo
  echo "Then run this script again."
  exit 0
fi

step "Download the code"
sudo mkdir -p "$APP_DIR"
sudo chown "$APP_USER:$APP_USER" "$APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  as_app git clone "$REPO" "$APP_DIR"
else
  as_app git -C "$APP_DIR" pull --ff-only
fi
as_app bash -c "cd '$APP_DIR/backend' && npm ci --omit=dev --no-audit --no-fund"

step "Settings file ($ENV_FILE)"
sudo mkdir -p "$ENV_DIR"
if ! sudo test -f "$ENV_FILE"; then
  sudo cp "$APP_DIR/deploy/env.production.example" "$ENV_FILE"
  sudo sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://$DOMAIN#" "$ENV_FILE"
fi
sudo chown root:"$APP_USER" "$ENV_FILE"
sudo chmod 640 "$ENV_FILE"
if sudo grep -Eq '=your-' "$ENV_FILE"; then
  echo
  echo "Fill in your settings (same values as your laptop's .env), save, then run this script again:"
  echo "  sudo nano $ENV_FILE"
  echo "Still to fill in:"
  sudo grep -E '=your-' "$ENV_FILE" | cut -d= -f1 | sed 's/^/  - /'
  exit 0
fi

step "Caddy site for $DOMAIN"
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl reload caddy || sudo systemctl restart caddy

step "App service"
sudo cp "$APP_DIR/deploy/ai-lead.service" /etc/systemd/system/ai-lead.service
sudo systemctl daemon-reload
sudo systemctl enable ai-lead >/dev/null
sudo systemctl restart ai-lead

step "Checking"
sleep 8
sudo systemctl --no-pager --lines=15 status ai-lead || true
if curl -fsS --max-time 20 "https://$DOMAIN/health" >/dev/null; then
  echo
  echo "Online: https://$DOMAIN/health answers."
  echo "Your form links are in the log:  sudo journalctl -u ai-lead | grep 'Form ('"
else
  echo
  echo "https://$DOMAIN/health does not answer yet. The certificate can take a minute."
  echo "Check:  sudo journalctl -u ai-lead -n 50   and   sudo journalctl -u caddy -n 50"
  echo "Also check the Oracle 'Security List' allows ports 80 and 443 (see docs/deploy-oracle.md)."
fi
