import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePresence, updatePresence, ROOM_IDLE_MS, ROOM_HEARTBEAT_TTL_MS } from "./room-presence.js";

const start = Date.UTC(2026, 8, 21);
const fresh = () => ({ createdAt: new Date(start).toISOString(), idleSince: start, connections: {} });
const presence = (participantId, connectionId = participantId, present = true) => ({ participantId, connectionId, present });

test("zero or one browser closes at eight minutes; heartbeats cannot extend it", () => {
  const room = fresh();
  assert.equal(reconcilePresence(room, start + ROOM_IDLE_MS - 1).expired, false);
  for (let elapsed = 0; elapsed < ROOM_IDLE_MS; elapsed += 10000) {
    updatePresence(room, presence("one"), start + elapsed);
  }
  assert.equal(updatePresence(room, presence("one"), start + ROOM_IDLE_MS).expired, true);
  assert.equal(reconcilePresence(fresh(), start + ROOM_IDLE_MS).expired, true);
});

test("two browsers keep a room alive beyond eight minutes; tabs do not count twice", () => {
  const room = fresh();
  updatePresence(room, presence("owner", "tab-1"), start);
  assert.equal(updatePresence(room, presence("owner", "tab-2"), start).participantCount, 1);
  for (let elapsed = 0; elapsed <= ROOM_IDLE_MS * 3; elapsed += 10000) {
    updatePresence(room, presence("owner", "tab-1"), start + elapsed);
    const state = updatePresence(room, presence("guest"), start + elapsed);
    assert.equal(state.expiresAt, null);
    assert.equal(state.expired, false);
  }
});

test("explicit departure starts eight minutes; rejoining cancels the deadline", () => {
  const room = fresh();
  updatePresence(room, presence("owner"), start);
  updatePresence(room, presence("guest"), start);
  const leftAt = start + 1000;
  assert.equal(updatePresence(room, presence("guest", "guest", false), leftAt).expiresAt, new Date(leftAt + ROOM_IDLE_MS).toISOString());
  updatePresence(room, presence("guest"), leftAt + 1000);
  assert.equal(room.idleSince, null);
  const leftAgainAt = leftAt + 2000;
  updatePresence(room, presence("owner", "owner", false), leftAgainAt);
  assert.equal(room.idleSince, leftAgainAt);
});

test("one tab leaving does not disconnect another tab from the same browser", () => {
  const room = fresh();
  updatePresence(room, presence("owner", "one"), start);
  updatePresence(room, presence("owner", "two"), start);
  updatePresence(room, presence("guest"), start);
  const state = updatePresence(room, presence("owner", "one", false), start + 1000);
  assert.equal(state.participantCount, 2);
  assert.equal(state.expiresAt, null);
});

test("departures win over delayed requests, including a first join still in flight", () => {
  const room = fresh();
  updatePresence(room, { ...presence("one"), sequence: 1 }, start);
  updatePresence(room, { ...presence("two"), sequence: 1 }, start);
  const left = updatePresence(room, { ...presence("two", "two", false), sequence: 3 }, start + 1000);
  assert.equal(left.participantCount, 1);
  assert.equal(updatePresence(room, { ...presence("two"), sequence: 2 }, start + 2000).participantCount, 1);
  assert.equal(room.idleSince, start + 1000);
  updatePresence(room, { ...presence("three", "three", false), sequence: 2 }, start + 3000);
  assert.equal(updatePresence(room, { ...presence("three"), sequence: 1 }, start + 4000).participantCount, 1);
  assert.equal(updatePresence(room, { ...presence("two"), sequence: 4 }, start + 5000).participantCount, 2);
});

test("abrupt disconnect and server restart preserve the exact inactivity deadline", () => {
  const room = fresh();
  updatePresence(room, presence("one"), start);
  updatePresence(room, presence("two"), start + 1000);
  const restored = JSON.parse(JSON.stringify(room));
  const disconnectedAt = start + ROOM_HEARTBEAT_TTL_MS;
  const state = reconcilePresence(restored, disconnectedAt + ROOM_IDLE_MS - 1);
  assert.equal(state.expiresAt, new Date(disconnectedAt + ROOM_IDLE_MS).toISOString());
  assert.equal(state.expired, false);
  assert.equal(updatePresence(restored, presence("three"), disconnectedAt + ROOM_IDLE_MS).expired, true);
});

test("with three browsers, the countdown begins only after the second departure", () => {
  const room = fresh();
  for (const id of ["one", "two", "three"]) updatePresence(room, presence(id), start);
  assert.equal(updatePresence(room, presence("one", "one", false), start + 1000).expiresAt, null);
  assert.equal(updatePresence(room, presence("two", "two", false), start + 2000).expiresAt, new Date(start + 2000 + ROOM_IDLE_MS).toISOString());
});
