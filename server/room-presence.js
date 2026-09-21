export const ROOM_IDLE_MS = 8 * 60 * 1000;
export const ROOM_HEARTBEAT_TTL_MS = 45 * 1000;

// Connections are tabs; participant IDs identify browsers, so opening another
// tab on the same device does not keep a room alive by itself.
export function reconcilePresence(room, now = Date.now()) {
  room.connections ??= {};
  if (room.idleSince === undefined) room.idleSince = Date.parse(room.createdAt);
  const deadlines = new Map();
  for (const [id, connection] of Object.entries(room.connections)) {
    if (connection.present !== false) deadlines.set(connection.participantId, Math.max(deadlines.get(connection.participantId) ?? 0, connection.expiresAt));
    if (connection.expiresAt <= now) delete room.connections[id];
  }
  const active = [...deadlines.values()].filter(deadline => deadline > now).length;
  if (active < 2 && room.idleSince === null) {
    // Use when the second-last browser actually disappeared, even after a
    // server restart or a delayed cleanup tick.
    room.idleSince = [...deadlines.values()].sort((a, b) => b - a)[1] ?? now;
  }
  if (active >= 2) room.idleSince = null;
  return {
    participantCount: active,
    expiresAt: room.idleSince === null ? null : new Date(room.idleSince + ROOM_IDLE_MS).toISOString(),
    expired: room.idleSince !== null && now >= room.idleSince + ROOM_IDLE_MS
  };
}

export function updatePresence(room, { participantId, connectionId, present = true, sequence }, now = Date.now()) {
  const previous = reconcilePresence(room, now);
  if (previous.expired) return previous;
  const current = room.connections[connectionId];
  sequence ??= (current?.sequence ?? 0) + 1;
  if (current && (current.participantId !== participantId || sequence <= current.sequence)) return previous;
  // Keep departures briefly so a delayed heartbeat cannot reconnect a closed
  // tab. A later pageshow heartbeat may reconnect it with a newer sequence.
  room.connections[connectionId] = { participantId, expiresAt: now + ROOM_HEARTBEAT_TTL_MS, present, sequence };
  const count = new Set(Object.values(room.connections).filter(connection => connection.present !== false).map(connection => connection.participantId)).size;
  if (count >= 2) room.idleSince = null;
  else if (previous.participantCount >= 2) room.idleSince = now;
  return reconcilePresence(room, now);
}
