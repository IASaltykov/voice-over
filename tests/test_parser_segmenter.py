from pathlib import Path

from parser import parse_delimited, parse_file, discover
from segmenter import split_text


def test_named_and_legacy_blocks():
    blocks = parse_delimited("# One\nText one.\n## Inner\n#\nText two.")
    assert [(b.title, b.text) for b in blocks] == [("One", "Text one.\n## Inner"), ("", "Text two.")]


def test_markdown_fence_does_not_split():
    blocks = parse_delimited("# A\n```python\n# not a block\n```\nText.", markdown=True)
    assert len(blocks) == 1
    assert "not a block" in blocks[0].text


def test_natural_discovery(tmp_path: Path):
    (tmp_path / "10.txt").write_text("# ten\ntext", encoding="utf-8")
    (tmp_path / "2.md").write_text("# two\ntext", encoding="utf-8")
    assert [p.name for p in discover(tmp_path)] == ["2.md", "10.txt"]


def test_segmenter_preserves_words():
    text = "Первое предложение. Второе предложение с достаточно длинным содержанием."
    chunks = split_text(text, max_chars=35, min_chars=1)
    assert " ".join(chunks).replace("  ", " ") == text
    assert all(len(chunk) <= 35 for chunk in chunks)


def test_three_digit_numbering_source_blocks():
    blocks = parse_delimited("\n".join(f"# Chapter {i}\nText {i}." for i in range(1, 126)))
    assert len(blocks) == 125
    assert max(2, len(str(len(blocks)))) == 3
    assert blocks[0].title == "Chapter 1"
    assert blocks[-1].title == "Chapter 125"
