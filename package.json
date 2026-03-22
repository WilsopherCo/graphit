// api/graph.js — Graphit backend
// Runs as a Vercel serverless function. Your API key never reaches the browser.

// ── Simple in-memory rate limiter ──────────────────────────────────────────
const rateMap = new Map();
const MAX_REQUESTS = 5;
const WINDOW_MS = 60 * 60 * 1000; // 1 hour

function isRateLimited(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW_MS; }
  entry.count++;
  rateMap.set(ip, entry);
  return entry.count > MAX_REQUESTS;
}

// ── System prompt (cached by Anthropic after first call) ───────────────────
const SYSTEM_PROMPT = `You are Graphit. Find real data and return ONLY a JSON object for Chart.js. No preamble, no markdown, no backticks.

JSON format:
{"title":"Graph title","subtitle":"Source & date range","message":"2-3 sentences on what the graph shows","sources":"Data sources used","rawData":{"labels":[...],"datasets":[{"label":"...","data":[...]}]},"chartConfig":{"type":"line","data":{"labels":[...],"datasets":[{"label":"...","data":[...],"borderColor":"#e8c84a","backgroundColor":"rgba(232,200,74,0.1)","tension":0.3,"fill":true,"pointRadius":3,"pointHoverRadius":6}]},"options":{"responsive":true,"maintainAspectRatio":false,"interaction":{"mode":"index","intersect":false},"plugins":{"legend":{"display":true},"tooltip":{"mode":"index"}},"scales":{"x":{"display":true},"y":{"display":true}}}}}

Chart types: "line"=time series, "bar"=categories, "scatter"=correlation.
Colors: 1st "#e8c84a"/"rgba(232,200,74,0.1)", 2nd "#5b8cff"/"rgba(91,140,255,0.1)", 3rd "#4af0a0"/"rgba(74,240,160,0.1)", 4th "#f05a4a"/"rgba(240,90,74,0.1)".
On failure: {"error":"reason"}`;

// ── Main handler ────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
           || req.headers['x-real-ip']
           || 'unknown';

  if (isRateLimited(ip)) {
    return res.status(429).json({
      error: "You've reached the limit of 5 free graphs per hour. Please try again later."
    });
  }

  // Validate input
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
    return res.status(400).json({ error: 'A graph description is required.' });
  }
  if (prompt.length > 500) {
    return res.status(400).json({ error: 'Description too long (max 500 characters).' });
  }

  // Check env var
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY is not set');
    return res.status(500).json({ error: 'Server misconfiguration. Please contact support.' });
  }

  // Forward to Anthropic
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: [
          { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
        ],
        tools: [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }
        ],
        messages: [{ role: 'user', content: prompt.trim() }]
      })
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.json().catch(() => ({}));
      console.error('Anthropic error:', anthropicRes.status, errBody);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }

    const data = await anthropicRes.json();

    // Calculate real cost from token usage
    let estimatedCost = 0;
    if (data.usage) {
      estimatedCost =
        (data.usage.input_tokens                || 0) / 1_000_000 * 1.0  +
        (data.usage.output_tokens               || 0) / 1_000_000 * 5.0  +
        (data.usage.cache_read_input_tokens     || 0) / 1_000_000 * 0.10 +
        (data.usage.cache_creation_input_tokens || 0) / 1_000_000 * 1.25;
    }

    const fullText = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (!fullText) return res.status(502).json({ error: 'No response from AI. Please try again.' });

    const clean = fullText.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) { try { parsed = JSON.parse(match[0]); } catch { return res.status(502).json({ error: 'Could not parse graph data. Try rephrasing.' }); } }
      else return res.status(502).json({ error: 'Could not parse graph data. Try rephrasing.' });
    }

    if (parsed.error) return res.status(422).json({ error: parsed.error });

    return res.status(200).json({ ...parsed, estimatedCost });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
