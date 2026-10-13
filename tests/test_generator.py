import asyncio
from pathlib import Path

import main


def test_cli_has_edge_only_and_dry_run(monkeypatch):
    monkeypatch.setattr("sys.argv", ["main.py", "--dry-run"])
    args = main.cli()
    assert args.engine is None
    assert args.dry_run is True


def test_config_has_no_local_model_settings(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text('[tts]\nengine = "edge"\nvoice = "ru-RU-DmitryNeural"\nrate = "-5%"\n', encoding="utf-8")
    args = type("Args", (), {"config": config, "input": None, "output": None, "engine": None, "voice": None, "rate": None, "max_chars": None, "force": False, "chapter_mode": None})()
    values = main.config_values(args)
    assert values["engine"] == "edge"
    assert "llm" not in values
    assert "model" not in values


def test_review_rejects_changed_text():
    assert main.chapter_detector.validate_review({"chapters": [{"index": 1, "title": "Глава", "text": "Текст"}]})[0].title == "Глава"
