import { netRpcRouter } from '../../protocol/packets/shared/netRpc/index.js';
import { decodeNetRpcHeader } from '../../protocol/packets/shared/netRpc/NetRpcCodec.js';
import { rpcTap, toHexPreview } from '../rpc/RpcTap.js';

function headerOf(data) {
  const header = decodeNetRpcHeader(data);
  return header ? { classIdKey: header.classIdKey, sender: header.sender,
    receiver: header.receiver, typeFlag: header.typeFlag } : null;
}

/** Orchestrates the existing RPC router; class-specific policy stays in its handlers. */
export class RpcRelay {
  constructor({ delivery, logger, router = netRpcRouter, tap = rpcTap }) {
    this.delivery = delivery;
    this.logger = logger;
    this.router = router;
    this.tap = tap;
  }

  stale(source, session, payload) {
    this.tap.push({ direction: 'C->S', status: 'stale_dropped', playerId: source.id,
      uuid: source.uuid.toString(), sessionId: session.id, levelId: source.levelId,
      levelChangeCount: payload.levelChangeCount, expectedLvSeq: source.lvSeq,
      sourcePlayer: payload.sourcePlayer, header: headerOf(payload.rpcData),
      hex: toHexPreview(payload.rpcData, this.tap.maxHexBytes), error: 'stale_level_generation' });
  }

  receive(source, session, payload) {
    const identity = { playerId: source.id, uuid: source.uuid.toString(), sessionId: session.id, levelId: source.levelId };
    const header = headerOf(payload.rpcData);
    this.tap.push({ ...identity, direction: 'C->S', status: 'received',
      levelChangeCount: payload.levelChangeCount, lvSeq: source.lvSeq, sourcePlayer: payload.sourcePlayer,
      header, hex: toHexPreview(payload.rpcData, this.tap.maxHexBytes), bytes: payload.rpcData?.length ?? 0 });
    source.lastRpc = { bytes: payload.rpcData.length, updatedAt: Date.now() };
    const rpcData = this.router.process(payload.rpcData, { source, logger: this.logger });
    const action = Buffer.from(rpcData).equals(payload.rpcData) ? 'routed' : 'patched';
    const forwardedTo = this.delivery.relay(source, session, { ...payload, rpcData, sourcePlayer: source.id });
    this.tap.push({ ...identity, direction: forwardedTo ? 'S->C' : 'dropped',
      status: forwardedTo ? 'forwarded' : 'no_receiver', header: headerOf(rpcData) ?? header,
      action, forwardedTo, hex: toHexPreview(rpcData, this.tap.maxHexBytes), bytes: rpcData?.length ?? 0 });
  }
}
