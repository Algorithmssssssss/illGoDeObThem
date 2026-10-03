import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import IPA, FileTreeNode, ObjCClass, APK, ApkFileTreeNode, DexClass
from ..services import get_class_summary, get_dex_class_summary, get_merged_functions
from ..schemas import (
    CompareResponse,
    CompareScanRef,
    FileDiffOut,
    FileEntryOut,
    FileChangedOut,
    ClassDiffOut,
    ClassSummaryOut,
    ClassChangedOut,
    FunctionChangedOut,
    FunctionDiffOut,
    BinaryStatsOut,
    BinaryRegionOut,
    BinaryDiffOut,
    ApkCompareResponse,
    ApkCompareScanRef,
    DexClassDiffOut,
    DexClassSummaryOut,
    DexClassChangedOut,
)

router = APIRouter(prefix="/api/compare", tags=["compare"])

MAX_DIFF_ITEMS = 2000


@router.get("", response_model=CompareResponse)
def compare_scans(a: str, b: str, db: Session = Depends(get_db)):
    if a == b:
        raise HTTPException(400, "Pick two different scans to compare")

    ipa_a = db.get(IPA, a)
    ipa_b = db.get(IPA, b)
    if not ipa_a or not ipa_b:
        raise HTTPException(404, "One or both scans not found")

    files = _diff_files(db, a, b)
    classes = _diff_classes(db, a, b)
    functions_a = get_merged_functions(db, a)
    functions_b = get_merged_functions(db, b)
    functions = _diff_functions(functions_a, functions_b)
    binary = _diff_binary(ipa_a, functions_a, ipa_b, functions_b)

    return CompareResponse(
        a=CompareScanRef(id=ipa_a.id, filename=ipa_a.original_filename),
        b=CompareScanRef(id=ipa_b.id, filename=ipa_b.original_filename),
        binary=binary,
        files=files,
        classes=classes,
        functions=functions,
    )


def _diff_files(db: Session, a: str, b: str) -> FileDiffOut:
    nodes_a = {n.path: n for n in db.query(FileTreeNode).filter(FileTreeNode.ipa_id == a).all()}
    nodes_b = {n.path: n for n in db.query(FileTreeNode).filter(FileTreeNode.ipa_id == b).all()}

    only_a = sorted(set(nodes_a) - set(nodes_b))
    only_b = sorted(set(nodes_b) - set(nodes_a))
    common = set(nodes_a) & set(nodes_b)

    changed = sorted(
        (
            FileChangedOut(path=p, size_a=nodes_a[p].size_bytes, size_b=nodes_b[p].size_bytes)
            for p in common
            if nodes_a[p].kind == "file"
            and nodes_b[p].kind == "file"
            and nodes_a[p].size_bytes != nodes_b[p].size_bytes
        ),
        key=lambda c: c.path,
    )

    return FileDiffOut(
        only_in_a=[FileEntryOut(path=p, kind=nodes_a[p].kind, size_bytes=nodes_a[p].size_bytes) for p in only_a[:MAX_DIFF_ITEMS]],
        only_in_a_total=len(only_a),
        only_in_b=[FileEntryOut(path=p, kind=nodes_b[p].kind, size_bytes=nodes_b[p].size_bytes) for p in only_b[:MAX_DIFF_ITEMS]],
        only_in_b_total=len(only_b),
        changed=changed[:MAX_DIFF_ITEMS],
        changed_total=len(changed),
        common_total=len(common),
    )


def _diff_classes(db: Session, a: str, b: str) -> ClassDiffOut:
    classes_a = {c.name: c for c in db.query(ObjCClass).filter(ObjCClass.ipa_id == a).all()}
    classes_b = {c.name: c for c in db.query(ObjCClass).filter(ObjCClass.ipa_id == b).all()}

    only_a = sorted(set(classes_a) - set(classes_b))
    only_b = sorted(set(classes_b) - set(classes_a))
    common = set(classes_a) & set(classes_b)

    changed = []
    for name in common:
        summary_a = get_class_summary(classes_a[name])
        summary_b = get_class_summary(classes_b[name])
        if summary_a != summary_b:
            changed.append(ClassChangedOut(name=name, a=ClassSummaryOut(**summary_a), b=ClassSummaryOut(**summary_b)))
    changed.sort(key=lambda c: c.name)

    return ClassDiffOut(
        only_in_a=[ClassSummaryOut(**get_class_summary(classes_a[n])) for n in only_a[:MAX_DIFF_ITEMS]],
        only_in_a_total=len(only_a),
        only_in_b=[ClassSummaryOut(**get_class_summary(classes_b[n])) for n in only_b[:MAX_DIFF_ITEMS]],
        only_in_b_total=len(only_b),
        changed=changed[:MAX_DIFF_ITEMS],
        changed_total=len(changed),
        common_total=len(common),
    )


