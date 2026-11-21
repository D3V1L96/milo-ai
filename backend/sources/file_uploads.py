"""Local, size-limited file storage and safe document extraction."""
from __future__ import annotations

import io
import re
import time
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO
from xml.etree import ElementTree

from PIL import Image, UnidentifiedImageError
from docx import Document
from docx.opc.exceptions import PackageNotFoundError
from pypdf import PdfReader
from pypdf.errors import PdfReadError

MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
MAX_ANALYSIS_FILE_BYTES = 100 * 1024 * 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024
MAX_EXTRACTED_CHARACTERS = 80_000
UPLOAD_TTL_SECONDS = 60 * 60
_TEXT_EXTENSIONS = {
    ".txt", ".md", ".csv", ".json", ".yaml", ".yml", ".xml", ".html",
    ".css", ".js", ".jsx", ".ts", ".tsx", ".py", ".ps1", ".log", ".rtf",
    ".sql", ".toml", ".ini", ".java", ".c", ".cpp", ".h", ".hpp", ".go",
    ".rs", ".sh", ".bat", ".properties",
}
_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}


class FileUploadError(Exception):
    pass


class FileTooLargeError(FileUploadError):
    pass


@dataclass(frozen=True)
class UploadedFile:
    id: str
    name: str
    content_type: str
    size: int
    path: Path
    created_at: float

    def public_data(self) -> dict[str, str | int]:
        return {
            "id": self.id,
            "name": self.name,
            "contentType": self.content_type,
            "size": self.size,
        }


