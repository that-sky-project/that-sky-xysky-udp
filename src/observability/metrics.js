import client from 'prom-client';

export function createMetrics() {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const onlinePlayers = new client.Gauge({
    registers: [registry],
    name: 'xysky_online_players',
    help: 'Current online player count'
  });

  const connectedPeers = new client.Gauge({
    registers: [registry],
    name: 'xysky_connected_peers',
    help: 'Current ENet peer count'
  });

  const packets = new client.Counter({
    registers: [registry],
    name: 'xysky_packets_total',
    help: 'Total decoded packets',
    labelNames: ['direction', 'type']
  });

  const disconnects = new client.Counter({
    registers: [registry],
    name: 'xysky_disconnects_total',
    help: 'Total disconnects',
    labelNames: ['reason']
  });

  const admissionRejections = new client.Counter({
    registers: [registry], name: 'xysky_admission_rejections_total',
    help: 'Business admission rejections, separate from malformed packets', labelNames: ['reason']
  });

  const packetErrors = new client.Counter({
    registers: [registry],
    name: 'xysky_packet_errors_total',
    help: 'Total packet processing errors',
    labelNames: ['reason']
  });

  const packetBytes = new client.Counter({
    registers: [registry],
    name: 'xysky_packet_bytes_total',
    help: 'Total packet bytes',
    labelNames: ['direction']
  });

  const packetDuration = new client.Histogram({
    registers: [registry],
    name: 'xysky_packet_process_seconds',
    help: 'Packet processing duration in seconds',
    labelNames: ['type'],
    buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1]
  });

  return {
    registry,
    onlinePlayers,
    connectedPeers,
    packets,
    disconnects,
    packetErrors,
    packetBytes,
    packetDuration
  };
}
