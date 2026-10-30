import fs from 'node:fs/promises';

const ACUTE = '\u0301';
const BUILTIN = new Map([
  ['договор', 'догово́р'], ['каталог', 'катало́г'], ['квартал', 'кварта́л'],
  ['звонит', 'звони́т'], ['начался', 'нача́лся'], ['облегчить', 'облегчи́ть'],
]);

function withCase(source, replacement) {
  if (source === source.toUpperCase()) return replacement.toUpperCase();
  if (source[0] === source[0]?.toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

export async function loadPronunciationExceptions(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
    return new Map(Object.entries(parsed).filter(([key, value]) => typeof key === 'string' && typeof value === 'string'));
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map();
    throw new Error(`Cannot read pronunciation exceptions: ${error.message}`);
  }
}

// Edge TTS receives ordinary Unicode text. Combining acute accents are used only
// where the spelling is explicitly known; unknown homographs are left unchanged.
export function preparePronunciation(source, exceptions = new Map()) {
  const changes = [];
  const text = String(source || '').replace(/\p{L}+/gu, (word) => {
    const key = word.toLocaleLowerCase('ru-RU');
    const replacement = exceptions.get(key) || BUILTIN.get(key);
    if (!replacement || word.includes(ACUTE)) return word;
    const prepared = withCase(word, replacement);
    changes.push({ source: word, prepared, origin: exceptions.has(key) ? 'user' : 'builtin' });
    return prepared;
  });
  return { text, changes, convention: 'unicode_combining_acute' };
}
