"""Parse the ``dump.dart`` a reFlutter-patched build writes on-device.

reFlutter's "display absolute code offsets" mode makes the patched Flutter
engine dump the reconstructed Dart program at launch: a flat text file of
libraries, the classes in each, and the functions in each class with their
absolute code offsets. The exact punctuation differs across reFlutter/engine
versions, so this parser is deliberately tolerant — it keys off the
``Library`` / ``Class`` / ``Function`` markers and the ``0x…`` offsets, and
keeps a sample of anything it couldn't place so the viewer degrades gracefully
instead of silently dropping data.
"""

import re

_OFFSET_RE = re.compile(r"0x[0-9a-fA-F]+")
_EXTENDS_RE = re.compile(r"\bextends\b\s*'?([^'{}\n]+?)'?\s*(?:[{]|$)", re.IGNORECASE)

# Cap how many unrecognized lines we echo back, so a malformed/huge file can't
# bloat the stored JSON. The counts in `stats` still reflect everything seen.
_MAX_UNPARSED_SAMPLE = 100


def _clean(text: str) -> str:
    """Strip surrounding quotes, braces and whitespace from a captured token."""
    return text.strip().strip("{}").strip().strip("'\"").strip()


def _extract_after_marker(line: str, marker: str) -> str:
    """Return the text after ``marker`` (and an optional following ``:``)."""
    idx = line.lower().find(marker.lower())
    rest = line[idx + len(marker):]
    rest = rest.lstrip()
    if rest.startswith(":"):
        rest = rest[1:]
    return rest


def parse_dump_dart(text: str) -> dict:
    """Parse ``dump.dart`` text into a Library → Class → Function tree.

    Returns ``{libraries, stats, unparsed_sample}`` where each library is
    ``{name, classes: [{name, extends, functions: [{name, offset}]}]}``.
    """
    libraries: list[dict] = []
    lib_index: dict[str, dict] = {}
    unparsed_sample: list[str] = []

    current_lib: dict | None = None
    current_class: dict | None = None

    n_lines = 0
    n_functions = 0
    n_unparsed = 0

    def ensure_lib(name: str) -> dict:
        nonlocal current_lib, current_class
        key = name or "(unknown library)"
        lib = lib_index.get(key)
        if lib is None:
            lib = {"name": key, "classes": []}
            lib_index[key] = lib
            libraries.append(lib)
        current_lib = lib
        current_class = None
        return lib

    def ensure_class(name: str, extends: str | None) -> dict:
        nonlocal current_class
        if current_lib is None:
            ensure_lib("(unknown library)")
        cls = {"name": name or "(anonymous)", "extends": extends, "functions": []}
        current_lib["classes"].append(cls)  # type: ignore[index]
        current_class = cls
        return cls

    def synthetic_class() -> dict:
        """Home for functions that appear with no enclosing class."""
        nonlocal current_class
        if current_lib is None:
            ensure_lib("(unknown library)")
        if current_class is None:
            current_class = {"name": "(top level)", "extends": None, "functions": []}
            current_lib["classes"].append(current_class)  # type: ignore[index]
        return current_class

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        n_lines += 1
        low = line.lower()

        if "library:" in low or low.startswith("library"):
            ensure_lib(_clean(_extract_after_marker(line, "Library")))
            continue

        if low.startswith("class:") or low.startswith("class ") or (" class:" in low and "function" not in low):
            after = _extract_after_marker(line, "Class")
            extends_m = _EXTENDS_RE.search(after)
            extends = _clean(extends_m.group(1)) if extends_m else None
            name = after
            if extends_m:
                name = after[: extends_m.start()]
            # Drop a trailing "{" and anything after a lone "extends" we didn't capture.
            name = re.split(r"\bextends\b", name, maxsplit=1, flags=re.IGNORECASE)[0]
            ensure_class(_clean(name), extends)
            continue

        if "function" in low:
            offset_m = _OFFSET_RE.search(line)
            offset = offset_m.group(0) if offset_m else None
            name = _extract_after_marker(line, "Function")
            if offset:
                name = name.replace(offset, "")
            name = _clean(name.strip(" :()"))
            synthetic_class()["functions"].append({"name": name or "(unnamed)", "offset": offset})
            n_functions += 1
            continue

        # No marker — but a bare "'name' (0x…)" under an open class is still a
        # function in many dumps. Anything else we keep as a sample.
        offset_m = _OFFSET_RE.search(line)
        if offset_m and current_class is not None:
            offset = offset_m.group(0)
            name = _clean(line.replace(offset, "").strip(" :()"))
            current_class["functions"].append({"name": name or "(unnamed)", "offset": offset})
            n_functions += 1
            continue

        n_unparsed += 1
        if len(unparsed_sample) < _MAX_UNPARSED_SAMPLE:
            unparsed_sample.append(line)

    n_classes = sum(len(lib["classes"]) for lib in libraries)
    return {
        "libraries": libraries,
        "stats": {
            "libraries": len(libraries),
            "classes": n_classes,
            "functions": n_functions,
            "lines": n_lines,
            "unparsed": n_unparsed,
        },
        "unparsed_sample": unparsed_sample,
    }
