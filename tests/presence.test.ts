import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRESENCE_IDLE_TIMEOUT_MS, resolveLocalPresenceStatus, resolveMemberPresence } from '../src/renderer/presence';

test('does not label absent users offline before presence sync is ready', () => {
  assert.equal(resolveMemberPresence('remote', 'local', 'online', {}, false), undefined);
  assert.equal(resolveMemberPresence('remote', 'local', 'online', {}, true), 'offline');
  assert.equal(resolveMemberPresence('remote', 'local', 'online', { remote: 'away' }, true), 'away');
  assert.equal(resolveMemberPresence('remote', 'local', 'online', { remote: 'online' }, true), 'online');
});

test('reports online until five minutes of focused activity have elapsed', () => {
  const now = 1_000_000;
  assert.equal(resolveLocalPresenceStatus(true, true, now - PRESENCE_IDLE_TIMEOUT_MS + 1, now), 'online');
  assert.equal(resolveLocalPresenceStatus(true, true, now - PRESENCE_IDLE_TIMEOUT_MS, now), 'away');
});

test('reports away while hidden or unfocused even after recent activity', () => {
  const now = 1_000_000;
  assert.equal(resolveLocalPresenceStatus(false, true, now, now), 'away');
  assert.equal(resolveLocalPresenceStatus(true, false, now, now), 'away');
});
