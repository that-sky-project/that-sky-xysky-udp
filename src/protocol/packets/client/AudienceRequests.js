import {
  AudienceGameMsgType,
  AUDIENCE_MAX_ENTITY_INDEX,
  AUDIENCE_ROOM_MEMBER_LIMIT
} from '../../types/Audience.js';

export const AudienceHintRequest = {
  gameMsgType: AudienceGameMsgType.Hint,

  decode(reader) {
    const count = reader.readUInt8();
    const entityIndices = [];
    for (let i = 0; i < count; i += 1) {
      entityIndices.push(reader.readCompressed(AUDIENCE_MAX_ENTITY_INDEX));
    }
    return { count, entityIndices };
  },

  encode(writer, packet) {
    const entityIndices = (packet.entityIndices ?? []).slice(0, 0xff);
    writer.writeUInt8(entityIndices.length);
    for (const index of entityIndices) writer.writeCompressed(index, AUDIENCE_MAX_ENTITY_INDEX);
  }
};

export const AudienceSocialBroadcastRequest = {
  gameMsgType: AudienceGameMsgType.SocialBroadcast,

  decode(reader) {
    return {
      timestamp: reader.readDouble(),
      actionId: reader.readUInt32(),
      payload: readLengthPrefixedBytes(reader)
    };
  },

  encode(writer, packet) {
    writer.writeDouble(packet.timestamp ?? 0);
    writer.writeUInt32(packet.actionId ?? 0);
    writeLengthPrefixedBytes(writer, packet.payload ?? Buffer.alloc(0));
  }
};

export const AudienceConsensusVoteRequest = {
  gameMsgType: AudienceGameMsgType.ConsensusVote,

  decode(reader) {
    const value = reader.readDouble();
    const trailing = reader.readBytes(reader.remaining);
    return { value, trailing };
  },

  encode(writer, packet) {
    writer.writeDouble(packet.value ?? 0);
    writer.writeBytes(Buffer.alloc(10));
  }
};

export const AudienceChatRequest = {
  gameMsgType: AudienceGameMsgType.Chat,

  decode(reader) {
    const messages = [];
    while (reader.remaining > 0) {
      messages.push({
        sender: readLengthPrefixedBytes(reader),
        message: readLengthPrefixedBytes(reader)
      });
    }
    return { messages };
  },

  encode(writer, packet) {
    for (const message of packet.messages ?? []) {
      writeLengthPrefixedBytes(writer, message.sender ?? Buffer.alloc(0));
      writeLengthPrefixedBytes(writer, message.message ?? Buffer.alloc(0));
    }
  }
};

export const AudienceSpotlightRequest = {
  gameMsgType: AudienceGameMsgType.SpotlightRequest,

  decode(reader) {
    return { requested: reader.readBool() };
  },

  encode(writer, packet) {
    writer.writeBool(packet.requested === true);
  }
};

export const audienceRequestPayloads = new Map([
  [AudienceGameMsgType.Hint, AudienceHintRequest],
  [AudienceGameMsgType.SocialBroadcast, AudienceSocialBroadcastRequest],
  [AudienceGameMsgType.ConsensusVote, AudienceConsensusVoteRequest],
  [AudienceGameMsgType.Chat, AudienceChatRequest],
  [AudienceGameMsgType.SpotlightRequest, AudienceSpotlightRequest]
]);

export { AUDIENCE_ROOM_MEMBER_LIMIT };

function writeLengthPrefixedBytes(writer, value) {
  const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
  writer.writeUInt32(buf.length);
  writer.writeBytes(buf);
}

function readLengthPrefixedBytes(reader) {
  const length = reader.readUInt32();
  return reader.readBytes(length);
}
