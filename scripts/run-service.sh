#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="/home/pinkdraconian/CodexWeb"
NODE_BIN="/home/pinkdraconian/.nvm/versions/node/v25.8.1/bin/node"
NODE_BIN_DIR="/home/pinkdraconian/.nvm/versions/node/v25.8.1/bin"

cd "$ROOT_DIR"
export PATH="$NODE_BIN_DIR:$PATH"
export XDG_CONFIG_HOME="$ROOT_DIR/.config"

if [ ! -x "$NODE_BIN" ]; then
  echo "node not found at $NODE_BIN" >&2
  exit 1
fi

exec "$NODE_BIN" --env-file=.env server.js
