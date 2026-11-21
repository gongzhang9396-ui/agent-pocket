#!/usr/bin/env bash
set -euo pipefail
if [[ $# -lt 5 || $# -gt 6 || ${6:-} != "" && ${6:-} != --enable-web ]]; then
  echo "usage: $0 <release.tar.gz> <version> <sha256> <signature> <ed25519-public-key.pem> [--enable-web]" >&2; exit 2
fi
[[ $(id -u) -eq 0 ]] || { echo 'run as root' >&2; exit 2; }
source "$(dirname "$(readlink -f "$0")")/release-state.sh"
artifact=$(readlink -f "$1"); version=$2; signature=$(readlink -f "$4"); public_key=$(readlink -f "$5")
release_dir=$(release_path "$version")
expected_sha=$(printf '%s' "$3" | tr '[:lower:]' '[:upper:]')
[[ $expected_sha =~ ^[0-9A-F]{64}$ ]] || exit 2
for file in "$artifact" "$signature" "$public_key"; do [[ -f $file ]] || { echo "missing file: $file" >&2; exit 2; }; done
[[ $(sha256sum "$artifact" | awk '{print toupper($1)}') == "$expected_sha" ]] || { echo 'SHA-256 mismatch' >&2; exit 1; }
openssl pkeyutl -verify -pubin -inkey "$public_key" -rawin -in "$artifact" -sigfile "$signature" >/dev/null
install -d -m 0755 -o root -g root "$root_dir/releases"
exec 9>"$root_dir/deploy.lock"
flock -n 9 || { echo 'another Relay deployment is running' >&2; exit 1; }
[[ ! -e $release_dir && ! -L $release_dir ]] || { echo 'release already exists; use a new version' >&2; exit 1; }
python3 - "$artifact" <<'PY'
import sys, tarfile, pathlib
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for item in archive.getmembers():
        path = pathlib.PurePosixPath(item.name)
        if path.is_absolute() or '..' in path.parts or not (item.isfile() or item.isdir()):
            raise SystemExit('unsafe archive entry')
PY
install -d -m 0755 "$release_dir"
tar --no-same-owner -xzf "$artifact" -C "$release_dir"
for file in dist/cli.js dist/register-update.js admin/dist/index.html web/dist/index.html package-lock.json deploy/agent-pocket-relay.service deploy/register-update.sh deploy/release-state.sh deploy/rollback.sh deploy/deploy-release.sh; do
  [[ -f "$release_dir/$file" ]] || { echo "release incomplete: $file" >&2; exit 1; }
done
(cd "$release_dir" && npm ci --omit=dev --ignore-scripts)
old_target=$(readlink -f "$current_link")
[[ -f $old_target/dist/cli.js ]] || { echo 'existing Relay required; use bootstrap for first install' >&2; exit 1; }
backup_dir="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$version-$$"
stopped=0; backed_up=0; completed=0
on_exit() {
  local result=$?
  trap - EXIT INT TERM
  if [[ $completed -eq 0 && $stopped -eq 1 ]]; then
    echo "deployment failed; restoring previous release from $backup_dir" >&2
    if stop_relay && { [[ $backed_up -eq 0 ]] || restore_state "$backup_dir"; } && switch_release "$old_target" && systemctl daemon-reload && systemctl start "$service" && healthy_relay; then
      echo 'previous executable, configuration and database restored' >&2
    else echo 'RESTORE FAILED: service must remain stopped; inspect the saved backup' >&2; systemctl stop "$service"; fi
  fi
  exit "$result"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stop_relay
stopped=1
backup_state "$backup_dir" "$old_target"
backed_up=1
if [[ ${6:-} == --enable-web ]]; then
  env_file=/etc/agent-pocket-relay/relay.env
  sed -i '/^[[:space:]]*AGENT_POCKET_WEB_ENABLED=/d' "$env_file"
  printf '\nAGENT_POCKET_WEB_ENABLED=true\n' >> "$env_file"
fi
switch_release "$release_dir"
install -m 0644 "$release_dir/deploy/agent-pocket-relay.service" /etc/systemd/system/agent-pocket-relay.service
install -m 0755 "$release_dir/deploy/register-update.sh" /usr/local/bin/agent-pocket-register-update
systemctl daemon-reload
systemctl start "$service"
healthy_relay
completed=1
echo "Relay $version deployed. Rollback snapshot: $backup_dir"
echo 'Caddy and proxy services were left unchanged.'
