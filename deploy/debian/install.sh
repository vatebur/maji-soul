#!/bin/bash
# Run as root after copying the project to /opt/maji-soul. Existing secrets/profile/data are preserved.
set -euo pipefail
mode=${1:-install}
test "$mode" = install || test "$mode" = --prepare-only || { echo 'Unknown install mode.' >&2; exit 1; }
test "$(id -u)" = 0 || { echo 'Run this installer as root.' >&2; exit 1; }
. /etc/os-release
test "${ID:-}" = debian && test "${VERSION_ID:-}" = 13 || { echo 'Debian 13 is required.' >&2; exit 1; }
cd /opt/maji-soul
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git build-essential pkg-config libssl-dev \
  chromium xvfb ffmpeg pipewire-pulse wireplumber dbus-user-session libpam-systemd fonts-noto-cjk x11vnc
id maji-soul >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/maji-soul --shell /bin/bash maji-soul
for device_group in render video; do
  if getent group "$device_group" >/dev/null; then usermod -a -G "$device_group" maji-soul; fi
done
install -d -m 0750 -o maji-soul -g maji-soul /etc/maji-soul /opt/maji-soul/data /var/lib/maji-soul/chromium

node_version=$(sed -n 's/.*"node": "\([0-9.]*\)".*/\1/p' package.json)
test -n "$node_version" || { echo 'Expected a pinned Node version in package.json.' >&2; exit 1; }
case "$(dpkg --print-architecture)" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
if ! test -x runtime/bin/node || test "$(runtime/bin/node --version)" != "v$node_version"; then
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  archive="node-v${node_version}-linux-${node_arch}.tar.xz"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v${node_version}/${archive}" -o "$stage/$archive"
  curl --fail --location --retry 3 "https://nodejs.org/dist/v${node_version}/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
  (cd "$stage"; awk -v file="$archive" '$2 == file { print }' SHASUMS256.txt | sha256sum --check --strict -)
  mkdir -p runtime
  tar -xJf "$stage/$archive" --strip-components=1 -C runtime
fi
export PATH="/opt/maji-soul/runtime/bin:$PATH"
if test "$mode" != --prepare-only; then
  npm ci
  npm run build:avatar
  npm run check
  if ! command -v cargo >/dev/null 2>&1; then
    echo 'Install Rust 1.93.1 or newer before building the native runner.' >&2
    exit 1
  fi
  cargo build --locked --release --manifest-path native/engine-runner/Cargo.toml

# Generated protocol files are copied from the reviewed source checkout, not re-fetched from a possibly changed game.
node --input-type=module <<'NODE'
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const versions = JSON.parse(readFileSync('config/versions.json'));
const base = `.runtime/upstream/Akagi-${versions.akagiCommit}/src/bridge/majsoul/`;
for (const [file, hash] of [['proto/liqi.proto', versions.protoSha256], ['liqi.json', versions.rpcMapSha256]]) {
  if (createHash('sha256').update(readFileSync(base + file)).digest('hex') !== hash) throw Error('PROTOCOL_HASH_MISMATCH');
}
NODE
fi

install -d -m 0700 -o maji-soul -g maji-soul /var/lib/maji-soul/.config/pipewire/pipewire.conf.d
cat > /var/lib/maji-soul/.config/pipewire/pipewire.conf.d/maji-soul.conf <<'CONF'
context.objects = [
  { factory = adapter
    args = {
      factory.name = support.null-audio-sink
      node.name = maji_live
      node.description = "Maji Soul Live"
      media.class = "Audio/Sink"
      audio.position = "FL,FR"
    }
  }
]
CONF
chown -R maji-soul:maji-soul /var/lib/maji-soul/.config
maji_uid=$(id -u maji-soul)
cat > /etc/maji-soul/session.env <<ENV
XDG_RUNTIME_DIR=/run/user/$maji_uid
DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$maji_uid/bus
PULSE_SERVER=unix:/run/user/$maji_uid/pulse/native
PULSE_SINK=maji_live
ENV
chmod 0640 /etc/maji-soul/session.env
chown root:maji-soul /etc/maji-soul/session.env
bash deploy/debian/browser-env.sh
loginctl enable-linger maji-soul
systemctl start "user@${maji_uid}.service"
runuser -u maji-soul -- env XDG_RUNTIME_DIR="/run/user/$maji_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$maji_uid/bus" \
  systemctl --user enable --now pipewire.socket pipewire-pulse.socket wireplumber.service
runuser -u maji-soul -- env XDG_RUNTIME_DIR="/run/user/$maji_uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$maji_uid/bus" \
  systemctl --user restart pipewire.service pipewire-pulse.service wireplumber.service

test -f /etc/maji-soul/live.json || install -m 0640 -o root -g maji-soul deploy/debian/live.example.json /etc/maji-soul/live.json
if ! test -f /etc/maji-soul/app.env; then
  install -m 0640 -o root -g maji-soul .env.example /etc/maji-soul/app.env
fi
chown -R maji-soul:maji-soul data
install -m 0644 deploy/debian/maji-soul*.service /etc/systemd/system/
for service in maji-soul-browser maji-soul; do
  install -d -m 0755 "/etc/systemd/system/$service.service.d"
  cat > "/etc/systemd/system/$service.service.d/session.conf" <<UNIT
[Unit]
Requires=user@${maji_uid}.service
After=user@${maji_uid}.service
UNIT
done
systemctl daemon-reload
systemctl enable --now maji-soul-display.service maji-soul-browser.service
echo 'Browser ready. Configure /etc/maji-soul/app.env, log into the game, then systemctl enable --now maji-soul.service.'
