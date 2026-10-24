const http = require('node:http');

let seq = 0;

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
