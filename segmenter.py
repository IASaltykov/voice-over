from __future__ import annotations

import re

ABBREVIATIONS = {"т.д.", "т.п.", "т.е.", "г.", "ул.", "им.", "стр.", "Mr.", "Dr.", "e.g.", "i.e."}


def _sentences(text: str) -> list[str]:
    text = re.sub(r"[ \t]+", " ", text.strip())
    if not text:
        return []
    result: list[str] = []
    start = 0
    for match in re.finditer(r"[.!?…]+(?:[\"'»”\)\]]+)?(?=\s|$)", text):
        candidate = text[start:match.end()].strip()
        lower = candidate.casefold()
        if any(lower.endswith(abbr.casefold()) for abbr in ABBREVIATIONS):
            continue
        if candidate:
            result.append(candidate)
            start = match.end()
    tail = text[start:].strip()
    if tail:
        result.append(tail)
    return result


def _split_long(text: str, limit: int) -> list[str]:
    words = text.split()
    parts: list[str] = []
    current = ""
    for word in words:
        if current and len(current) + len(word) + 1 > limit:
            parts.append(current)
            current = ""
        current = f"{current} {word}".strip()
    if current:
        parts.append(current)
    return parts or [text[:limit]]


def split_text(text: str, max_chars: int = 700, min_chars: int = 150) -> list[str]:
    if max_chars < 20:
        raise ValueError("max_chars должен быть не меньше 20")
    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    units: list[str] = []
    for paragraph in paragraphs:
        units.extend(_sentences(paragraph) or [paragraph])
    chunks: list[str] = []
    current = ""
    for unit in units:
        pieces = [unit] if len(unit) <= max_chars else _split_long(unit, max_chars)
        for piece in pieces:
            if current and len(current) + len(piece) + 1 <= max_chars:
                current = f"{current} {piece}"
            elif current:
                chunks.append(current)
                current = piece
            else:
                current = piece
    if current:
        chunks.append(current)
    # Merge very small tail chunks where the limit permits, preserving all text.
    if len(chunks) > 1 and len(chunks[-1]) < min_chars and len(chunks[-2]) + len(chunks[-1]) + 1 <= max_chars:
        chunks[-2] = f"{chunks[-2]} {chunks[-1]}"
        chunks.pop()
    return chunks
