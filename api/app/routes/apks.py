import hashlib
import json
import mimetypes
import os
import uuid
import zipfile

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..celery_client import enqueue_analyze_apk, enqueue_cleanup_apk, enqueue_decompile_class
from ..config import settings
from ..db import get_db
from ..fileread import read_member_preview
from ..models import APK, AndroidJob, ApkFileTreeNode, ManifestRecord, DexClass, DecompiledSource
from ..schemas import (
    APKOut,
    ApkFileTreeNodeOut,
    ManifestOut,
    AndroidJobOut,
    DexClassesResponse,
    DexClassOut,
    ClassSourceOut,
    ClassSourceRequestResult,
    FilePreviewOut,
)

router = APIRouter(prefix="/api/apks", tags=["apks"])

CHUNK_SIZE = 1024 * 1024


@router.post("/upload", response_model=APKOut)
async def upload_apk(file: UploadFile = File(...), db: Session = Depends(get_db)):
    if not file.filename.lower().endswith(".apk"):
        raise HTTPException(400, "Only .apk files are accepted")

    os.makedirs(settings.uploads_dir, exist_ok=True)
    apk_id = uuid.uuid4().hex
    storage_path = os.path.join(settings.uploads_dir, f"{apk_id}.apk")

    sha256 = hashlib.sha256()
    size = 0
    try:
        with open(storage_path, "wb") as out:
            while chunk := await file.read(CHUNK_SIZE):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise HTTPException(413, "File exceeds maximum allowed size")
                sha256.update(chunk)
                out.write(chunk)
    except HTTPException:
        if os.path.exists(storage_path):
            os.remove(storage_path)
        raise

    apk = APK(
        id=apk_id,
        original_filename=file.filename,
        sha256=sha256.hexdigest(),
        size_bytes=size,
        storage_path=storage_path,
        status="pending",
    )
    db.add(apk)
    db.flush()

    job = AndroidJob(apk_id=apk.id, phase="extract", status="queued")
    db.add(job)
    db.commit()

    task_id = enqueue_analyze_apk(apk.id, job.id, storage_path)
    job.celery_task_id = task_id
    db.commit()

    return apk


@router.get("", response_model=list[APKOut])
def list_apks(db: Session = Depends(get_db)):
    return db.query(APK).order_by(APK.uploaded_at.desc()).all()


