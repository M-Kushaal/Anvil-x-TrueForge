// Prints a TrueForge session's events, oldest first, one line each (debugging aid).
// Usage: node scripts/session-log.mjs [sessionId] [count]   (default: the latest session, 40 events)
import { TrueForge } from '@truefoundry/trueforge-sdk';

const client = new TrueForge({ baseUrl: process.env.TRUEFORGE_URL ?? 'http://localhost:8790' });
const [, , sessionArg, countArg = '40'] = process.argv;

let id = sessionArg;
if (!id) for await (const session of await client.sessions.list()) { id = session.id; break; }

const events = [];
for await (const { event } of await client.sessions.listEvents(id)) events.push(event);
events.reverse();

/** "read_file({"path":"src/x.py"})" for each tool call in a model message. */
const calls = (event) => event.toolCalls?.map((call) => {
  const args = JSON.parse(call.function.arguments || '{}');
  return `${args.tool_name ?? call.function.name}(${JSON.stringify(args.input ?? args).slice(0, 90)})`;
}).join(' ');

for (const event of events.slice(-Number(countArg))) {
  const detail = calls(event) ?? event.content ?? event.output ?? event.state?.message ?? event.state?.status ?? '';
  const text = (typeof detail === 'string' ? detail : JSON.stringify(detail)).replace(/\s+/g, ' ').slice(0, 150);
  const tokens = event.usage ? ` [${event.usage.inputTokens}]` : '';
  console.log(`${event.createdAt?.slice(11, 19) ?? ''} ${event.type.padEnd(22)}${tokens} ${text}`);
}
console.log(`${events.length} events in session ${id}`);
