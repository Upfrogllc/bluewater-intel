/**
 * fishing-reports.js
 * Netlify Function — Fishing Report Ingestion Pipeline
 *
 * 4-stage pipeline:
 *   Stage 1 — Source discovery: find recent relevant report pages for species + region
 *   Stage 2 — Extraction: pull concrete observations from each source
 *   Stage 3 — Normalization: convert to structured signal JSON
 *   Stage 4 — Signal summary: produce a low-weight confidence signal for the main prompt
 *
 * Design principles:
 *   - Reports confirm activity only — they do NOT drive hotspot placement
 *   - Stale reports (>72hr) are discounted heavily
 *   - Vague/marketing language is stripped in extraction
 *   - Output is a single clean signal block ready for buildAnalysisPrompt()
 *
 * Called BEFORE the main analyze call so the signal is ready to inject.
 */

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 1000;

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };

  let payload;
  try { payload = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { species, region, location, date } = payload;
  if (!species || !region) {
    return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'species and region required' }) };
  }

  const today = date || new Date().toISOString().slice(0, 10);

  try {
    // Run the 4-stage pipeline
    const sources   = await stage1_discover(species, region, location, today);
    const extracted = await stage2_extract(sources, species, location);
    const normalized = stage3_normalize(extracted, today);
    const signal    = stage4_summarize(normalized, species);

    return {
      statusCode: 200,
      headers: { ...CORS, 'Cache-Control': 'public, max-age=3600' }, // 1hr cache — reports don't change that fast
      body: JSON.stringify({ signal, normalized, sources: sources.length }),
    };

  } catch (err) {
    console.error('[fishing-reports] pipeline error:', err.message);
    // Never let report failure block the main analysis — return a neutral signal
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        signal: neutralSignal(species),
        normalized: [],
        sources: 0,
        error: err.message,
      }),
    };
  }
};

// ─── Stage 1: Source Discovery ────────────────────────────────────────────────

