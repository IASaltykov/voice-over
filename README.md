# Озвучка документов через Edge TTS

Node.js-проект для создания MP3 из TXT, Markdown, FB2, FB2.ZIP и PDF. Единственный движок синтеза речи — Microsoft Edge TTS. Локальные модели, GPU, Piper, Silero, Qwen, llama.cpp и Python не используются.

## Быстрый запуск в Windows через Docker

1. Установите и запустите Docker Desktop.
2. Поместите документы в `input/`.
3. Дважды нажмите [`start-docker.bat`](start-docker.bat).
4. Готовые файлы будут в `output/`, журнал — в `logs/generation.log`.

`start-docker.bat` проверяет Docker CLI, Docker Engine, Compose V2, входные папки и имя сервиса из Compose. Он собирает образ только при первом запуске и сохраняет вывод последнего запуска в `logs/docker-last.log`.

Другие BAT-файлы:

- `rebuild-docker.bat` — принудительная пересборка без Docker-кеша;
- `stop-docker.bat` — останавливает только контейнеры этого Compose-проекта.

## Форматы и главы

### URL, HTML и EPUB

Помимо локальных TXT, Markdown, FB2, FB2.ZIP и PDF с текстовым слоем, поддерживаются HTML/XHTML и EPUB. Поместите ссылки по одной на строку в `input/urls.txt`; пустые строки и строки с `#` игнорируются. Либо передайте одну ссылку напрямую:

```powershell
docker compose run --rm voice-over --url "https://example.org/article"
```

Загрузчик принимает только публичные HTTP/HTTPS-адреса, проверяет DNS при каждом перенаправлении, не допускает localhost/частные сети, ограничивает размер и число перенаправлений и не выполняет JavaScript страницы. Очищенный источник сохраняется в `cache/sources/`; готовое аудио использует тот же кеш фрагментов и механизм возобновления, что и локальная книга. Если HTML не даёт достаточно содержательного текста, озвучивание не запускается.

EPUB читается по `spine` из `META-INF/container.xml`; DRM и сканированные PDF не поддерживаются.

- **TXT / Markdown:** строка `#` или `# Название` начинает новый блок. `#` внутри обычной строки не является разделителем.
- **FB2 / FB2.ZIP:** разделение по XML-элементам `<section>` и `<title>`.
- **PDF с текстовым слоем:** PDF.js извлекает текст последовательно по страницам и формирует внутреннее представление **Normalized Markdown V2**. Учитываются координаты, размер шрифта, интервалы строк и две колонки. Повторяющиеся колонтитулы и самостоятельные номера страниц удаляются.

Если в PDF не распознаны заголовки, режим `auto` делит текст по абзацам и целевому числу слов. Названия в таком случае нейтральные: «Раздел 1», «Раздел 2» и т.д. Предложения по возможности не разрываются.

Сканированный PDF без текстового слоя не озвучивается: программа сообщит, что нужен OCR. OCR намеренно не устанавливается и не скачивается автоматически.

Нормализованный текст PDF и метаданные кэшируются в `cache/pdf/<SHA-256>.md` и `cache/pdf/<SHA-256>.json`. Эти файлы не попадают в Git.

## Docker-команды

```powershell
docker compose build
docker compose run --rm voice-over
docker compose run --rm voice-over --analyze-only
docker compose run --rm voice-over --only "Книги/Документ.pdf"
```

Имя сервиса в текущем `docker-compose.yml` — `voice-over`; `start-docker.bat` получает его из конфигурации автоматически.

Контейнер получает папки хоста:

```text
input/  -> /app/input
output/ -> /app/output
cache/  -> /app/cache
logs/   -> /app/logs
```

Поэтому готовые MP3 остаются на компьютере после завершения контейнера.

## Локальный запуск Node.js

Нужны Node.js 22.13+ и FFmpeg/FFprobe в `PATH`.

```powershell
npm ci
npm test
npm start -- --input input --output output
npm start -- --input input --analyze-only
npm start -- --only "Книги/Документ.pdf"
```

Голос и скорость задаются в `config.toml` или параметрами:

```powershell
npm start -- --voice ru-RU-DmitryNeural --rate=-5%
```

