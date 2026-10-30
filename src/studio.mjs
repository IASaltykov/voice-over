import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadStudioConfig, saveStandardSettings, saveStudioLanguage } from './studio-config.mjs';
import { LanguageSelectionRequiredError, StandardTaskStore, processStandardDocument } from './standard-processing.mjs';
import { TranslatorUnavailableError } from './translator.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t = {
  ru: {
    title: 'ARTICLE STUDIO', subtitle: 'Перевод и озвучивание', menu: 'ГЛАВНОЕ МЕНЮ',
    options: ['Стандартная обработка', 'Расширенная обработка', 'Библиотека', 'Очередь задач', 'Настройки', 'Состояние системы', 'Язык / Language', 'Выход'],
    pending: 'ДОКУМЕНТЫ, ОЖИДАЮЩИЕ ОБРАБОТКИ', all: 'Обработать все', refresh: 'Обновить список', back: 'Назад', noPending: 'Нет документов, ожидающих обработки.',
    standard: 'Стандартная обработка', file: 'Файл', language: 'Язык', status: 'Статус', total: 'Всего файлов', processing: 'Обработка', completed: 'Завершено', failed: 'Ошибка', settings: 'Настройки → Стандартная обработка',
    unavailable: 'Недоступно в текущей сборке', sourceLanguage: 'Язык исходного документа: 1 — русский, 2 — английский, Enter — отмена: ',
  },
  en: {
    title: 'ARTICLE STUDIO', subtitle: 'Translation & Speech', menu: 'MAIN MENU',
    options: ['Standard Processing', 'Advanced Processing', 'Library', 'Task Queue', 'Settings', 'System Status', 'Language / Language', 'Exit'],
    pending: 'DOCUMENTS WAITING FOR PROCESSING', all: 'Process all', refresh: 'Refresh list', back: 'Back', noPending: 'No documents are waiting for processing.',
    standard: 'Standard Processing', file: 'File', language: 'Language', status: 'Status', total: 'Total files', processing: 'Processing', completed: 'Completed', failed: 'Failed', settings: 'Settings → Standard Processing',
    unavailable: 'Not available in this build', sourceLanguage: 'Source language: 1 — Russian, 2 — English, Enter — cancel: ',
  },
};

function clear() { if (process.stdout.isTTY) process.stdout.write('\x1Bc'); }
function divider() { console.log('──────────────────────────────────────────────────────────'); }
function label(code) { return ({ NEW: 'Новый', COPYING: 'Копируется', TRANSLATING: 'Переводится', TRANSLATED: 'Переведён', PREPARING_PRONUNCIATION: 'Подготовка произношения', SPEAKING: 'Озвучивается', PAUSED: 'Прерван', WAITING_TRANSLATOR: 'Ожидает TranslateGemma', NEEDS_TRANSLATION_DECISION: 'Нужно решение о переводе', NEEDS_LANGUAGE_SELECTION: 'Нужен язык', FAILED: 'Ошибка', COMPLETED: 'Готово' })[code] || code; }

async function ask(question) { const rl = readline.createInterface({ input, output }); try { return (await rl.question(question)).trim(); } finally { rl.close(); } }

async function select(title, options, initial = 0) {
  if (!input.isTTY || !input.setRawMode) {
    console.log(`\n${title}`); options.forEach((item, index) => console.log(` ${index + 1}. ${item.label}`));
    const answer = await ask('> '); const value = Number(answer); return Number.isInteger(value) && value >= 1 && value <= options.length ? options[value - 1].value : options[initial].value;
  }
  let current = initial;
  return new Promise((resolve) => {
    const render = () => { clear(); console.log(title); divider(); options.forEach((item, index) => console.log(`${index === current ? '❯' : ' '} ${index + 1}. ${item.label}`)); divider(); console.log('↑↓ Выбор    Enter Подтвердить    Esc Назад'); };
    const handler = (buffer) => {
      const key = buffer.toString();
      if (key === '\u0003') { cleanup(); resolve('exit'); }
      else if (key === '\u001b[A') { current = (current + options.length - 1) % options.length; render(); }
      else if (key === '\u001b[B') { current = (current + 1) % options.length; render(); }
      else if (key === '\r' || key === '\n') { const value = options[current].value; cleanup(); resolve(value); }
      else if (key === '\u001b') { cleanup(); resolve('back'); }
    };
    const cleanup = () => { input.off('data', handler); input.setRawMode(false); input.pause(); };
    input.setRawMode(true); input.resume(); input.on('data', handler); render();
  });
}