async function stage1_discover(species, region, location, today) {
  const regionLabel = {
    SE_FLORIDA:   'Southeast Florida (Jupiter, Palm Beach, Fort Lauderdale, Miami, Florida Keys)',
    MID_ATLANTIC: 'Mid-Atlantic (North Carolina Hatteras, Virginia Beach, Maryland Ocean City)',
    NORTHEAST:    'Northeast (New Jersey, New York, Rhode Island, Massachusetts)',
  }[region] || region;

  const prompt = `You are a fishing-report source discovery system.

Find the most likely URLs containing RECENT fishing reports for:
Species: ${species}
Region: ${regionLabel}
Location: ${location || regionLabel}
Today: ${today}

Return 3–5 sources that are likely to have RECENT (within 7 days) fishing observations.

Prioritize these source types:
- Local charter company "fishing reports" or "bite reports" pages
- Regional tackle shop weekly reports
- Marina fishing report pages
- Tournament recap pages if within the past 7 days

Do NOT include:
- Generic travel or tourism pages
- Evergreen how-to articles
- Gear reviews or regulations pages
- Social media (can't fetch reliably)

Respond ONLY with valid JSON array:
[
  {
    "source_name": "",
    "source_type": "charter_report|tackle_shop|marina|tournament",
    "url": "",
    "region": "",
    "likely_recency": "days_old_estimate",
    "why_useful": ""
  }
]`;

  const data = await callClaude(prompt, 'Return only valid JSON array. No markdown.');
  try {
    const text = extractText(data).replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch {
    return [];
  }
}

// ─── Stage 2: Extraction ──────────────────────────────────────────────────────

async function stage2_extract(sources, species, location) {
  if (!sources.length) return [];

  // Fetch each source page and extract concrete observations
  const results = await Promise.allSettled(
    sources.map(src => extractFromSource(src, species, location))
  );

  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

async function extractFromSource(source, species, location) {
  // Fetch the page content
  let pageContent = '';
  try {
    const resp = await fetch(source.url, {
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'BlueWaterIntel/2.0 fishing-report-bot' },
    });
    if (!resp.ok) return null;
    const html = await resp.text();
    // Strip HTML tags for cleaner extraction — basic approach
    pageContent = html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
  } catch {
    return null;
  }

  if (!pageContent || pageContent.length < 100) return null;

  const prompt = `You are a fishing report extraction engine. Extract ONLY concrete fishing observations.

Source: ${source.source_name}
Target species: ${species}
Page content:
"""
${pageContent}
"""

Extract only:
- Species mentioned and catch success (good/slow/mixed/not mentioned)
- Any size information (weight, length)
- Location hints (miles offshore, depth, reef name, specific area)
- Technique mentioned (kite fishing, trolling, chunking, etc.)
- Water conditions (SST, clarity, current direction)
- Report date if visible on the page

Ignore: marketing language, generic descriptions, vague statements like "great day on the water"

If the page has NO concrete fishing observations for ${species}, return null.

Respond ONLY with valid JSON or the word null:
{
  "species": "",
  "catch_success": "good|slow|mixed|unknown",
  "size_info": "",
  "location_hint": "",
  "technique": "",
  "conditions": "",
  "report_date": "",
  "key_phrase": ""
}`;

  const data = await callClaude(prompt, 'Return valid JSON or null. No markdown.');
  try {
    const text = extractText(data).replace(/```json|```/g, '').trim();
    if (text === 'null' || !text) return null;
    const parsed = JSON.parse(text);
    parsed.source = source.source_name;
    parsed.url = source.url;
    return parsed;
  } catch {
    return null;
  }
}

// ─── Stage 3: Normalization ───────────────────────────────────────────────────

function stage3_normalize(extracted, today) {
  const todayMs = new Date(today).getTime();

  return extracted
    .filter(Boolean)
    .map(item => {
      // Calculate recency in hours
      let recencyHours = 999; // default = very stale
      if (item.report_date) {
        try {
          const reportMs = new Date(item.report_date).getTime();
          recencyHours = Math.round((todayMs - reportMs) / 3600000);
        } catch { /* keep 999 */ }
      }

      // Weight by recency
      const weight = recencyHours <= 24  ? 'high'
                   : recencyHours <= 72  ? 'medium'
                   : recencyHours <= 168 ? 'low'
                   : 'very_low';

      return {
        species:        item.species || '',
        source:         item.source || '',
        catch_success:  item.catch_success || 'unknown',
        size_info:      item.size_info || '',
        location_hint:  item.location_hint || '',
        technique:      item.technique || '',
        conditions:     item.conditions || '',
        recency_hours:  recencyHours,
        recency_weight: weight,
        key_phrase:     item.key_phrase || '',
      };
    })
    // Sort by recency — freshest first
    .sort((a, b) => a.recency_hours - b.recency_hours);
}

// ─── Stage 4: Signal Summary ──────────────────────────────────────────────────

function stage4_summarize(normalized, species) {
  if (!normalized.length) return neutralSignal(species);

  // Filter to only weighted reports (discard very_low)
  const usable = normalized.filter(r => r.recency_weight !== 'very_low');
  if (!usable.length) return neutralSignal(species);

  // Activity level from catch success
  const successCounts = { good: 0, mixed: 0, slow: 0, unknown: 0 };
  usable.forEach(r => successCounts[r.catch_success]++);

  const activityLevel = successCounts.good >= usable.length * 0.5 ? 'high'
                      : successCounts.slow >= usable.length * 0.5 ? 'low'
                      : 'medium';

  // Confidence adjustment
  const confidenceAdjustment = activityLevel === 'high' && usable[0]?.recency_hours <= 48
    ? 'slight_increase'
    : activityLevel === 'low'
    ? 'slight_decrease'
    : 'none';

  // Build summary sentence from freshest usable reports
  const freshest = usable.slice(0, 2);
  const techniques = [...new Set(freshest.map(r => r.technique).filter(Boolean))];
  const locations  = [...new Set(freshest.map(r => r.location_hint).filter(Boolean))];

  let summary = `${species} activity: ${activityLevel}.`;
  if (locations.length)  summary += ` Recent reports reference ${locations[0]}.`;
  if (techniques.length) summary += ` Technique: ${techniques[0]}.`;
  if (freshest[0]?.key_phrase) summary += ` "${freshest[0].key_phrase}"`;

  return {
    summary,
    species,
    activity_level:        activityLevel,        // 'high' | 'medium' | 'low'
    confidence_adjustment: confidenceAdjustment, // 'slight_increase' | 'none' | 'slight_decrease'
    report_count:          usable.length,
    freshest_hours:        usable[0]?.recency_hours || 999,
    techniques_mentioned:  techniques,
    locations_mentioned:   locations,
    weight: 'LOW',   // ALWAYS low weight — activity confirmation only, never location driver
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function neutralSignal(species) {
  return {
    summary: `No recent ${species} reports found — relying on ocean data only.`,
    species,
    activity_level:        'unknown',
    confidence_adjustment: 'none',
    report_count:          0,
    freshest_hours:        999,
    techniques_mentioned:  [],
    locations_mentioned:   [],
    weight: 'LOW',
  };
}

async function callClaude(prompt, systemPrompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}`);
  return resp.json();
}

function extractText(data) {
  return data?.content?.map(b => b.type === 'text' ? b.text : '').join('') || '';
}
