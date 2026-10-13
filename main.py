from __future__ import annotations

import argparse
import asyncio
import json
import logging
import shutil
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

import audio
import chapter_detector
import engines
import manifest
from parser import Document, decode_bytes, discover, output_document_dir, parse_documents
from segmenter import split_text

BASE = Path(__file__).resolve().parent
DEFAULT_CONFIG = BASE / "config.toml"


def load_config(path: Path) -> dict:
    import tomllib
    return tomllib.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def logger_for(log_path: Path) -> logging.Logger:
    logger = logging.getLogger("unified_tts")
    logger.handlers.clear()
    logger.setLevel(logging.INFO)
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    for handler in (logging.StreamHandler(sys.stdout), logging.FileHandler(log_path, encoding="utf-8")):
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    return logger


def cli() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Edge TTS генератор MP3 из TXT, Markdown и FB2.")
    parser.add_argument("--input", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--engine", choices=("edge",), default=None)
    parser.add_argument("--voice", default=None)
    parser.add_argument("--rate", default=None)
    parser.add_argument("--max-chars", type=int, default=None)
    parser.add_argument("--only", type=Path)
    parser.add_argument("--only-block", type=int)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--chapter-mode", choices=("rules", "auto"), default=None)
    parser.add_argument("--analyze-only", action="store_true")
    parser.add_argument("--review-chapters", action="store_true")
    parser.add_argument("--apply-review", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def config_values(args: argparse.Namespace) -> dict:
    config = load_config(args.config)
    paths, tts, segmentation, audio_cfg, fb2, chapters = (config.get(x, {}) for x in ("paths", "tts", "segmentation", "audio", "fb2", "chapter_detection"))
    root = args.config.parent
    return {
        "input": (args.input or root / paths.get("input", "input")).resolve(),
        "output": (args.output or root / paths.get("output", "output")).resolve(),
        "cache": (root / paths.get("cache", "cache")).resolve(),
        "logs": (root / paths.get("logs", "logs")).resolve(),
        "engine": "edge",
        "voice": args.voice or tts.get("voice", "ru-RU-DmitryNeural"),
        "rate": args.rate or tts.get("rate", "-5%"),
        "retries": int(tts.get("retries", 4)),
        "timeout": int(tts.get("timeout_seconds", 90)),
        "max_chars": args.max_chars or int(segmentation.get("max_chars", 700)),
        "min_chars": int(segmentation.get("min_chars", 150)),
        "quality": str(audio_cfg.get("mp3_quality", "2")),
        "fb2": fb2,
        "force": args.force,
        "chapter_mode": args.chapter_mode or chapters.get("mode", "auto"),
        "chapter_target_max_words": int(chapters.get("target_max_words", 5000)),
    }


def preflight(settings: dict, logger: logging.Logger, audio_required: bool) -> tuple[bool, str]:
    if audio_required:
        try:
            ffmpeg, ffprobe = audio.require_tools()
        except RuntimeError as exc:
            logger.error("DEPENDENCY: %s", exc)
            return False, "ffmpeg"
        logger.info("FFmpeg=%s; FFprobe=%s", ffmpeg, ffprobe)
    try:
        import edge_tts
        logger.info("edge-tts=%s", getattr(edge_tts, "__version__", "installed"))
    except ImportError:
        logger.error("DEPENDENCY: edge-tts не установлен")
        return False, "edge-tts"
    return True, "ok"


def resolve_chapters(document: Document, destination: Path, settings: dict) -> tuple[Document, dict]:
    if document.blocks or document.kind not in {"text", "markdown"}:
        result = chapter_detector.report(document, document.blocks, "rules")
        result["reason"] = "existing document structure preserved"
        return document, result
    source_text = decode_bytes(document.path.read_bytes(), str(document.path))
    cache_path = destination / ".chapters.json"
    cache_key = chapter_detector.document_cache_key(source_text, {"mode": settings["chapter_mode"], "target_max_words": settings["chapter_target_max_words"]})
    cached = None
    if cache_path.exists():
        try:
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
    blocks = chapter_detector.deserialize_blocks(cached.get("blocks")) if isinstance(cached, dict) and cached.get("cache_key") == cache_key else None
    method = str(cached.get("method", "cache")) if blocks and isinstance(cached, dict) else ""
    if blocks is None:
        blocks, method = chapter_detector.detect_plain(source_text, settings["chapter_mode"], settings["chapter_target_max_words"])
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps({"cache_key": cache_key, "method": method, "blocks": chapter_detector.serialize_blocks(blocks)}, ensure_ascii=False, indent=2), encoding="utf-8")
    updated = replace(document, blocks=blocks)
    result = chapter_detector.report(updated, blocks, method)
    result["cache_key"] = cache_key
    return updated, result


def write_review(destination: Path, result: dict, blocks) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    payload = dict(result)
    payload["chapters"] = chapter_detector.serialize_blocks(blocks)
    payload["instructions"] = "Можно менять только title. Поля index и text должны совпадать с исходными."
    (destination / "chapters_review.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


async def process_block(document: Document, block, destination: Path, settings: dict, logger: logging.Logger, old: dict) -> tuple[str, str]:
    width = max(2, len(str(len(document.blocks))))
    filename = f"{block.index:0{width}d} {block.title}.mp3" if block.title else f"{block.index:0{width}d}.mp3"
    target = destination / filename
    key = str(block.index)
    config_hash = manifest.digest({"engine": "edge", "voice": settings["voice"], "rate": settings["rate"], "max_chars": settings["max_chars"], "version": 3})
    text_hash = manifest.digest(block.text)
    stored = old.get("blocks", {}).get(key, {})
    valid, _, _ = audio.probe(target)
    if not settings["force"] and valid and stored.get("text_hash") == text_hash and stored.get("config_hash") == config_hash and stored.get("filename") == filename:
        return "skipped", filename
    if not block.text.strip():
        return "empty", filename
    chunks = split_text(block.text, settings["max_chars"], settings["min_chars"])
    logger.info("%s / блок %s: длина=%s символов, фрагментов=%s, длины=%s", document.relative_path, block.index, len(block.text), len(chunks), [len(x) for x in chunks])
    settings["cache"].mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f"block_{block.index}_", dir=settings["cache"]))
    parts: list[Path] = []
    engine = engines.EdgeEngine(settings["voice"], settings["rate"], settings["timeout"])
    try:
        for index, chunk in enumerate(chunks, 1):
            part = work / f"part_{index}.mp3"
            error = ""
            for attempt in range(1, settings["retries"] + 1):
                try:
                    logger.info("%s / блок %s / фрагмент %s/%s / попытка %s", document.relative_path, block.index, index, len(chunks), attempt)
                    await engine.synthesize(chunk, part)
                    ok, duration, detail = audio.probe(part)
                    decoded, decode_detail = audio.decode_check(part)
                    if not ok or not decoded:
                        raise RuntimeError(detail or decode_detail)
                    logger.info("фрагмент %s: длина=%s, duration=%.3fs", index, len(chunk), duration)
                    parts.append(part)
                    break
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    part.unlink(missing_ok=True)
                    logger.warning("TTS/MP3 ошибка блока %s, фрагмента %s, попытка %s/%s: %s", block.index, index, attempt, settings["retries"], error)
                    if attempt < settings["retries"]:
                        await asyncio.sleep(min(2 ** (attempt - 1), 20))
            if len(parts) != index:
                return "failed", f"фрагмент {index}: {error}"
        target.parent.mkdir(parents=True, exist_ok=True)
        ok, duration, detail = await audio.merge_mp3(parts, target, settings["quality"])
        if not ok:
            return "failed", f"объединение MP3: {detail}"
        old.setdefault("blocks", {})[key] = {"index": block.index, "title": block.title, "filename": filename, "text_hash": text_hash, "config_hash": config_hash, "engine": "edge", "duration": duration, "chunks": len(chunks)}
        return "created", filename
    finally:
        shutil.rmtree(work, ignore_errors=True)


