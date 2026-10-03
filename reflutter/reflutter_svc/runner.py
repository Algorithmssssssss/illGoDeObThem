"""Drives the ``reflutter`` CLI non-interactively.

reFlutter normally prompts for a mode and (for traffic mode) a Burp IP; we feed
those answers over stdin. It downloads the matching pre-patched Flutter engine
from GitHub, swaps it into a *copy* of the app, repackages, and writes an
``*.RE.ipa`` / ``*.RE.apk`` next to where it ran. It never executes the app.
"""

import glob
import os
import re
import shutil
import subprocess

# reFlutter prints the detected Dart snapshot hash on a line such as
# "Found the Snapshot Hash: adb4292f..."; stay tolerant of wording changes.
_SNAPSHOT_HASH_RE = re.compile(r"snapshot\s*hash[:\s]+([0-9a-fA-F]{8,})", re.IGNORECASE)

DEFAULT_TIMEOUT = 1700  # seconds; under the Celery soft limit


def _find_artifact(search_dir: str, input_copy: str) -> str | None:
    """Locate the patched artifact reFlutter produced, by name pattern."""
    input_abs = os.path.abspath(input_copy)
    candidates: set[str] = set()
    for ext in ("ipa", "apk"):
        candidates.update(glob.glob(os.path.join(search_dir, f"**/*.RE.{ext}"), recursive=True))
        candidates.update(glob.glob(os.path.join(search_dir, f"**/*RE*.{ext}"), recursive=True))
    found = [c for c in candidates if os.path.abspath(c) != input_abs and os.path.isfile(c)]
    if not found:
        return None
    found.sort(key=os.path.getmtime, reverse=True)
    return found[0]


def run_reflutter_cli(
    input_path: str,
    mode: str,
    proxy_ip: str | None,
    work_dir: str,
    timeout: int = DEFAULT_TIMEOUT,
) -> dict:
    """Run reFlutter against a copy of ``input_path`` inside ``work_dir``.

    Returns ``{returncode, output_log, snapshot_hash, artifact}`` where
    ``artifact`` is the path to the produced RE file (or ``None``).
    """
    os.makedirs(work_dir, exist_ok=True)
    input_copy = os.path.join(work_dir, os.path.basename(input_path))
    shutil.copy2(input_path, input_copy)

    # Menu answer: 1 = traffic monitoring/interception (then the Burp IP),
    # 2 = display absolute code offsets (dump.dart). The trailing newline(s)
    # satisfy reFlutter's input() prompts.
    if mode == "traffic":
        stdin_text = f"1\n{proxy_ip}\n"
    else:
        stdin_text = "2\n"

    proc = subprocess.run(
        ["reflutter", input_copy],
        input=stdin_text,
        capture_output=True,
        text=True,
        cwd=work_dir,
        timeout=timeout,
    )

    output_log = (proc.stdout or "")
    if proc.stderr:
        output_log += ("\n" if output_log else "") + proc.stderr

    snapshot_match = _SNAPSHOT_HASH_RE.search(output_log)
    snapshot_hash = snapshot_match.group(1) if snapshot_match else None

    return {
        "returncode": proc.returncode,
        "output_log": output_log,
        "snapshot_hash": snapshot_hash,
        "artifact": _find_artifact(work_dir, input_copy),
    }


def summarize_failure(result: dict) -> str:
    """A short, user-facing reason for a failed/empty patch run."""
    log = (result.get("output_log") or "").strip()
    if log:
        tail = [ln for ln in log.splitlines() if ln.strip()][-12:]
        return "reFlutter did not produce a patched build:\n" + "\n".join(tail)
    return f"reFlutter failed (exit code {result.get('returncode')})."