## Надёжность генерации

- длинные блоки разделяются на небольшие фрагменты;
- повторяется только сетевой запрос Edge TTS, максимум `retries` раз;
- ошибки FFprobe/FFmpeg отделены от ошибок TTS и не отправляют текст повторно;
- каждый фрагмент проверяется FFprobe и полным декодированием FFmpeg;
- фрагменты объединяются FFmpeg, не простым копированием байтов;
- manifest содержит хеш текста и настроек: готовый MP3 пропускается только при совпадении хеша и успешной проверке;
- ошибка одного документа не останавливает остальные.

## Ограничения Edge TTS

Edge TTS — внешний неофициальный интернет-интерфейс Microsoft. Он может вернуть HTTP 403, `NoAudioReceived`, сетевой сбой или ограничить частоту запросов. Программа честно фиксирует такую ошибку после ограниченных повторов и не переключается на другой TTS-движок и не пытается обходить ограничения сервиса.

## Тесты

```powershell
npm test
npm audit --omit=dev --audit-level=high
```

Тесты используют синтетические документы и PDF; пользовательские книги и аудиофайлы не изменяются.

## Диагностика Edge TTS

Проект использует `node-edge-tts@1.2.11`, а не устаревший пакет `edge-tts@1.0.1`. Новый клиент применяет актуальный WebSocket endpoint и параметр `Sec-MS-GEC`.

Независимая проверка соединения:

```powershell
node tests/edge-connection.mjs
docker compose run --rm --entrypoint node voice-over tests/edge-connection.mjs
```

Тест проверяет DNS, HTTPS/TLS, WebSocket handshake, создание MP3, FFprobe и FFmpeg. Его временный результат хранится отдельно от пользовательских аудиокниг в `cache/diagnostics/edge-connection.mp3`, а последнее диагностическое резюме — в `logs/edge-connection-latest.json`.

Для HTTP 403 приложение выводит этап ошибки, HTTP-статус, среду, голос и номер попытки. HTTP 403 и HTTP 429 на WebSocket handshake открывают защитный circuit breaker: дальнейшие главы продолжают анализироваться, но не отправляются повторно сотнями одинаковых запросов.
## Smart Queue, fragment cache, and resume

Every Edge TTS request goes through one sequential queue. The conservative
defaults in `config.toml` are one active request, a 5,000 ms minimum interval,
and no more than 8 requests per minute. These are local safety controls, not a
claim about a Microsoft limit. Change `[edge_queue]` only if you understand
that a lower delay can make `HTTP 429` more likely.

Each completed fragment is immediately validated by FFprobe and FFmpeg, then
stored atomically in `cache/tts/<sha256>/fragment.mp3` with `metadata.json`.
The key includes the fragment text, Edge engine, voice, rate, and client. On
restart, valid matching fragments are reused; a damaged file or changed voice
or rate is never reused. A final chapter MP3 is produced only after all of its
fragments are available.

If Edge returns HTTP 429, the queue stops accepting new requests, atomically
saves fragment progress and enters `COOLDOWN` without ending the Node.js
process or Docker container. It waits asynchronously, then retries only the
unfinished fragment. With no `Retry-After` header the conservative defaults
are 15, 30, 60 and then 120 minutes, plus a positive 0–10% jitter. A supplied
`Retry-After` is always treated as a minimum. These are application safety
settings, not claimed Microsoft limits, and can be changed in `[edge_queue]`
in `config.toml`. If Docker or Windows is stopped while waiting, the saved
`next_retry_at` is honored at the next run when Edge supplied `Retry-After`.
When no server retry time was supplied, a restarted worker immediately makes
one normal half-open request for the same unfinished fragment; a new 429
starts a new conservative cooldown.

HTTP 403 is deliberately different: the program makes at most one diagnostic
retry, persists `PAUSED_REQUIRES_ATTENTION`, and does not treat it as a rate
limit or try to bypass the service restriction. `logs/events.jsonl` records
cooldown and recovery events without secrets, request URLs or credentials.

The Docker Compose bind mounts keep `output/`, `cache/`, and `logs/` on the
host, so progress survives a container, Docker Desktop, or Windows restart.
