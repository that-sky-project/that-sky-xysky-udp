export function handleDisconnect(session, payload, { logger, transport }) {
  logger.debug({ sessionId: session.id }, 'client requested disconnect');
  session.close();
  transport.disconnect(session.peerId, 'normal', payload?.reason ?? 0);
}
