#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 5 ]]; then
  echo "usage: $0 <release.tar.gz> <version> <sha256> <signature> <ed25519-public-key.pem>" >&2
  exit 2
fi
if [[ $(id -u) -ne 0 ]]; then
  echo "run as root" >&2
  exit 2
fi

artifact=$(readlink -f "$1")
version=$2
expected_sha=$(printf '%s' "$3" | tr '[:lower:]' '[:upper:]')
signature=$(readlink -f "$4")
public_key=$(readlink -f "$5")
if [[ ! $version =~ ^[0-9A-Za-z._+-]+$ ]]; then
  echo "invalid version" >&2
  exit 2
fi
for file in "$artifact" "$signature" "$public_key"; do
  [[ -f $file ]] || { echo "missing file: $file" >&2; exit 2; }
done

actual_sha=$(sha256sum "$artifact" | awk '{print toupper($1)}')
[[ $actual_sha == "$expected_sha" ]] || { echo "SHA-256 mismatch" >&2; exit 1; }
openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin -in "$artifact" -sigfile "$signature" >/dev/null

root_dir=/opt/agent-pocket-relay
release_dir="$root_dir/releases/$version"
data_dir=/var/lib/agent-pocket-relay
backup_dir="/var/backups/agent-pocket-relay/$(date -u +%Y%m%dT%H%M%SZ)-$version"
current_link="$root_dir/current"
service=agent-pocket-relay.service
install -d -m 0755 -o root -g root "$root_dir/releases"
install -d -m 0700 -o agent-pocket-relay -g agent-pocket-relay "$data_dir"
install -d -m 0700 -o agent-pocket-relay -g agent-pocket-relay "$data_dir/updates"
install -d -m 0700 -o root -g root "$backup_dir"
exec 9>"$root_dir/deploy.lock"
flock -n 9 || { echo "another Relay deployment is running" >&2; exit 1; }

old_target=""
if [[ -L $current_link ]]; then old_target=$(readlink -f "$current_link"); fi
systemctl stop "$service" 2>/dev/null || true
find "$data_dir" -maxdepth 1 -type f \( -name 'relay.db' -o -name 'relay.db-wal' -o -name 'relay.db-shm' \) -exec cp -a -- '{}' "$backup_dir/" \;

rm -rf -- "$release_dir"
install -d -m 0755 "$release_dir"
tar -xzf "$artifact" -C "$release_dir"
[[ -f "$release_dir/dist/cli.js" && -f "$release_dir/dist/register-update.js" && -f "$release_dir/admin/dist/index.html" && -f "$release_dir/package-lock.json" ]] || {
  echo "release archive is incomplete" >&2
  exit 1
}
(cd "$release_dir" && npm ci --omit=dev --ignore-scripts)
ln -sfn "$release_dir" "$current_link"
install -m 0644 "$release_dir/deploy/agent-pocket-relay.service" /etc/systemd/system/agent-pocket-relay.service
install -m 0755 "$release_dir/deploy/register-update.sh" /usr/local/bin/agent-pocket-register-update
systemctl daemon-reload
systemctl enable --now "$service"

healthy=0
for _ in $(seq 1 30); do
  if curl --fail --silent --max-time 2 http://127.0.0.1:8790/health >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ $healthy -ne 1 ]]; then
  systemctl stop "$service" || true
  if [[ -n $old_target && -d $old_target ]]; then
    ln -sfn "$old_target" "$current_link"
    systemctl start "$service" || true
  fi
  echo "health check failed; executable symlink rolled back. Database backup: $backup_dir" >&2
  exit 1
fi

echo "Relay $version deployed. Database backup: $backup_dir"
echo "Caddy and all proxy services were left unchanged."