async def run() -> int:
    args = cli()
    settings = config_values(args)
    logger = logger_for(settings["logs"] / "generation.log")
    analysis_only = args.analyze_only or args.review_chapters or args.dry_run
    logger.info("Запуск Edge-only TTS: Python=%s voice=%s rate=%s chapter_mode=%s", sys.version.split()[0], settings["voice"], settings["rate"], settings["chapter_mode"])
    ready, _ = preflight(settings, logger, audio_required=not analysis_only)
    if not ready:
        return 3
    if args.check:
        ok, detail = await engines.edge_probe(settings["voice"], settings["rate"])
        logger.info("Проверка Edge TTS: %s (%s)", "доступен" if ok else "недоступен", detail)
        return 0 if ok else 4
    if not settings["input"].exists():
        logger.error("Входная папка не найдена: %s", settings["input"])
        return 2
    if args.only:
        candidate = args.only if args.only.is_absolute() else settings["input"] / args.only
        files = [candidate.resolve()]
    else:
        files = discover(settings["input"])
    if args.only and not files[0].exists():
        logger.error("Документ не найден: %s", files[0])
        return 2
    if analysis_only:
        totals = {"documents": 0, "blocks": 0, "created": 0, "skipped": 0, "errors": 0}
        for source in files:
            relative = source.relative_to(settings["input"]) if source.is_relative_to(settings["input"]) else Path(source.name)
            try:
                documents = parse_documents(source, relative, settings["fb2"])
            except Exception as exc:
                logger.exception("Ошибка чтения %s: %s", source, exc)
                totals["errors"] += 1
                continue
            for document in documents:
                destination = output_document_dir(settings["output"], document.relative_path)
                document, result = resolve_chapters(document, destination, settings)
                write_review(destination, result, document.blocks)
                totals["documents"] += 1
                totals["blocks"] += len(document.blocks)
                logger.info("CHAPTERS %s: method=%s blocks=%s", document.relative_path, result.get("method"), len(document.blocks))
                for block in document.blocks:
                    logger.info("  chapter %s: chars=%s words=%s title=%s", block.index, len(block.text), len(block.text.split()), block.title or "-")
        print(json.dumps(totals, ensure_ascii=False, indent=2))
        return 0 if totals["errors"] == 0 else 1
    logger.info("Edge TTS будет проверяться на каждом фрагменте; ошибки сервиса не останавливают остальные документы")
    totals = {"documents": 0, "blocks": 0, "created": 0, "skipped": 0, "errors": 0}
    used_destinations: set[Path] = set()
    for source in files:
        relative = source.relative_to(settings["input"]) if source.is_relative_to(settings["input"]) else Path(source.name)
        try:
            documents = parse_documents(source, relative, settings["fb2"])
        except Exception as exc:
            logger.exception("Ошибка чтения %s: %s", source, exc)
            totals["errors"] += 1
            continue
        for document in documents:
            totals["documents"] += 1
            destination = output_document_dir(settings["output"], document.relative_path)
            document, chapter_report = resolve_chapters(document, destination, settings)
            review_path = destination / "chapters_review.json"
            if not args.apply_review or not review_path.exists():
                write_review(destination, chapter_report, document.blocks)
            if args.apply_review:
                try:
                    reviewed = chapter_detector.validate_review(json.loads(review_path.read_text(encoding="utf-8")))
                except (OSError, json.JSONDecodeError):
                    reviewed = None
                if reviewed is None or len(reviewed) != len(document.blocks) or any(a.text != b.text for a, b in zip(reviewed, document.blocks)):
                    logger.error("Некорректный review или изменён исходный текст: %s", review_path)
                    totals["errors"] += 1
                    continue
                document = replace(document, blocks=reviewed)
            if args.only_block is not None and args.only:
                selected = tuple(block for block in document.blocks if block.index == args.only_block)
                if not selected:
                    logger.error("Блок %s не найден в %s", args.only_block, document.relative_path)
                    totals["errors"] += 1
                    continue
                document = replace(document, blocks=selected)
            totals["blocks"] += len(document.blocks)
            if destination in used_destinations:
                destination = destination.with_name(destination.name + "__" + document.path.suffix.casefold().lstrip("."))
            used_destinations.add(destination)
            manifest_path = destination / ".manifest.json"
            old = manifest.load(manifest_path)
            old.update({"source": str(document.relative_path), "source_hash": manifest.digest(source.read_bytes()), "kind": document.kind})
            for block in document.blocks:
                status, detail = await process_block(document, block, destination, settings, logger, old)
                if status == "created": totals["created"] += 1
                elif status == "skipped": totals["skipped"] += 1
                elif status != "empty": totals["errors"] += 1; logger.error("Ошибка блока %s: %s", block.index, detail)
            manifest.save(manifest_path, old)
    logger.info("ИТОГ: документы=%s блоков=%s создано=%s пропущено=%s ошибок=%s", totals["documents"], totals["blocks"], totals["created"], totals["skipped"], totals["errors"])
    print(json.dumps(totals, ensure_ascii=False, indent=2))
    return 0 if totals["errors"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
