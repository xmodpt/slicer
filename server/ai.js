// Server-side AI analysis. Runs inside the Vite dev/preview server (see
// vite.config.js) so the Anthropic API key never reaches the browser.
//
// The browser sends a few rendered views of the model, with every detected
// object drawn in its own colour and labelled with its number, plus each
// object's measurements. Claude looks at them and returns names, groups and
// keep/remove suggestions as structured JSON.

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

const MODEL = 'claude-opus-5-5';

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

export async function analyzeModel(body, { apiKey } = {}) {
  const { images = [], objects = [], fileName = 'model.stl', goal = '', units = 'model units' } = body;
  if (!images.length || !objects.length) throw new HttpError(400, 'Nothing to analyse.');

  const table = objects
    .map(
      (o) =>
        `#${o.id}: ${o.triangles} triangles, ${(o.share * 100).toFixed(1)}% of surface, ` +
        `size ${o.size.map((v) => v.toFixed(1)).join(' x ')}, centre (${o.center.map((v) => v.toFixed(1)).join(', ')})`,
    )
    .join('\n');

  const content = [];
  for (const img of images) {
    content.push({ type: 'text', text: `View: ${img.view}` });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: img.data } });
  }
  content.push({
    type: 'text',
    text:
      `File: ${fileName}\nCoordinates are in ${units}, Z is up.\n\nDetected objects:\n${table}\n\n` +
      (goal.trim() ? `The user's goal: ${goal.trim()}` : 'The user did not state a goal.'),
  });

  let response;
  try {
    const client = new Anthropic(apiKey ? { apiKey } : {});
    response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: betaZodOutputFormat(Analysis) },
      // If a safety classifier declines, the API retries on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      throw new HttpError(500, 'The server has no valid Anthropic API key. Set ANTHROPIC_API_KEY (see README).');
    }
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(429, 'AI is busy (rate limited) – try again in a minute.');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `AI request failed (${err.status}): ${err.message}`);
    if (err instanceof Error && /api key|apiKey|credentials/i.test(err.message)) {
      throw new HttpError(500, 'The server has no Anthropic API key. Set ANTHROPIC_API_KEY (see README).');
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new HttpError(422, 'The AI declined to analyse this model.');
  if (!response.parsed_output) throw new HttpError(502, 'The AI returned an unreadable answer – try again.');

  // Keep only object ids that exist, and each id in one item.
  const valid = new Set(objects.map((o) => o.id));
  const seen = new Set();
  const result = response.parsed_output;
  result.items = result.items
    .map((item) => ({
      ...item,
      object_ids: item.object_ids.filter((id) => valid.has(id) && !seen.has(id) && seen.add(id)),
    }))
    .filter((item) => item.object_ids.length);
  return result;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Connect-style middleware for Vite's dev and preview servers.
export function aiMiddleware(getApiKey) {
  return async (req, res, next) => {
    if (req.url !== '/api/ai/analyze') return next();
    if (req.method !== 'POST') {
      res.statusCode = 405;
      return res.end();
    }
    const send = (status, payload) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(payload));
    };
    try {
      const body = JSON.parse(await readBody(req, 25 * 1024 * 1024));
      send(200, await analyzeModel(body, { apiKey: getApiKey() }));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error('[ai]', err);
      send(status, { error: err instanceof HttpError ? err.message : 'AI analysis failed – see the server log.' });
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
