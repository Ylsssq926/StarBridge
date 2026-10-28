const http = require('node:http');

let seq = 0;
const badKeyHits = new Map();
const rateKeyHits = new Map();

function usage(model) {
  return { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    seq += 1;
    const model = (() => {
      try {
        return JSON.parse(body || '{}').model || 'mock-model';
      } catch {
        return 'mock-model';
      }
    })();
    const headers = { 'content-type': 'application/json' };
    // Harness runs reuse one long-lived mock process; without a reset the
    // "fails once" credential below stays healthy and the auto-disable case
    // silently stops reproducing on the second run.
    if (req.method === 'POST' && req.url === '/__reset') {
      badKeyHits.clear();
      rateKeyHits.clear();
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // A revoked credential: lets the harness exercise per-key auto-disable
    // without a real upstream.
    const auth = String(req.headers.authorization || '');
    // Account-level rate limiting: the first request on this credential is
    // answered with 429 + Retry-After, then it behaves. Lets the harness prove
    // that the gateway rests the key and serves from another one.
    if (auth.includes('rate429')) {
      rateKeyHits.set(auth, (rateKeyHits.get(auth) || 0) + 1);
      if (rateKeyHits.get(auth) <= 1) {
        res.writeHead(429, { ...headers, 'retry-after': '2' });
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded (mock)', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }));
        return;
      }
    }
    if (auth.includes('bad')) {
      // A revoked credential that "comes back": fail a limited number of times,
      // then behave. This lets the harness prove cooldown recovery deterministically
      // (a permanently-401 key would be disabled again the moment it is recovered).
      badKeyHits.set(auth, (badKeyHits.get(auth) || 0) + 1);
      if (badKeyHits.get(auth) <= 1) {
        res.writeHead(401, headers);
        res.end(JSON.stringify({ error: { message: 'invalid api key (mock)', type: 'invalid_request_error', code: 'invalid_api_key' } }));
        return;
      }
    }
    if (/\/messages$/.test(req.url)) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'mock claude reply' }],
        model,
        stop_reason: 'end_turn',
        usage: { input_tokens: 5, output_tokens: 5 },
      }));
      return;
    }
    if (/generateContent|streamGenerateContent/.test(req.url)) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'mock gemini reply' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5, totalTokenCount: 10 },
      }));
      return;
    }
    if (/chat\/completions$|\/embeddings$|completions$/.test(req.url)) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        id: `chatcmpl_mock_${seq}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'mock reply' }, finish_reason: 'stop' }],
        usage: usage(model),
      }));
      return;
    }
    if (req.url.startsWith('/v1/images/generations')) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        created: Math.floor(Date.now() / 1000),
        data: [{ url: 'https://example.com/mock.png', revised_prompt: 'mock' }],
      }));
      return;
    }
    if (req.url.startsWith('/v1/models')) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', owned_by: 'mock' }] }));
      return;
    }
    res.writeHead(404, headers);
    res.end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
  });
});

server.listen(3999, '0.0.0.0', () => console.log('mock upstream on 3999'));
