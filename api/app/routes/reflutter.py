import hashlib
import json
import os
import shutil
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..celery_client import enqueue_reflutter
from ..config import settings
from ..db import get_db
from ..models import DumpDart, ReflutterJob
from ..reflutter_dump import parse_dump_dart
from ..routes.jobs import _require_internal_token
from ..schemas import (
    DumpDartOut,
    DumpDartSummaryOut,
    ReflutterCompletePayload,
    ReflutterJobOut,
)

router = APIRouter(tags=["reflutter"])

CHUNK_SIZE = 1024 * 1024
VALID_MODES = {"traffic", "snapshot"}
# dump.dart is plain text but can be large for a big app; cap it well under the
# binary upload ceiling so a pasted-in wrong file fails fast.
MAX_DUMP_BYTES = 64 * 1024 * 1024


def _job_out(job: ReflutterJob) -> ReflutterJobOut:
    return ReflutterJobOut(
        id=job.id,
        platform=job.platform,
        original_filename=job.original_filename,
        size_bytes=job.size_bytes,
        mode=job.mode,
        proxy_ip=job.proxy_ip,
        status=job.status,
        progress_pct=job.progress_pct,
        message=job.message,
        error_message=job.error_message,
        output_log=job.output_log,
        snapshot_hash=job.snapshot_hash,
        artifact_filename=job.artifact_filename,
        has_artifact=bool(job.artifact_path and os.path.exists(job.artifact_path)),
        created_at=job.created_at,
        finished_at=job.finished_at,
    )


# ---------------------------------------------------------------------------
# reFlutter patch jobs
# ---------------------------------------------------------------------------


@router.post("/api/reflutter/upload", response_model=ReflutterJobOut)
async def upload_reflutter(
    file: UploadFile = File(...),
    mode: str = Form(...),
    proxy_ip: str | None = Form(None),
    db: Session = Depends(get_db),
):
    name = (file.filename or "").lower()
    if name.endswith(".ipa"):
        platform, ext = "ios", ".ipa"
    elif name.endswith(".apk"):
        platform, ext = "android", ".apk"
    else:
        raise HTTPException(400, "Only .ipa or .apk files are accepted")

    if mode not in VALID_MODES:
        raise HTTPException(400, f"mode must be one of {sorted(VALID_MODES)}")

    proxy_ip = (proxy_ip or "").strip() or None
    if mode == "traffic" and not proxy_ip:
        raise HTTPException(400, "A proxy IP is required for traffic-monitoring mode")
    if mode == "snapshot":
        proxy_ip = None  # not meaningful for the offset-dump mode

    os.makedirs(settings.uploads_dir, exist_ok=True)
    job_id = uuid.uuid4().hex
    input_path = os.path.join(settings.uploads_dir, f"reflutter-{job_id}{ext}")

    sha256 = hashlib.sha256()
    size = 0
    try:
        with open(input_path, "wb") as out:
            while chunk := await file.read(CHUNK_SIZE):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(413, "File exceeds maximum allowed size")
                sha256.update(chunk)
                out.write(chunk)
    except HTTPException:
        if os.path.exists(input_path):
            os.remove(input_path)
        raise

    job = ReflutterJob(
        id=job_id,
        platform=platform,
        original_filename=file.filename,
        sha256=sha256.hexdigest(),
        size_bytes=size,
        input_path=input_path,
        mode=mode,
        proxy_ip=proxy_ip,
        status="queued",
    )
    db.add(job)
    db.commit()

    task_id = enqueue_reflutter(job.id, input_path, mode, proxy_ip, platform)
    job.celery_task_id = task_id
    db.commit()

    return _job_out(job)


@router.get("/api/reflutter/jobs", response_model=list[ReflutterJobOut])
def list_reflutter_jobs(db: Session = Depends(get_db)):
    jobs = db.query(ReflutterJob).order_by(ReflutterJob.created_at.desc()).all()
    return [_job_out(j) for j in jobs]


@router.get("/api/reflutter/jobs/{job_id}", response_model=ReflutterJobOut)
def get_reflutter_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ReflutterJob, job_id)
    if not job:
        raise HTTPException(404, "reFlutter job not found")
    return _job_out(job)


@router.delete("/api/reflutter/jobs/{job_id}", status_code=204)
def delete_reflutter_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ReflutterJob, job_id)
    if not job:
        raise HTTPException(404, "reFlutter job not found")

    if job.input_path and os.path.exists(job.input_path):
        os.remove(job.input_path)
    _remove_artifact_dir(job)

    db.delete(job)  # cascades to this job's dump.dart rows
    db.commit()
    return None


@router.get("/api/reflutter/jobs/{job_id}/artifact")
def download_artifact(job_id: str, db: Session = Depends(get_db)):
    job = db.get(ReflutterJob, job_id)
    if not job:
        raise HTTPException(404, "reFlutter job not found")
    if not job.artifact_path or not os.path.exists(job.artifact_path):
        raise HTTPException(404, "No patched artifact available for this job")

    path = job.artifact_path
    filename = job.artifact_filename or os.path.basename(path)
    size = os.path.getsize(path)

    def iter_file():
        with open(path, "rb") as fh:
            while chunk := fh.read(256 * 1024):
                yield chunk

    return StreamingResponse(
        iter_file(),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(size),
        },
    )


