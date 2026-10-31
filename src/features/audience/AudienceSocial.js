import { AudiencePacketId, AudienceChatEntityId } from '../../protocol/types/Audience.js';
export class AudienceSocial {
  constructor({ rosters, sendToClient, stats = {} }) {
    this.rosters = rosters;
    this.sendToClient = sendToClient;
    this.stats = stats;
  }
  async broadcastConsensus(consensus) {
    for (const playerId of this.rosters.keys()) {
      await this.sendToClient(playerId, {
        id: AudiencePacketId.AudienceConsensus,
        payload: consensus
      });
    }
    this.stats.consensusBroadcasts = (this.stats.consensusBroadcasts ?? 0) + 1;
  }
  async broadcastChat({ entityId, payload, reliable = true }) {
    const packetId = reliable
      ? AudiencePacketId.AudienceChatDownReliable
      : AudiencePacketId.AudienceChatDownUnreliable;
    if (entityId >= AudienceChatEntityId.SetFloatParam) {
      for (const playerId of this.rosters.keys()) {
        await this.sendToClient(playerId, {
          id: packetId,
          payload: { messages: [{ entityId, payload }] }
        });
      }
      this.stats.chatRouted = (this.stats.chatRouted ?? 0) + 1;
      return;
    }
    const sender = this.rosterForEntity(entityId);
    const recipients = sender ? this.roommatesOf(sender) : [...this.rosters.keys()];
    for (const playerId of recipients) {
      await this.sendToClient(playerId, {
        id: packetId,
        payload: { messages: [{ entityId, payload }] }
      });
    }
    this.stats.chatRouted = (this.stats.chatRouted ?? 0) + 1;
  }
  async broadcastPresence(recipientId, matches) {
    await this.sendToClient(recipientId, {
      id: AudiencePacketId.PresenceMatches,
      payload: { matches }
    });
  }
  rosterForEntity(entityId) {
    for (const roster of this.rosters.values()) {
      if (roster.roomMembers.includes(entityId)) return roster;
    }
    return undefined;
  }
  roommatesOf(roster) {
    return [...this.rosters.entries()]
      .filter(([, other]) => other.levelId === roster.levelId && other.benchId === roster.benchId)
      .map(([playerId]) => playerId);
  }
}
