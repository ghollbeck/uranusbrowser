#!/usr/bin/env python3
"""Export desktop browser history (Arc, Chrome, UrAnus Browser; any Chromium `History` file) as JSON for the
Algorithm Diet importer in the iOS app.

  python3 Tools/export-history.py --arc -o ./history.json          every Arc profile
  python3 Tools/export-history.py --anus --chrome -o history.json          more browsers
  python3 Tools/export-history.py "/path/to/History" -o history.json       one Chromium History file
  python3 Tools/export-history.py --arc --since 2026-09-01 -o history.json

Output: {"version": 1, "source": "...", "visits": [{"url", "title", "visitedAt" (unix seconds),
"seconds" (time on page, from Chromium's visit_duration), "profile"}]}. Visits are ordered oldest first.

SQLite's backup API makes a consistent local snapshot, including recent WAL writes, while the browser runs.
Nothing is sent anywhere. The output is your browsing history: keep it out of git.
Then import it in the app: Algorithm Diet > ... > Import history (Files), or for the Simulator:
  xcrun simctl get_app_container <udid> dev.oprimo.anus.mobile data   ->  copy to Documents/history-import.json
"""
import argparse
import datetime as dt
import json
import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

HOME = Path.home()
BROWSERS = {
    "arc": HOME / "Library/Application Support/Arc/User Data",
    "chrome": HOME / "Library/Application Support/Google/Chrome",
    "anus": HOME / "Library/Application Support/Anus Browser",
}
# Chromium stores times as microseconds since 1601-01-01.
EPOCH_DELTA_US = 11_644_473_600 * 1_000_000
SKIP_SCHEMES = ("chrome:", "arc:", "about:", "chrome-extension:", "file:", "data:", "blob:", "javascript:", "devtools:")


def profiles(root: Path):
    if not root.is_dir():
        return []
    out = []
    for p in sorted(root.iterdir()):
        if (p / "History").is_file() and (p.name == "Default" or p.name.startswith("Profile")):
            out.append(p / "History")
    return out


def read_history(path: Path, label: str, since_us: int):
    with tempfile.TemporaryDirectory() as tmp:
        copy = Path(tmp) / "History"
        source = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)
        target = sqlite3.connect(copy)
        try:
            deadline = time.monotonic() + 10
            def progress(status, remaining, total):
                if time.monotonic() > deadline:
                    raise TimeoutError("Browser history stayed busy for 10 seconds; try again when the browser is idle.")
            source.backup(target, pages=256, progress=progress, sleep=0.05)
        finally:
            target.close()
            source.close()
        con = sqlite3.connect(f"file:{copy}?mode=ro", uri=True)
        try:
            rows = con.execute(
                """SELECT u.url, u.title, v.visit_time, v.visit_duration
                   FROM visits v JOIN urls u ON u.id = v.url
                   WHERE v.visit_time >= ? ORDER BY v.visit_time""",
                (since_us,),
            ).fetchall()
        finally:
            con.close()
    visits = []
    for url, title, t, dur in rows:
        if not url or urlsplit(url).scheme.lower() not in ("http", "https"):
            continue
        visits.append({
            "url": url,
            "title": title or "",
            "visitedAt": round((t - EPOCH_DELTA_US) / 1_000_000, 3),
            "seconds": round((dur or 0) / 1_000_000, 1),
            "profile": label,
        })
    return visits


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("files", nargs="*", type=Path, help="Chromium History files")
    for name in BROWSERS:
        ap.add_argument(f"--{name}", action="store_true", help=f"every {name} profile")
    ap.add_argument("--since", help="only visits on or after this date (YYYY-MM-DD)")
    ap.add_argument("-o", "--output", type=Path, required=True)
    args = ap.parse_args()

    since_us = 0
    if args.since:
        d = dt.datetime.strptime(args.since, "%Y-%m-%d").replace(tzinfo=dt.timezone.utc)
        since_us = int(d.timestamp() * 1_000_000) + EPOCH_DELTA_US

    sources = [(f, f.parent.name) for f in args.files]
    for name, root in BROWSERS.items():
        if getattr(args, name):
            sources += [(f, f"{name}/{f.parent.name}") for f in profiles(root)]
    if not sources:
        ap.error("name a History file or pass --arc / --chrome / --anus")

    visits = []
    for path, label in sources:
        try:
            got = read_history(path, label, since_us)
        except (sqlite3.Error, OSError) as e:
            print(f"skipped {path}: {e}", file=sys.stderr)
            continue
        print(f"{label}: {len(got)} visits", file=sys.stderr)
        visits += got
    visits.sort(key=lambda v: v["visitedAt"])
    if not visits:
        raise SystemExit("No visits could be exported; existing datasets have been preserved.")
    payload = {"version": 1, "source": ", ".join(sorted({l for _, l in sources})), "visits": visits}
    # Never silently replace a previous private dataset; owner-only permissions from creation.
    with os.fdopen(os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(payload, output, ensure_ascii=False)
    print(f"wrote {len(visits)} visits to {args.output}", file=sys.stderr)


if __name__ == "__main__":
    main()
