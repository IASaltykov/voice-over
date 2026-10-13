from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Iterable


def find_tool(name: str) -> str | None:
    found = shutil.which(name) or shutil.which(name + ".exe")
    if found:
        return found
    candidates = list(Path(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "WinGet", "Packages").glob("**/bin/" + name + ".exe")) if os.name == "nt" else []
    return str(candidates[0]) if candidates else None


def require_tools() -> tuple[str, str]:
    ffmpeg, ffprobe = find_tool("ffmpeg"), find_tool("ffprobe")
    missing = [name for name, value in (("ffmpeg", ffmpeg), ("ffprobe", ffprobe)) if not value]
    if missing:
        raise RuntimeError("Не найдены: " + ", ".join(missing) + ". Установите FFmpeg и добавьте bin в PATH.")
    return ffmpeg, ffprobe


def probe(path: Path, ffprobe: str | None = None) -> tuple[bool, float, str]:
    ffprobe = ffprobe or find_tool("ffprobe")
    if not path.exists() or path.stat().st_size == 0:
        return False, 0.0, "файл отсутствует или пуст"
    if not ffprobe:
        return False, 0.0, "ffprobe не найден"
    command = [ffprobe, "-v", "error", "-show_entries", "format=format_name,duration", "-of", "json", str(path)]
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    if result.returncode:
        return False, 0.0, result.stderr.strip() or "ffprobe не распознал файл"
    import json
    try:
        value = json.loads(result.stdout).get("format", {})
        duration = float(value.get("duration", 0))
        if "mp3" not in str(value.get("format_name", "")).casefold() or duration <= 0:
            return False, duration, "нет корректного MP3-потока или длительность равна нулю"
        return True, duration, "ok"
    except (ValueError, TypeError, json.JSONDecodeError) as exc:
        return False, 0.0, f"ошибка ответа ffprobe: {exc}"


def decode_check(path: Path, ffmpeg: str | None = None) -> tuple[bool, str]:
    ffmpeg = ffmpeg or find_tool("ffmpeg")
    if not ffmpeg:
        return False, "ffmpeg не найден"
    result = subprocess.run([ffmpeg, "-v", "error", "-i", str(path), "-f", "null", "-"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
    return result.returncode == 0, result.stderr.strip()


async def merge_mp3(parts: Iterable[Path], destination: Path, quality: str = "2") -> tuple[bool, float, str]:
    ffmpeg, ffprobe = require_tools()
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, list_name = tempfile.mkstemp(prefix="tts_concat_", suffix=".txt", text=True)
    os.close(fd)
    listing = Path(list_name)
    # Keep the final .mp3 suffix so FFmpeg can select the output muxer.
    temp = destination.with_name(destination.stem + ".building.mp3")
    try:
        listing.write_text("".join("file '" + str(path.resolve()).replace("'", "'\\''") + "'\n" for path in parts), encoding="utf-8")
        command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(listing), "-vn", "-c:a", "libmp3lame", "-q:a", quality, str(temp)]
        result = await asyncio.to_thread(subprocess.run, command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=300)
        if result.returncode:
            return False, 0.0, result.stderr.strip() or "FFmpeg не смог объединить фрагменты"
        valid, duration, detail = probe(temp, ffprobe)
        if not valid:
            return False, duration, detail
        decoded, decode_detail = decode_check(temp, ffmpeg)
        if not decoded:
            return False, duration, decode_detail or "ошибка декодирования итогового файла"
        os.replace(temp, destination)
        return True, duration, "ok"
    finally:
        listing.unlink(missing_ok=True)
        temp.unlink(missing_ok=True)
