#!/usr/bin/env bash
# Shared by deploy-release.sh and rollback.sh; requires root and deploy.lock.
root_dir=/opt/agent-pocket-relay
data_dir=/var/lib/agent-pocket-relay
backup_root=/var/backups/agent-pocket-relay
current_link="$root_dir/current"
service=agent-pocket-relay.service
state_names=(relay.db relay.db-wal relay.db-shm relay.env service.unit register-update)
state_paths=("$data_dir/relay.db" "$data_dir/relay.db-wal" "$data_dir/relay.db-shm" /etc/agent-pocket-relay/relay.env /etc/systemd/system/agent-pocket-relay.service /usr/local/bin/agent-pocket-register-update)

valid_version() { [[ $1 =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,95}$ ]]; }
release_path() {
  valid_version "$1" || { echo 'invalid version' >&2; return 1; }
  local target="$root_dir/releases/$1"
  [[ $(readlink -m "$target") == "$target" ]] || { echo 'release path escapes root' >&2; return 1; }
  printf '%s\n' "$target"
}
stop_relay() {
  systemctl stop "$service" || return 1
  [[ $(systemctl show "$service" -p MainPID --value) == 0 ]] || return 1
  ! systemctl is-active --quiet "$service"
}
healthy_relay() {
  local i
  for i in {1..30}; do
    if systemctl is-active --quiet "$service" && curl --fail --silent --max-time 2 http://127.0.0.1:8790/health | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}
switch_release() { ln -s "$1" "$root_dir/current.pending.$$" && mv -Tf "$root_dir/current.pending.$$" "$current_link"; }
backup_state() {
  local dest=$1 previous=$2 i name path
  install -d -m 0700 -o root -g root "$dest" || return 1
  printf '%s\n' "$previous" > "$dest/previous-target" || return 1
  : > "$dest/state.manifest"
  for i in "${!state_names[@]}"; do
    name=${state_names[$i]}; path=${state_paths[$i]}
    if [[ -f $path && ! -L $path ]]; then
      cp -a -- "$path" "$dest/$name" || return 1
      printf 'present %s\n' "$name" >> "$dest/state.manifest"
    elif [[ ! -e $path && ! -L $path ]]; then printf 'absent %s\n' "$name" >> "$dest/state.manifest"
    else echo "unsupported state file: $path" >&2; return 1; fi
  done
  (cd "$dest" && { sha256sum previous-target state.manifest; while read -r present name; do if [[ $present == present ]]; then sha256sum "$name" || exit 1; fi; done < state.manifest; } > state.sha256) || return 1
  validate_backup "$dest"
}
validate_backup() {
  local dest=$1 i present name extra
  [[ -d $dest && ! -L $dest && $(readlink -f "$dest") == "$backup_root/"* ]] || return 1
  [[ -f $dest/state.sha256 && ! -L $dest/state.sha256 ]] || return 1
  (cd "$dest" && sha256sum --strict --check state.sha256 >/dev/null) || return 1
  i=0
  while read -r present name extra; do
    [[ -z $extra && $i -lt ${#state_names[@]} && $name == "${state_names[$i]}" ]] || return 1
    if [[ $present == present ]]; then [[ -f $dest/$name && ! -L $dest/$name ]] || return 1
    elif [[ $present != absent || -e $dest/$name || -L $dest/$name ]]; then return 1; fi
    i=$((i + 1))
  done < "$dest/state.manifest"
  [[ $i -eq ${#state_names[@]} ]]
}
restore_state() {
  local dest=$1 i=0 present name path
  validate_backup "$dest" || { echo 'backup validation failed; service remains stopped' >&2; return 1; }
  while read -r present name; do
    path=${state_paths[$i]}
    [[ ! -L $path ]] || return 1
    rm -f -- "$path" || return 1
    if [[ $present == present ]]; then cp -a -- "$dest/$name" "$path" || return 1; fi
    i=$((i + 1))
  done < "$dest/state.manifest"
}