# ---------------------------------------------------------------------------
# dump.dart viewer
# ---------------------------------------------------------------------------


@router.post("/api/reflutter/dumpdart/upload", response_model=DumpDartOut)
async def upload_dumpdart(
    file: UploadFile = File(...),
    reflutter_job_id: str | None = Form(None),
    db: Session = Depends(get_db),
):
    reflutter_job_id = (reflutter_job_id or "").strip() or None
    if reflutter_job_id and not db.get(ReflutterJob, reflutter_job_id):
        raise HTTPException(404, "reFlutter job not found")

    size = 0
    buf = bytearray()
    while chunk := await file.read(CHUNK_SIZE):
        size += len(chunk)
        if size > MAX_DUMP_BYTES:
            raise HTTPException(413, "dump.dart exceeds the maximum allowed size")
        buf.extend(chunk)

    text = buf.decode("utf-8", errors="replace")
    parsed = parse_dump_dart(text)

    dump = DumpDart(
        reflutter_job_id=reflutter_job_id,
        original_filename=file.filename or "dump.dart",
        size_bytes=size,
        parsed_json=json.dumps(parsed),
    )
    db.add(dump)
    db.commit()

    return DumpDartOut(
        id=dump.id,
        reflutter_job_id=dump.reflutter_job_id,
        original_filename=dump.original_filename,
        size_bytes=dump.size_bytes,
        parsed=parsed,
        created_at=dump.created_at,
    )


@router.get("/api/reflutter/dumpdart", response_model=list[DumpDartSummaryOut])
def list_dumpdarts(db: Session = Depends(get_db)):
    dumps = db.query(DumpDart).order_by(DumpDart.created_at.desc()).all()
    out = []
    for d in dumps:
        parsed = json.loads(d.parsed_json)
        out.append(
            DumpDartSummaryOut(
                id=d.id,
                reflutter_job_id=d.reflutter_job_id,
                original_filename=d.original_filename,
                size_bytes=d.size_bytes,
                stats=parsed.get("stats", {}),
                created_at=d.created_at,
            )
        )
    return out


@router.get("/api/reflutter/dumpdart/{dump_id}", response_model=DumpDartOut)
def get_dumpdart(dump_id: str, db: Session = Depends(get_db)):
    d = db.get(DumpDart, dump_id)
    if not d:
        raise HTTPException(404, "dump.dart not found")
    return DumpDartOut(
        id=d.id,
        reflutter_job_id=d.reflutter_job_id,
        original_filename=d.original_filename,
        size_bytes=d.size_bytes,
        parsed=json.loads(d.parsed_json),
        created_at=d.created_at,
    )


@router.delete("/api/reflutter/dumpdart/{dump_id}", status_code=204)
def delete_dumpdart(dump_id: str, db: Session = Depends(get_db)):
    d = db.get(DumpDart, dump_id)
    if not d:
        raise HTTPException(404, "dump.dart not found")
    db.delete(d)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# Internal callbacks (from the reflutter service) — token-guarded
# ---------------------------------------------------------------------------


class ReflutterProgressPayload(BaseModel):
    progress_pct: int
    message: str | None = None


@router.post("/internal/reflutter/{job_id}/progress", dependencies=[Depends(_require_internal_token)])
def internal_reflutter_progress(job_id: str, payload: ReflutterProgressPayload, db: Session = Depends(get_db)):
    job = db.get(ReflutterJob, job_id)
    if not job:
        raise HTTPException(404, "reFlutter job not found")
    job.status = "running"
    job.progress_pct = payload.progress_pct
    job.message = payload.message
    db.commit()
    return {"ok": True}


@router.post("/internal/reflutter/{job_id}/complete", dependencies=[Depends(_require_internal_token)])
def internal_reflutter_complete(job_id: str, payload: ReflutterCompletePayload, db: Session = Depends(get_db)):
    job = db.get(ReflutterJob, job_id)
    if not job:
        raise HTTPException(404, "reFlutter job not found")

    job.output_log = payload.output_log
    job.snapshot_hash = payload.snapshot_hash
    if payload.success:
        job.status = "done"
        job.progress_pct = 100
        job.artifact_path = payload.artifact_path
        job.artifact_filename = payload.artifact_filename
    else:
        job.status = "failed"
        job.error_message = payload.error_message

    job.finished_at = datetime.utcnow()
    db.commit()
    return {"ok": True}


def _remove_artifact_dir(job: ReflutterJob) -> None:
    """Remove this job's artifact directory, but only if it's safely under the
    artifacts root (never follow an unexpected absolute path out of it)."""
    if not job.artifact_path:
        return
    artifacts_root = os.path.realpath(settings.reflutter_artifacts_dir)
    job_dir = os.path.realpath(os.path.dirname(job.artifact_path))
    if job_dir == artifacts_root or not job_dir.startswith(artifacts_root + os.sep):
        return
    shutil.rmtree(job_dir, ignore_errors=True)
