#!/usr/bin/env bash
set -euo pipefail
[[ $# -eq 2 && $(id -u) -eq 0 ]] || { echo "usage (root): $0 <previous-version> <matching-backup-directory>" >&2; exit 2; }
source "$(dirname "$(readlink -f "$0")")/release-state.sh"
target=$(release_path "$1"); backup_dir=$(readlink -f "$2")
[[ -f $target/dist/cli.js ]] || { echo 'release does not exist' >&2; exit 1; }
exec 9>"$root_dir/deploy.lock"
flock -n 9 || { echo 'another Relay deployment is running' >&2; exit 1; }
validate_backup "$backup_dir"
[[ $(cat "$backup_dir/previous-target") == "$target" ]] || { echo 'backup does not match previous version' >&2; exit 1; }
original=$(readlink -f "$current_link")
stopped=0; saved=0; completed=0; rescue=""
on_exit() {
  local result=$?
  trap - EXIT INT TERM
  if [[ $completed -eq 0 && $stopped -eq 1 ]]; then
    echo "rollback failed; restoring pre-rollback state; rescue: $rescue" >&2
    if stop_relay && { [[ $saved -eq 0 ]] || restore_state "$rescue"; } && switch_release "$original" && systemctl daemon-reload && systemctl start "$service" && healthy_relay; then
      echo 'pre-rollback state restored' >&2
    else echo "RESTORE FAILED; service stopped; rescue: $rescue" >&2; systemctl stop "$service"; fi
  fi
  exit "$result"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
stop_relay
stopped=1
rescue="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-before-rollback-$$"
backup_state "$rescue" "$original"
saved=1
restore_state "$backup_dir"
switch_release "$target"
systemctl daemon-reload
systemctl start "$service"
if ! healthy_relay; then systemctl stop "$service"; echo "rollback health check failed; service stopped; rescue: $rescue" >&2; exit 1; fi
completed=1
echo "Relay and database restored to $1. Post-upgrade rescue snapshot: $rescue"
