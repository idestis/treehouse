#!/usr/bin/env python3
"""Write the tauri-plugin-updater feed (latest.json) for one release.

Usage: latest-json.py VERSION BASE_URL NOTES_FILE OUT PLATFORM=FILE [PLATFORM=FILE ...]
  BASE_URL  public URL of the release folder, e.g. https://treehouse-releases.x.workers.dev/v0.2.0
  PLATFORM  updater target, e.g. darwin-aarch64, darwin-x86_64, windows-x86_64
  FILE      update payload; its signature is read from FILE.sig and its URL is
            BASE_URL/<basename of FILE>
Example:
  latest-json.py 0.2.0 https://…/v0.2.0 build/notes-0.2.0.md build/latest.json \\
    darwin-aarch64=build/Treehouse.app.tar.gz darwin-x86_64=build/Treehouse.app.tar.gz \\
    windows-x86_64=build/Treehouse-0.2.0-setup.exe
"""
import datetime, json, os, sys


def main() -> None:
    if len(sys.argv) < 6:
        sys.exit(__doc__)
    version, base, notes_file, out = sys.argv[1:5]
    with open(notes_file) as f:
        notes = f.read().strip()
    platforms = {}
    for arg in sys.argv[5:]:
        name, _, path = arg.partition("=")
        with open(path + ".sig") as f:
            signature = f.read().strip()
        platforms[name] = {
            "signature": signature,
            "url": f"{base.rstrip('/')}/{os.path.basename(path)}",
        }
    feed = {
        "version": version,
        "notes": notes,
        "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": platforms,
    }
    with open(out, "w") as f:
        json.dump(feed, f, indent=2)
        f.write("\n")


if __name__ == "__main__":
    main()
