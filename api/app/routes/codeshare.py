import hashlib
import json
import re
import urllib.request
from urllib.error import HTTPError, URLError

from fastapi import APIRouter, HTTPException

from ..schemas import CodeshareResolveRequest, CodeshareResolveResponse

router = APIRouter(tags=["codeshare"])

# Frida CodeShare identifies a script as "<author>/<slug>", e.g. the project at
# https://codeshare.frida.re/@dweinstein/pin-app/ has uri "dweinstein/pin-app".
# Keep this strict (no "/", "@", "." tricks) since it's interpolated straight
# into the codeshare.frida.re API URL we fetch server-side.
_SLUG_RE = re.compile(r"^[A-Za-z0-9_.-]+$")

CODESHARE_HOST_RE = re.compile(r"^(?:https?://)?(?:www\.)?codeshare\.frida\.re", re.IGNORECASE)


def _parse_uri(raw: str) -> tuple[str, str]:
    raw = raw.strip()
    if not raw:
        raise HTTPException(400, "Enter a Frida CodeShare link or <author>/<slug>.")

    raw = CODESHARE_HOST_RE.sub("", raw)
    raw = raw.strip("/")
    raw = raw.lstrip("@")

    parts = [p for p in raw.split("/") if p]
    if len(parts) != 2:
        raise HTTPException(
            400, "Expected a CodeShare link like https://codeshare.frida.re/@author/slug/ (or author/slug)."
        )

    author, slug = parts
    if not (_SLUG_RE.match(author) and _SLUG_RE.match(slug)):
        raise HTTPException(400, "CodeShare author/slug contains invalid characters.")

    return author, slug


@router.post("/api/codeshare/resolve", response_model=CodeshareResolveResponse)
def resolve_codeshare_script(body: CodeshareResolveRequest):
    author, slug = _parse_uri(body.input)
    uri = f"{author}/{slug}"
    project_url = f"https://codeshare.frida.re/api/project/{uri}/"

    request = urllib.request.Request(
        project_url,
        headers={"User-Agent": "iOSDeOb-DynamicAnalysis/1.0"},
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except HTTPError as e:
        if e.code == 404:
            raise HTTPException(404, f"No CodeShare project found at {uri}")
        raise HTTPException(502, f"CodeShare returned HTTP {e.code}")
    except URLError as e:
        raise HTTPException(502, f"Could not reach codeshare.frida.re: {e.reason}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(502, "CodeShare returned an unexpected response.")

    source = payload.get("source")
    if not isinstance(source, str) or not source.strip():
        raise HTTPException(502, "That CodeShare project has no script source.")

    fingerprint = hashlib.sha256(source.encode("utf-8")).hexdigest()

    return CodeshareResolveResponse(
        author=author,
        slug=slug,
        project_name=payload.get("project_name") or slug,
        source=source,
        fingerprint=fingerprint,
        url=f"https://codeshare.frida.re/@{uri}",
    )
