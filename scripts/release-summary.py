#!/usr/bin/env python3
"""Write a 1-2 sentence summary of release notes with a local Ollama model.

Usage: release-summary.py NOTES_FILE
Prints the summary, or nothing when Ollama isn't running or answers badly:
a release never depends on it. Model: $OLLAMA_MODEL (default qwen2.5-coder:7b),
server: $OLLAMA_HOST (default http://localhost:11434).
"""

import json
import os
import re
import sys
import urllib.request

PROMPT = """You write the short summary at the top of the release notes for Treehouse, \
a private voice and chat app (Windows and macOS) for a small group of friends: \
text chat, voice rooms and moderation.

Summarize the changes below for people using the app in 1 or 2 plain sentences \
(at most 45 words). Mention only what is in the list, starting with the most useful \
change. No heading, no list, no emojis, no marketing words like "exciting", \
"seamless" or "enhanced", and don't start with "This release".

Changes:
{notes}
"""


def main() -> None:
    with open(sys.argv[1]) as f:
        notes = f.read().strip()
    if not notes:
        return
    host = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
    if not host.startswith("http"):
        host = "http://" + host
    body = json.dumps({
        "model": os.environ.get("OLLAMA_MODEL") or "qwen2.5-coder:7b",
        "prompt": PROMPT.format(notes=notes),
        "stream": False,
        "options": {"temperature": 0.2},
    }).encode()
    req = urllib.request.Request(f"{host}/api/generate", body, {"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            text = json.load(r).get("response", "")
    except Exception as e:  # not running, model missing, timeout: release goes on without it
        print(f"release-summary: skipped ({e})", file=sys.stderr)
        return
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip().strip('"')
    text = " ".join(text.split())
    if text and len(text) < 600:
        print(text)


if __name__ == "__main__":
    main()
