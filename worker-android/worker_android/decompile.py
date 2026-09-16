"""On-demand, single-class decompilation. Two independent tools, run fresh
per request (nothing is cached to a worker-local volume — see the plan doc
for why): JADX genuinely only decompiles the requested class thanks to its
`--single-class` mode, so this is cheap regardless of APK size; apktool has
no equivalent flag, so the smali side always pays a whole-dex disassembly,
just discarding everything but the one file we asked for."""

import os
import shutil
import subprocess
import tempfile

EXTRACT_ROOT = os.environ.get("EXTRACT_DIR", "/work")
JADX_BIN = os.environ.get("JADX_BIN", "/opt/jadx/bin/jadx")
APKTOOL_JAR = os.environ.get("APKTOOL_JAR", "/opt/apktool.jar")

JADX_TIMEOUT_SECS = 120
APKTOOL_TIMEOUT_SECS = 180
MAX_SOURCE_BYTES = 2 * 1024 * 1024


def _cap(text: str) -> tuple[str, bool]:
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= MAX_SOURCE_BYTES:
        return text, False
    return encoded[:MAX_SOURCE_BYTES].decode("utf-8", errors="ignore"), True


def _run_jadx(apk_path: str, class_name: str, work_dir: str) -> tuple[str | None, str | None]:
    out_file = os.path.join(work_dir, "decompiled.java")
    try:
        proc = subprocess.run(
            [
                JADX_BIN,
                "--single-class",
                class_name,
                "--single-class-output",
                out_file,
                "-r",  # skip resource decoding, we don't need it here
                apk_path,
            ],
            capture_output=True,
            text=True,
            timeout=JADX_TIMEOUT_SECS,
        )
    except subprocess.TimeoutExpired:
        return None, "jadx timed out decompiling this class"
    except Exception as exc:
        return None, f"Failed to run jadx: {exc}"

    if os.path.isfile(out_file):
        with open(out_file, "r", encoding="utf-8", errors="replace") as f:
            return f.read(), None

    stderr_tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
    return None, stderr_tail or "jadx produced no output for this class"


def _dex_class_relpath(class_name: str) -> str:
    return class_name.replace(".", "/") + ".smali"


def _find_smali_file(apktool_out: str, class_name: str) -> str | None:
    rel = _dex_class_relpath(class_name)
    if not os.path.isdir(apktool_out):
        return None
    for entry in sorted(os.listdir(apktool_out)):
        if not entry.startswith("smali"):
            continue
        candidate = os.path.join(apktool_out, entry, rel)
        if os.path.isfile(candidate):
            return candidate
    return None


def _run_apktool(apk_path: str, class_name: str, work_dir: str) -> tuple[str | None, str | None]:
    out_dir = os.path.join(work_dir, "apktool_out")
    try:
        proc = subprocess.run(
            ["java", "-jar", APKTOOL_JAR, "d", "--no-res", "-f", "-o", out_dir, apk_path],
            capture_output=True,
            text=True,
            timeout=APKTOOL_TIMEOUT_SECS,
        )
    except subprocess.TimeoutExpired:
        return None, "apktool timed out disassembling this APK"
    except Exception as exc:
        return None, f"Failed to run apktool: {exc}"

    smali_path = _find_smali_file(out_dir, class_name)
    if smali_path:
        with open(smali_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(), None

    stderr_tail = (proc.stderr or proc.stdout or "").strip()[-2000:]
    return None, stderr_tail or f"No smali output found for {class_name}"


def decompile_class(apk_path: str, class_name: str) -> dict:
    os.makedirs(EXTRACT_ROOT, exist_ok=True)
    work_dir = tempfile.mkdtemp(prefix="decompile_", dir=EXTRACT_ROOT)
    try:
        java_code, java_error = _run_jadx(apk_path, class_name, work_dir)
        smali_code, smali_error = _run_apktool(apk_path, class_name, work_dir)

        truncated = False
        if java_code is not None:
            java_code, java_trunc = _cap(java_code)
            truncated = truncated or java_trunc
        if smali_code is not None:
            smali_code, smali_trunc = _cap(smali_code)
            truncated = truncated or smali_trunc

        return {
            "class_name": class_name,
            "java_code": java_code,
            "java_error": java_error,
            "smali_code": smali_code,
            "smali_error": smali_error,
            "truncated": truncated,
        }
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
