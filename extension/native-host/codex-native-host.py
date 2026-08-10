#!/usr/bin/env python3
"""Chrome native messaging host bridging AcademicReader to a locally
installed, ChatGPT-authenticated Codex CLI (`codex`) — lets the extension
use a ChatGPT Plus/Pro subscription's included Codex usage instead of a
metered OpenAI API key, without the browser needing to spawn processes
itself (which it can't — this is the whole reason native messaging exists).

Not invoked directly: `register.sh` writes a small wrapper script that
execs this with PATH pre-seeded to include `codex`'s directory (Chrome
spawns native hosts with a minimal environment that does NOT include a
normal login shell's PATH — codex, installed at e.g. ~/.local/bin/codex,
would otherwise fail with ENOENT).

Protocol: Chrome's native messaging framing — each message is a 4-byte
little-endian length prefix followed by that many bytes of UTF-8 JSON, in
both directions. See https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

Request shapes (from the extension):
  {"action": "list_models"}
  {"action": "chat", "model": "<slug>", "prompt": "<full composed text>",
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
SCRATCH_DIR = STATE_DIR / "scratch"
LOG_PATH = STATE_DIR / "codex-native-host.log"

# codex exec's own reasoning/tool-use loop can legitimately take a while
# for a single "explain this" call (see the README note this ships
# alongside: no token streaming, several seconds of nothing, then the full
# reply). This is generous but bounded — a hung `codex` process must not
# hang this host forever, since Chrome is waiting on a reply.
CHAT_TIMEOUT_SECONDS = 120
LIST_MODELS_TIMEOUT_SECONDS = 20


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


def run_codex_json(args: list[str], timeout: int) -> list[dict]:
    """Runs `codex <args>` with --json, returns the parsed JSONL events.
    stdin is DEVNULL (codex otherwise blocks reading from a pipe that will
    never close — see this project's own discovery of that hang), stdout is
    captured (never inherited — inheriting it would corrupt the native
    messaging protocol's own stdout framing), stderr goes to the log file.
    """
    SCRATCH_DIR.mkdir(parents=True, exist_ok=True)
    with open(LOG_PATH, "a", encoding="utf-8") as stderr_log:
        proc = subprocess.run(
            ["codex", *args],
            cwd=str(SCRATCH_DIR),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=stderr_log,
            timeout=timeout,
            text=True,
        )
    if proc.returncode != 0:
        raise RuntimeError(f"codex exited with status {proc.returncode} (see {LOG_PATH} for details)")

    events = []
    for line in proc.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a non-JSON line (e.g. a stray log line); ignore
    return events


def handle_list_models() -> dict:
    proc = subprocess.run(
        ["codex", "debug", "models"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=LIST_MODELS_TIMEOUT_SECONDS,
        text=True,
    )
    if proc.returncode != 0:
        return {"ok": False, "error": f"codex debug models exited with status {proc.returncode}"}
    try:
        catalog = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        return {"ok": False, "error": f"could not parse codex debug models output: {e}"}

    # The raw catalog includes each model's full system-instructions text
    # (tens of KB per entry) — nothing the extension's dropdown needs.
    # Trimming to slug/display_name also keeps this comfortably under the
    # native messaging 1MB response cap regardless of how many models
    # `codex debug models` ever returns.
    models = [
        {"slug": m.get("slug"), "display_name": m.get("display_name") or m.get("slug")}
        for m in catalog.get("models", [])
        if m.get("visibility") == "list" and m.get("slug")
    ]
    return {"ok": True, "models": models}


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
            fd, path = tempfile.mkstemp(suffix=ext, dir=str(SCRATCH_DIR) if SCRATCH_DIR.exists() else None)
            try:
                os.write(fd, base64.b64decode(b64))
            finally:
                os.close(fd)
            tmp_image_paths.append(path)

        args = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--json"]
        if model:
            args += ["-m", model]
        # The PROMPT positional argument must come before `-i <FILE>...` —
        # `-i` takes an unbounded number of values, so anything placed
        # after it (including the prompt) gets silently swallowed into the
        # image-file list instead of being read as the prompt, and codex
        # falls back to (never-arriving) stdin. Verified empirically: this
        # exact failure mode ("Reading prompt from stdin... No prompt
        # provided via stdin.") is what putting -i first produces.
        args.append(prompt)
        for path in tmp_image_paths:
            args += ["-i", path]

        events = run_codex_json(args, CHAT_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"codex exec timed out after {CHAT_TIMEOUT_SECONDS}s"}
    except Exception as e:  # noqa: BLE001 - surface to the caller, one bad call must not crash the host
        log(f"chat error: {e}")
        return {"ok": False, "error": str(e)}
    finally:
        for path in tmp_image_paths:
            try:
                os.remove(path)
            except OSError:
                pass

    reply_parts = [
        e["item"]["text"]
        for e in events
        if e.get("type") == "item.completed" and e.get("item", {}).get("type") == "agent_message"
    ]
    if not reply_parts:
        return {"ok": False, "error": "codex exec produced no agent_message; see log for raw events"}
    return {"ok": True, "text": "".join(reply_parts)}


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
