import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CloudConnectionStatus } from '../src/shared/cloud-contracts';
import { connectionPresentation } from '../src/renderer/presentation';

const states: { state: CloudConnectionStatus['state']; details: [string, string] }[] = [
  { state: 'connecting', details: ['Supabase: timeout', 'WebRTC signaling unavailable'] },
  { state: 'not-configured', details: ['supabaseUrl missing in config.json', 'service-role key rejected'] },
  { state: 'unavailable', details: ['STUN lookup failed', 'HTTP 503 from provider'] },
  { state: 'ready', details: ['connected to Supabase', 'Ed25519 identity registered'] },
];

function statusWithDetail(state: CloudConnectionStatus['state'], detail: string): CloudConnectionStatus {
  if (state === 'ready') return { state, detail, groups: [], userId: 'local-user' };
  return { state, detail, groups: [] };
}

test('connection presentation depends only on the connection state', () => {
  for (const { state, details } of states) {
    const first = connectionPresentation(statusWithDetail(state, details[0]));
    const second = connectionPresentation(statusWithDetail(state, details[1]));

    assert.deepEqual(first, second);
    for (const detail of details) {
      assert.ok(!first.label.includes(detail));
      assert.ok(!first.description.includes(detail));
    }
  }
});