def _function_sizes(functions: list[dict]) -> dict[str, int | None]:
    """name -> bytes of code. Names aren't unique (e.g. same-named static
    symbols), so duplicates are summed; None if any of them is unmeasured."""
    sizes: dict[str, int | None] = {}
    for f in functions:
        name, size = f["name"], f.get("size")
        if name in sizes:
            prev = sizes[name]
            sizes[name] = None if prev is None or size is None else prev + size
        else:
            sizes[name] = size
    return sizes


def _diff_functions(functions_a: list[dict], functions_b: list[dict]) -> FunctionDiffOut:
    sizes_a = _function_sizes(functions_a)
    sizes_b = _function_sizes(functions_b)
    names_a = set(sizes_a)
    names_b = set(sizes_b)

    only_a = sorted(names_a - names_b)
    only_b = sorted(names_b - names_a)
    common = names_a & names_b

    # A protector can rewrite every function body while leaving every name in
    # place, so "same name on both sides" says nothing on its own — the code
    # size is what shows whether the function was actually touched.
    changed = [
        FunctionChangedOut(name=n, size_a=sizes_a[n], size_b=sizes_b[n])
        for n in common
        if sizes_a[n] is not None and sizes_b[n] is not None and sizes_a[n] != sizes_b[n]
    ]
    changed.sort(key=lambda c: (-abs(c.size_b - c.size_a), c.name))

    return FunctionDiffOut(
        only_in_a=only_a[:MAX_DIFF_ITEMS],
        only_in_a_total=len(only_a),
        only_in_b=only_b[:MAX_DIFF_ITEMS],
        only_in_b_total=len(only_b),
        changed=changed[:MAX_DIFF_ITEMS],
        changed_total=len(changed),
        larger_in_a_total=sum(1 for c in changed if c.size_a > c.size_b),
        larger_in_b_total=sum(1 for c in changed if c.size_b > c.size_a),
        common_total=len(common),
    )


def _binary_stats(ipa: IPA, functions: list[dict]) -> tuple[BinaryStatsOut | None, list[dict]]:
    if not ipa.binary_stats_json:
        return None, []
    raw = json.loads(ipa.binary_stats_json)
    stats = BinaryStatsOut(
        path=raw.get("path"),
        file_size=raw.get("file_size"),
        text_size=raw.get("text_size"),
        size_source=raw.get("size_source"),
        function_count=raw.get("function_count"),
        unnamed_function_count=raw.get("unnamed_function_count"),
        named_function_count=len(functions),
        named_code_size=sum(f.get("size") or 0 for f in functions),
    )
    return stats, raw.get("segments", [])


def _diff_binary(ipa_a: IPA, functions_a: list[dict], ipa_b: IPA, functions_b: list[dict]) -> BinaryDiffOut:
    stats_a, segments_a = _binary_stats(ipa_a, functions_a)
    stats_b, segments_b = _binary_stats(ipa_b, functions_b)

    # One row per segment followed by its sections, in A's layout order with
    # anything that only exists in B slotted in after it.
    by_name_a = {seg["name"]: seg for seg in segments_a}
    by_name_b = {seg["name"]: seg for seg in segments_b}
    regions: list[BinaryRegionOut] = []
    for seg_name in list(by_name_a) + [n for n in by_name_b if n not in by_name_a]:
        seg_a = by_name_a.get(seg_name)
        seg_b = by_name_b.get(seg_name)
        regions.append(BinaryRegionOut(
            name=seg_name,
            kind="segment",
            size_a=seg_a["file_size"] if seg_a else None,
            size_b=seg_b["file_size"] if seg_b else None,
        ))
        sections_a = {s["name"]: s["size"] for s in seg_a["sections"]} if seg_a else {}
        sections_b = {s["name"]: s["size"] for s in seg_b["sections"]} if seg_b else {}
        for sec_name in list(sections_a) + [n for n in sections_b if n not in sections_a]:
            regions.append(BinaryRegionOut(
                name=f"{seg_name},{sec_name}",
                kind="section",
                size_a=sections_a.get(sec_name),
                size_b=sections_b.get(sec_name),
            ))

    return BinaryDiffOut(a=stats_a, b=stats_b, regions=regions)


