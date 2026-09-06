#!/usr/bin/env bash
# One-time setup: registers the Claude Code CLI native messaging host so
# AcademicReader can silently launch it on demand (Chrome spawns it
# per-request via chrome.runtime.sendNativeMessage — no persistent process,
# nothing to keep running). Re-run this any time claude's install location
# changes; safe to re-run otherwise.
#
# Sibling of register.sh (the Codex CLI equivalent) — the two register
# independent hosts and do not interfere.
set -euo pipefail

EXTENSION_ID="dplbidighoojohkjjcegfdfinffmdmdj"
HOST_NAME="com.academicreader.claudebridge"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$HOME/.academicreader/native-host"

if ! command -v claude >/dev/null 2>&1; then
  echo "claude CLI not found on PATH." >&2
  echo "Install it and sign in (run 'claude' once and complete login with your" >&2
  echo "Claude account) first, then re-run this script." >&2
  exit 1
fi
CLAUDE_DIR="$(dirname "$(command -v claude)")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found on PATH — required to run the native messaging host." >&2
  exit 1
fi
PYTHON3_BIN="$(command -v python3)"

mkdir -p "$STATE_DIR"
cp "$SCRIPT_DIR/claude-native-host.py" "$STATE_DIR/claude-native-host.py"

# Chrome spawns native messaging hosts with a minimal environment that does
# NOT include a normal login shell's PATH, so `claude` (commonly installed
# somewhere like ~/.local/bin, not a system directory) would otherwise fail
# to launch with ENOENT. This wrapper bakes in claude's resolved directory
# at registration time rather than relying on PATH at request time. Its
# name is claude-specific so it doesn't collide with register.sh's run.sh.
cat > "$STATE_DIR/run-claude.sh" << EOF
#!/usr/bin/env bash
export PATH="$CLAUDE_DIR:\$PATH"
exec "$PYTHON3_BIN" "$STATE_DIR/claude-native-host.py"
EOF
chmod +x "$STATE_DIR/run-claude.sh"

MANIFEST_JSON=$(cat << EOF
{
  "name": "$HOST_NAME",
  "description": "AcademicReader bridge to a locally logged-in Claude Code CLI",
  "path": "$STATE_DIR/run-claude.sh",
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
echo "Done. In AcademicReader's Settings, choose \"Claude CLI\" as the provider —"
echo "no API key needed, it uses your local 'claude' login session."
