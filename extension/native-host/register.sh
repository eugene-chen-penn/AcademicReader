#!/usr/bin/env bash
# One-time setup: registers the Codex CLI native messaging host so
# AcademicReader can silently launch it on demand (Chrome spawns it
# per-request via chrome.runtime.sendNativeMessage — no persistent process,
# nothing to keep running). Re-run this any time codex's install location
# changes; safe to re-run otherwise.
set -euo pipefail

EXTENSION_ID="dplbidighoojohkjjcegfdfinffmdmdj"
HOST_NAME="com.academicreader.codexbridge"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HOME/.academicreader/native-host"

if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI not found on PATH." >&2
  echo "Install it and run 'codex login' (sign in with your ChatGPT account) first," >&2
  echo "then re-run this script." >&2
  exit 1
fi
CODEX_DIR="$(dirname "$(command -v codex)")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found on PATH — required to run the native messaging host." >&2
  exit 1
fi
PYTHON3_BIN="$(command -v python3)"

mkdir -p "$STATE_DIR"
cp "$SCRIPT_DIR/codex-native-host.py" "$STATE_DIR/codex-native-host.py"

# Chrome spawns native messaging hosts with a minimal environment that does
# NOT include a normal login shell's PATH, so `codex` (commonly installed
# somewhere like ~/.local/bin, not a system directory) would otherwise fail
# to launch with ENOENT. This wrapper bakes in codex's resolved directory
# at registration time rather than relying on PATH at request time.
cat > "$STATE_DIR/run.sh" << EOF
#!/usr/bin/env bash
export PATH="$CODEX_DIR:\$PATH"
exec "$PYTHON3_BIN" "$STATE_DIR/codex-native-host.py"
EOF
chmod +x "$STATE_DIR/run.sh"

MANIFEST_JSON=$(cat << EOF
{
  "name": "$HOST_NAME",
  "description": "AcademicReader bridge to a locally logged-in Codex CLI",
  "path": "$STATE_DIR/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
EOF
)

# Standard, sudo-free, per-user manifest locations Chrome documents for
# each OS/browser (see
# https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
# Registers into every one that could plausibly apply rather than trying to
# detect which browser/OS is in use — installing into a directory for a
# browser you don't have is harmless (Chrome/Chromium/Brave/Edge all only
# ever read their own).
case "$(uname -s)" in
  Darwin)
    TARGET_DIRS=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
      "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
    )
    ;;
  Linux)
    TARGET_DIRS=(
      "$HOME/.config/google-chrome/NativeMessagingHosts"
      "$HOME/.config/chromium/NativeMessagingHosts"
      "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
      "$HOME/.config/microsoft-edge/NativeMessagingHosts"
    )
    ;;
  *)
    echo "Unsupported OS: $(uname -s) — this script supports macOS and Linux." >&2
    exit 1
    ;;
esac

for dir in "${TARGET_DIRS[@]}"; do
  mkdir -p "$dir"
  printf '%s' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
  echo "Registered: $dir/$HOST_NAME.json"
done

echo ""
echo "Done. In AcademicReader's Settings, choose \"Codex CLI\" as the provider —"
echo "no API key needed, it uses your local 'codex login' session."
