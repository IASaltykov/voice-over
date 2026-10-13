from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from defusedxml import ElementTree as SafeET

SUPPORTED_SUFFIXES = {".txt", ".md", ".markdown", ".fb2"}
EXCLUDED_DIRS = {"output", "cache", "logs", "models", ".venv", ".git", "__pycache__"}
DIVIDER = re.compile(r"^\s*#(?:\s+(.*?))?\s*$")
WINDOWS_FORBIDDEN = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


@dataclass(frozen=True)
class Block:
    index: int
    title: str
    text: str


@dataclass(frozen=True)
class Document:
    path: Path
    relative_path: Path
    blocks: tuple[Block, ...]
    kind: str
    book_title: str = ""
    author: str = ""


def natural_key(value: str | Path) -> list[object]:
    return [int(part) if part.isdigit() else part.casefold() for part in re.split(r"(\d+)", str(value))]


def decode_bytes(data: bytes, source: str) -> str:
    for encoding in ("utf-8-sig", "utf-8"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise UnicodeDecodeError("utf-8", data, 0, min(len(data), 1), f"Не удалось прочитать UTF-8: {source}")


def normalize_title(title: str, fallback: str = "") -> str:
    title = re.sub(r"\s+", " ", title).strip()
    title = WINDOWS_FORBIDDEN.sub("_", title).rstrip(" .")
    if not title:
        return fallback
    if title.upper() in RESERVED:
        title = f"_{title}"
    return title[:100].rstrip(" .") or fallback


def normalize_markdown(text: str) -> str:
    # Preserve content while removing syntax that should not be spoken literally.
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"^\s{0,3}(#{2,6})\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*```[^\n]*\n", "", text, flags=re.M)
    text = re.sub(r"^\s*```\s*$", "", text, flags=re.M)
    text = re.sub(r"[*_~`]", "", text)
    return text


def parse_delimited(text: str, markdown: bool = False) -> tuple[Block, ...]:
    blocks: list[tuple[str, list[str]]] = []
    current_title: str | None = None
    current: list[str] | None = None
    in_fence = False
    for line in text.splitlines():
        if re.match(r"^\s*```", line):
            in_fence = not in_fence
            if current is not None:
                current.append(line)
            continue
        match = None if (markdown and in_fence) else DIVIDER.fullmatch(line)
        if match:
            if current is not None:
                blocks.append((current_title or "", current))
            current_title, current = (match.group(1) or "").strip(), []
        elif current is not None:
            current.append(line)
    if current is not None:
        blocks.append((current_title or "", current))
    result: list[Block] = []
    for idx, (title, lines) in enumerate(blocks, 1):
        value = normalize_markdown("\n".join(lines)) if markdown else "\n".join(lines)
        value = "\n".join(line.rstrip() for line in value.splitlines()).strip()
        result.append(Block(idx, normalize_title(title), value))
    return tuple(result)


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(element, name: str):
    return [child for child in list(element) if _local_name(child.tag) == name]


def _text(element) -> str:
    return " ".join(part.strip() for part in element.itertext() if part.strip())


def parse_fb2_bytes(data: bytes, source: str, max_section_depth: int = 1, include_epigraphs: bool = True, include_poems: bool = True, include_notes: bool = False, speak_titles: bool = False) -> tuple[Block, ...]:
    root = SafeET.fromstring(data)
    description = next((x for x in root.iter() if _local_name(x.tag) == "description"), None)
    book_title = ""
    author = ""
    if description is not None:
        title_node = next((x for x in description.iter() if _local_name(x.tag) == "book-title"), None)
        book_title = _text(title_node) if title_node is not None else ""
        first = next((x for x in description.iter() if _local_name(x.tag) == "first-name"), None)
        last = next((x for x in description.iter() if _local_name(x.tag) == "last-name"), None)
        author = " ".join(x for x in (_text(first) if first is not None else "", _text(last) if last is not None else "") if x)
    bodies = [x for x in root.iter() if _local_name(x.tag) == "body"]
    sections = [x for x in (bodies[0] if bodies else root) if _local_name(x.tag) == "section"]

    def section_title(section) -> str:
        title = next((x for x in list(section) if _local_name(x.tag) == "title"), None)
        return _text(title) if title is not None else ""

    def content(section, depth: int) -> list[str]:
        pieces: list[str] = []
        for child in list(section):
            name = _local_name(child.tag)
            if name == "section":
                if depth < max_section_depth:
                    pieces.extend(content(child, depth + 1))
                else:
                    pieces.extend(content(child, depth + 1))
            elif name == "title":
                if speak_titles and depth == 1:
                    pieces.append(_text(child))
            elif name == "annotation":
                continue
            elif name == "epigraph":
                if include_epigraphs:
                    pieces.append(_text(child))
            elif name == "poem":
                if include_poems:
                    pieces.append("\n".join(_text(x) for x in child.iter() if _local_name(x.tag) in {"v", "stanza"}))
            elif name in {"p", "subtitle", "text-author", "cite"}:
                value = _text(child)
                if value:
                    pieces.append(value)
            elif name == "a" and include_notes:
                value = _text(child)
                if value:
                    pieces.append(value)
        return pieces

    selected = sections or [root]
    blocks: list[Block] = []
    for idx, section in enumerate(selected, 1):
        title = normalize_title(section_title(section), f"Chapter {idx}")
        body = "\n\n".join(x for x in content(section, 1) if x.strip()).strip()
        blocks.append(Block(idx, title, body))
    return tuple(blocks)