async function selectDocuments(entries, strings) {
  if (!entries.length) { await ask('Enter — назад'); return { action: 'back', entries: [] }; }
  if (!input.isTTY || !input.setRawMode) {
    const answer = (await ask('Номер, номера через запятую, A — все, R — обновить, Enter — назад: ')).toLowerCase();
    if (answer === 'a') return { action: 'process', entries };
    if (answer === 'r') return { action: 'refresh', entries: [] };
    const selected = [...new Set(answer.split(',').map((value) => Number(value.trim()) - 1).filter((index) => index >= 0 && index < entries.length))].map((index) => entries[index]);
    return selected.length ? { action: 'process', entries: selected } : { action: 'back', entries: [] };
  }
  let current = 0; const selected = new Set();
  return new Promise((resolve) => {
    const render = () => {
      heading(strings, strings.standard); console.log(`Папка: ${entries[0]?.file ? path.dirname(entries[0].file) : ''}\n`); console.log(strings.pending); divider();
      console.log(`   ${strings.file.padEnd(34)} ${strings.language.padEnd(8)} ${strings.status}`);
      entries.forEach((entry, index) => console.log(`${index === current ? '❯' : ' '} ${selected.has(index) ? '●' : ' '} ${entry.name.slice(0, 29).padEnd(30)} ${entry.language.padEnd(8)} ${label(entry.status)}`));
      divider(); console.log(`${strings.total}: ${entries.length}\nA — ${strings.all}    Space — выбрать несколько    R — ${strings.refresh}\n↑↓ Выбор    Enter Подтвердить    Esc Назад`);
    };
    const handler = (buffer) => {
      const raw = buffer.toString(); const key = raw.toLowerCase();
      if (key === '\u0003' || key === '\u001b') { cleanup(); resolve({ action: 'back', entries: [] }); }
      else if (raw === '\u001b[A') { current = (current + entries.length - 1) % entries.length; render(); }
      else if (raw === '\u001b[B') { current = (current + 1) % entries.length; render(); }
      else if (key === ' ') { selected.has(current) ? selected.delete(current) : selected.add(current); render(); }
      else if (key === 'a') { cleanup(); resolve({ action: 'process', entries }); }
      else if (key === 'r') { cleanup(); resolve({ action: 'refresh', entries: [] }); }
      else if (key === '\r' || key === '\n') { const chosen = selected.size ? [...selected].sort((a, b) => a - b).map((index) => entries[index]) : [entries[current]]; cleanup(); resolve({ action: 'process', entries: chosen }); }
    };
    const cleanup = () => { input.off('data', handler); input.setRawMode(false); input.pause(); };
    input.setRawMode(true); input.resume(); input.on('data', handler); render();
  });
}

function heading(strings, page) { clear(); console.log(`╔════════════════════════════════════════════════════════╗\n║                     ${strings.title}                     ║\n║                ${strings.subtitle}                ║\n╚════════════════════════════════════════════════════════╝\n`); console.log(page); divider(); }

async function chooseLanguage(strings) {
  const answer = await ask(strings.sourceLanguage); return answer === '1' ? 'RU' : answer === '2' ? 'EN' : null;
}

async function chooseTranslationDecision() {
  return select('Перевод выключен', [
    { label: 'Оставить документ в очереди до включения перевода', value: 'wait' },
    { label: 'Озвучить оригинал без перевода', value: 'speak_original' },
    { label: 'Отмена', value: 'cancel' },
  ]);
}

async function standardScreen(config, strings) {
  let store = new StandardTaskStore(config);
  while (true) {
    let entries = await store.pending();
    if (!entries.length) { heading(strings, strings.standard); console.log(strings.noPending); await ask('Enter — назад'); return config; }
    const selection = await selectDocuments(entries, strings);
    if (selection.action === 'back') return config;
    if (selection.action === 'refresh') continue;
    const batch = selection.entries;
    for (const entry of batch) {
      heading(strings, `${strings.processing}: ${entry.name}`);
      try {
        let task = await processStandardDocument(store, entry, { interactive: true });
        if (task.status === 'NEEDS_LANGUAGE_SELECTION') {
          const language = await chooseLanguage(strings);
          if (language) task = await processStandardDocument(store, entry, { language, interactive: true });
        }
        if (task.status === 'NEEDS_TRANSLATION_DECISION') {
          const decision = await chooseTranslationDecision();
          if (decision === 'speak_original') task = await processStandardDocument(store, entry, { interactive: true, translationDecision: decision });
          else if (decision === 'wait') task = await processStandardDocument(store, entry, { translationDecision: 'wait' });
        }
        console.log(`${entry.name}: ${label(task.status)}`);
      } catch (error) {
        if (error instanceof LanguageSelectionRequiredError) console.log(error.message);
        else if (error instanceof TranslatorUnavailableError) console.log(`TranslateGemma: ${error.message}`);
        else console.log(`${strings.failed}: ${error.message}`);
      }
    }
    await ask('Enter — продолжить');
  }
}

