from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from audio import probe


class EdgeEngine:
    name = "edge"

    def __init__(self, voice: str, rate: str, timeout: int = 90):
        self.voice, self.rate, self.timeout = voice, rate, timeout

    async def synthesize(self, text: str, destination: Path) -> None:
        import edge_tts
        await asyncio.wait_for(edge_tts.Communicate(text=text, voice=self.voice, rate=self.rate).save(str(destination)), self.timeout)


async def edge_probe(voice: str, rate: str) -> tuple[bool, str]:
    try:
        with tempfile.TemporaryDirectory(prefix="edge_probe_") as directory:
            target = Path(directory) / "probe.mp3"
            await EdgeEngine(voice, rate, 35).synthesize("Проверка доступности Edge TTS.", target)
            ok, duration, detail = probe(target)
            return ok, f"duration={duration:.3f}s" if ok else detail
    except Exception as exc:
        return False, f"{type(exc).__name__}: {exc}"
