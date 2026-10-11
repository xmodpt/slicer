import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chatWithBackups } from '../server/ai.js';

// A fake OpenAI-compatible server: answers per model as told.
function fakeServer(behaviour) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const { model } = JSON.parse(b);
      seen.push(model);
      const [status, body] = behaviour(model, seen.filter((m) => m === model).length);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, seen, url: `http://127.0.0.1:${server.address().port}/v1` })));
}
const answer = (model) => [200, { model, choices: [{ message: { content: '{"ok": true}' } }] }];
const daily = [429, { error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: x. Per day. Please retry in 3.2s.' } }];
const overloaded = [503, { error: { code: 503, message: 'The model is overloaded. Please try again later.' } }];
const perMinute = [429, { error: { code: 429, message: 'Resource exhausted. Please retry in 0.1s.' } }];
const req = { messages: [{ role: 'user', content: 'hi' }] };

test('a busy Gemini model: the other free Gemini models are tried, and it says which one answered', async () => {
  const { server, seen, url } = await fakeServer((m) => (m === 'gemini-2.5-flash' ? answer(m) : m === 'gemini-flash-latest' ? daily : overloaded));
  try {
    const data = await chatWithBackups({ provider: 'gemini', model: 'gemini-flash-latest', baseUrl: url, apiKey: 'k', others: [] }, req);
    assert.equal(data.model, 'gemini-2.5-flash');
    assert.match(data.usedInstead, /answered by Gemini · gemini-2.5-flash/);
    // A used-up daily limit is not waited for; an overloaded one is retried once.
    assert.equal(seen.filter((m) => m === 'gemini-flash-latest').length, 1);
  } finally {
    server.close();
  }
});

test('busy for a moment: waits and asks the same model again', async () => {
  const { server, seen, url } = await fakeServer((m, n) => (n === 1 ? perMinute : answer(m)));
  try {
    const data = await chatWithBackups({ provider: 'gemini', model: 'gemini-flash-latest', baseUrl: url, apiKey: 'k', others: [] }, req);
    assert.equal(data.model, 'gemini-flash-latest');
    assert.equal(data.usedInstead, undefined);
    assert.deepEqual(seen, ['gemini-flash-latest', 'gemini-flash-latest']);
  } finally {
    server.close();
  }
});

test('all Gemini models busy: OpenRouter (with a saved key) answers; nothing left: a clear message', async () => {
  const g = await fakeServer(() => daily);
  const o = await fakeServer((m) => answer(m));
  try {
    const data = await chatWithBackups(
      { provider: 'gemini', model: 'gemini-flash-latest', baseUrl: g.url, apiKey: 'k', others: [{ provider: 'openrouter', model: 'openrouter/free', baseUrl: o.url, apiKey: 'k2' }] },
      req,
    );
    assert.equal(data.model, 'openrouter/free');
    assert.match(data.usedInstead, /OpenRouter/);
    await assert.rejects(
      chatWithBackups({ provider: 'gemini', model: 'gemini-flash-latest', baseUrl: g.url, apiKey: 'k', others: [] }, req),
      (err) => err.status === 429 && /All free AIs are busy/.test(err.message) && /daily limit/.test(err.message) && /OpenRouter key/.test(err.message),
    );
  } finally {
    g.server.close();
    o.server.close();
  }
});

test('a real mistake (wrong key) is reported straight away, not hidden by backups', async () => {
  const { server, seen, url } = await fakeServer(() => [401, { error: { message: 'API key not valid' } }]);
  try {
    await assert.rejects(chatWithBackups({ provider: 'gemini', model: 'gemini-flash-latest', baseUrl: url, apiKey: 'bad', others: [] }, req), /rejected the API key/);
    assert.equal(seen.length, 1);
  } finally {
    server.close();
  }
});
