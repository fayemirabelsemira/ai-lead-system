#!/usr/bin/env bash
# Puts the newest code from GitHub on the server and restarts the app.
# On the server:  bash /opt/ai-lead-system/deploy/update.sh
# If the update includes a new file in supabase/migrations/, run it in the
# Supabase SQL Editor FIRST.
set -euo pipefail
APP_DIR=/opt/ai-lead-system

sudo -u ailead -H git -C "$APP_DIR" pull --ff-only
sudo -u ailead -H bash -c "cd '$APP_DIR/backend' && npm ci --omit=dev --no-audit --no-fund"
sudo cp "$APP_DIR/deploy/ai-lead.service" /etc/systemd/system/ai-lead.service
sudo systemctl daemon-reload
sudo systemctl restart ai-lead
sleep 5
sudo systemctl --no-pager --lines=10 status ai-lead
