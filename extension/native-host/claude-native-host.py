#!/usr/bin/env python3
"""Chrome native messaging host bridging AcademicReader to a locally
installed, logged-in Claude Code CLI (`claude`) — lets the extension use
a Claude Pro/Max subscription's included usage instead of a metered
Anthropic API key, without the browser needing to spawn processes itself
(which it can't — this is the whole reason native messaging exists).

Sibling of codex-native-host.py; the two are deliberately near-identical
so the one bridge pattern only has to be understood once. Differences are
only where the two CLIs' invocation and JSON output actually differ, and
each such spot is commented.

Not invoked directly: `register-claude.sh` writes a small wrapper script
that execs this with PATH pre-seeded to include `claude`'s directory
(Chrome spawns native hosts with a minimal environment that does NOT
include a normal login shell's PATH — claude, installed at e.g.
~/.local/bin/claude, would otherwise fail with ENOENT).

Protocol: Chrome's native messaging framing — each message is a 4-byte
little-endian length prefix followed by that many bytes of UTF-8 JSON, in
both directions. See https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

Request shapes (from the extension):
  {"action": "list_models"}
  {"action": "chat", "model": "<alias>", "prompt": "<full composed text>",
   "images": [{"base64": "...", "mimeType": "image/png"}, ...]}

Response shapes (to the extension):
  {"ok": true, "models": [{"slug": "...", "display_name": "..."}, ...]}
  {"ok": true, "text": "<assistant reply>"}
  {"ok": false, "error": "<message>"}
"""

import base64
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
from pathlib import Path

STATE_DIR = Path.home() / ".academicreader" / "native-host"
SCRATCH_DIR = STATE_DIR / "claude-scratch"
LOG_PATH = STATE_DIR / "claude-native-host.log"

# `claude -p` runs a full agent loop (it may read an attached image file
# before answering), so a single "explain this" call can legitimately take
# a while. Generous but bounded — a hung `claude` process must not hang
# this host forever, since Chrome is waiting on a reply.
CHAT_TIMEOUT_SECONDS = 120

# The stable model ALIASES the Claude CLI accepts for `--model` (verified
# against the installed CLI: `opus`, `sonnet`, `haiku` all resolve). This
# is the one place this project hardcodes a model list rather than fetching
# it live (see shared/model-catalog.ts's note on why it avoids that
# elsewhere): the Claude CLI has no "list models" command, and unlike a
# raw model ID an alias resolves to the current latest model server-side,
# so it does not go stale.
MODEL_ALIASES = [
    {"slug": "opus", "display_name": "Claude Opus (latest)"},
    {"slug": "sonnet", "display_name": "Claude Sonnet (latest)"},
    {"slug": "haiku", "display_name": "Claude Haiku (latest)"},
]


def log(message: str) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"[{time.strftime('%Y-%m-%dT%H:%M:%S')}] {message}\n")
    except Exception:
        pass  # logging must never be why a request fails


def read_message() -> dict:
    raw_length = sys.stdin.buffer.read(4)
    if len(raw_length) < 4:
        sys.exit(0)  # Chrome closed the pipe; nothing to reply to
    (length,) = struct.unpack("<I", raw_length)
    data = sys.stdin.buffer.read(length)
    return json.loads(data)


def send_message(obj: dict) -> None:
    # Native messaging caps each message at 1MB in each direction. A
    # response this host would ever produce (model list, or a text reply)
    # should never get close to that, but truncate defensively rather than
    # let Chrome silently drop an oversized message with no error visible
    # to the extension.
    data = json.dumps(obj).encode("utf-8")
    if len(data) > 1_000_000:
        data = json.dumps(
            {"ok": False, "error": "native host response exceeded the 1MB native messaging limit"}
        ).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def run_claude_json(args: list[str], timeout: int) -> dict:
    """Runs `claude <args> --output-format json`, returns the parsed result
    object. stdin is DEVNULL (nothing to pipe in — the prompt is a
    positional arg), stdout is captured (never inherited — inheriting it
    would corrupt the native messaging protocol's own stdout framing),
    stderr goes to the log file.

    `claude -p --output-format json` prints a single JSON object as its
    last stdout line, but may print non-JSON diagnostic lines before it
    (e.g. "[claude-code:unrecognized_model] {...}" for a bad --model), and
    its exit code is 0 even for an API-level error — so this parses the
    last line that decodes to a JSON object with type == "result" and
    relies on that object's own "is_error" flag, not the return code.
    """
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as stderr_log:
        proc = subprocess.run(
            ["claude", *args],
            cwd=str(SCRATCH_DIR),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=stderr_log,
            timeout=timeout,
            text=True,
        )

    result_obj = None
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue  # a non-JSON diagnostic line; ignore
        if isinstance(obj, dict) and obj.get("type") == "result":
            result_obj = obj

    if result_obj is None:
        raise RuntimeError(
            f"claude produced no result object (exit {proc.returncode}); see {LOG_PATH} for details"
        )
    return result_obj


