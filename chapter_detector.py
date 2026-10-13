from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass

from parser import Block, Document, normalize_markdown


@dataclass(frozen=True)
class Paragraph:
    id: str
    index: int
    text: str


@dataclass(frozen=True)
class Chapter:
    index: int
    title: str
    text: str
    paragraph_start: int
    paragraph_end: int
    method: str
    confidence: float


def _looks_like_heading(line: str) -> bool:
    return bool(re.match(r"^\s*(?:#\s+\S|Глава\s+\d+|Chapter\s+\d+|Часть\s+(?:[IVXLC]+|\d+)|Part\s+(?:[IVXLC]+|\d+)|Пролог|Эпилог|Введение|Заключение)\b", line, re.I))


def paragraphs(text: str) -> list[Paragraph]:
    values: list[str] = []
    current: list[str] = []
    for line in text.splitlines():
        if not line.strip() or (current and _looks_like_heading(line)):
            if current:
                values.append("\n".join(current).strip())
                current = []
            if not line.strip():
                continue
        current.append(line)
    if current:
        values.append("\n".join(current).strip())
    values = [x for x in values if x]
    return [Paragraph(f"P{i:06d}", i, value) for i, value in enumerate(values, 1)]


def _title_from_paragraph(value: str) -> str | None:
    line = value.splitlines()[0].strip()
    patterns = (
        r"^(?:Глава|Chapter)\s+\d+(?:\s*[.:—-].*)?$",
        r"^(?:Часть|Part)\s+(?:[IVXLC]+|\d+)(?:\s*[.:—-].*)?$",
        r"^(?:Пролог|Эпилог|Введение|Заключение)$",
        r"^\d+[.)]\s+\S+",
    )
    return line[:100] if any(re.match(pattern, line, re.I) for pattern in patterns) else None


def _safe_blocks(ps: list[Paragraph], boundaries: list[tuple[int, str, float]]) -> tuple[Block, ...]:
    if not ps:
        return ()
    raw_starts = [(1, "", 1.0)]
    raw_starts.extend((index + 1, title, confidence) for index, title, confidence in boundaries if 0 <= index < len(ps))
    unique_starts: dict[int, tuple[int, str, float]] = {}
    for item in raw_starts:
        if item[0] not in unique_starts or item[1]:
            unique_starts[item[0]] = item
    starts = sorted(unique_starts.values(), key=lambda x: x[0])
    result: list[Block] = []
    for number, (start, title, _confidence) in enumerate(starts, 1):
        end = starts[number][0] - 1 if number < len(starts) else len(ps)
        content = "\n\n".join(p.text for p in ps[start - 1:end]).strip()
        if content:
            result.append(Block(number, title, content))
    return tuple(result)


def rules_for_text(text: str, target_max_words: int = 5000) -> tuple[Block, ...]:
    ps = paragraphs(text)
    if not ps:
        return ()
    boundaries: list[tuple[int, str, float]] = []
    first_title = _title_from_paragraph(ps[0].text)
    if first_title:
        boundaries.append((0, first_title, 1.0))
    for p in ps[1:]:
        title = _title_from_paragraph(p.text)
        if title:
            boundaries.append((p.index - 1, title, 1.0))
    if not boundaries and target_max_words > 0:
        total = 0
        for p in ps[:-1]:
            total += len(p.text.split())
            if total >= target_max_words:
                boundaries.append((p.index, "", 0.7))
                total = 0
    return _safe_blocks(ps, boundaries) or (Block(1, "", text.strip()),)


def detect_plain(text: str, mode: str = "auto", target_max_words: int = 5000) -> tuple[tuple[Block, ...], str]:
    """Deterministic chapter detection; no LLM or model is ever invoked."""
    normalized = normalize_markdown(text)
    if not paragraphs(normalized):
        return (), "rules"
    return rules_for_text(text, target_max_words if mode == "auto" else 0), "rules"


def document_cache_key(text: str, settings: dict) -> str:
    value = {"text": text, "mode": settings.get("mode"), "target_max_words": settings.get("target_max_words"), "version": 2}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def report(document: Document, blocks: tuple[Block, ...], method: str) -> dict:
    chapters = []
    cursor = 1
    for block in blocks:
        count = max(1, len(paragraphs(block.text)))
        chapters.append(asdict(Chapter(block.index, block.title, block.text, cursor, cursor + count - 1, method, 1.0)) | {"words": len(block.text.split()), "paragraph_ids": [f"P{i:06d}" for i in range(cursor, cursor + count)]})
        cursor += count
    return {"source": str(document.relative_path), "method": method, "chapters": chapters}


def serialize_blocks(blocks: tuple[Block, ...]) -> list[dict]:
    return [asdict(block) for block in blocks]


def deserialize_blocks(value: object) -> tuple[Block, ...] | None:
    if not isinstance(value, list):
        return None
    result: list[Block] = []
    for expected, item in enumerate(value, 1):
        if not isinstance(item, dict):
            return None
        try:
            index, title, text = int(item["index"]), str(item.get("title", "")), str(item["text"])
        except (KeyError, TypeError, ValueError):
            return None
        if index != expected or not text.strip():
            return None
        result.append(Block(index, title, text))
    return tuple(result)


def validate_review(value: object) -> tuple[Block, ...] | None:
    if not isinstance(value, dict):
        return None
    return deserialize_blocks(value.get("chapters"))
