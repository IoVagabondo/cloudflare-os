#!/bin/sh
set -eu

persist_path="${WORKERD_PERSIST_PATH:-/data}"
if [ "$persist_path" != "/data" ]; then
  echo "WORKERD_PERSIST_PATH must be /data in the Railway image." >&2
  exit 1
fi

mkdir -p /data "$HOME"
chown node:node /data "$HOME"

exec gosu node:node node /app/railway/workerd/supervisor.mjs
