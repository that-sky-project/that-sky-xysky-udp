// Explicit one-time attachment resolves AudienceService <-> PerformanceAuthority
// without changing the domain API or replacing the authority used by packet handlers.
export function attachPerformanceAuthority (audience, authority) {
  if (audience.performance) throw new Error('audience performance authority is already attached')
  audience.performance = authority
}

export function createAudienceSender ({ players, transport, codec, packetDebug }) {
  return (playerId, packet) => {
    const session = players.getByUuid(playerId)?.session
    if (!session) return false
    const reliable = packet.id !== 27 && packet.id !== 33
    const buffer = codec.encode(packet)
    packetDebug.log('s2c', packet, {
      peerId: session.peerId?.toString?.(),
      sessionId: session.id
    })
    return transport.send(session.peerId, buffer, { reliable })
  }
}
