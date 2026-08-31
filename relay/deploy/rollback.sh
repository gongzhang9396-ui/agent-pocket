#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! $1 =~ ^[0-9A-Za-z._+-]+$ ]]; then
  echo "usage: $0 <previous-version>" >&2
  exit 2
fi
if [[ $(id -u) -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi

target="/opt/agent-pocket-relay/releases/$1"
[[ -f "$target/dist/cli.js" ]] || { echo "release does not exist: $target" >&2; exit 1; }
systemctl stop agent-pocket-relay.service
ln -sfn "$target" /opt/agent-pocket-relay/current
systemctl start agent-pocket-relay.service
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health >/dev/null; then
    echo "Relay executable rolled back to $1. Database was not modified."
    exit 0
  fi
  sleep 1
done
echo "rollback health check failed" >&2
exit 1
