"""One-command demo reset: wipe state and reseed the simulated fleet.

You will demo to multiple judges. Without this, judge #2 sees judge #1's
leftover pins and the 'watch it flip to CONFIRMED' beat breaks because
it already confirmed. Run between demos:

  python tools/demo_reset.py                       # wipe + reseed cloud db
  python tools/demo_reset.py --db pc_mirror.db --no-seed   # wipe PC mirror
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

ROOT = Path(__file__).resolve().parent.parent


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("ROADSENSE_DB", "roadsense.db"))
    ap.add_argument("--cloud", default="http://localhost:8000")
    ap.add_argument("--no-seed", action="store_true")
    args = ap.parse_args()

    for suffix in ("", "-wal", "-shm"):
        p = Path(args.db + suffix)
        if p.exists():
            p.unlink()
            print(f"removed {p}")

    if args.no_seed:
        return
    print("reseeding simulated fleet (restart the cloud server first if it "
          "holds the old connection)…")
    subprocess.run([sys.executable, str(ROOT / "tools" / "simulate_fleet.py"),
                    "--cloud", args.cloud, "--resolve-demo"], check=True)


if __name__ == "__main__":
    main()
