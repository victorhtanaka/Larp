import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notificationsReducer, type AppNotification } from '../src/renderer/notifications';

function notification(id: string, read = false): AppNotification {
  return {
    id,
    kind: 'message',
    groupId: 'group-1',
    groupName: 'Grupo',
    actorName: 'Ana',
    createdAt: '2026-01-01T12:00:00.000Z',
    read,
  };
}

test('a central abre como lida, permite marcar uma entrada e mantém contagem correta', () => {
  let state = notificationsReducer([], { type: 'add', notification: notification('message-1') });
  state = notificationsReducer(state, { type: 'add', notification: notification('call-1') });
  assert.equal(state.filter((item) => !item.read).length, 2);

  state = notificationsReducer(state, { type: 'read-all' });
  assert.equal(state.filter((item) => !item.read).length, 0);
  state = notificationsReducer(state, { type: 'add', notification: notification('message-2') });
  state = notificationsReducer(state, { type: 'read', id: 'message-2' });
  assert.equal(state.filter((item) => !item.read).length, 0);
  assert.deepEqual(state.map((item) => item.read), [true, true, true]);
});

test('a central ignora IDs repetidos e limita o histórico às 100 entradas mais recentes', () => {
  let state: AppNotification[] = [];
  for (let index = 0; index < 101; index += 1) {
    state = notificationsReducer(state, { type: 'add', notification: notification(`message-${index}`) });
  }

  assert.equal(state.length, 100);
  assert.equal(state[0]?.id, 'message-100');
  assert.equal(state.at(-1)?.id, 'message-1');
  assert.strictEqual(notificationsReducer(state, { type: 'add', notification: notification('message-100') }), state);
  assert.deepEqual(notificationsReducer(state, { type: 'clear' }), []);
});
