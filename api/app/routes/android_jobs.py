import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Header, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..models import APK, AndroidJob, ApkFileTreeNode, ManifestRecord, DexClass, DecompiledSource
from ..schemas import AndroidJobOut
from ..ws import broadcaster

router = APIRouter(tags=["android-jobs"])


@router.get("/api/android-jobs/{job_id}", response_model=AndroidJobOut)
def get_job(job_id: str, db: Session = Depends(get_db)):
    job = db.get(AndroidJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    return job


@router.websocket("/ws/android-jobs/{job_id}")
async def job_progress_ws(websocket: WebSocket, job_id: str):
    await websocket.accept()
    await broadcaster.subscribe(job_id, websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await broadcaster.unsubscribe(job_id, websocket)


def _require_internal_token(x_internal_token: str = Header(default="")):
    if x_internal_token != settings.internal_token:
        raise HTTPException(403, "Invalid internal token")


class ProgressPayload(BaseModel):
    progress_pct: int
    message: str | None = None
    phase: str | None = None


class ApkFileTreeNodeIn(BaseModel):
    parent_path: str | None
    path: str
    name: str
    kind: str
    size_bytes: int | None = None
    mime_guess: str | None = None
    is_main_binary: bool = False


class DexMethodIn(BaseModel):
    name: str
    descriptor: str | None = None
    access_flags: str | None = None


class DexFieldIn(BaseModel):
    name: str
    descriptor: str | None = None
    access_flags: str | None = None


class DexClassIn(BaseModel):
    name: str
    superclass: str | None = None
    access_flags: str | None = None
    interfaces: list[str] = []
    methods: list[DexMethodIn] = []
    fields: list[DexFieldIn] = []


class AnalyzeCompletePayload(BaseModel):
    success: bool
    error_message: str | None = None
    file_tree: list[ApkFileTreeNodeIn] = []
    manifest: dict = {}
    classes: list[DexClassIn] = []
    warnings: list[str] = []


class DecompileResultIn(BaseModel):
    class_name: str
    java_code: str | None = None
    java_error: str | None = None
    smali_code: str | None = None
    smali_error: str | None = None
    truncated: bool = False


class DecompileCompletePayload(BaseModel):
    success: bool
    error_message: str | None = None
    result: DecompileResultIn | None = None


@router.post("/internal/android-jobs/{job_id}/progress", dependencies=[Depends(_require_internal_token)])
async def internal_job_progress(job_id: str, payload: ProgressPayload, db: Session = Depends(get_db)):
    job = db.get(AndroidJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")
    job.status = "running"
    job.progress_pct = payload.progress_pct
    job.message = payload.message
    if payload.phase:
        job.phase = payload.phase
    if not job.started_at:
        job.started_at = datetime.utcnow()
    db.commit()

    await broadcaster.publish(job_id, {
        "job_id": job_id,
        "status": job.status,
        "progress_pct": job.progress_pct,
        "message": job.message,
        "phase": job.phase,
    })
    return {"ok": True}


@router.post("/internal/android-jobs/{job_id}/complete", dependencies=[Depends(_require_internal_token)])
async def internal_job_complete(job_id: str, payload: AnalyzeCompletePayload, db: Session = Depends(get_db)):
    job = db.get(AndroidJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    apk = db.get(APK, job.apk_id)

    if payload.success:
        db.query(ApkFileTreeNode).filter(ApkFileTreeNode.apk_id == job.apk_id).delete()
        db.query(ManifestRecord).filter(ManifestRecord.apk_id == job.apk_id).delete()
        db.query(DexClass).filter(DexClass.apk_id == job.apk_id).delete()

        for node in payload.file_tree:
            db.add(ApkFileTreeNode(
                apk_id=job.apk_id,
                parent_path=node.parent_path,
                path=node.path,
                name=node.name,
                kind=node.kind,
                size_bytes=node.size_bytes,
                mime_guess=node.mime_guess,
                is_main_binary=node.is_main_binary,
            ))

        if payload.manifest:
            db.add(ManifestRecord(apk_id=job.apk_id, parsed_json=json.dumps(payload.manifest)))

        for cls in payload.classes:
            db.add(DexClass(
                apk_id=job.apk_id,
                name=cls.name,
                superclass=cls.superclass,
                access_flags=cls.access_flags,
                data_json=json.dumps({
                    "interfaces": cls.interfaces,
                    "methods": [m.model_dump() for m in cls.methods],
                    "fields": [f.model_dump() for f in cls.fields],
                }),
            ))

        job.status = "done"
        job.progress_pct = 100
        if apk:
            apk.status = "ready"
            apk.warnings_json = json.dumps(payload.warnings)
            apk.app_name = payload.manifest.get("app_name") or None
            apk.package_name = payload.manifest.get("package")
            apk.version_name = payload.manifest.get("version_name")
            apk.version_code = str(payload.manifest.get("version_code")) if payload.manifest.get("version_code") is not None else None
            apk.min_sdk_version = str(payload.manifest.get("min_sdk_version")) if payload.manifest.get("min_sdk_version") is not None else None
            apk.target_sdk_version = str(payload.manifest.get("target_sdk_version")) if payload.manifest.get("target_sdk_version") is not None else None
    else:
        job.status = "failed"
        job.error_message = payload.error_message
        if apk:
            apk.status = "failed"
            apk.error_message = payload.error_message

    job.finished_at = datetime.utcnow()
    db.commit()

    await broadcaster.publish(job_id, {
        "job_id": job_id,
        "status": job.status,
        "progress_pct": job.progress_pct,
        "message": job.error_message if not payload.success else "done",
    })
    return {"ok": True}


@router.post("/internal/android-jobs/{job_id}/decompile_complete", dependencies=[Depends(_require_internal_token)])
async def internal_decompile_complete(job_id: str, payload: DecompileCompletePayload, db: Session = Depends(get_db)):
    job = db.get(AndroidJob, job_id)
    if not job:
        raise HTTPException(404, "Job not found")

    if payload.success and payload.result:
        result = payload.result
        db.query(DecompiledSource).filter(
            DecompiledSource.apk_id == job.apk_id, DecompiledSource.class_name == result.class_name
        ).delete()
        db.add(DecompiledSource(
            apk_id=job.apk_id,
            class_name=result.class_name,
            java_code=result.java_code,
            java_error=result.java_error,
            smali_code=result.smali_code,
            smali_error=result.smali_error,
            truncated=result.truncated,
        ))
        job.status = "done"
        job.progress_pct = 100
    else:
        job.status = "failed"
        job.error_message = payload.error_message

    job.finished_at = datetime.utcnow()
    db.commit()

    await broadcaster.publish(job_id, {
        "job_id": job_id,
        "status": job.status,
        "progress_pct": job.progress_pct,
        "message": job.error_message if not payload.success else "done",
    })
    return {"ok": True}
