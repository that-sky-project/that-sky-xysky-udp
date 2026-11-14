/** ENet queues successfully with 0; a negative numeric result is failure. */
export function sendPacket(broadcaster, session, packet, options, failureMessage = 'Packet send failed to queue') {
  const result = broadcaster.send(session, packet, options);
  if (typeof result === 'number' && result < 0) throw new Error(failureMessage);
  return result;
}
