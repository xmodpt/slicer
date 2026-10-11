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

// "Kit" mode: sort small patches into the parts a figure is printed in.
const SYSTEM_KIT = `You help prepare a 3D-printable figure or model as a kit of separate parts, the way miniature and statue creators split their models before printing: head, hair, torso/jacket, each arm, hands, skirt or trousers, each leg, shoes or feet, accessories, and props such as a table, chair, rock or base.
The editor has split the model into many small numbered "patches" along its folds; one real part is made of many patches. You get rendered views where each patch has its own colour and a "#N" label, plus a table of each patch's size and position (Z is up).

Assign EVERY patch to exactly one part:
- Name parts clearly, e.g. "Head", "Hair", "Jacket", "Left arm (figure's left)", "Right hand", "Skirt", "Left leg", "Right shoe", "Table". Use the figure's own left/right.
- Group by what the patches show, not by where patch borders happen to be.
- Choose parts that make sense to print separately and glue back: separations at natural seams – clothing edges, collars, cuffs, where a shoe meets a leg, where the figure touches a prop.
- Keep small details with the part they sit on (a badge stays with the jacket, a button with the shirt) unless they are clearly separate objects.
- suggestion: "keep" for every part, "review" only if you are unsure which part some patches belong to.
- description: what the part is; reason: why this is a good place to separate it. Use only patch numbers from the table.`;

// settings: { provider, model, baseUrl, apiKey } (see resolveSettings).
export async function analyzeModel(body, settings = {}) {
  const { images = [], objects = [], fileName = 'model.stl', goal = '', units = 'model units', mode = 'objects' } = body;
  const kit = mode === 'kit';
  if (!images.length || !objects.length) throw new HttpError(400, 'Nothing to analyse.');

  const table = objects
    .map(
      (o) =>
        `#${o.id}: ${o.triangles} triangles, ${(o.share * 100).toFixed(1)}% of surface, ` +
        `size ${o.size.map((v) => v.toFixed(1)).join(' x ')}, centre (${o.center.map((v) => v.toFixed(1)).join(', ')})`,
    )
    .join('\n');
  const request = {
    system: kit ? SYSTEM_KIT : SYSTEM,
    images,
    text:
      `File: ${fileName}\nCoordinates are in ${units}, Z is up.\n\n${kit ? 'Patches' : 'Detected objects'}:\n${table}\n\n` +
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
async function askOpenAICompatible({ system, images, text }, { provider, apiKey, model, baseUrl }) {
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
  let data = await chatCompletion(provider, baseUrl, apiKey, body).catch(async (err) => {
    // Some servers don't take response_format – ask again without it.
    if (err instanceof HttpError && err.status === 400 && /response_format|json/i.test(err.message)) {
      delete body.response_format;
      return chatCompletion(provider, baseUrl, apiKey, body);
    }
    throw err;
  });
  const reply = data?.choices?.[0]?.message?.content;
  const textReply = Array.isArray(reply) ? reply.map((p) => p.text || '').join('') : reply || '';
  const answer = parseAnswer(textReply);
  if (data.replacedModel) answer.replacedModel = data.replacedModel;
  return answer;
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
    if (res.status === 429) throw new HttpError(429, `AI is busy or out of credit (rate limited). (${msg})`);
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
export function resolveSettings(file, envKey = () => undefined) {
  const saved = loadSettings(file);
  const provider = PROVIDERS[saved.provider] ? saved.provider : 'anthropic';
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
      // Remember a replacement for a retired model, so it's asked directly next time.
      const keepModel = (result) => {
        if (!result.replacedModel) return result;
        const saved = loadSettings(settingsFile);
        saved.models = { ...saved.models, [settings.provider]: result.replacedModel };
        saveSettings(settingsFile, saved);
        return result;
      };
      if (path === '/api/ai/test') return send(200, keepModel(await testSettings(settings)));
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
