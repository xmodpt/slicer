import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { parseAnswer, resolveSettings, aiMiddleware } from '../server/ai.js';

test('answers from other AIs: JSON found inside text, ids like "#12" fixed', () => {
  const r = parseAnswer('Sure! ```json\n{"model_description":"A figure","items":[{"name":"Head","object_ids":["#3", 4],"description":"d","suggestion":"keep","reason":"r"},{"name":"Table","object_ids":[7]}],"tips":[]}\n```');
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items[0].object_ids, [3, 4]);
  assert.equal(r.items[1].suggestion, 'keep');
  assert.throws(() => parseAnswer('no json here'));
});

// Calls the middleware like the server would.
function call(mw, method, url, body) {
  return new Promise((resolve) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url });
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(data) {
        resolve({ status: this.statusCode, body: data ? JSON.parse(data) : null });
      },
    };
    mw(req, res, () => resolve({ status: 'next' }));
  });
}

test('AI settings: saved per provider, keys never sent back', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-')), 'ai-settings.json');
  const mw = aiMiddleware(() => undefined, { settingsFile: file });
  const saved = await call(mw, 'POST', '/api/ai/settings', { provider: 'openai', model: 'gpt-test', apiKey: 'sk-secret-123' });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.body).includes('sk-secret-123'), 'key not in the answer');
  const got = await call(mw, 'GET', '/api/ai/settings');
  assert.ok(!JSON.stringify(got.body).includes('sk-secret-123'));
  assert.equal(got.body.provider, 'openai');
  const openai = got.body.providers.find((p) => p.id === 'openai');
  assert.equal(openai.hasKey, true);
  assert.equal(openai.model, 'gpt-test');
  const s = resolveSettings(file);
  assert.equal(s.apiKey, 'sk-secret-123');
  assert.equal(s.baseUrl, 'https://api.openai.com/v1');
  // Removing the key.
  await call(mw, 'POST', '/api/ai/settings', { provider: 'openai', model: 'gpt-test', clearKey: true });
  assert.equal(resolveSettings(file).apiKey, process.env.OPENAI_API_KEY || '');
  // Without a key, a clear message pointing to the settings.
  const r = await call(mw, 'POST', '/api/ai/analyze', { images: [], objects: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /AI settings/);
  // Other URLs pass through.
  assert.equal((await call(mw, 'GET', '/index.html')).status, 'next');
});
