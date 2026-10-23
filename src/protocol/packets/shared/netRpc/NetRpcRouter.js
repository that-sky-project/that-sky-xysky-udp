import { decodeNetRpcHeader, classIdKey } from './NetRpcCodec.js';
import { GIFT_CLASS_ID, GiftTypeFlag, patchGiftReceiverUuid } from './handlers/giftHandler.js';

const GIFT_KEY = classIdKey(GIFT_CLASS_ID);

export class NetRpcRouter {
  constructor() {
    this._handlers = new Map();
  }

  register(classId, typeFlag, handler) {
    if (!this._handlers.has(classId)) {
      this._handlers.set(classId, new Map());
    }
    this._handlers.get(classId).set(typeFlag ?? '*', handler);
    return this;
  }

  process(rpcData, context) {
    const decoded = decodeNetRpcHeader(rpcData);
    if (!decoded) return rpcData;

    const typemap = this._handlers.get(decoded.classIdKey);
    if (!typemap) return rpcData;

    const handler = typemap.get(decoded.typeFlag) ?? typemap.get('*');
    if (!handler) return rpcData;

    return handler(rpcData, decoded, context) ?? rpcData;
  }
}

export function createNetRpcRouter() {
  const router = new NetRpcRouter();

  router.register(GIFT_KEY, GiftTypeFlag.Accept, (rpcData, _decoded, { source, logger }) => {
    const uuid = source?.uuid?.bytes;
    if (!uuid) {
      logger?.debug({ playerId: source?.id }, 'gift accept: source has no uuid, skipping injection');
      return null;
    }
    logger?.debug({ playerId: source.id, uuid: source.uuid.toString() }, 'gift replace ok');
    return patchGiftReceiverUuid(rpcData, uuid);
  });

  return router;
}
