#!/usr/bin/env bash
# Sets up views-automation on a Debian/Ubuntu server.
# Run as root:  sudo bash deploy/install.sh
set -euo pipefail

APP_DIR=/opt/views-automation
APP_USER=views

echo "==> Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node 20 or newer first:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "  sudo apt install -y nodejs"
  exit 1
fi
node --version

echo "==> Creating service user"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
fi

echo "==> Installing to $APP_DIR"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/logs" ]; then cp -r "$APP_DIR/logs" "$APP_DIR/logs.bak" 2>/dev/null || true; fi
cp -r . "$APP_DIR/"
mkdir -p "$APP_DIR/logs" "$APP_DIR/shots"

echo "==> Installing dependencies"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Installing the browser and its system libraries"
npx playwright install --with-deps chromium

echo "==> Setting permissions"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Installing the systemd unit"
cp "$APP_DIR/deploy/views-automation.service" /etc/systemd/system/views-automation.service
systemctl daemon-reload
systemctl enable views-automation

echo
echo "Done. Now verify the page and selectors BEFORE going unattended:"
echo
echo "  sudo -u $APP_USER bash -c 'cd $APP_DIR && node zefame.js --check'"
echo
echo "That fills the form and checks all 9 selectors without clicking Get Now."
echo "If every line says OK, start the service:"
echo
echo "  sudo systemctl start views-automation"
echo "  sudo systemctl status views-automation"
echo "  tail -f $APP_DIR/logs/service.log"
echo
echo "The service is NOT started yet on purpose - run the check first."
