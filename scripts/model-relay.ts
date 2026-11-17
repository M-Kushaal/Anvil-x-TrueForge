// Local OpenAI-compatible relay in front of Groq ("AI gateway"). TrueForge calls it; the
// extension never does. The API key comes from TrueForge's request and is passed through untouched.
// Run: node scripts/model-relay.ts   (env: UPSTREAM, RELAY_PORT; RELAY_LOG=1 prints request sizes)
import http from 'node:http';
import { requestSizes, stripReplayedReasoning, upstreamUrl } from './lib/model-relay.ts';

const UPSTREAM = process.env.UPSTREAM ?? 'https://api.groq.com/openai/v1';
const PORT = Number(process.env.RELAY_PORT ?? 8791);
const LOG = Boolean(process.env.RELAY_LOG);

const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const json = raw && req.headers['content-type']?.includes('json') ? stripReplayedReasoning(JSON.parse(raw)) : undefined;
    if (LOG && json) console.log(requestSizes(json));

    const upstream = await fetch(upstreamUrl({ base: UPSTREAM, path: req.url ?? '/' }), {
      method: req.method,
      headers: { 'content-type': 'application/json', authorization: req.headers.authorization ?? '' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : json ? JSON.stringify(json) : raw || undefined,
    });
    if (LOG) console.log(`  ← ${upstream.status} · tokens left this minute: ${upstream.headers.get('x-ratelimit-remaining-tokens') ?? '?'}`);

    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    const reader = upstream.body?.getReader();
    for (let chunk = await reader?.read(); chunk && !chunk.done; chunk = await reader?.read()) res.write(chunk.value);
    res.end();
  } catch (error) {
    // Surface as a normal upstream failure so TrueForge reports "Cannot connect"-style errors.
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `relay: ${String(error)}` } }));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`model relay  http://127.0.0.1:${PORT}/v1 → ${UPSTREAM}`));
