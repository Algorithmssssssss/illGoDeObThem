import logging
import mimetypes
import os
import shutil
import tempfile
import zipfile
from typing import Callable

EXTRACT_ROOT = os.environ.get("EXTRACT_DIR", "/work")

ProgressFn = Callable[[int, str | None, str | None], None]

# androguard logs verbosely at DEBUG/INFO via both stdlib logging and loguru;
# neither is useful in a Celery worker's output.
logging.getLogger("androguard").setLevel(logging.ERROR)
try:
    from loguru import logger as _loguru_logger

    _loguru_logger.remove()
except Exception:
    pass


def _safe_extract(zf: zipfile.ZipFile, dest: str) -> None:
    dest_abs = os.path.abspath(dest)
    for member in zf.infolist():
        member_path = os.path.abspath(os.path.join(dest, member.filename))
        if member_path != dest_abs and not member_path.startswith(dest_abs + os.sep):
            raise ValueError(f"Refusing to extract unsafe zip entry path: {member.filename!r}")
    zf.extractall(dest)


def _guess_mime(name: str) -> str | None:
    mime, _ = mimetypes.guess_type(name)
    return mime


def _is_dex_file(name: str) -> bool:
    return name == "classes.dex" or (name.startswith("classes") and name.endswith(".dex"))


def _build_file_tree(root_dir: str) -> list[dict]:
    nodes: list[dict] = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        rel_dir = os.path.relpath(dirpath, root_dir)
        rel_dir = "" if rel_dir == "." else rel_dir

        for d in dirnames:
            rel_path = f"{rel_dir}/{d}" if rel_dir else d
            nodes.append(
                {
                    "parent_path": rel_dir or None,
                    "path": rel_path,
                    "name": d,
                    "kind": "dir",
                    "size_bytes": None,
                    "mime_guess": None,
                    "is_main_binary": False,
                }
            )

        for fname in filenames:
            rel_path = f"{rel_dir}/{fname}" if rel_dir else fname
            full_path = os.path.join(dirpath, fname)
            try:
                size = os.path.getsize(full_path)
            except OSError:
                size = None
            nodes.append(
                {
                    "parent_path": rel_dir or None,
                    "path": rel_path,
                    "name": fname,
                    "kind": "file",
                    "size_bytes": size,
                    "mime_guess": _guess_mime(fname),
                    "is_main_binary": _is_dex_file(fname),
                }
            )
    return nodes


def _dotted_class_name(raw: str) -> str:
    """'Lcom/foo/Bar$Inner;' -> 'com.foo.Bar$Inner'"""
    name = raw
    if name.startswith("L") and name.endswith(";"):
        name = name[1:-1]
    return name.replace("/", ".")


def _parse_manifest(apk) -> dict:
    return {
        "package": apk.get_package(),
        "app_name": apk.get_app_name(),
        "version_name": apk.get_androidversion_name(),
        "version_code": apk.get_androidversion_code(),
        "min_sdk_version": apk.get_min_sdk_version(),
        "target_sdk_version": apk.get_target_sdk_version(),
        "is_multidex": apk.is_multidex(),
        "is_signed": apk.is_signed(),
        "main_activity": apk.get_main_activity(),
        "permissions": apk.get_permissions(),
        "activities": apk.get_activities(),
        "services": apk.get_services(),
        "receivers": apk.get_receivers(),
        "providers": apk.get_providers(),
        "features": apk.get_features(),
        "libraries": apk.get_libraries(),
    }


def _parse_methods(class_analysis) -> list[dict]:
    methods = []
    for ma in class_analysis.get_methods():
        methods.append(
            {
                "name": ma.name,
                "descriptor": ma.descriptor,
                "access_flags": ma.access,
            }
        )
    return methods


def _parse_fields(class_analysis) -> list[dict]:
    fields = []
    for fa in class_analysis.get_fields():
        ef = fa.get_field()
        fields.append(
            {
                "name": ef.get_name(),
                "descriptor": ef.get_descriptor(),
                "access_flags": ef.get_access_flags_string(),
            }
        )
    return fields


def _parse_classes(dx) -> dict:
    warnings: list[str] = []
    classes: list[dict] = []
    unresolved = 0

    internal = list(dx.get_internal_classes())

    for ca in internal:
        try:
            vm_class = ca.get_vm_class()
            interfaces = [_dotted_class_name(i) for i in (ca.implements or [])]
            classes.append(
                {
                    "name": _dotted_class_name(ca.name),
                    "superclass": _dotted_class_name(ca.extends) if ca.extends else None,
                    "interfaces": interfaces,
                    "access_flags": vm_class.get_access_flags_string() if vm_class else None,
                    "methods": _parse_methods(ca),
                    "fields": _parse_fields(ca),
                }
            )
        except Exception:
            unresolved += 1

    if unresolved:
        warnings.append(f"{unresolved} of {len(internal)} classes could not be fully parsed.")

    classes.sort(key=lambda c: c["name"].lower())
    return {"classes": classes, "warnings": warnings}


def analyze(apk_id: str, storage_path: str, progress: ProgressFn) -> dict:
    progress(5, "Extracting APK", "extract")
    os.makedirs(EXTRACT_ROOT, exist_ok=True)
    work_dir = tempfile.mkdtemp(prefix="apk_", dir=EXTRACT_ROOT)
    try:
        with zipfile.ZipFile(storage_path) as zf:
            _safe_extract(zf, work_dir)

        progress(25, "Building file tree", "extract")
        nodes = _build_file_tree(work_dir)

        manifest_warnings: list[str] = []
        manifest: dict = {}
        classes_result = {"classes": [], "warnings": []}

        try:
            # androguard.misc.AnalyzeAPK does the full parse + cross-reference
            # pass in one call and hands back the same APK object get_package()
            # etc. read from, so the manifest and class-list phases below both
            # reuse it rather than re-parsing the APK twice.
            from androguard.misc import AnalyzeAPK

            progress(45, "Parsing AndroidManifest.xml", "extract")
            apk, _dex_list, dx = AnalyzeAPK(storage_path)
            manifest = _parse_manifest(apk)

            progress(70, "Parsing DEX class list", "extract")
            classes_result = _parse_classes(dx)
        except Exception as exc:
            manifest_warnings.append(f"Manifest/DEX parsing failed: {exc}")

        progress(90, "Finalizing", "extract")
        return {
            "file_tree": nodes,
            "manifest": manifest,
            "classes": classes_result["classes"],
            "warnings": classes_result["warnings"] + manifest_warnings,
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