@router.get("/apk", response_model=ApkCompareResponse)
def compare_apk_scans(a: str, b: str, db: Session = Depends(get_db)):
    if a == b:
        raise HTTPException(400, "Pick two different scans to compare")

    apk_a = db.get(APK, a)
    apk_b = db.get(APK, b)
    if not apk_a or not apk_b:
        raise HTTPException(404, "One or both scans not found")

    files = _diff_apk_files(db, a, b)
    classes = _diff_dex_classes(db, a, b)

    return ApkCompareResponse(
        a=ApkCompareScanRef(id=apk_a.id, filename=apk_a.original_filename),
        b=ApkCompareScanRef(id=apk_b.id, filename=apk_b.original_filename),
        files=files,
        classes=classes,
    )


def _diff_apk_files(db: Session, a: str, b: str) -> FileDiffOut:
    nodes_a = {n.path: n for n in db.query(ApkFileTreeNode).filter(ApkFileTreeNode.apk_id == a).all()}
    nodes_b = {n.path: n for n in db.query(ApkFileTreeNode).filter(ApkFileTreeNode.apk_id == b).all()}

    only_a = sorted(set(nodes_a) - set(nodes_b))
    only_b = sorted(set(nodes_b) - set(nodes_a))
    common = set(nodes_a) & set(nodes_b)

    changed = sorted(
        (
            FileChangedOut(path=p, size_a=nodes_a[p].size_bytes, size_b=nodes_b[p].size_bytes)
            for p in common
            if nodes_a[p].kind == "file"
            and nodes_b[p].kind == "file"
            and nodes_a[p].size_bytes != nodes_b[p].size_bytes
        ),
        key=lambda c: c.path,
    )

    return FileDiffOut(
        only_in_a=[FileEntryOut(path=p, kind=nodes_a[p].kind, size_bytes=nodes_a[p].size_bytes) for p in only_a[:MAX_DIFF_ITEMS]],
        only_in_a_total=len(only_a),
        only_in_b=[FileEntryOut(path=p, kind=nodes_b[p].kind, size_bytes=nodes_b[p].size_bytes) for p in only_b[:MAX_DIFF_ITEMS]],
        only_in_b_total=len(only_b),
        changed=changed[:MAX_DIFF_ITEMS],
        changed_total=len(changed),
        common_total=len(common),
    )


def _diff_dex_classes(db: Session, a: str, b: str) -> DexClassDiffOut:
    classes_a = {c.name: c for c in db.query(DexClass).filter(DexClass.apk_id == a).all()}
    classes_b = {c.name: c for c in db.query(DexClass).filter(DexClass.apk_id == b).all()}

    only_a = sorted(set(classes_a) - set(classes_b))
    only_b = sorted(set(classes_b) - set(classes_a))
    common = set(classes_a) & set(classes_b)

    changed = []
    for name in common:
        summary_a = get_dex_class_summary(classes_a[name])
        summary_b = get_dex_class_summary(classes_b[name])
        if summary_a != summary_b:
            changed.append(DexClassChangedOut(name=name, a=DexClassSummaryOut(**summary_a), b=DexClassSummaryOut(**summary_b)))
    changed.sort(key=lambda c: c.name)

    return DexClassDiffOut(
        only_in_a=[DexClassSummaryOut(**get_dex_class_summary(classes_a[n])) for n in only_a[:MAX_DIFF_ITEMS]],
        only_in_a_total=len(only_a),
        only_in_b=[DexClassSummaryOut(**get_dex_class_summary(classes_b[n])) for n in only_b[:MAX_DIFF_ITEMS]],
        only_in_b_total=len(only_b),
        changed=changed[:MAX_DIFF_ITEMS],
        changed_total=len(changed),
        common_total=len(common),
    )
