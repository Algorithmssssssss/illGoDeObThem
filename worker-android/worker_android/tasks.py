import os

import requests

from .celery_app import celery_app
from .decompile import decompile_class as run_decompile_class
from .extract import analyze

API_INTERNAL_URL = os.environ.get("API_INTERNAL_URL", "http://api:8000")
INTERNAL_TOKEN = os.environ.get("INTERNAL_TOKEN", "dev-internal-token-change-me")


def _headers() -> dict:
    return {"X-Internal-Token": INTERNAL_TOKEN}


def _report_progress(job_id: str, pct: int, message: str | None = None, phase: str | None = None) -> None:
    try:
        requests.post(
            f"{API_INTERNAL_URL}/internal/android-jobs/{job_id}/progress",
            json={"progress_pct": pct, "message": message, "phase": phase},
            headers=_headers(),
            timeout=10,
        )
    except Exception:
        pass  # best-effort; final state is still reported via the complete callback


@celery_app.task(name="worker_android.tasks.analyze_apk", bind=True)
def analyze_apk(self, apk_id: str, job_id: str, storage_path: str) -> bool:
    def progress(pct: int, message: str | None = None, phase: str | None = None) -> None:
        _report_progress(job_id, pct, message, phase)

    try:
        result = analyze(apk_id, storage_path, progress)
        payload = {
            "success": True,
            "file_tree": result["file_tree"],
            "manifest": result["manifest"],
            "classes": result["classes"],
            "warnings": result["warnings"],
        }
    except Exception as exc:
        payload = {"success": False, "error_message": str(exc)}

    requests.post(
        f"{API_INTERNAL_URL}/internal/android-jobs/{job_id}/complete",
        json=payload,
        headers=_headers(),
        # No cap on how many classes get returned (see extract.py), so a
        # heavily-multidexed/obfuscated APK's class list can be large enough
        # that 60s is cutting it close for the POST + the API's bulk insert.
        timeout=300,
    )
    return payload["success"]


@celery_app.task(name="worker_android.tasks.decompile_class", bind=True)
def decompile_class(self, apk_id: str, job_id: str, storage_path: str, class_name: str) -> bool:
    try:
        result = run_decompile_class(storage_path, class_name)
        payload = {"success": True, "result": result}
    except Exception as exc:
        payload = {"success": False, "error_message": str(exc)}

    requests.post(
        f"{API_INTERNAL_URL}/internal/android-jobs/{job_id}/decompile_complete",
        json=payload,
        headers=_headers(),
        timeout=60,
    )
    return payload["success"]


@celery_app.task(name="worker_android.tasks.cleanup_apk")
def cleanup_apk(apk_id: str) -> bool:
    return True
