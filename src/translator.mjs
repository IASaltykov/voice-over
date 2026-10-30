import { splitText } from './segmenter.mjs';

export class TranslatorUnavailableError extends Error {
  constructor(message) { super(message); this.name = 'TranslatorUnavailableError'; }
}

function responseText(body) {
  return body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || body?.text || null;
}

export async function translateToRussian(source, settings, { fetchImpl = fetch } = {}) {
  if (settings.translation_provider !== 'translategemma_openai') throw new TranslatorUnavailableError(`Unsupported translation provider: ${settings.translation_provider}`);
  if (!settings.translation_endpoint) throw new TranslatorUnavailableError('TranslateGemma endpoint is not configured. Set standard_processing.translation_endpoint on the server.');
  const endpoint = new URL(settings.translation_endpoint);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new TranslatorUnavailableError('TranslateGemma endpoint must use HTTP or HTTPS.');
  const chunks = splitText(String(source), 6000, 300);
  const translated = [];
  for (const chunk of chunks) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(5, Number(settings.translation_timeout_seconds || 120)) * 1000);
    try {
      const headers = { 'content-type': 'application/json' };
      if (process.env.TRANSLATEGEMMA_API_KEY) headers.authorization = `Bearer ${process.env.TRANSLATEGEMMA_API_KEY}`;
      const response = await fetchImpl(endpoint, {
        method: 'POST', headers, signal: controller.signal,
        body: JSON.stringify({ model: settings.translation_model, temperature: 0, messages: [
          { role: 'system', content: 'Translate the user text into Russian. Preserve paragraph boundaries, headings, facts, numbers, names and citations. Return only the translation.' },
          { role: 'user', content: chunk },
        ] }),
      });
      if (!response.ok) throw new TranslatorUnavailableError(`TranslateGemma endpoint returned HTTP ${response.status}`);
      const text = responseText(await response.json());
      if (!text || typeof text !== 'string') throw new TranslatorUnavailableError('TranslateGemma response did not contain translated text.');
      translated.push(text.trim());
    } finally { clearTimeout(timer); }
  }
  return translated.join('\n\n');
}
