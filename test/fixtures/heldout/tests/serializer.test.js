import { serializeMessage, deserializeMessage } from '../src/serializer.js';

export function testMessageRoundTrip() {
  const message = { text: 'hello', sentAt: new Date('2026-01-01') };
  const restored = deserializeMessage(serializeMessage(message));
  if (restored.text !== message.text) throw new Error('lost text');
}
