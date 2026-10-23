export function handleLevelUpdate(session, payload, { levelService }) {
  levelService.changeLevel(session, payload);
}
