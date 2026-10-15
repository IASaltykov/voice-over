const CARDINAL = ['ноль', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];
const ORDINAL_LOCATIVE = ['', 'первом', 'втором', 'третьем', 'четвёртом', 'пятом', 'шестом', 'седьмом', 'восьмом', 'девятом', 'десятом', 'одиннадцатом', 'двенадцатом', 'тринадцатом', 'четырнадцатом', 'пятнадцатом', 'шестнадцатом', 'семнадцатом', 'восемнадцатом', 'девятнадцатом', 'двадцатом', 'двадцать первом', 'двадцать втором', 'двадцать третьем', 'двадцать четвёртом', 'двадцать пятом', 'двадцать шестом', 'двадцать седьмом', 'двадцать восьмом', 'двадцать девятом', 'тридцатом'];

function numberToWords(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return String(value);
  if (n < 20) return CARDINAL[n];
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${CARDINAL[n % 10]}` : ''}`;
  if (n < 1000) return `${HUNDREDS[Math.floor(n / 100)]}${n % 100 ? ` ${numberToWords(n % 100)}` : ''}`;
  const thousands = Math.floor(n / 1000);
  const thousand = thousands === 1 ? 'тысяча' : thousands === 2 ? 'две тысячи' : thousands === 3 ? 'три тысячи' : thousands === 4 ? 'четыре тысячи' : `${CARDINAL[thousands]} тысяч`;
  return `${thousand}${n % 1000 ? ` ${numberToWords(n % 1000)}` : ''}`;
}

function romanToNumber(value) {
  const symbols = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0; let previous = 0;
  for (const char of value.toUpperCase().split('').reverse()) { const current = symbols[char]; if (!current) return null; total += current < previous ? -current : current; previous = Math.max(previous, current); }
  return total;
}

function yearToWords(value) {
  const year = Number(value);
  if (!Number.isInteger(year) || year < 1000 || year > 2099) return numberToWords(value);
  const tail = year % 100;
  if (!tail || tail >= ORDINAL_LOCATIVE.length) return numberToWords(year);
  return `${numberToWords(year - tail)} ${ORDINAL_LOCATIVE[tail]}`;
}

// This deliberately handles only unambiguous editorial conventions. The
// original document is never changed; this string is used solely for speech.
export function normalizeForSpeech(source) {
  let text = String(source ?? '').replace(/\u00a0/g, ' ').replace(/\u00ad/g, '');
  text = text.replace(/([\p{L}])-[\r\n]+\s*([\p{L}])/gu, '$1$2');
  text = text.replace(/\b(\d{1,4})\s*г\.(?=\s|$|[,;:)])/gu, (_m, year) => `${yearToWords(year)} году`);
  text = text.replace(/(^|\s)([IVXLCDM]+)\s+веке(?=$|[\s.,;:])/gmu, (_m, prefix, roman) => { const value = romanToNumber(roman); return value && value < ORDINAL_LOCATIVE.length ? `${prefix}${ORDINAL_LOCATIVE[value]} веке` : _m; });
  text = text.replace(/(^|\s)т\.\s*д\./gmu, '$1и так далее').replace(/(^|\s)т\.\s*п\./gmu, '$1и тому подобное').replace(/(^|\s)т\.\s*е\./gmu, '$1то есть');
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}
