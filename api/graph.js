// api/graph.js — Graphit backend
// Verifies Clerk session tokens. Rate limits per user ID (not IP).

import { createClerkClient } from '@clerk/backend';

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// ── Rate limiter — keyed by Clerk userId ──────────────────────────────────────
const rateMap  = new Map();
const MAX_REQS = 20;
const WINDOW   = 60 * 60 * 1000; // 1 hour

function checkRate(key) {
  const now   = Date.now();
  const entry = rateMap.get(key) || { count: 0, resetAt: now + WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + WINDOW; }
  entry.count++;
  rateMap.set(key, entry);
  return { limited: entry.count > MAX_REQS, remaining: Math.max(0, MAX_REQS - entry.count) };
}

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Graphit. Search the web for real data, then return ONLY valid JSON. No preamble. No markdown. No backticks. Start with { end with }.

CRITICAL: You will rarely get a perfect complete dataset from search results — that is expected. Build the best chart you can from whatever you find: snippets, summary statistics, partial tables, figures mentioned in articles, or well-known approximate values. Use round numbers and reasonable interpolation. A chart with approximate data is far more useful than an error.

Only return {"error":"..."} if you find absolutely zero relevant numbers after searching.

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
Aim for 10-30 datapoints per series.`;

function calcCost(u = {}) {
  return (u.input_tokens||0)/1e6*1 + (u.output_tokens||0)/1e6*5 +
         (u.cache_read_input_tokens||0)/1e6*0.1 + (u.cache_creation_input_tokens||0)/1e6*1.25;
}

function extractJSON(text) {
  const s = text.replace(/```json\s*/gi,'').replace(/```\s*/g,'').trim();
  try { return JSON.parse(s); } catch {}
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i !== -1 && j > i) { try { return JSON.parse(s.slice(i, j+1)); } catch {} }
  for (const m of [...(s.match(/\{[\s\S]+?\}/g)||[])].reverse()) {
    try { const p = JSON.parse(m); if (p.labels||p.error) return p; } catch {}
  }
  return null;
}

const H = (k) => ({
  'Content-Type':'application/json','x-api-key':k,
  'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31'
});
const MODEL = 'claude-haiku-4-5-20251001';

async function callSearch(apiKey, prompt) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method:'POST', headers:H(apiKey),
    body: JSON.stringify({
      model:MODEL, max_tokens:800,
      system:[{type:'text',text:SYSTEM_PROMPT,cache_control:{type:'ephemeral'}}],
      tools:[{type:'web_search_20250305',name:'web_search',max_uses:3}],
      messages:[{role:'user',content:prompt}]
    })
  });
}

async function callFix(apiKey, broken) {
  return fetch('https://api.anthropic.com/v1/messages', {
    method:'POST', headers:H(apiKey),
    body: JSON.stringify({
      model:MODEL, max_tokens:800,
      system:[{type:'text',text:SYSTEM_PROMPT,cache_control:{type:'ephemeral'}}],
      messages:[{role:'user',content:`You returned malformed JSON. Previous response:\n\n${broken}\n\nReturn only valid JSON starting with { and ending with }. Nothing else.`}]
    })
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // 1. Verify Clerk token
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Sign in required.' });

  let userId;
  try {
    const payload = await clerk.verifyToken(token);
    userId = payload.sub;
  } catch (err) {
    console.error('Token verify failed:', err.message);
    return res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }

  // 2. Rate limit by user ID
  const { limited, remaining } = checkRate(userId);
  if (limited) {
    return res.status(429).json({
      error: `You've made ${MAX_REQS} graphs this hour. Limit resets soon — check back in a bit!`
    });
  }

  // 3. Validate prompt
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3)
    return res.status(400).json({ error: 'A graph description is required.' });
  if (prompt.length > 600)
    return res.status(400).json({ error: 'Description too long (max 600 characters).' });

  // 4. Check env vars
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Server misconfiguration.' });

  let cost = 0;

  try {
    // Attempt 1
    const r1 = await callSearch(apiKey, prompt.trim());
    if (!r1.ok) {
      console.error('Anthropic error:', r1.status);
      return res.status(502).json({ error: 'AI service error. Please try again.' });
    }
    const d1 = await r1.json();
    cost += calcCost(d1.usage);
    const t1 = (d1.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const p1 = t1 ? extractJSON(t1) : null;

    if (p1 && !p1.error && p1.labels && p1.datasets)
      return res.status(200).json({ ...p1, estimatedCost: cost, remainingGraphs: remaining });
    if (p1?.error) return res.status(422).json({ error: p1.error });

    // Attempt 2 — cheap fix
    console.warn('Attempt 1 parse failed, fixing...');
    const r2 = await callFix(apiKey, t1 || '(empty)');
    if (!r2.ok) return res.status(502).json({ error: 'Could not generate graph. Try rephrasing.' });

    const d2 = await r2.json();
    cost += calcCost(d2.usage);
    const t2 = (d2.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const p2 = t2 ? extractJSON(t2) : null;

    if (p2 && !p2.error && p2.labels && p2.datasets)
      return res.status(200).json({ ...p2, estimatedCost: cost, remainingGraphs: remaining });

    return res.status(422).json({
      error: "Couldn't build a graph for that. Try being more specific, e.g. 'U.S. GDP growth rate 2000–2024'."
    });

  } catch (err) {
    console.error('Unexpected error:', err);
    return res.status(500).json({ error: 'Server error. Please try again.' });
  }
}
