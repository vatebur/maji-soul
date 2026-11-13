#!/bin/bash
# Preserve an operator's choice; regenerate explicitly if the host GPU changes.
set -euo pipefail
test -f /etc/maji-soul/browser.env && exit 0
intel=false
for vendor_file in /sys/class/drm/renderD*/device/vendor; do
  if test -r "$vendor_file" && test "$(cat "$vendor_file")" = 0x8086; then intel=true; fi
done
umask 027
if "$intel" && test -f /usr/share/vulkan/icd.d/intel_icd.json; then
  cat > /etc/maji-soul/browser.env <<'ENV'
MAJI_BROWSER_FLAGS=--use-gl=angle --use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface --disable-software-rasterizer
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/intel_icd.json
ENV
else
  cat > /etc/maji-soul/browser.env <<'ENV'
MAJI_BROWSER_FLAGS=--use-gl=angle --use-angle=swiftshader
ENV
fi
chown root:maji-soul /etc/maji-soul/browser.env
chmod 0640 /etc/maji-soul/browser.env
