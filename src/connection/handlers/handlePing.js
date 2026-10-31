import { PacketIds } from '../../protocol/PacketIds.js';

const DEFAULT_SCALAR = 0;

export function handlePing(session, payload, { broadcaster, clock }) {
  const now = clock();
  broadcaster.send(session, {
    id: PacketIds.NetTimePong,
    payload: {
      requestId: payload.requestId,
      serverTime: now,
      reserved: 0,
      scalar: DEFAULT_SCALAR
    }
  });
}
