import { PacketIds } from '../../protocol/PacketIds.js';

export function handleJoin(session, payload, { joinService }) {
  joinService.join(session, payload);
}
