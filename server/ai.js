// Server-side AI analysis. Runs inside the Vite dev/preview server (see
// vite.config.js) or the desktop app, so API keys never reach the browser.
//
// The browser sends a few rendered views of the model, with every detected
// object drawn in its own colour and labelled with its number, plus each
// object's measurements. The AI looks at them and returns names, groups and
// keep/remove suggestions as JSON.
//
// Providers: Claude (Anthropic SDK, the default), ChatGPT (OpenAI), Gemini
// (Google) and any OpenAI-compatible server (Ollama, LM Studio…), chosen in the
// app's AI settings and saved in a settings file next to the server.

import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { RECIPE_HELP } from './recipe-help.js';

export const PROVIDERS = {
  anthropic: { label: 'Claude (Anthropic)', model: 'claude-opus-5-5', env: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/' },
  openai: { label: 'ChatGPT (OpenAI)', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Gemini (Google)', model: 'gemini-flash-latest', free: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter (has free models)', model: 'openrouter/free', free: true, baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys' },
  local: { label: 'Local / other (OpenAI-compatible: Ollama, LM Studio…)', model: 'llama3.2-vision', baseUrl: 'http://localhost:11434/v1', env: '', keyUrl: '' },
};

const Analysis = z.object({
  model_description: z.string().describe('One or two sentences: what the whole model is.'),
  items: z
    .array(
      z.object({
        name: z.string().describe('Short name, e.g. "Candle", "Cake base", "Support strut".'),
        object_ids: z.array(z.number().int()).describe('Numbers of the detected objects that make up this item.'),
        description: z.string().describe('What this item is and how you recognised it.'),
        suggestion: z.enum(['keep', 'remove', 'review']),
        reason: z.string().describe('Why you suggest keeping/removing it, in one sentence.'),
      }),
    )
    .describe('Every labelled object should appear in exactly one item.'),
  tips: z.array(z.string()).describe('Optional hints, e.g. objects that look wrongly split or merged.'),
});

const SYSTEM = `You help people edit 3D-printable STL models in a mesh editor.
The editor has automatically split the model into numbered "objects" by cutting it at concave creases (where one shape joins another). This split is approximate: one real-world part may be cut into several objects (e.g. a candle and its flame), and occasionally two parts stay merged.

You get rendered views of the model where each object has its own colour and a "#N" label, plus a table of each object's size and position. Identify what each object is, group objects that form one real-world part into a single item, and suggest whether to keep, remove or review each item.
- If the user states a goal, base keep/remove suggestions on it.
- Without a goal, suggest "remove" only for things that are clearly unwanted for printing (stray fragments, debris, supports, bases/plates obviously added for display); otherwise "keep".
- Use "review" when unsure.
- Only use object numbers from the table. Be concise and concrete.`;

// settings: { provider, model, baseUrl, apiKey } (see resolveSettings).
export async function analyzeModel(body, settings = {}) {
  const { images = [], objects = [], fileName = 'model.stl', goal = '', units = 'model units' } = body;
  if (!images.length || !objects.length) throw new HttpError(400, 'Nothing to analyse.');

  const table = objects
    .map(
      (o) =>
        `#${o.id}: ${o.triangles} triangles, ${(o.share * 100).toFixed(1)}% of surface, ` +
        `size ${o.size.map((v) => v.toFixed(1)).join(' x ')}, centre (${o.center.map((v) => v.toFixed(1)).join(', ')})`,
    )
    .join('\n');
  const request = {
    system: SYSTEM,
    images,
    text:
      `File: ${fileName}\nCoordinates are in ${units}, Z is up.\n\nDetected objects:\n${table}\n\n` +
      (goal.trim() ? `The user's goal: ${goal.trim()}` : 'The user did not state a goal.'),
  };
  const provider = settings.provider || 'anthropic';
  const result = provider === 'anthropic' ? await askClaude(request, settings) : await askOpenAICompatible(request, settings);

  // Keep only object ids that exist, and each id in one item.
  const valid = new Set(objects.map((o) => o.id));
  const seen = new Set();
  result.items = result.items
    .map((item) => ({
      ...item,
      object_ids: item.object_ids.filter((id) => valid.has(id) && !seen.has(id) && seen.add(id)),
    }))
    .filter((item) => item.object_ids.length);
  return result;
}

// ---------------------------------------------------------------------------
// Make a new object from a description (and optional reference pictures): the
// AI answers with a shape recipe (see src/shapegen.js) that the browser turns
// into a closed mesh. A previous recipe can be passed to change it.

const SYSTEM_MAKE = `You design 3D-printable objects for a mesh editor. The user describes an object (and may attach reference pictures); you answer with a shape recipe that the editor builds into a solid.

${RECIPE_HELP}

Guidelines:
- Real-world size in mm unless the user gives one (a table candle ~ 20–25 mm wide, 80–150 mm tall; a toy wheel ~ 40–60 mm across).
- Model it standing on the plate: nothing below z = 0, the object resting on z = 0.
- Make it printable: walls and details at least 1.2 mm thick, no loose floating pieces – parts that belong together must touch or overlap (overlap them by ~0.5 mm in unions).
- Prefer revolve for round, turned shapes (candles, vases, wheels' rims and tyres, knobs), extrude for flat outlines, around for repeated features (spokes, flutes, teeth), difference for holes.
- Use enough detail to look like the thing, but keep it under ~150 nodes.
- With a reference picture, copy its proportions and main features.
- When a previous recipe is given, change it as asked and keep the rest.

Answer with ONLY a JSON object (no other text):
{"name": "short name", "description": "one sentence: what you made and its size", "recipe": <node>}

Example – "a mug":
{"name": "Mug", "description": "A mug 80 mm across and 95 mm tall with a handle.",
 "recipe": {"difference": [
   {"union": [
     {"cylinder": {"r": 40, "h": 95}},
     {"torus": {"R": 22, "r": 5}, "rotate": [90, 0, 0], "translate": [42, 0, 50]}]},
   {"cylinder": {"r": 36, "h": 95}, "translate": [0, 0, 4]}]}}

Example – "a candle with drips" (revolve profile points are [distance from the axis, height], going round the outline):
{"name": "Candle", "description": "A candle 24 mm wide and 100 mm tall with a wick and drips.",
 "recipe": {"union": [
   {"revolve": {"profile": [[0, 0], [12, 0], [12, 90], [10, 92], [0, 92]]}},
   {"around": {"count": 7, "shape": {"cylinder": {"r": 1.6, "h": 14, "r2": 0.8}, "translate": [11.6, 0, 76]}}},
   {"cylinder": {"r": 1, "h": 9, "r2": 0.6}, "translate": [0, 0, 91]}]}}`;

export async function makeShape(body, settings = {}) {
  const { prompt = '', images = [], previous = null, error = '' } = body;
  if (!String(prompt).trim() && !images.length) throw new HttpError(400, 'Describe the object to make.');
  if (images.length > 4) throw new HttpError(400, 'At most 4 reference pictures.');
  const text = error
    ? `Your recipe below could not be built – the editor said: "${String(error).slice(0, 400)}".\n${JSON.stringify(previous)}\n\nAnswer the whole corrected recipe in the same JSON answer format, using only the node types listed. The object asked for: ${String(prompt).trim() || 'the object in the picture'}`
    : (previous ? `Previous recipe (change it as asked):\n${JSON.stringify(previous)}\n\n` : '') + `Object: ${String(prompt).trim() || 'the object in the picture'}`;
  const provider = settings.provider || 'anthropic';
  let reply, replacedModel, usedInstead;
  if (provider === 'anthropic') {
    const content = [];
    for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime || 'image/jpeg', data: img.data } });
    content.push({ type: 'text', text });
    try {
      const client = new Anthropic(settings.apiKey ? { apiKey: settings.apiKey } : {});
      const response = await client.messages.create({
        model: settings.model || PROVIDERS.anthropic.model,
        max_tokens: 16000,
        output_config: { effort: 'medium' },
        system: SYSTEM_MAKE,
        messages: [{ role: 'user', content }],
      });
      if (response.stop_reason === 'refusal') throw new HttpError(422, 'The AI declined to make this.');
      reply = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    } catch (err) {
      throw err instanceof HttpError ? err : claudeError(err);
    }
  } else {
    const content = [];
    for (const img of images) content.push({ type: 'image_url', image_url: { url: `data:${img.mime || 'image/jpeg'};base64,${img.data}` } });
    content.push({ type: 'text', text });
    const req = {
      model: settings.model || PROVIDERS[provider]?.model,
      messages: [
        { role: 'system', content: SYSTEM_MAKE },
        { role: 'user', content: images.length ? content : text },
      ],
      response_format: { type: 'json_object' },
    };
    const data = await chatWithBackups(settings, req);
    const r = data?.choices?.[0]?.message?.content;
    reply = Array.isArray(r) ? r.map((p) => p.text || '').join('') : r || '';
    replacedModel = data.replacedModel;
    usedInstead = data.usedInstead;
  }
  const answer = parseRecipe(reply);
  if (replacedModel) answer.replacedModel = replacedModel;
  if (usedInstead) answer.usedInstead = usedInstead;
  return answer;
}

