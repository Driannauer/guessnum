#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    printf '%s\n' 'Run this script as root.' >&2
    exit 1
fi

app_source="$(cd "$(dirname "$0")/.." && pwd)"
runtime_source="$(command -v node)"
"$runtime_source" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'

install -d -m 0755 /opt/guessnum /var/www/guessnum /var/www/guessnum/public /var/www/guessnum/lib
install -d -o www-data -g www-data -m 0700 /var/lib/guessnum
# Keep the runtime outside /root so the service can use ProtectHome=true.
install -m 0755 "$runtime_source" /opt/guessnum/node
install -m 0644 "$app_source/server.mjs" "$app_source/package.json" "$app_source/package-lock.json" /var/www/guessnum/
install -m 0644 "$app_source/lib/game.mjs" /var/www/guessnum/lib/
install -m 0644 "$app_source/public/index.html" "$app_source/public/app.js" "$app_source/public/styles.css" "$app_source/public/favicon.svg" /var/www/guessnum/public/
npm ci --omit=dev --ignore-scripts --prefix /var/www/guessnum
install -m 0644 "$app_source/deploy/guessnum.service" /etc/systemd/system/guessnum.service
systemctl daemon-reload
systemctl enable guessnum.service
systemctl restart guessnum.service
printf '%s\n' 'Application installed. Check: systemctl status guessnum.service'
