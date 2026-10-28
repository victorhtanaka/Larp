import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RemoteAudioParticipants } from '../src/renderer/media/remote-audio-participants';

function audioTrack(id: string): MediaStreamTrack {
  return { id, kind: 'audio', readyState: 'live' } as MediaStreamTrack;
}

function videoTrack(id: string): MediaStreamTrack {
  return { id, kind: 'video', readyState: 'live' } as MediaStreamTrack;
}

function stream(id: string, videoTracks: MediaStreamTrack[] = []): MediaStream {
  return { id, getVideoTracks: () => videoTracks } as unknown as MediaStream;
}

test('classifica áudio de tela em qualquer ordem e sem streams mantém voz', () => {
  const participants = new RemoteAudioParticipants();
  const firstScreenStream = stream('screen-audio-first');
  const firstAudio = audioTrack('audio-first');
  const firstRecord = participants.addAudioTrack('peer-audio-first', firstAudio, [firstScreenStream]).record;
  assert.equal(participants.isTransmission(firstRecord), false);
  const firstChanges = participants.addVideoStreams('peer-audio-first', [firstScreenStream]);
  assert.equal(firstChanges.length, 1);
  assert.equal(firstChanges[0].previousSource, 'voice');
  assert.equal(firstChanges[0].source, 'transmission');
  assert.deepEqual(participants.peerIds, []);

  const secondScreenStream = stream('screen-video-first', [videoTrack('video-first')]);
  participants.addVideoStreams('peer-video-first', [secondScreenStream]);
  const secondRecord = participants.addAudioTrack('peer-video-first', audioTrack('audio-later'), [secondScreenStream]).record;
  assert.equal(participants.isTransmission(secondRecord), true);
  assert.equal(participants.setSource(secondRecord, 'transmission').peerJoined, false);

  const voiceRecord = participants.addAudioTrack('peer-no-stream', audioTrack('voice'), []).record;
  assert.equal(participants.isTransmission(voiceRecord), false);
  assert.equal(participants.setSource(voiceRecord, 'voice').peerJoined, true);
  assert.deepEqual(participants.peerIds, ['peer-no-stream']);
});

test('voice participation survives other track removals but ends with the last voice track', () => {
  const participants = new RemoteAudioParticipants();
  participants.setPeerState('peer-1', 'connected');
  const firstVoice = audioTrack('voice-1');
  const secondVoice = audioTrack('voice-2');
  const screen = stream('screen', [videoTrack('screen-video')]);
  const transmission = audioTrack('screen-audio');
  const first = participants.addAudioTrack('peer-1', firstVoice, []).record;
  assert.equal(participants.setSource(first, 'voice').peerJoined, true);
  const second = participants.addAudioTrack('peer-1', secondVoice, []).record;
  participants.setSource(second, 'voice');
  const screenAudio = participants.addAudioTrack('peer-1', transmission, [screen]).record;
  participants.setSource(screenAudio, 'transmission');

  assert.deepEqual(participants.peerIds, ['peer-1']);
  assert.equal(participants.removeTrack('peer-1', firstVoice).peerLeft, false);
  assert.deepEqual(participants.peerIds, ['peer-1']);
  assert.equal(participants.removeTrack('peer-1', transmission).peerLeft, false);
  assert.deepEqual(participants.peerIds, ['peer-1']);
  assert.equal(participants.removeTrack('peer-1', secondVoice).peerLeft, true);
  assert.deepEqual(participants.peerIds, []);
});

test('reconnection retains participant identity until connected without a voice track', () => {
  const participants = new RemoteAudioParticipants();
  const voice = audioTrack('voice');
  participants.setPeerState('peer-1', 'connected');
  const record = participants.addAudioTrack('peer-1', voice, []).record;
  assert.equal(participants.setSource(record, 'voice').peerJoined, true);

  participants.setPeerState('peer-1', 'disconnected');
  assert.equal(participants.removeTrack('peer-1', voice).peerLeft, false);
  assert.deepEqual(participants.peerIds, ['peer-1']);
  participants.setPeerState('peer-1', 'connecting');
  assert.deepEqual(participants.peerIds, ['peer-1']);
  participants.setPeerState('peer-1', 'connected');
  assert.deepEqual(participants.peerIds, []);

  const reconnectedVoice = participants.addAudioTrack('peer-1', audioTrack('voice-again'), []).record;
  assert.equal(participants.setSource(reconnectedVoice, 'voice').peerJoined, true);
  participants.setPeerState('peer-1', 'disconnected');
  participants.setPeerState('peer-1', 'connected');
  assert.deepEqual(participants.peerIds, ['peer-1']);
});

test('definitive peer removal clears audio tracks, stream associations and state', () => {
  const participants = new RemoteAudioParticipants();
  participants.setPeerState('peer-1', 'connected');
  const voice = participants.addAudioTrack('peer-1', audioTrack('voice'), []).record;
  participants.setSource(voice, 'voice');
  const screen = stream('screen', [videoTrack('screen-video')]);
  const transmission = participants.addAudioTrack('peer-1', audioTrack('system'), [screen]).record;
  participants.setSource(transmission, 'transmission');

  assert.equal(participants.getPeerState('peer-1'), 'connected');
  assert.deepEqual(participants.removePeer('peer-1').map((record) => record.source).sort(), ['transmission', 'voice']);
  assert.deepEqual(participants.records, []);
  assert.deepEqual(participants.peerIds, []);
  assert.equal(participants.getPeerState('peer-1'), undefined);
});

test('media-state mutes one peer and screen cleanup preserves its voice track', () => {
  const participants = new RemoteAudioParticipants();
  participants.setPeerState('peer-1', 'connected');
  const voice = participants.addAudioTrack('peer-1', audioTrack('voice'), []).record;
  participants.setSource(voice, 'voice');
  const screen = stream('screen', [videoTrack('screen-video')]);
  const systemAudio = participants.addAudioTrack('peer-1', audioTrack('system'), [screen]).record;
  participants.addVideoStreams('peer-1', [screen]);
  participants.setSource(systemAudio, 'transmission');

  const muted = participants.setVoiceActive('peer-1', false);
  assert.equal(muted.peerLeft, true);
  assert.deepEqual(participants.peerIds, []);
  assert.deepEqual(muted.records.map((record) => record.track.id), ['voice']);
  assert.deepEqual(participants.removeSource('peer-1', 'transmission').records.map((record) => record.track.id), ['system']);
  participants.clearVideoStreams('peer-1');
  assert.deepEqual(participants.records.map((record) => record.track.id), ['voice']);
  assert.equal(participants.setVoiceActive('peer-1', true).peerJoined, true);
  assert.deepEqual(participants.peerIds, ['peer-1']);
});
