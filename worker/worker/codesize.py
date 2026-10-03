"""Measures how much code each function occupies, plus a per-segment/section
size breakdown of the binary — the numbers a class/function *count* can't
show. A protector that inflates function bodies (control-flow flattening,
junk code, inlined integrity checks) leaves every name and count untouched
while the binary grows by tens of MB; comparing sizes is what makes that
visible.

Function boundaries come from LC_FUNCTION_STARTS, which lists every
function's start address (named or not) and survives symbol stripping. A
function's size is the distance to the next start, clipped to the end of its
section. Without that load command we fall back to the named addresses we
already know, which only gives an upper bound (unnamed functions in between
get counted into their named predecessor). Layout verified against Apple's
cctools <mach-o/loader.h> (linkedit_data_command) and dyld's function-starts
reader."""

import struct
from bisect import bisect_right

from .machoimage import MachOImage

LC_FUNCTION_STARTS = 0x26


def _find_function_starts_command(data: bytes, base: int) -> tuple[int, int] | None:
    magic_be = struct.unpack_from(">I", data, base)[0]
    if magic_be not in (0xCFFAEDFE, 0xFEEDFACF):
        return None
    endian = "<" if magic_be == 0xCFFAEDFE else ">"

    ncmds = struct.unpack_from(endian + "I", data, base + 16)[0]
    offset = base + 32
    for _ in range(ncmds):
        cmd, cmdsize = struct.unpack_from(endian + "2I", data, offset)
        if cmd == LC_FUNCTION_STARTS:
            dataoff, datasize = struct.unpack_from(endian + "2I", data, offset + 8)
            return (base + dataoff, datasize)
        offset += cmdsize
    return None


def extract_function_starts(img: MachOImage) -> list[int]:
    """Every function start address, ascending. Empty if the binary has no
    LC_FUNCTION_STARTS. The payload is a zero-terminated run of ULEB128
    deltas, the first one relative to the __TEXT segment's vmaddr."""
    loc = _find_function_starts_command(img.data, img.base)
    if loc is None or img.image_base_vmaddr is None:
        return []
    pos, size = loc
    end = min(pos + size, len(img.data))

    starts: list[int] = []
    addr = img.image_base_vmaddr
    while pos < end:
        result, shift = 0, 0
        while pos < end:
            byte = img.data[pos]
            pos += 1
            result |= (byte & 0x7F) << shift
            if (byte & 0x80) == 0:
                break
            shift += 7
        if result == 0:
            break
        addr += result
        starts.append(addr)
    return starts


def _section_ranges(img: MachOImage) -> list[tuple[int, int]]:
    ranges = [(sec.addr, sec.addr + sec.size) for seg in img.segments for sec in seg.sections if sec.size]
    ranges.sort()
    return ranges


def _iter_named_functions(objc_classes: list[dict], symbols: list[dict]):
    for cls in objc_classes:
        yield from cls.get("instance_methods", [])
        yield from cls.get("class_methods", [])
    yield from symbols


def measure_code(
    data: bytes,
    slice_offset: int,
    slice_size: int,
    objc_classes: list[dict],
    symbols: list[dict],
) -> dict:
    """Adds a "size" key (bytes, or None if unknown) to every ObjC method and
    symbol dict passed in, and returns the binary-wide stats."""
    img = MachOImage(data, slice_offset)
    starts = extract_function_starts(img)

    named = [f for f in _iter_named_functions(objc_classes, symbols) if f.get("address") is not None]
    named_addresses = {f["address"] for f in named}

    boundaries = starts if starts else sorted(named_addresses)
    sections = _section_ranges(img)
    section_starts = [s for s, _ in sections]

    def size_of(address: int) -> int | None:
        idx = bisect_right(section_starts, address) - 1
        if idx < 0 or address >= sections[idx][1]:
            return None  # not inside any section — nothing sane to measure
        end = sections[idx][1]
        nxt = bisect_right(boundaries, address)
        if nxt < len(boundaries):
            end = min(end, boundaries[nxt])
        return end - address

    for f in _iter_named_functions(objc_classes, symbols):
        f["size"] = size_of(f["address"]) if f.get("address") is not None else None

    text = None
    for seg in img.segments:
        if seg.name == "__TEXT":
            text = next((sec for sec in seg.sections if sec.sectname == "__text"), None)
            break

    return {
        "file_size": len(data),
        "slice_size": slice_size,
        "text_size": text.size if text else None,
        "size_source": "function_starts" if starts else "named_symbols",
        "function_count": len(starts) if starts else None,
        "unnamed_function_count": len(set(starts) - named_addresses) if starts else None,
        "segments": [
            {
                "name": seg.name,
                "file_size": seg.filesize,
                "sections": [{"name": sec.sectname, "size": sec.size} for sec in seg.sections],
            }
            for seg in img.segments
        ],
    }
