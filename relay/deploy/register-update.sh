#!/usr/bin/env bash
set -euo pipefail

if [[ $(id -u) -ne 0 ]]; then
  echo "run as root (normally through the restricted sudo rule)" >&2
  exit 2
fi
if [[ $# -ne 4 || $1 != --manifest || $3 != --signature ]]; then
  echo "usage: agent-pocket-register-update --manifest <path> --signature <path>" >&2
  exit 2
fi

update_root=/var/lib/agent-pocket-relay/updates
manifest=$(readlink -f -- "$2")
signature=$(readlink -f -- "$4")
[[ -f $manifest && -f $signature ]] || { echo "manifest or signature is missing" >&2; exit 2; }
[[ $manifest == "$update_root/"* ]] || { echo "manifest is outside the update root" >&2; exit 2; }
[[ $signature == "$manifest.sig" ]] || { echo "signature path must be <manifest>.sig" >&2; exit 2; }

exec /usr/bin/systemd-run --wait --pipe --quiet \
  --uid=agent-pocket-relay --gid=agent-pocket-relay \
  --working-directory=/opt/agent-pocket-relay/current \
  --property=EnvironmentFile=/etc/agent-pocket-relay/relay.env \
  /usr/bin/node /opt/agent-pocket-relay/current/dist/register-update.js \
  --manifest "$manifest" --signature "$signature"
