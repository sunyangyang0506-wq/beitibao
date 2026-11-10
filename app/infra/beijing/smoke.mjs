import { createServer } from 'node:http';

function respond(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') return respond(response, 200, { status: 'ok' });
  if (request.method !== 'POST' || request.url !== '/invoke') return respond(response, 404, { status: 'missing' });
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 16_384) return respond(response, 413, { status: 'too_large' });
      chunks.push(chunk);
    }
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const id = event?.id;
    if (event.source !== 'beitibao.queue.smoke' || typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      return respond(response, 400, { status: 'invalid_event' });
    }
    console.log(JSON.stringify({ code: 'QUEUE_SMOKE_RECEIVED', id }));
    return respond(response, 200, { status: 'ok' });
  } catch {
    return respond(response, 400, { status: 'invalid_event' });
  }
}).listen(9000, '0.0.0.0');
