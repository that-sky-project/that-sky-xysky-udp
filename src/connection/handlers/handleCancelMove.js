export function handleCancelMove(session, payload, { moveService, logger }) {
  const player = moveService.players.getBySession(session);
  moveService.cancelPlayerMove(player, payload.reason);
  logger.debug({ sessionId: session.id, reason: payload.reason }, 'client cancelled move');
}
