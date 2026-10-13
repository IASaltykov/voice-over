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
