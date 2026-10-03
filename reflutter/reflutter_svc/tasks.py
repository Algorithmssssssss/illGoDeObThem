import os
import shutil

import requests

from .celery_app import celery_app
from .runner import run_reflutter_cli, summarize_failure

API_INTERNAL_URL = os.environ.get("API_INTERNAL_URL", "http://api:8000")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "dev-internal-token-change-me")
WORK_DIR = os.environ.get("WORK_DIR", "/work")
ARTIFACTS_DIR = os.environ.get("REFLUTTER_ARTIFACTS_DIR", "/reflutter-artifacts")


def _headers() -> dict:
    return {"X-Internal-Token": INTERNAL_TOKEN}


def _report_progress(job_id: str, pct: int, message: str | None = None) -> None:
    try:
        requests.post(
            f"{API_INTERNAL_URL}/internal/reflutter/{job_id}/progress",
            json={"progress_pct": pct, "message": message},
            headers=_headers(),
            timeout=10,
        )
    except Exception:
        pass  # best-effort; final state is still reported via /complete


@celery_app.task(name="reflutter.tasks.run_reflutter", bind=True)
def run_reflutter(self, job_id: str, input_path: str, mode: str, proxy_ip: str | None, platform: str) -> bool:
    work_dir = os.path.join(WORK_DIR, job_id)
    payload: dict

    try:
        _report_progress(job_id, 15, "Preparing input…")
        _report_progress(job_id, 30, "Running reFlutter (fetching engine & patching)…")
        result = run_reflutter_cli(input_path, mode, proxy_ip, work_dir)

        artifact = result["artifact"]
        if result["returncode"] != 0 or not artifact:
            payload = {
                "success": False,
                "output_log": result["output_log"],
                "snapshot_hash": result["snapshot_hash"],
                "error_message": summarize_failure(result),
            }
        else:
            _report_progress(job_id, 85, "Collecting patched artifact…")
            dest_dir = os.path.join(ARTIFACTS_DIR, job_id)
            os.makedirs(dest_dir, exist_ok=True)
            artifact_name = os.path.basename(artifact)
            dest = os.path.join(dest_dir, artifact_name)
            shutil.move(artifact, dest)
            payload = {
                "success": True,
                "output_log": result["output_log"],
                "snapshot_hash": result["snapshot_hash"],
                "artifact_path": dest,
                "artifact_filename": artifact_name,
            }
    except Exception as exc:  # includes subprocess.TimeoutExpired
        payload = {"success": False, "error_message": str(exc) or exc.__class__.__name__}
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    try:
        requests.post(
            f"{API_INTERNAL_URL}/internal/reflutter/{job_id}/complete",
            json=payload,
            headers=_headers(),
            timeout=60,
        )
    except Exception:
        pass

    return bool(payload.get("success"))
