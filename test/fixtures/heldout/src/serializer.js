export function serializeMessage(message) {
  return JSON.stringify({ text: message.text, sentAt: message.sentAt.toISOString() });
}

export function deserializeMessage(json) {
  const message = JSON.parse(json);
  return { text: message.text, sentAt: new Date(message.sentAt) };
}