// The JSON object in a reply (it may be wrapped in a code block or text).
export function parseRecipe(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new HttpError(502, 'The AI did not answer with a shape – try again, or describe it differently.');
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new HttpError(502, 'The AI answered with broken JSON – try again, or another model.');
  }
  // The recipe – or, when the AI answered the shape itself, the whole object.
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => !['name', 'description'].includes(k)));
  const recipe = obj.recipe && typeof obj.recipe === 'object' ? obj.recipe : obj.shape && typeof obj.shape === 'object' ? obj.shape : Object.keys(rest).length ? rest : null;
  if (!recipe) throw new HttpError(502, 'The AI answer has no shape recipe – try again.');
  return { name: String(obj.name || 'Generated model').slice(0, 80), description: String(obj.description || ''), recipe };
}

// Claude, through the Anthropic SDK with structured output.
async function askClaude({ system, images, text }, { apiKey, model }) {
  const content = [];
  for (const img of images) {
    content.push({ type: 'text', text: `View: ${img.view}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.data } });
  }
  content.push({ type: 'text', text });
  let response;
  try {
    const client = new Anthropic(apiKey ? { apiKey } : {});
    response = await client.beta.messages.parse({
      model: model || PROVIDERS.anthropic.model,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: betaZodOutputFormat(Analysis) },
      // If a safety classifier declines, the API retries on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    throw claudeError(err);
  }
  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The AI declined to analyse this model.');
  if (!response.parsed_output) throw new HttpError(502, 'The AI returned an unreadable answer – try again.');
  return response.parsed_output;
}

function claudeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return new HttpError(401, 'Claude rejected the API key – check it in ✨ AI → AI settings.');
  if (err instanceof Anthropic.NotFoundError) return new HttpError(400, `Claude doesn't know that model – check the model name in AI settings (${err.message}).`);
  if (err instanceof Anthropic.RateLimitError) return new HttpError(429, 'AI is busy (rate limited) – try again in a minute.');
  if (err instanceof Anthropic.APIError) return new HttpError(502, `AI request failed (${err.status}): ${err.message}`);
  if (err instanceof Error && /api key|apiKey|credentials/i.test(err.message)) return new HttpError(400, NO_KEY('anthropic'));
  return err;
}

const NO_KEY = (provider) => `No API key for ${PROVIDERS[provider]?.label || provider} – open ✨ AI → AI settings and paste one.`;

// What the answer must look like, for providers without Claude's structured
// output: described in the prompt, checked here.
const JSON_SHAPE = `
Answer with ONLY a JSON object (no other text) of this shape:
{"model_description": "…", "items": [{"name": "…", "object_ids": [1, 2], "description": "…", "suggestion": "keep" | "remove" | "review", "reason": "…"}], "tips": ["…"]}`;

// ChatGPT, Gemini, Ollama, LM Studio… – the OpenAI chat completions format.
async function askOpenAICompatible({ system, images, text }, settings) {
  const { provider, model } = settings;
  const content = [];
  for (const img of images) {
    content.push({ type: 'text', text: `View: ${img.view}` });
    content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${img.data}` } });
  }
  content.push({ type: 'text', text });
  const body = {
    model: model || PROVIDERS[provider]?.model,
    messages: [
      { role: 'system', content: system + JSON_SHAPE },
      { role: 'user', content },
    ],
    response_format: { type: 'json_object' },
  };
  const data = await chatWithBackups(settings, body);
  const reply = data?.choices?.[0]?.message?.content;
  const textReply = Array.isArray(reply) ? reply.map((p) => p.text || '').join('') : reply || '';
  const answer = parseAnswer(textReply);
  if (data.replacedModel) answer.replacedModel = data.replacedModel;
  if (data.usedInstead) answer.usedInstead = data.usedInstead;
  return answer;
}

// ---------------------------------------------------------------------------
// Busy free AIs. Free tiers are often "busy": a per-minute limit, a used-up
// daily allowance, or the servers overloaded. Then the request is retried
// once after a short wait, other free models of the same AI are tried, and
// then the other free AIs that have a key saved (Gemini ↔ OpenRouter).

export const FREE_MODELS = {
  gemini: ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  openrouter: ['openrouter/free'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One model: asks again without response_format if the server doesn't take
// it, and once more after a short wait if it's only busy for a moment.
async function chatOnce(t, req) {
  const body = { ...req, model: t.model };
  const ask = () =>
    chatCompletion(t.provider, t.baseUrl, t.apiKey, body).catch((err) => {
      if (err instanceof HttpError && err.status === 400 && body.response_format && /response_format|json/i.test(err.message)) {
        delete body.response_format;
        return chatCompletion(t.provider, t.baseUrl, t.apiKey, body);
      }
      throw err;
    });
  try {
    return await ask();
  } catch (err) {
    if (!(err instanceof HttpError) || !err.busy || err.daily || !(err.retryIn <= chatOnce.maxWait)) throw err;
    await sleep(err.retryIn * 1000);
    return ask();
  }
}
chatOnce.maxWait = 20; // seconds

export async function chatWithBackups(settings, req) {
  const tries = [];
  const seen = new Set();
  const add = (s, model) => {
    const key = s.provider + '|' + model;
    if (!model || seen.has(key)) return;
    seen.add(key);
    tries.push({ ...s, model });
  };
  add(settings, settings.model || PROVIDERS[settings.provider]?.model);
  for (const m of FREE_MODELS[settings.provider] || []) add(settings, m);
  for (const o of settings.others || []) {
    add(o, o.model);
    for (const m of FREE_MODELS[o.provider] || []) add(o, m);
  }
  const failed = [];
  for (let i = 0; i < tries.length; i++) {
    const t = tries[i];
    try {
      const data = await chatOnce(t, req);
      if (i > 0) {
        delete data.replacedModel; // that was another model's
        data.usedInstead = `${failed.map((f) => f.split(':')[0]).join(', ')} busy – answered by ${PROVIDERS[t.provider]?.label.replace(/ \(.*\)/, '')} · ${t.model}`;
      }
      return data;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      // The chosen model itself: only "busy" moves on; a backup may also be
      // unknown (retired) or not allowed with that key.
      if (i === 0 && !err.busy) throw err;
      failed.push(`${t.model}: ${err.reason || err.message}`);
    }
  }
  const tip = settings.others?.length ? '' : ' Tip: also save a free OpenRouter key (AI settings → OpenRouter) – it is used when Gemini is busy.';
  throw new HttpError(429, `All free AIs are busy right now – ${failed.join('; ')}. Try again in a minute.${tip}`);
}

async function chatCompletion(provider, baseUrl, apiKey, body, retired = false) {
  const url = (baseUrl || PROVIDERS[provider]?.baseUrl || '').replace(/\/+$/, '') + '/chat/completions';
  if (!/^https?:\/\//.test(url)) throw new HttpError(400, 'Set the server address in AI settings (e.g. http://localhost:11434/v1).');
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch (err) {
    throw new HttpError(502, `Can't reach ${url} – ${err.cause?.code || err.message}. Is the address right${provider === 'local' ? ' and the server running' : ''}?`);
  }
  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {}
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || raw.slice(0, 300);
    if (res.status === 401 || res.status === 403) throw new HttpError(401, `${PROVIDERS[provider]?.label || provider} rejected the API key – check it in AI settings. (${msg})`);
    // A retired model: the error names its replacement ("…use models/x
    // instead") – ask that one once, and say so (the caller saves it).
    const newer = res.status === 404 && !retired && /use (?:models\/)?([\w.-]*\d[\w.-]*)/i.exec(String(msg));
    if (newer && newer[1] !== body.model) {
      const data2 = await chatCompletion(provider, baseUrl, apiKey, { ...body, model: newer[1] }, true);
      return { ...data2, replacedModel: newer[1] };
    }
    if (res.status === 404) throw new HttpError(400, `Model or address not found – check AI settings. (${msg})`);
    if (res.status === 429 || res.status === 503 || res.status === 529 || (res.status >= 500 && /overload|unavailable|try again/i.test(String(msg)))) {
      const text = String(raw);
      const daily = /per ?day|PerDay|daily|limit: ?0\b|quota exceeded for metric.*free_tier_requests.*day/i.test(text);
      const noFree = /limit: ?0\b/.test(text);
      const wait = /retry in ([\d.]+)\s*s|"retryDelay":\s*"(\d+)/i.exec(text);
      const reason = noFree ? 'no free use of this model on your key' : daily ? 'free daily limit used up' : res.status === 429 ? 'too many requests – busy' : 'servers overloaded';
      const err = new HttpError(429, `${PROVIDERS[provider]?.label || provider} is busy: ${reason}. (${String(msg).slice(0, 200)})`);
      Object.assign(err, { busy: true, daily, reason, retryIn: wait ? +(wait[1] || wait[2]) : res.status === 429 ? 0 : 5 });
      throw err;
    }
    throw new HttpError(res.status === 400 ? 400 : 502, `AI request failed (${res.status}): ${msg}`);
  }
  return data;
}

// The JSON object in a reply (it may be wrapped in a code block or text),
// checked against the expected shape; small slips (ids as "#12") are fixed.
export function parseAnswer(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new HttpError(502, 'The AI did not answer with the expected JSON – try again, or another model.');
  let obj;
  try {
    obj = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new HttpError(502, 'The AI answered with broken JSON – try again, or another model.');
  }
  const items = (Array.isArray(obj.items) ? obj.items : []).map((it) => ({
    name: String(it?.name ?? 'Part'),
    object_ids: (Array.isArray(it?.object_ids) ? it.object_ids : []).map((x) => parseInt(String(x).replace(/[^\d-]/g, ''), 10)).filter(Number.isInteger),
    description: String(it?.description ?? ''),
    suggestion: ['keep', 'remove', 'review'].includes(it?.suggestion) ? it.suggestion : 'keep',
    reason: String(it?.reason ?? ''),
  }));
  const checked = Analysis.safeParse({
    model_description: String(obj.model_description ?? ''),
    items,
    tips: Array.isArray(obj.tips) ? obj.tips.map(String) : [],
  });
  if (!checked.success) throw new HttpError(502, 'The AI answer was missing parts – try again.');
  return checked.data;
}

// A tiny request to check the settings work.
export async function testSettings(settings) {
  const provider = settings.provider || 'anthropic';
  if (provider === 'anthropic') {
    try {
      const client = new Anthropic(settings.apiKey ? { apiKey: settings.apiKey } : {});
      const response = await client.messages.create({
        model: settings.model || PROVIDERS.anthropic.model,
        max_tokens: 1024,
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
      });
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { ok: true, model: response.model, reply: text };
    } catch (err) {
      throw claudeError(err);
    }
  }
  const data = await chatCompletion(provider, settings.baseUrl, settings.apiKey, {
    model: settings.model || PROVIDERS[provider]?.model,
    messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
    max_tokens: 20,
  });
  return { ok: true, model: data?.model || data?.replacedModel || settings.model, replacedModel: data?.replacedModel, reply: String(data?.choices?.[0]?.message?.content ?? '').trim() };
}

// ---------------------------------------------------------------------------
// Settings file: { provider, models: {…}, baseUrls: {…}, keys: {…} }.

export function loadSettings(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

// The settings to use: saved ones, keys from the environment as a fallback.
export function resolveSettings(file, envKey = () => undefined, only = null) {
  const saved = loadSettings(file);
  const provider = only || (PROVIDERS[saved.provider] ? saved.provider : 'anthropic');
  const p = PROVIDERS[provider];
  const apiKey = saved.keys?.[provider] || (provider === 'anthropic' ? envKey() : '') || (p.env ? process.env[p.env] : '') || '';
  return { provider, model: saved.models?.[provider] || p.model, baseUrl: saved.baseUrls?.[provider] || p.baseUrl || '', apiKey };
}

// What the browser may see: no keys, only whether one is set.
function publicSettings(file, envKey) {
  const saved = loadSettings(file);
  const current = resolveSettings(file, envKey);
  return {
    provider: current.provider,
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      defaultModel: p.model,
      model: saved.models?.[id] || p.model,
      baseUrl: saved.baseUrls?.[id] || p.baseUrl || '',
      needsBaseUrl: id === 'local',
      keyUrl: p.keyUrl,
      free: !!p.free,
      hasKey: !!(saved.keys?.[id] || (id === 'anthropic' && envKey()) || (p.env && process.env[p.env])),
    })),
  };
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Connect-style middleware for Vite's dev and preview servers (and the
// desktop app's server). settingsFile: where the AI settings are saved.
export function aiMiddleware(getApiKey = () => undefined, { settingsFile = 'ai-settings.json' } = {}) {
  return async (req, res, next) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/ai/')) return next();
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    try {
      if (path === '/api/ai/settings' && req.method === 'GET') return send(200, publicSettings(settingsFile, getApiKey));
      if (req.method !== 'POST') return send(405, { error: 'Method not allowed.' });
      if (path === '/api/ai/settings') {
        const body = JSON.parse(await readBody(req, 64 * 1024));
        const saved = loadSettings(settingsFile);
        const provider = PROVIDERS[body.provider] ? body.provider : 'anthropic';
        saved.provider = provider;
        saved.models = { ...saved.models, [provider]: String(body.model || '').trim() || PROVIDERS[provider].model };
        if (body.baseUrl !== undefined) saved.baseUrls = { ...saved.baseUrls, [provider]: String(body.baseUrl).trim() };
        saved.keys = { ...saved.keys };
        if (body.clearKey) delete saved.keys[provider];
        else if (body.apiKey && String(body.apiKey).trim()) saved.keys[provider] = String(body.apiKey).trim();
        saveSettings(settingsFile, saved);
        return send(200, publicSettings(settingsFile, getApiKey));
      }
      const settings = resolveSettings(settingsFile, getApiKey);
      if (!settings.apiKey && settings.provider !== 'local') throw new HttpError(400, NO_KEY(settings.provider));
      // The other free AIs with a key: used when the chosen one is busy.
      settings.others = Object.keys(FREE_MODELS)
        .filter((id) => id !== settings.provider)
        .map((id) => resolveSettings(settingsFile, getApiKey, id))
        .filter((o) => o.apiKey);
      // Remember a replacement for a retired model, so it's asked directly next time.
      const keepModel = (result) => {
        if (!result.replacedModel) return result;
        const saved = loadSettings(settingsFile);
        saved.models = { ...saved.models, [settings.provider]: result.replacedModel };
        saveSettings(settingsFile, saved);
        return result;
      };
      if (path === '/api/ai/test') return send(200, keepModel(await testSettings(settings)));
      if (path === '/api/ai/generate') {
        const body = JSON.parse(await readBody(req, 30 * 1024 * 1024));
        return send(200, keepModel(await makeShape(body, settings)));
      }
      if (path === '/api/ai/analyze') {
        const body = JSON.parse(await readBody(req, 40 * 1024 * 1024));
        return send(200, keepModel(await analyzeModel(body, settings)));
      }
      return send(404, { error: 'Unknown AI request.' });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[ai]', err);
      send(status, { error: err instanceof HttpError ? err.message : 'AI request failed – see the server log.' });
    }
  };
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
