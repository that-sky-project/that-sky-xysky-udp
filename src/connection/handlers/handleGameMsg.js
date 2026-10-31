import { GameMsgType } from '../../protocol/packets/shared/GameMsgPacket.js';

const AUDIENCE_TYPES = new Set([
  GameMsgType.AudienceHint,
  GameMsgType.AudienceSocialBroadcast,
  GameMsgType.AudienceConsensusVote,
  GameMsgType.AudienceChat,
  GameMsgType.AudienceSpotlightRequest
]);

export function handleGameMsg(session, payload, { gameMessageService, audienceService }) {
  if (audienceService && AUDIENCE_TYPES.has(payload.type)) {
    audienceService.handleRequest(session, payload).catch((error) => {
    });
    return;
  }
  gameMessageService.handle(session, payload);
}
