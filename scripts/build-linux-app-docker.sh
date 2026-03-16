#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_REPO_DIR="$ROOT_DIR/vendor/codex-desktop-linux"
DMG_CACHE_PATH="$ROOT_DIR/.cache/Codex.dmg"
APP_START_PATH="$APP_REPO_DIR/codex-app/start.sh"
SEVEN_ZIP_PATH="/work/node_modules/7zip-bin-full/linux/x64/7zz"

if [ ! -d "$APP_REPO_DIR" ]; then
  echo "Missing repo: $APP_REPO_DIR" >&2
  exit 1
fi

if [ ! -f "$DMG_CACHE_PATH" ]; then
  echo "Missing cached DMG: $DMG_CACHE_PATH" >&2
  exit 1
fi

HOST_UID="$(id -u)"
HOST_GID="$(id -g)"

docker run --rm \
  -v "$ROOT_DIR:/work" \
  -w /work \
  node:22-bookworm \
  bash -lc "
    set -Eeuo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends python3 p7zip-full curl unzip build-essential ca-certificates
    if ! getent group $HOST_GID >/dev/null; then groupadd -g $HOST_GID hostgroup; fi
    if ! id -u $HOST_UID >/dev/null 2>&1; then useradd -m -u $HOST_UID -g $HOST_GID hostuser; fi
    HOST_USER=\$(getent passwd $HOST_UID | cut -d: -f1)
    chown -R $HOST_UID:$HOST_GID /work
    su -s /bin/bash \"\$HOST_USER\" -c '
      set -Eeuo pipefail
      cd /work/vendor/codex-desktop-linux
      ln -sf ../../.cache/Codex.dmg Codex.dmg
      chmod +x install.sh
      chmod +x $SEVEN_ZIP_PATH
      export SEVEN_ZIP_CMD=$SEVEN_ZIP_PATH
      ./install.sh Codex.dmg
    '
    chown -R $HOST_UID:$HOST_GID /work
  "

if [ ! -x "$APP_START_PATH" ]; then
  echo "Build completed without producing $APP_START_PATH" >&2
  exit 1
fi

echo "Linux Codex app built at: $APP_START_PATH"
