export function handleDisconnect(session, payload, { logger, transport, finalizeSession }) {
  logger.debug({ sessionId: session.id }, 'client requested disconnect');
  if (finalizeSession) return finalizeSession(session, 'client_disconnect', { disconnect: 'now' });
  session.close();
  transport.disconnect(session.peerId, 'normal', payload?.reason ?? 0);
}
