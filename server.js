const path = require('path');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { GoogleGenAI } = require('@google/genai');

dotenv.config({ path: path.resolve(__dirname, '.env.local') });

const app = express();
const port = process.env.PORT || 3001;

// Tracks Gemini call volume per UTC day since AI Studio free-tier keys have no Cloud Console usage view.
const geminiUsage = { date: '', attempted: 0, success: 0, error: 0 };

function recordGeminiRequest(outcome) {
  const today = new Date().toISOString().slice(0, 10);
  if (geminiUsage.date !== today) {
    geminiUsage.date = today;
    geminiUsage.attempted = 0;
    geminiUsage.success = 0;
    geminiUsage.error = 0;
  }

  geminiUsage.attempted += 1;
  geminiUsage[outcome] += 1;

  console.log(`Gemini usage today (${geminiUsage.date}): ${geminiUsage.attempted} attempted, ${geminiUsage.success} success, ${geminiUsage.error} error`);

  return { ...geminiUsage };
}

function extractJsonObject(text) {
  if (typeof text !== 'string') {
    return null;
  }

  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch (error) {
    return null;
  }
}

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'MCP Maps backend is running.'
  });
});

app.get('/api/usage', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const usage = geminiUsage.date === today ? geminiUsage : { date: today, attempted: 0, success: 0, error: 0 };
  res.json({ usageToday: usage });
});

app.post('/api/chat', async (req, res) => {
  const { prompt } = req.body || {};

  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'A non-empty prompt is required.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({
      error: 'Gemini is not configured on the backend.',
      errorStatus: 503,
      errorMessage: 'Set GEMINI_API_KEY in My-MCP-Maps-Backend/.env.local and restart the server.',
    });
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const systemInstruction = `You are a helpful assistant for a map app. Return valid JSON with exactly these keys: "reply", "mapHint", "places", and "debug". "reply" should be a concise conversational answer. "mapHint" should be a short place or search phrase relevant to the user's request, or an empty string if no place is relevant. "places" should contain up to 24 distinct place names or short place descriptions relevant to the request. For broad discovery requests such as "list all museums in the London area", provide a substantial list of notable matching places rather than only the most famous few. Do not invent places, and do not claim the list is literally exhaustive unless you can support that claim. Use the same geographic scope in "mapHint" that you use for "places", such as "museums in London, UK". "debug" should be a short developer-facing summary of how you interpreted the request.`;
    const response = await ai.models.generateContent({
      model,
      contents: `${systemInstruction}\nUser request: ${prompt}`,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            reply: { type: 'string' },
            mapHint: { type: 'string' },
            places: {
              type: 'array',
              items: { type: 'string' },
              maxItems: 24,
            },
            debug: { type: 'string' },
          },
          required: ['reply', 'mapHint', 'places', 'debug'],
        },
      },
    });

    const rawText = response.text || response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const parsed = extractJsonObject(rawText);
    const modelName = response.model || response?.candidates?.[0]?.model || model;
    const usageMetadata = response.usageMetadata || response?.candidates?.[0]?.tokenCount || null;
    const inputTokens = typeof usageMetadata?.inputTokenCount === 'number'
      ? usageMetadata.inputTokenCount
      : typeof usageMetadata?.promptTokenCount === 'number'
        ? usageMetadata.promptTokenCount
        : 0;
    const outputTokens = typeof usageMetadata?.outputTokenCount === 'number'
      ? usageMetadata.outputTokenCount
      : typeof usageMetadata?.candidatesTokenCount === 'number'
        ? usageMetadata.candidatesTokenCount
        : 0;

    if (parsed && typeof parsed === 'object'
      && typeof parsed.reply === 'string'
      && typeof parsed.mapHint === 'string'
      && Array.isArray(parsed.places)
      && parsed.places.every((place) => typeof place === 'string')
      && typeof parsed.debug === 'string') {
      return res.json({
        reply: parsed.reply,
        mapHint: parsed.mapHint.trim(),
        places: parsed.places.filter(Boolean).slice(0, 24),
        debug: parsed.debug,
        model: modelName,
        inputTokens,
        outputTokens,
        usageToday: recordGeminiRequest('success'),
      });
    }

    return res.status(502).json({
      error: 'Gemini returned an invalid response.',
      errorStatus: 502,
      errorMessage: 'Gemini did not return the required reply, mapHint, places, and debug fields.',
      errorDetails: rawText.slice(0, 2000),
      model: modelName,
      usageToday: recordGeminiRequest('error'),
    });
  } catch (error) {
    const upstreamStatus = Number(error?.status ?? error?.response?.status ?? error?.code);
    const errorMessage = typeof error?.message === 'string' ? error.message : 'Unknown Gemini error';
    const details = error?.details ?? error?.response?.data ?? null;

    console.error('Gemini request failed', {
      status: upstreamStatus || 'unknown',
      message: errorMessage,
      details,
      stack: error?.stack,
    });

    const status = upstreamStatus === 429 || /429|quota|RESOURCE_EXHAUSTED|rate-limit/i.test(errorMessage)
      ? 429
      : upstreamStatus === 401 || /unauthorized|api key/i.test(errorMessage)
        ? 401
        : upstreamStatus === 403 || /forbidden|permission|authentication/i.test(errorMessage)
          ? 403
          : upstreamStatus === 404 || /not found|model/i.test(errorMessage)
            ? 404
            : 502;

    return res.status(status).json({
      error: 'Gemini request failed.',
      errorStatus: status,
      errorMessage,
      errorDetails: details ? JSON.stringify(details).slice(0, 2000) : '',
      usageToday: recordGeminiRequest('error'),
    });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
