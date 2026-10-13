import zipfile

from parser import parse_documents, parse_fb2_bytes, parse_file


def test_fb2_namespaces_and_sections():
    data = b'''<?xml version="1.0" encoding="utf-8"?>
    <FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0">
      <description><title-info><book-title>Book</book-title><author><first-name>A</first-name><last-name>B</last-name></author></title-info></description>
      <body><section><title><p>Chapter One</p></title><p>First text.</p></section><section><title><p>Chapter Two</p></title><p>Second text.</p></section></body>
    </FictionBook>'''
    blocks = parse_fb2_bytes(data, "book.fb2")
    assert [b.title for b in blocks] == ["Chapter One", "Chapter Two"]
    assert blocks[0].text == "First text."


def test_fb2_zip(tmp_path):
    raw = b'<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body><section><title><p>One</p></title><p>Text.</p></section></body></FictionBook>'
    archive = tmp_path / "book.fb2.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("nested/book.fb2", raw)
    document = parse_file(archive, archive.name)
    assert len(document.blocks) == 1
    assert document.blocks[0].title == "One"


def test_fb2_zip_multiple_documents(tmp_path):
    raw = b'<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><body><section><title><p>One</p></title><p>Text.</p></section></body></FictionBook>'
    archive = tmp_path / "books.fb2.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("a.fb2", raw)
        zf.writestr("b.fb2", raw)
    documents = parse_documents(archive, archive.name)
    assert len(documents) == 2
    assert documents[0].relative_path != documents[1].relative_path
