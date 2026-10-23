import { PacketIds } from '../../protocol/PacketIds.js';

export function handlePing(session, payload, { broadcaster, clock }) {
  const recv = clock();
  broadcaster.send(session, {
    id: PacketIds.NetTimePong,
    payload: {
      requestId: payload.requestId,
      serverRecvTime: recv,
      serverSendTime: clock()
    }
  });
}
