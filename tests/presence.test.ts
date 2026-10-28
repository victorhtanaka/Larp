import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveMemberPresence } from '../src/renderer/presence';

test('hides presence before sync and resolves synchronized member states', () => {
  assert.equal(resolveMemberPresence('remote', 'local', 'online', {}, false), undefined);
  assert.equal(resolveMemberPresence('remote', 'local', 'online', { remote: 'online' }, false), undefined);
  assert.equal(resolveMemberPresence('remote', 'local', 'online', {}, true), 'offline');
  assert.equal(resolveMemberPresence('remote', 'local', 'online', { remote: 'away' }, true), 'away');
  assert.equal(resolveMemberPresence('remote', 'local', 'online', { remote: 'online' }, true), 'online');
});
