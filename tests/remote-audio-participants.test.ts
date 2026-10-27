import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteAudioParticipants } from '../src/renderer/media/remote-audio-participants';

test('mantém o participante até encerrar sua última faixa de áudio', () => {
  const participants = new RemoteAudioParticipants();
  const firstTrack = {} as MediaStreamTrack;
  const secondTrack = {} as MediaStreamTrack;

  assert.equal(participants.add('peer-1', firstTrack), 'peer-joined');
  assert.equal(participants.add('peer-1', firstTrack), 'duplicate');
  assert.equal(participants.add('peer-1', secondTrack), 'track-added');
  assert.deepEqual(participants.peerIds, ['peer-1']);

  assert.equal(participants.remove('peer-1', firstTrack), 'track-removed');
  assert.deepEqual(participants.peerIds, ['peer-1']);
  assert.equal(participants.remove('peer-1', secondTrack), 'peer-left');
  assert.deepEqual(participants.peerIds, []);
  assert.equal(participants.remove('peer-1', secondTrack), 'unknown');
});

test('permite uma nova entrada após a saída e limpa participantes ao trocar de grupo', () => {
  const participants = new RemoteAudioParticipants();
  const track = {} as MediaStreamTrack;

  assert.equal(participants.add('peer-1', track), 'peer-joined');
  assert.equal(participants.remove('peer-1', track), 'peer-left');
  assert.equal(participants.add('peer-1', track), 'peer-joined');
  participants.clear();
  assert.deepEqual(participants.peerIds, []);
});
