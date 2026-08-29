#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root (for example: sudo bash provision-oci-relay.sh ...)." >&2
  exit 1
fi
if [[ "$#" -ne 3 ]]; then
  echo "Usage: provision-oci-relay.sh <domain> <public-key-file> <remote-port>" >&2
  exit 1
fi

domain="$1"
public_key_file="$2"
remote_port="$3"
tunnel_user="agentpocket"
caddy_file="/etc/caddy/Caddyfile"
state_dir="/etc/agent-pocket"
state_file="${state_dir}/relay.env"
begin_marker="# BEGIN AGENT POCKET RELAY"
end_marker="# END AGENT POCKET RELAY"

[[ "${domain}" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "Invalid domain." >&2; exit 1; }
[[ "${remote_port}" =~ ^[0-9]+$ ]] && (( remote_port >= 1024 && remote_port <= 65535 )) || {
  echo "Remote port must be between 1024 and 65535." >&2
  exit 1
}
[[ -f "${public_key_file}" ]] || { echo "Tunnel public key file not found." >&2; exit 1; }
[[ -f "${caddy_file}" ]] || { echo "Caddyfile not found." >&2; exit 1; }

public_key="$(tr -d '\r\n' < "${public_key_file}")"
[[ "${public_key}" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+([[:space:]].*)?$ ]] || {
  echo "Expected one Ed25519 public key." >&2
  exit 1
}

route_token=""
if [[ -f "${state_file}" ]]; then
  # This file is root-owned and only contains values written by this script.
  # shellcheck disable=SC1090
  source "${state_file}"
  if [[ "${RELAY_DOMAIN:-}" == "${domain}" && "${RELAY_PATH:-}" =~ ^/ap/[a-f0-9]{64}$ ]]; then
    route_token="${RELAY_PATH#/ap/}"
  fi
fi
if [[ -z "${route_token}" ]]; then
  route_token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
fi
relay_path="/ap/${route_token}"

if ! id "${tunnel_user}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${tunnel_user}"
fi
install -d -m 700 -o "${tunnel_user}" -g "${tunnel_user}" "/home/${tunnel_user}/.ssh"
authorized_keys="/home/${tunnel_user}/.ssh/authorized_keys"
printf '%s\n' "command=\"/usr/bin/false\",restrict,port-forwarding,permitlisten=\"127.0.0.1:${remote_port}\" ${public_key}" \
  > "${authorized_keys}"
chown "${tunnel_user}:${tunnel_user}" "${authorized_keys}"
chmod 600 "${authorized_keys}"

backup_file="${caddy_file}.agent-pocket.$(date -u +%Y%m%dT%H%M%SZ).bak"
cp --preserve=mode,ownership,timestamps "${caddy_file}" "${backup_file}"
candidate="$(mktemp /etc/caddy/Caddyfile.agent-pocket.XXXXXX)"
trap 'rm -f "${candidate}"' EXIT

rollback_caddy() {
  cp --preserve=mode,ownership,timestamps "${backup_file}" "${caddy_file}"
  command -v restorecon >/dev/null 2>&1 && restorecon -F "${caddy_file}"
  systemctl reload caddy || true
}

awk -v begin="${begin_marker}" -v end="${end_marker}" '
  $0 == begin { skipping = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
' "${caddy_file}" > "${candidate}"
cat >> "${candidate}" <<EOF

${begin_marker}
${domain} {
    @agent_pocket_bridge path ${relay_path}
    handle @agent_pocket_bridge {
        reverse_proxy 127.0.0.1:${remote_port}
    }
    respond 404
}
${end_marker}
EOF
chown --reference="${caddy_file}" "${candidate}"
chmod --reference="${caddy_file}" "${candidate}"

if ! caddy validate --config "${candidate}" --adapter caddyfile; then
  echo "Caddy validation failed; the live configuration was not changed." >&2
  exit 1
fi
mv "${candidate}" "${caddy_file}"
command -v restorecon >/dev/null 2>&1 && restorecon -F "${caddy_file}"
if ! systemctl reload caddy; then
  rollback_caddy
  echo "Caddy reload failed; the previous configuration was restored." >&2
  exit 1
fi

if ! systemctl is-active --quiet caddy; then
  rollback_caddy
  echo "Caddy did not remain active after reload; the previous configuration was restored." >&2
  exit 1
fi
install -d -m 700 -o root -g root "${state_dir}"
umask 077
cat > "${state_file}" <<EOF
RELAY_DOMAIN=${domain}
RELAY_PATH=${relay_path}
RELAY_PORT=${remote_port}
EOF

echo "AGENT_POCKET_WSS_URL=wss://${domain}${relay_path}"
