#!/bin/bash
# Usage: bash scripts/deploy/debian.sh [root@192.168.1.2] [--prepare-only]
set -euo pipefail
cd "$(dirname "$0")/../.."
target=${1:-root@192.168.1.2}
mode=${2:-install}
test "$mode" = install || test "$mode" = --prepare-only || { echo 'Unknown deploy mode.' >&2; exit 1; }
[[ "$target" =~ ^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.:-]+$ ]] || { echo 'Invalid SSH target' >&2; exit 1; }
ssh -o BatchMode=yes "$target" 'install -d -m 0755 /opt/maji-soul; systemctl stop maji-soul.service 2>/dev/null || true'
# No --delete: preserve runtime, private configuration, recordings and game login.
rsync -az --exclude=.git --include=.env.example --exclude=.env --exclude='.env.*' \
  --exclude=node_modules --exclude=.runtime --exclude=.vfox --exclude=data --exclude=runtime \
  --exclude='native/engine-runner/target' --exclude=.DS_Store --exclude='/*.mp4' \
  ./ "$target:/opt/maji-soul/"
protocol=.runtime/upstream/Akagi-63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/src/bridge/majsoul
test -f "$protocol/proto/liqi.proto" && test -f "$protocol/liqi.json" || { echo 'Prepare and verify protocol files locally first.' >&2; exit 1; }
ssh -o BatchMode=yes "$target" 'mkdir -p /opt/maji-soul/.runtime/upstream/Akagi-63cea4b5d23d83bbee8d56bc3b9d547cca2046c3/src/bridge/majsoul/proto'
rsync -az "$protocol/liqi.json" "$target:/opt/maji-soul/$protocol/"
rsync -az "$protocol/proto/liqi.proto" "$target:/opt/maji-soul/$protocol/proto/"
ssh -o BatchMode=yes "$target" "bash /opt/maji-soul/deploy/debian/install.sh $mode"
