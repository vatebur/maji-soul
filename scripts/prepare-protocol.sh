#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
commit=63cea4b5d23d83bbee8d56bc3b9d547cca2046c3
mkdir -p .runtime/upstream
if [ ! -d ".runtime/upstream/Akagi-$commit" ]; then
  curl -fL "https://codeload.github.com/shinkuan/Akagi/tar.gz/$commit" -o .runtime/akagi.tar.gz
  actual=$(shasum -a 256 .runtime/akagi.tar.gz | cut -d ' ' -f 1)
  test "$actual" = 45786d0046ca8ab5b832c8ffdf0fbb7b470ed3d848730fbcb8123032f9f4cd43
  tar -xzf .runtime/akagi.tar.gz -C .runtime/upstream
fi
# An existing Python with lzma support is required. This never installs a global package.
"${MAJI_PROTOCOL_PYTHON:-python3}" -c 'import lzma'
"${MAJI_PROTOCOL_PYTHON:-python3}" -m venv .runtime/protocol-env
.runtime/protocol-env/bin/python -m pip install -r scripts/protocol-requirements.lock
.runtime/protocol-env/bin/python ".runtime/upstream/Akagi-$commit/scripts/extract_liqi.py" --timeout 30
