// api/graph.js — Graphit backend
// Claude now returns ONLY raw data (~200 tokens). Frontend builds the Chart.js config.

const rateMap = new Map();
const MAX_REQUESTS = 5;
const WINDOW_MS = 60 * 60 * 1000;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; }
  entry.count++;
  rateMap.set(ip, entry);
  return entry.count > MAX_REQUESTS;
}

const MODEL = 'claude-haiku-4-5-20251001';
const HEADERS = (key) => ({
  'Content-Type': 'application/json',
  'x-api-key': key,
  'anthropic-version': '2023-06-01',
  'anthropic-beta': 'prompt-caching-2024-07-31'
});

// Claude only needs to return raw data — no Chart.js boilerplate.
// The frontend handles ALL styling. Saves ~650 output tokens per call.
const SYSTEM_PROMPT = `You are Graphit. Search the web for real, accurate data then return ONLY valid JSON. No preamble. No markdown. No backticks. Start with { end with }.

Return this exact shape:
{
  "title": "Short descriptive title",
  "subtitle": "Source names and date range",
  "message": "2-3 sentence insight about what this data shows",
  "sources": "e.g. Federal Reserve FRED, World Bank, BLS.gov",
  "chartType": "line",
  "labels": ["2000", "2001", "2002"],
  "datasets": [
    { "label": "Series name", "data": [1.2, 1.5, 1.8] }
  ]
}

chartType must be one of: "line", "bar", "scatter".
Use multiple objects in datasets for multi-series graphs.
If data cannot be found: {"error": "brief explanation"}`;

function calcCost(usage = {}) {
  return (
    (usage.input_tokens                || 0) / 1_000_000 * 1.00 +
    (usage.output_tokens               || 0) / 1_000_000 * 5.00 +
    (usage.cache_read_input_tokens     || 0) / 1_000_000 * 0.10 +
    (usage.cache_creation_input_tokens || 0) / 1_000_000 * 1.25
  );
}

function extractJSON(text) {
  const stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  try { return JSON.parse(stripped); } catch {}
  const start = stripped.indexOf('{');
  const end   = stripped.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)); } catch {}
  }
  const matches = stripped.match(/\{[\s\S]+?\}/g) || [];
  for (const m of [...matches].reverse()) {
    try { const p = JSON.parse(m); if (p.labels || p.error) return p; } catch {}
  }
  return null;
}

async function callWithSearch(apiKey, prompt) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: HEADERS(apiKey),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }]
    })
  });
}

async function callFixJSON(apiKey, brokenText) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: HEADERS(apiKey),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: `You returned malformed JSON. Previous response:\n\n${brokenText}\n\nReturn only valid JSON starting with { and ending with }. Nothing else.`
      }]
    })
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || 'unknown';
  if (isRateLimited(ip)) return res.status(429).json({ error: "You've reached the limit of 5 free graphs per hour. Try again later." });

  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) return res.status(400).json({ error: 'A graph description is required.' });
  if (prompt.length > 500) return res.status(400).json({ error: 'Description too long (max 500 characters).' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { console.error('ANTHROPIC_API_KEY not set'); return res.status(500).json({ error: 'Server misconfiguration.' }); }

  let totalCost = 0;

  try {
    const r1 = await callWithSearch(apiKey, prompt.trim());
    if (!r1.ok) {
      const b = await r1.json().catch(() => ({}));
      console.error('Anthropic error (attempt 1):', r1.status, b);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }
    const d1 = await r1.json();
    totalCost += calcCost(d1.usage);
    const text1 = (d1.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed1 = text1 ? extractJSON(text1) : null;

    if (parsed1 && !parsed1.error && parsed1.labels && parsed1.datasets) {
      return res.status(200).json({ ...parsed1, estimatedCost: totalCost });
    }
    if (parsed1?.error) return res.status(422).json({ error: parsed1.error });

    // Attempt 2 — cheap fix-up, no web search
    console.warn('Attempt 1 parse failed, running cheap fix-up...');
    const r2 = await callFixJSON(apiKey, text1 || '(empty)');
    if (!r2.ok) return res.status(502).json({ error: 'Could not generate graph. Try rephrasing your request.' });

    const d2 = await r2.json();
    totalCost += calcCost(d2.usage);
    const text2 = (d2.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed2 = text2 ? extractJSON(text2) : null;

    if (parsed2 && !parsed2.error && parsed2.labels && parsed2.datasets) {
      return res.status(200).json({ ...parsed2, estimatedCost: totalCost });
    }

    return res.status(422).json({
      error: "Couldn't build a graph for that request. Try being more specific, e.g. 'U.S. GDP growth rate 2000–2024'."
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
