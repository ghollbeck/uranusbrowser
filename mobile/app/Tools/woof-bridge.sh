#!/usr/bin/env bash
# Serve Underdog Woof 2B 1.1 (MLX 4-bit) on 127.0.0.1:8799 for the iOS Simulator, which can't run llama.cpp.
# Loopback only: the Simulator reaches it as localhost; nothing is exposed to the network.
# Uses OpenWhisper's MLX environment and the Woof snapshot it downloaded (OpenWhisper > Settings > Intelligence).
#   Tools/woof-bridge.sh            foreground
#   WOOF_VENV=... WOOF_MODEL=... Tools/woof-bridge.sh
set -euo pipefail
VENV="${WOOF_VENV:-$HOME/.local/share/voxtral-transcribe/.venv}"
MODEL="${WOOF_MODEL:-}"
if [ -z "$MODEL" ]; then
  MODEL=$(ls -d "$HOME/.cache/huggingface/hub/models--ConwayResearch--Underdog-Woof-2B-1.1/snapshots/"* 2>/dev/null | head -1 || true)
fi
[ -x "$VENV/bin/mlx_lm.server" ] || { echo "mlx-lm not found in $VENV (set WOOF_VENV)" >&2; exit 1; }
[ -f "$MODEL/config.json" ] || { echo "Woof 2B 1.1 snapshot not found (set WOOF_MODEL)" >&2; exit 1; }
export HF_HUB_OFFLINE=1
exec "$VENV/bin/mlx_lm.server" --model "$MODEL" --host 127.0.0.1 --port "${WOOF_PORT:-8799}" \
  --chat-template-args '{"enable_thinking":false}' --max-tokens 1024