def handle_list_models() -> dict:
    # The Claude CLI has no programmatic model-list command, so the list
    # itself is fixed (see MODEL_ALIASES). But the Options page's "Refresh
    # models" button is the one pre-save health check the user has, so
    # actually run the CLI here — a missing binary or a broken install
    # should surface on that click, not later as a confusing chat error.
    try:
        proc = subprocess.run(
            ["claude", "--version"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
    except Exception as e:  # noqa: BLE001 - surface as a normal error response
        return {"ok": False, "error": f"claude CLI not runnable: {e}"}
    if proc.returncode != 0:
        return {"ok": False, "error": f"claude --version exited with status {proc.returncode}"}
    return {"ok": True, "models": MODEL_ALIASES}


def handle_chat(request: dict) -> dict:
    model = request.get("model")
    prompt = request.get("prompt")
    images = request.get("images") or []
    if not prompt or not isinstance(prompt, str):
        return {"ok": False, "error": "chat request missing a prompt"}

    tmp_image_paths: list[str] = []
    try:
        for img in images:
            b64 = img.get("base64")
            mime = img.get("mimeType", "image/png")
            if not b64:
                continue
            ext = ".png" if "png" in mime else ".jpg"
            fd, path = tempfile.mkstemp(suffix=ext, dir=str(SCRATCH_DIR))
            try:
                os.write(fd, base64.b64decode(b64))
            finally:
                os.close(fd)
            tmp_image_paths.append(path)

        # The Claude CLI has no image-attachment flag; instead it reads a
        # file referenced by path in the prompt via its Read tool. The
        # temp files are written INTO the run's working directory
        # (SCRATCH_DIR, which is also `cwd` above) so `--restricted`'s
        # working-directory confinement still permits the read, and
        # `--permission-prompts none` denies (rather than hangs on)
        # anything that would otherwise prompt — verified: a file in the
        # cwd reads with no permission denial.
        effective_prompt = prompt
        if tmp_image_paths:
            listing = "\n".join(f"- {p}" for p in tmp_image_paths)
            effective_prompt = (
                f"{prompt}\n\n"
                f"The following image file(s) are attached — read them to answer:\n{listing}"
            )

        # --restricted: no command/code-running tools, and settings files
        #   (user/project/local CLAUDE.md etc.) are ignored — a clean
        #   sandbox for a one-shot Q&A. It does NOT disable the CLI's
        #   normal login, so this still draws on the `claude` subscription
        #   session, no API key.
        # --strict-mcp-config: also ignore any configured MCP servers.
        # --permission-prompts none: deny anything that would prompt
        #   instead of blocking forever waiting on a human.
        args = [
            "-p",
            "--output-format",
            "json",
            "--restricted",
            "--strict-mcp-config",
            "--permission-prompts",
            "none",
        ]
        if model:
            args += ["--model", model]
        args.append(effective_prompt)

        result_obj = run_claude_json(args, CHAT_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"claude -p timed out after {CHAT_TIMEOUT_SECONDS}s"}
    except Exception as e:  # noqa: BLE001 - surface to the caller, one bad call must not crash the host
        log(f"chat error: {e}")
        return {"ok": False, "error": str(e)}
    finally:
        for path in tmp_image_paths:
            try:
                os.remove(path)
            except OSError:
                pass

    text = result_obj.get("result")
    if result_obj.get("is_error") or not isinstance(text, str) or not text:
        message = text if isinstance(text, str) and text else "claude -p reported an error; see log for the raw result"
        return {"ok": False, "error": message}
    return {"ok": True, "text": text}


def main() -> None:
    try:
        request = read_message()
    except Exception as e:  # noqa: BLE001
        log(f"failed to read request: {e}")
        return

    action = request.get("action")
    try:
        if action == "list_models":
            response = handle_list_models()
        elif action == "chat":
            response = handle_chat(request)
        else:
            response = {"ok": False, "error": f"unknown action: {action!r}"}
    except Exception as e:  # noqa: BLE001 - never let an unhandled exception skip sending a reply
        log(f"unhandled error for action {action!r}: {e}")
        response = {"ok": False, "error": str(e)}

    send_message(response)


if __name__ == "__main__":
    main()
