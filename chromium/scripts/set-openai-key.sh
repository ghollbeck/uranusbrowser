#!/bin/bash
# Stores the OpenAI API key for Uranus Browser's Agent panel in the macOS Keychain, where the native
# host reads it (chromium/native-host/secrets.ts). The key never goes on a command line (other
# processes could read it there): it comes from stdin, or from an env file, and reaches
# `security` on its stdin. It isn't printed.
#
#   chromium/scripts/set-openai-key.sh                                # paste the key, then Return
#   chromium/scripts/set-openai-key.sh --from-env-file <file> [VAR]   # VAR defaults to OPENAI_API_KEY
#   chromium/scripts/set-openai-key.sh --status                       # whether one is stored
#   chromium/scripts/set-openai-key.sh --delete
#
# Reopen the Agent panel afterwards (the host looks the key up on each message).
set -euo pipefail
service="dev.oprimo.anus.agent.openai"
account="api-key"

case "${1:-}" in
  --status)
    if security find-generic-password -s "$service" -a "$account" >/dev/null 2>&1; then
      echo "An OpenAI API key for Uranus Browser is in the Keychain."
    else
      echo "No OpenAI API key for Uranus Browser in the Keychain."
      exit 1
    fi
    exit 0
    ;;
  --delete)
    security delete-generic-password -s "$service" -a "$account" >/dev/null
    echo "Removed Uranus Browser's OpenAI API key from the Keychain."
    exit 0
    ;;
  --from-env-file)
    file="${2:?--from-env-file needs a file}"
    var="${3:-OPENAI_API_KEY}"
    # The last assignment wins, as in a shell; quotes and `export` are allowed.
    key="$(sed -nE "s/^[[:space:]]*(export[[:space:]]+)?${var}[[:space:]]*=[[:space:]]*['\"]?([^'\"[:space:]#]+).*/\\2/p" "$file" | tail -n 1)"
    ;;
  "")
    printf 'OpenAI API key (hidden): ' >&2
    IFS= read -rs key
    printf '\n' >&2
    ;;
  *)
    echo "error: unknown argument $1" >&2
    exit 1
    ;;
esac

if [ -z "${key:-}" ]; then
  echo "error: no key found" >&2
  exit 1
fi
# Only the characters OpenAI keys have, so nothing else can reach security's command line.
if ! [[ "$key" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]]; then
  echo "error: that doesn't look like an OpenAI API key (sk-...)" >&2
  exit 1
fi
printf 'add-generic-password -U -s %s -a %s -l "Uranus Browser Agent (OpenAI API key)" -w %s\n' "$service" "$account" "$key" | security -i >/dev/null
unset key
echo "Stored Uranus Browser's OpenAI API key in the Keychain (service $service)."