@router.get("/{apk_id}", response_model=APKOut)
def get_apk(apk_id: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")
    return apk


@router.delete("/{apk_id}", status_code=204)
def delete_apk(apk_id: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")

    if os.path.exists(apk.storage_path):
        os.remove(apk.storage_path)

    db.delete(apk)  # cascades to file tree, manifest, classes, sources, jobs
    db.commit()

    enqueue_cleanup_apk(apk_id)
    return None


@router.get("/{apk_id}/jobs", response_model=list[AndroidJobOut])
def list_jobs(apk_id: str, db: Session = Depends(get_db)):
    return db.query(AndroidJob).filter(AndroidJob.apk_id == apk_id).all()


@router.get("/{apk_id}/tree", response_model=list[ApkFileTreeNodeOut])
def get_tree(apk_id: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")

    nodes = db.query(ApkFileTreeNode).filter(ApkFileTreeNode.apk_id == apk_id).all()
    by_path: dict[str, ApkFileTreeNodeOut] = {}
    for n in nodes:
        by_path[n.path] = ApkFileTreeNodeOut(
            path=n.path,
            name=n.name,
            kind=n.kind,
            size_bytes=n.size_bytes,
            mime_guess=n.mime_guess,
            is_main_binary=n.is_main_binary,
            children=[],
        )

    roots: list[ApkFileTreeNodeOut] = []
    for n in nodes:
        node_out = by_path[n.path]
        if n.parent_path and n.parent_path in by_path:
            by_path[n.parent_path].children.append(node_out)
        else:
            roots.append(node_out)

    def sort_children(node: ApkFileTreeNodeOut):
        node.children.sort(key=lambda c: (c.kind != "dir", c.name.lower()))
        for c in node.children:
            sort_children(c)

    roots.sort(key=lambda c: (c.kind != "dir", c.name.lower()))
    for r in roots:
        sort_children(r)

    return roots


@router.get("/{apk_id}/manifest", response_model=ManifestOut)
def get_manifest(apk_id: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")
    record = db.query(ManifestRecord).filter(ManifestRecord.apk_id == apk_id).first()
    if not record:
        raise HTTPException(404, "Manifest not parsed yet")
    warnings = json.loads(apk.warnings_json) if apk.warnings_json else []
    return ManifestOut(parsed=json.loads(record.parsed_json), warnings=warnings)


@router.get("/{apk_id}/classes", response_model=DexClassesResponse)
def get_classes(apk_id: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")
    records = db.query(DexClass).filter(DexClass.apk_id == apk_id).order_by(DexClass.name).all()
    classes = [
        DexClassOut(
            name=r.name,
            superclass=r.superclass,
            access_flags=r.access_flags,
            **json.loads(r.data_json),
        )
        for r in records
    ]
    warnings = json.loads(apk.warnings_json) if apk.warnings_json else []
    return DexClassesResponse(classes=classes, warnings=warnings)


@router.post("/{apk_id}/classes/{class_name}/decompile", response_model=ClassSourceRequestResult)
def request_decompile(apk_id: str, class_name: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")

    cached = (
        db.query(DecompiledSource)
        .filter(DecompiledSource.apk_id == apk_id, DecompiledSource.class_name == class_name)
        .first()
    )
    if cached:
        return ClassSourceRequestResult(
            cached=True,
            result=ClassSourceOut(
                class_name=cached.class_name,
                java_code=cached.java_code,
                java_error=cached.java_error,
                smali_code=cached.smali_code,
                smali_error=cached.smali_error,
                truncated=cached.truncated,
            ),
        )

    job = AndroidJob(apk_id=apk_id, phase="decompile", status="queued", context_class_name=class_name)
    db.add(job)
    db.commit()

    task_id = enqueue_decompile_class(apk_id, job.id, apk.storage_path, class_name)
    job.celery_task_id = task_id
    db.commit()

    return ClassSourceRequestResult(cached=False, job_id=job.id)


@router.get("/{apk_id}/classes/{class_name}/source", response_model=ClassSourceOut)
def get_class_source(apk_id: str, class_name: str, db: Session = Depends(get_db)):
    cached = (
        db.query(DecompiledSource)
        .filter(DecompiledSource.apk_id == apk_id, DecompiledSource.class_name == class_name)
        .first()
    )
    if not cached:
        raise HTTPException(404, "Not decompiled yet")
    return ClassSourceOut(
        class_name=cached.class_name,
        java_code=cached.java_code,
        java_error=cached.java_error,
        smali_code=cached.smali_code,
        smali_error=cached.smali_error,
        truncated=cached.truncated,
    )


@router.get("/{apk_id}/file", response_model=FilePreviewOut)
def get_file_preview(apk_id: str, path: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")
    try:
        preview = read_member_preview(apk.storage_path, path)
    except KeyError:
        raise HTTPException(404, "File not found in archive")
    except zipfile.BadZipFile:
        raise HTTPException(500, "Stored archive is corrupt")
    return preview


@router.get("/{apk_id}/file/download")
def download_file(apk_id: str, path: str, db: Session = Depends(get_db)):
    apk = db.get(APK, apk_id)
    if not apk:
        raise HTTPException(404, "APK not found")

    try:
        zf = zipfile.ZipFile(apk.storage_path)
        info = zf.getinfo(path)
        stream = zf.open(path)
    except KeyError:
        raise HTTPException(404, "File not found in archive")
    except zipfile.BadZipFile:
        raise HTTPException(500, "Stored archive is corrupt")

    filename = path.rsplit("/", 1)[-1]
    mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    def iter_and_close():
        try:
            while chunk := stream.read(1024 * 256):
                yield chunk
        finally:
            stream.close()
            zf.close()

    return StreamingResponse(
        iter_and_close(),
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(info.file_size),
        },
    )
