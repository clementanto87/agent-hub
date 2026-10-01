#!/bin/bash
mkdir -p /root/agent-hub/data
LOG_FILE="/tmp/cloudflared_daemon.log"
URL_FILE="/root/agent-hub/data/tunnel_url.txt"

rm -f "$URL_FILE"

exec /usr/local/bin/cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate 2>&1 | while read -r line; do
    echo "$line" >> "$LOG_FILE"
    if [[ "$line" =~ https://[a-zA-Z0-9-]+\.trycloudflare\.com ]]; then
        URL="${BASH_REMATCH[0]}"
        echo "$URL" > "$URL_FILE"
        echo "[Tunnel Daemon] Established public HTTPS URL: $URL"
    fi
done