class FileStore:
    def __init__(self, root: Path | None = None) -> None:
        local_app_data = Path.home()
        try:
            import os
            local_app_data = Path(os.environ.get(
                "LOCALAPPDATA", str(local_app_data / "AppData" / "Local")
            ))
        except OSError as exc:
            raise FileUploadError(f"Could not locate local app storage: {exc}") from exc
        self.root = root or local_app_data / "MILO" / "Uploads"
        self._files: dict[str, UploadedFile] = {}

    def save(self, name: str, content_type: str, data: bytes) -> UploadedFile:
        return self.save_stream(name, content_type, io.BytesIO(data))

    def save_stream(self, name: str, content_type: str, stream: BinaryIO) -> UploadedFile:
        if not name or not name.strip():
            raise FileUploadError("Choose a file with a name.")
        self._remove_expired()
        safe_name = Path(name.replace("\\", "/")).name[:180]
        suffix = Path(safe_name).suffix.lower()
        file_id = uuid.uuid4().hex
        path = self.root / f"{file_id}{suffix}"
        size = 0
        try:
            self.root.mkdir(parents=True, exist_ok=True)
            with path.open("wb") as target:
                while True:
                    chunk = stream.read(UPLOAD_CHUNK_BYTES)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > MAX_UPLOAD_BYTES:
                        raise FileTooLargeError("Files must be 2 GB or smaller.")
                    target.write(chunk)
        except FileTooLargeError as exc:
            try:
                path.unlink(missing_ok=True)
            except OSError as cleanup_error:
                raise FileUploadError(
                    f"{exc} Also could not remove the partial upload: {cleanup_error}"
                ) from cleanup_error
            raise
        except (OSError, ValueError) as exc:
            try:
                path.unlink(missing_ok=True)
            except OSError as cleanup_error:
                raise FileUploadError(
                    f"Could not store the uploaded file locally: {exc}. "
                    f"Also could not remove the partial upload: {cleanup_error}"
                ) from cleanup_error
            raise FileUploadError(f"Could not store the uploaded file locally: {exc}") from exc
        uploaded = UploadedFile(
            id=file_id,
            name=safe_name,
            content_type=content_type or "application/octet-stream",
            size=size,
            path=path,
            created_at=time.time(),
        )
        self._files[file_id] = uploaded
        return uploaded

    def get(self, file_id: str) -> UploadedFile:
        self._remove_expired()
        uploaded = self._files.get(file_id)
        if uploaded is None or not uploaded.path.is_file():
            raise FileUploadError("That upload expired or is no longer available. Please attach it again.")
        return uploaded

    def extract(self, file_id: str) -> dict[str, Any]:
        uploaded = self.get(file_id)
        suffix = uploaded.path.suffix.casefold()
        if suffix not in _TEXT_EXTENSIONS and uploaded.size > MAX_ANALYSIS_FILE_BYTES:
            raise FileUploadError(
                f"{uploaded.name} was uploaded, but file analysis is limited to 100 MB. "
                "Larger files can still be sent on WhatsApp."
            )
        try:
            if suffix in _TEXT_EXTENSIONS:
                with uploaded.path.open("r", encoding="utf-8-sig") as source:
                    text = source.read(MAX_EXTRACTED_CHARACTERS + 1)
                if suffix == ".rtf":
                    text = re.sub(r"\\'[0-9a-fA-F]{2}|\\[a-z]+-?\d* ?|[{}]", " ", text)
            elif suffix == ".pdf":
                reader = PdfReader(str(uploaded.path))
                if reader.is_encrypted:
                    raise FileUploadError("This PDF is password-protected and cannot be read.")
                text = "\n".join(
                    page.extract_text() or ""
                    for page in reader.pages[:100]
                )
            elif suffix == ".docx":
                self._validate_office_archive(uploaded.path)
                document = Document(str(uploaded.path))
                text = "\n".join(
                    paragraph.text for paragraph in document.paragraphs if paragraph.text
                )
                for table in document.tables:
                    text += "\n" + "\n".join(
                        " | ".join(cell.text for cell in row.cells) for row in table.rows
                    )
            elif suffix in {".xlsx", ".pptx"}:
                self._validate_office_archive(uploaded.path)
                text = self._extract_office_xml(uploaded.path, suffix)
            elif suffix in _IMAGE_EXTENSIONS:
                return {"text": "", "images": [self._image_for_vision(uploaded.path)]}
            else:
                raise FileUploadError(
                    f"MILO can send {suffix or 'this file'} on WhatsApp, but cannot read this format yet."
                )
        except FileUploadError:
            raise
        except (
            OSError,
            UnicodeError,
            ValueError,
            zipfile.BadZipFile,
            ElementTree.ParseError,
            PackageNotFoundError,
            PdfReadError,
        ) as exc:
            raise FileUploadError(f"Could not read {uploaded.name}: {exc}") from exc

        text = text[:MAX_EXTRACTED_CHARACTERS]
        if not text.strip():
            raise FileUploadError(
                f"No readable text was found in {uploaded.name}. You can still send it on WhatsApp."
            )
        return {"text": text, "images": []}

    @staticmethod
    def _validate_office_archive(path: Path) -> None:
        with zipfile.ZipFile(path) as archive:
            files = archive.infolist()
            if len(files) > 10_000:
                raise FileUploadError("This office document contains too many files to analyze.")
            if sum(item.file_size for item in files) > MAX_ANALYSIS_FILE_BYTES:
                raise FileUploadError(
                    "This office document expands beyond the 100 MB analysis limit."
                )

    @staticmethod
    def _extract_office_xml(path: Path, suffix: str) -> str:
        with zipfile.ZipFile(path) as archive:
            if suffix == ".pptx":
                names = sorted(
                    name for name in archive.namelist()
                    if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
                )
                parts = []
                for name in names:
                    root = ElementTree.fromstring(archive.read(name))
                    parts.extend(element.text or "" for element in root.iter()
                                 if element.tag.endswith("}t"))
                return "\n".join(parts)

            shared: list[str] = []
            if "xl/sharedStrings.xml" in archive.namelist():
                root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
                shared = [
                    "".join(element.text or "" for element in item.iter()
                            if element.tag.endswith("}t"))
                    for item in root
                ]
            parts = []
            sheets = sorted(
                name for name in archive.namelist()
                if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
            )
            for name in sheets:
                root = ElementTree.fromstring(archive.read(name))
                for cell in root.iter():
                    if not cell.tag.endswith("}c"):
                        continue
                    value = cell.find("{*}v")
                    if value is None or value.text is None:
                        continue
                    if cell.get("t") == "s":
                        try:
                            parts.append(shared[int(value.text)])
                        except (ValueError, IndexError):
                            continue
                    else:
                        parts.append(value.text)
            return "\n".join(parts)

    @staticmethod
    def _image_for_vision(path: Path) -> str:
        try:
            with Image.open(path) as image:
                image.thumbnail((1600, 1600))
                if image.mode not in {"RGB", "L"}:
                    image = image.convert("RGB")
                output = io.BytesIO()
                image.save(output, format="JPEG", quality=85, optimize=True)
        except (OSError, UnidentifiedImageError, Image.DecompressionBombError) as exc:
            raise FileUploadError(f"Could not read this image: {exc}") from exc
        import base64
        return base64.b64encode(output.getvalue()).decode("ascii")

    def _remove_expired(self) -> None:
        cutoff = time.time() - UPLOAD_TTL_SECONDS
        for file_id, uploaded in tuple(self._files.items()):
            if uploaded.created_at >= cutoff:
                continue
            self._files.pop(file_id, None)
            try:
                uploaded.path.unlink(missing_ok=True)
            except OSError:
                pass
