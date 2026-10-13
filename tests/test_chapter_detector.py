from pathlib import Path

from chapter_detector import detect_plain, paragraphs, rules_for_text, validate_review


def test_paragraph_ids_are_stable_and_rules_find_headings():
    text = "Введение.\n\nГлава 1. Начало\n\nПервый текст.\n\nГлава 2. Продолжение\n\nВторой текст."
    assert [p.id for p in paragraphs(text)] == ["P000001", "P000002", "P000003", "P000004", "P000005"]
    blocks = rules_for_text(text)
    assert [b.title for b in blocks] == ["", "Глава 1. Начало", "Глава 2. Продолжение"]
    assert "Первый текст." in blocks[1].text
    assert "Второй текст." in blocks[2].text


def test_long_plain_text_is_split_without_losing_words():
    paragraphs_text = [f"Абзац {i}: слово слово слово слово слово." for i in range(1, 8)]
    source = "\n\n".join(paragraphs_text)
    blocks = rules_for_text(source, target_max_words=12)
    assert len(blocks) > 1
    assert "\n\n".join(b.text for b in blocks) == source


def test_heading_without_blank_line_is_detected():
    blocks = rules_for_text("Глава 1\nПервый текст.\nГлава 2. Продолжение\nВторой текст.")
    assert [b.title for b in blocks] == ["Глава 1", "Глава 2. Продолжение"]


def test_auto_mode_is_deterministic_and_has_no_llm_dependency():
    text = "Глава 1. Один\n\nТекст.\n\nГлава 2. Два\n\nЕщё текст."
    blocks, method = detect_plain(text, "auto")
    assert method == "rules"
    assert len(blocks) == 2


def test_review_cannot_replace_source_text():
    assert validate_review({"chapters": [{"index": 1, "title": "Ок", "text": "Исходный"}]})[0].title == "Ок"
    assert validate_review({"chapters": [{"index": 2, "title": "Неверно", "text": "Исходный"}]}) is None
