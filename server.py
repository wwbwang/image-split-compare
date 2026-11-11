"""Read-only HTTP service for comparing same-named images across directories."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path, PurePosixPath
from urllib.parse import parse_qs, quote, unquote, urlsplit

APP_DIR = Path(__file__).resolve().parent
DEFAULT_ROOT = Path("/")
INDEX_PATH = APP_DIR / "index.html"
IMAGE_CACHE_PATH = APP_DIR / "image-cache.js"
IMAGE_EXTENSIONS = {".bmp", ".jpeg", ".jpg", ".png", ".webp"}
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
MEDIA_RE = re.compile(r"^/media/([A-Za-z0-9_-]+)/([A-Za-z0-9_-]+)$")
ROOT_ID = "root"
CHUNK_SIZE = 1024 * 1024


class CatalogError(ValueError):
    """Raised when a requested path is outside the read-only image catalog."""


def natural_key(value: str) -> tuple:
    """Sort digit runs numerically while keeping deterministic case-sensitive ties."""
    parts = re.split(r"(\d+)", value)
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold(), part)
        for part in parts
        if part
    )


class ImageCatalog:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise CatalogError(f"Image root is not a directory: {self.root}")
        self._index_cache: dict[
            str, tuple[int, list[dict], dict[str, dict]]
        ] = {}

    @staticmethod
    def encode_id(value: str) -> str:
        if value == "":
            return ROOT_ID
        payload = value.encode("utf-8")
        return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")

    @staticmethod
    def decode_id(value_id: str) -> str:
        if value_id == ROOT_ID:
            return ""
        if not value_id or not ID_RE.fullmatch(value_id):
            raise CatalogError("Invalid opaque id.")
        padding = "=" * (-len(value_id) % 4)
        try:
            payload = base64.b64decode(
                value_id + padding, altchars=b"-_", validate=True
            ).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as error:
            raise CatalogError("Invalid opaque id.") from error
        if not payload or ImageCatalog.encode_id(payload) != value_id:
            raise CatalogError("Non-canonical opaque id.")
        return payload

    def resolve_directory(self, directory_id: str) -> tuple[Path, str]:
        relative = self.decode_id(directory_id)
        if relative == "":
            return self.root, ""
        pure_path = PurePosixPath(relative)
        if pure_path.is_absolute() or not pure_path.parts or ".." in pure_path.parts:
            raise CatalogError("Directory path escapes the configured root.")
        try:
            path = self.root.joinpath(*pure_path.parts).resolve(strict=True)
        except (FileNotFoundError, RuntimeError) as error:
            raise CatalogError("Directory does not exist.") from error
        if not path.is_relative_to(self.root) or not path.is_dir():
            raise CatalogError("Directory path escapes the configured root.")
        canonical_relative = path.relative_to(self.root).as_posix()
        if canonical_relative != relative:
            raise CatalogError("Directory id does not resolve to its canonical path.")
        return path, relative

    def id_for_path(self, raw_path: str) -> str:
        path = Path(raw_path)
        if not path.is_absolute():
            raise CatalogError("Enter an absolute directory path.")
        try:
            path = path.resolve(strict=True)
        except (OSError, RuntimeError) as error:
            raise CatalogError("Directory does not exist.") from error
        if not path.is_dir() or not path.is_relative_to(self.root):
            raise CatalogError("Directory is outside the configured root.")
        relative = path.relative_to(self.root).as_posix()
        return self.encode_id("" if relative == "." else relative)

    @staticmethod
    def _validate_basename(name: str) -> None:
        pure_name = PurePosixPath(name)
        if (
            not name
            or pure_name.is_absolute()
            or len(pure_name.parts) != 1
            or name in {".", ".."}
        ):
            raise CatalogError("Image name must be one direct basename.")

    def resolve_image(
        self, directory_id: str, name_id: str
    ) -> tuple[Path, str, str]:
        directory, relative_directory = self.resolve_directory(directory_id)
        name = self.decode_id(name_id)
        self._validate_basename(name)
        try:
            path = (directory / name).resolve(strict=True)
        except (FileNotFoundError, RuntimeError) as error:
            raise CatalogError("Image does not exist.") from error
        if (
            not path.is_relative_to(self.root)
            or path.parent != directory
            or path.name != name
            or not path.is_file()
            or path.suffix.lower() not in IMAGE_EXTENSIONS
        ):
            raise CatalogError("Requested path is not a supported direct image.")
        return path, relative_directory, name

    def invalidate(self, directory_ids: list[str] | None = None) -> None:
        if directory_ids is None:
            self._index_cache.clear()
            return
        for directory_id in directory_ids:
            self._index_cache.pop(directory_id, None)

    def directory_index(self, directory_id: str, refresh: bool = False) -> list[dict]:
        directory, _ = self.resolve_directory(directory_id)
        if refresh:
            self._index_cache.pop(directory_id, None)
        fingerprint = directory.stat().st_mtime_ns
        cached = self._index_cache.get(directory_id)
        if cached is not None and cached[0] == fingerprint:
            return cached[1]

        images = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if (
                    not entry.is_file(follow_symlinks=False)
                    or Path(entry.name).suffix.lower() not in IMAGE_EXTENSIONS
                ):
                    continue
                stat = entry.stat(follow_symlinks=False)
                images.append(
                    {
                        "name": entry.name,
                        "nameId": self.encode_id(entry.name),
                        "size": stat.st_size,
                        "mtime": stat.st_mtime,
                        "version": f"{stat.st_mtime_ns:x}-{stat.st_size:x}",
                    }
                )
        images.sort(key=lambda item: natural_key(item["name"]))
        self._index_cache[directory_id] = (
            fingerprint,
            images,
            {item["name"]: item for item in images},
        )
        return images

    def directory_map(self, directory_id: str, refresh: bool = False) -> dict[str, dict]:
        self.directory_index(directory_id, refresh=refresh)
        return self._index_cache[directory_id][2]

    def browse(self, directory_id: str, refresh: bool = False) -> dict:
        directory, relative = self.resolve_directory(directory_id)
        children = []
        with os.scandir(directory) as entries:
            for entry in entries:
                if not entry.is_dir(follow_symlinks=False):
                    continue
                child_relative = (
                    entry.name if relative == "" else f"{relative}/{entry.name}"
                )
                children.append(
                    {"id": self.encode_id(child_relative), "name": entry.name}
                )
        children.sort(key=lambda item: natural_key(item["name"]))

        breadcrumbs = [{"id": ROOT_ID, "name": self.root.name or "/", "path": ""}]
        if relative:
            parts = PurePosixPath(relative).parts
            for end in range(1, len(parts) + 1):
                breadcrumb_relative = PurePosixPath(*parts[:end]).as_posix()
                breadcrumbs.append(
                    {
                        "id": self.encode_id(breadcrumb_relative),
                        "name": parts[end - 1],
                        "path": breadcrumb_relative,
                    }
                )
        parent_relative = (
            PurePosixPath(relative).parent.as_posix() if relative else None
        )
        if parent_relative == ".":
            parent_relative = ""
        return {
            "root": str(self.root),
            "current": {
                "id": directory_id,
                "path": relative,
                "name": directory.name or "/",
                "imageCount": len(self.directory_index(directory_id, refresh=refresh)),
            },
            "parentId": (
                self.encode_id(parent_relative) if parent_relative is not None else None
            ),
            "breadcrumbs": breadcrumbs,
            "directories": children,
        }

    def compare(self, directory_ids: list[str], refresh: bool = False) -> dict:
        if not 2 <= len(directory_ids) <= 6:
            raise CatalogError("Comparison requires two to six directories (including optional references).")
        indexes = [
            self.directory_index(directory_id, refresh=refresh)
            for directory_id in directory_ids
        ]
        maps = [self.directory_map(directory_id) for directory_id in directory_ids]
        master_names = [item["name"] for item in indexes[0]]
        master_set = set(master_names)
        groups = []
        for position, (directory_id, index, name_map) in enumerate(
            zip(directory_ids, indexes, maps)
        ):
            _, relative = self.resolve_directory(directory_id)
            names = set(name_map)
            groups.append(
                {
                    "id": directory_id,
                    "label": chr(ord("A") + position),
                    "path": relative,
                    "name": Path(relative).name if relative else self.root.name or "/",
                    "imageCount": len(index),
                    "availableCount": len(master_set & names),
                    "missingCount": len(master_set - names),
                    "extraCount": len(names - master_set),
                }
            )
        return {
            "root": str(self.root),
            "files": master_names,
            "groups": groups,
            "indexes": indexes,
        }

    def current_images(self, directory_ids: list[str], name: str) -> dict:
        if not 2 <= len(directory_ids) <= 6:
            raise CatalogError("Comparison requires two to six directories (including optional references).")
        self._validate_basename(name)
        entries = []
        for position, directory_id in enumerate(directory_ids):
            _, relative = self.resolve_directory(directory_id)
            image = self.directory_map(directory_id).get(name)
            entries.append(
                {
                    "id": directory_id,
                    "label": chr(ord("A") + position),
                    "path": relative,
                    "exists": image is not None,
                    "name": name,
                    "nameId": image["nameId"] if image else None,
                    "size": image["size"] if image else None,
                    "mtime": image["mtime"] if image else None,
                    "version": image["version"] if image else None,
                }
            )
        return {"name": name, "images": entries}


def make_handler(catalog: ImageCatalog, index_path: Path = INDEX_PATH):
    index_bytes = index_path.read_bytes()
    image_cache_bytes = IMAGE_CACHE_PATH.read_bytes()

    class ImageCompareHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "ImageCompare/1.0"

        def do_GET(self) -> None:
            self._handle(head_only=False)

        def do_HEAD(self) -> None:
            self._handle(head_only=True)

        def do_POST(self) -> None:
            self._send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "Read-only service."})

        def _handle(self, head_only: bool) -> None:
            parsed = urlsplit(self.path)
            path = unquote(parsed.path)
            query = parse_qs(parsed.query, keep_blank_values=True)
            if path in {"/", "/index.html"}:
                self._send_bytes(
                    HTTPStatus.OK,
                    index_bytes,
                    "text/html; charset=utf-8",
                    head_only=head_only,
                )
                return
            if path == "/healthz":
                self._send_json(
                    HTTPStatus.OK,
                    {"status": "ok", "root": str(catalog.root)},
                    head_only=head_only,
                )
                return
            if path == "/image-cache.js":
                self._send_bytes(
                    HTTPStatus.OK,
                    image_cache_bytes,
                    "text/javascript; charset=utf-8",
                    head_only=head_only,
                )
                return
            if path == "/api/browse":
                directory_id = (query.get("dir") or [ROOT_ID])[0]
                refresh = (query.get("refresh") or ["0"])[0] == "1"
                raw_path = (query.get("path") or [None])[0]
                self._catalog_json(
                    lambda: catalog.browse(
                        catalog.id_for_path(raw_path) if raw_path is not None else directory_id,
                        refresh=refresh,
                    ),
                    head_only,
                )
                return
            if path == "/api/compare":
                directory_ids = query.get("dirs") or []
                refresh = (query.get("refresh") or ["0"])[0] == "1"
                self._catalog_json(
                    lambda: catalog.compare(directory_ids, refresh=refresh), head_only
                )
                return
            if path == "/api/current":
                directory_ids = query.get("dirs") or []
                names = query.get("name") or []
                if len(names) != 1:
                    self._send_json(
                        HTTPStatus.BAD_REQUEST,
                        {"error": "Exactly one image name is required."},
                        head_only=head_only,
                    )
                else:
                    self._catalog_json(
                        lambda: catalog.current_images(directory_ids, names[0]),
                        head_only,
                    )
                return

            media_match = MEDIA_RE.fullmatch(path)
            if media_match:
                self._send_media(
                    media_match.group(1), media_match.group(2), head_only=head_only
                )
                return
            self._send_json(
                HTTPStatus.NOT_FOUND, {"error": "Not found."}, head_only=head_only
            )

        def _catalog_json(self, callback, head_only: bool) -> None:
            try:
                payload = callback()
            except (CatalogError, OSError) as error:
                self._send_json(
                    HTTPStatus.BAD_REQUEST, {"error": str(error)}, head_only=head_only
                )
            else:
                self._send_json(HTTPStatus.OK, payload, head_only=head_only)

        def _send_media(
            self, directory_id: str, name_id: str, head_only: bool
        ) -> None:
            try:
                path, _, name = catalog.resolve_image(directory_id, name_id)
            except CatalogError as error:
                self._send_json(
                    HTTPStatus.NOT_FOUND, {"error": str(error)}, head_only=head_only
                )
                return
            size = path.stat().st_size
            content_type = mimetypes.guess_type(name)[0] or "application/octet-stream"
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header(
                "Content-Disposition", f"inline; filename*=UTF-8''{quote(name)}"
            )
            self.end_headers()
            if head_only:
                return
            try:
                with path.open("rb") as image_file:
                    while chunk := image_file.read(CHUNK_SIZE):
                        self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return

        def _send_json(self, status, payload, head_only: bool = False) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self._send_bytes(
                status,
                data,
                "application/json; charset=utf-8",
                head_only=head_only,
            )

        def _send_bytes(
            self, status, payload: bytes, content_type: str, head_only: bool = False
        ) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            if not head_only:
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    return

    return ImageCompareHandler


class ImageCompareServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def build_server(host: str, port: int, catalog: ImageCatalog) -> ImageCompareServer:
    return ImageCompareServer((host, port), make_handler(catalog))


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8801)
    parser.add_argument("--image-root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--check", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    catalog = ImageCatalog(args.image_root)
    if args.check:
        print(json.dumps({"root": str(catalog.root), "status": "ok"}, ensure_ascii=False))
        return
    server = build_server(args.host, args.port, catalog)
    print(
        f"Image Compare serving {catalog.root} at "
        f"http://{args.host}:{server.server_address[1]}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
