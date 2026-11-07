#!/usr/bin/env python3
"""Serialize this app's canonical Xcode builds without deleting locks or another task's outputs."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parents[1]
(root / '.run').mkdir(exist_ok=True)
with (root / '.run/build.lock').open('a') as lock:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('Waiting for the existing mobile build to finish.', flush=True)
        fcntl.flock(lock, fcntl.LOCK_EX)
    env = dict(os.environ, ANUS_BUILD_LOCKED=str(root))
    result = subprocess.run([str(root / 'run.sh'), *sys.argv[1:]], env=env)
    raise SystemExit(result.returncode)
