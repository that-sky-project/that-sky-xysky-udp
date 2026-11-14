export function handleGameMsg(session, payload, { gameMessageService }) {
  gameMessageService.handle(session, payload);
}