async function showTasks(config, strings, onlyCompleted = false) {
  heading(strings, onlyCompleted ? strings.options[2] : strings.options[3]);
  const tasks = (await new StandardTaskStore(config).list()).filter((task) => onlyCompleted ? task.status === 'COMPLETED' : task.status !== 'COMPLETED');
  if (!tasks.length) console.log('—');
  for (const task of tasks) console.log(`${task.source?.file_name || task.id} — ${label(task.status)} — ${task.updated_at || ''}`);
  await ask('Enter — назад'); return config;
}

async function settingsScreen(config, strings) {
  while (true) {
    const s = config.standard;
    const options = [
      { label: `Автоопределение языка: ${config.ai.languageDetection.enabled ? 'ВКЛ' : 'ВЫКЛ'}${config.ai.languageDetection.source !== 'config.toml' ? ' [ENV]' : ''}`, value: 'language-detection' },
      { label: `Автоматический перевод: ${config.ai.translation.enabled ? 'ВКЛ' : 'ВЫКЛ'}${config.ai.translation.source !== 'config.toml' ? ' [ENV]' : ''}`, value: 'translate' },
      { label: `TranslateGemma endpoint: ${s.translation_endpoint || 'не настроен'}`, value: 'endpoint' },
      { label: `Расстановка ударений: ${config.ai.pronunciation.enabled ? 'ВКЛ' : 'ВЫКЛ'}${config.ai.pronunciation.source !== 'config.toml' ? ' [ENV]' : ''}`, value: 'pronunciation' },
      { label: `Голос: ${s.voice}`, value: 'voice' }, { label: `Скорость: ${s.rate}`, value: 'rate' },
      { label: strings.back, value: 'back' },
    ];
    const action = await select(strings.settings, options);
    if (action === 'back') return config;
    if (['language-detection', 'translate', 'pronunciation'].includes(action) && config.ai[{ 'language-detection': 'languageDetection', translate: 'translation', pronunciation: 'pronunciation' }[action]].source !== 'config.toml') {
      console.log('Значение задано через переменную окружения и не меняется в меню.'); await ask('Enter — продолжить'); continue;
    }
    const patch = action === 'language-detection' ? { language_detection_enabled: !s.language_detection_enabled }
      : action === 'translate' ? { auto_translate: !s.auto_translate }
      : action === 'pronunciation' ? { pronunciation_enabled: !s.pronunciation_enabled }
        : action === 'endpoint' ? { translation_endpoint: await ask('HTTP(S) endpoint TranslateGemma: ') }
          : action === 'voice' ? { voice: await ask('Voice: ') || s.voice }
            : { rate: await ask('Rate (for example +0%): ') || s.rate };
    config = await saveStandardSettings(config, patch);
  }
}

async function systemStatus(config, strings) {
  heading(strings, strings.options[5]);
  console.log(`Input: ${config.input}\nOutput: ${config.output}\nData: ${config.data}\nTranslateGemma: ${config.standard.translation_endpoint || 'not configured'}\nEdge TTS: ${config.standard.voice} ${config.standard.rate}`);
  await ask('Enter — назад'); return config;
}

async function main() {
  let config = await loadStudioConfig(path.join(ROOT, 'config.toml'));
  while (true) {
    const strings = t[config.language] || t.ru;
    const choice = await select(`${strings.title}\n${strings.subtitle}\n\n${strings.menu}`, strings.options.map((label, index) => ({ label, value: index })), 0);
    if (choice === 'exit' || choice === 7) return;
    if (choice === 0) config = await standardScreen(config, strings);
    else if (choice === 2) config = await showTasks(config, strings, true);
    else if (choice === 3) config = await showTasks(config, strings, false);
    else if (choice === 4) config = await settingsScreen(config, strings);
    else if (choice === 5) config = await systemStatus(config, strings);
    else if (choice === 6) config = await saveStudioLanguage(config, config.language === 'ru' ? 'en' : 'ru');
    else { heading(strings, strings.options[1]); console.log(strings.unavailable); await ask('Enter — назад'); }
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