def parse_file(path: Path, relative_path: Path, fb2_options: dict | None = None) -> Document:
    options = fb2_options or {}
    if path.name.casefold().endswith(".fb2.zip"):
        blocks: list[Block] = []
        with zipfile.ZipFile(path) as archive:
            entries = [x for x in archive.infolist() if not x.is_dir() and x.filename.casefold().endswith(".fb2")]
            total = 0
            if len(entries) > 20:
                raise ValueError(f"В архиве слишком много FB2-файлов: {path}")
            for entry in entries:
                total += entry.file_size
                if total > 100 * 1024 * 1024:
                    raise ValueError(f"Распакованный размер FB2.ZIP превышает 100 МБ: {path}")
                raw = archive.read(entry)
                parsed = parse_fb2_bytes(raw, f"{path}!{entry.filename}", max_section_depth=int(options.get("max_section_depth", 1)), include_epigraphs=bool(options.get("include_epigraphs", True)), include_poems=bool(options.get("include_poems", True)), include_notes=bool(options.get("include_notes", False)), speak_titles=bool(options.get("speak_chapter_titles", False)))
                blocks.extend(Block(len(blocks) + i, b.title, b.text) for i, b in enumerate(parsed, 1))
        return Document(path, relative_path, tuple(blocks), "fb2.zip")
    raw = path.read_bytes()
    if path.suffix.casefold() == ".fb2":
        blocks = parse_fb2_bytes(raw, str(path), max_section_depth=int(options.get("max_section_depth", 1)), include_epigraphs=bool(options.get("include_epigraphs", True)), include_poems=bool(options.get("include_poems", True)), include_notes=bool(options.get("include_notes", False)), speak_titles=bool(options.get("speak_chapter_titles", False)))
        return Document(path, relative_path, blocks, "fb2")
    text = decode_bytes(raw, str(path))
    blocks = parse_delimited(text, markdown=path.suffix.casefold() in {".md", ".markdown"})
    return Document(path, relative_path, blocks, "markdown" if path.suffix.casefold() in {".md", ".markdown"} else "text")


def discover(root: Path, excluded: Iterable[str] = EXCLUDED_DIRS) -> list[Path]:
    excluded_set = {x.casefold() for x in excluded}
    result: list[Path] = []
    for path in root.rglob("*"):
        if path.is_symlink() or not path.is_file():
            continue
        if any(part.casefold() in excluded_set for part in path.relative_to(root).parts[:-1]):
            continue
        name = path.name.casefold()
        if name.endswith(".fb2.zip") or path.suffix.casefold() in SUPPORTED_SUFFIXES:
            result.append(path)
    return sorted(result, key=lambda p: natural_key(p.relative_to(root)))


def parse_documents(path: Path, relative_path: Path, fb2_options: dict | None = None) -> list[Document]:
    relative_path = Path(relative_path)
    if not path.name.casefold().endswith(".fb2.zip"):
        return [parse_file(path, relative_path, fb2_options)]
    options = fb2_options or {}
    documents: list[Document] = []
    with zipfile.ZipFile(path) as archive:
        entries = sorted((x for x in archive.infolist() if not x.is_dir() and x.filename.casefold().endswith(".fb2")), key=lambda x: natural_key(x.filename))
        total = 0
        if len(entries) > 20:
            raise ValueError(f"В архиве слишком много FB2-файлов: {path}")
        for entry in entries:
            total += entry.file_size
            if total > 100 * 1024 * 1024:
                raise ValueError(f"Распакованный размер FB2.ZIP превышает 100 МБ: {path}")
            blocks = parse_fb2_bytes(archive.read(entry), f"{path}!{entry.filename}", max_section_depth=int(options.get("max_section_depth", 1)), include_epigraphs=bool(options.get("include_epigraphs", True)), include_poems=bool(options.get("include_poems", True)), include_notes=bool(options.get("include_notes", False)), speak_titles=bool(options.get("speak_chapter_titles", False)))
            suffix = normalize_title(Path(entry.filename).stem, "book")
            virtual_relative = relative_path.with_name(relative_path.name + "__" + suffix)
            documents.append(Document(path, virtual_relative, blocks, "fb2.zip"))
    return documents


def output_document_dir(output_root: Path, relative: Path) -> Path:
    name = relative.name[:-8] if relative.name.casefold().endswith(".fb2.zip") else relative.stem
    return output_root / relative.parent / normalize_title(name, "document")
