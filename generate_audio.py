"""Backward-compatible entry point. The project uses Edge TTS only."""

import asyncio

from main import run


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
