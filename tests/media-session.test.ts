import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaSession, supportsNoiseSuppression } from '../src/renderer/media/session';
import { loadNoiseSuppression, saveNoiseSuppression } from '../src/renderer/media/noise-suppression';
import {
  loadTransmissionPlaybackVolume,
  loadVoicePlaybackVolume,
  saveTransmissionPlaybackVolume,
  saveVoicePlaybackVolume,
} from '../src/renderer/media/playback-volume';


test('persists and restores noise suppression, defaulting on malformed data', () => {
  const values = new Map<string, string>();
  const storage: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  assert.equal(loadNoiseSuppression(storage), true);
  saveNoiseSuppression(storage, false);
  assert.equal(loadNoiseSuppression(storage), false);
  saveNoiseSuppression(storage, true);
  assert.equal(loadNoiseSuppression(storage), true);
  values.set('larp-noise-suppression', 'invalid');
  assert.equal(loadNoiseSuppression(storage), true);
  values.set('larp-noise-suppression', '"false"');
  assert.equal(loadNoiseSuppression(storage), true);
});

test('reports noise suppression support only when the constraint is advertised', () => {
  assert.equal(supportsNoiseSuppression({ getSupportedConstraints: () => ({ noiseSuppression: true }) } as unknown as MediaDevices), true);
  assert.equal(supportsNoiseSuppression({ getSupportedConstraints: () => ({}) } as unknown as MediaDevices), false);
  assert.equal(supportsNoiseSuppression({ getSupportedConstraints: () => { throw new Error('unavailable'); } } as unknown as MediaDevices), false);
});

test('threads noise suppression through permission and selected microphone constraints', async () => {
  const constraints: MediaStreamConstraints[] = [];
  const track = Object.assign(new EventTarget(), { stop: () => undefined, enabled: true }) as unknown as MediaStreamTrack;
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const mediaDevices = {
    getUserMedia: async (value: MediaStreamConstraints) => { constraints.push(value); return stream; },
  } as unknown as MediaDevices;
  const session = new MediaSession({
    mediaDevices,
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
  });
  try {
    await session.requestMicrophonePermission(false);
    assert.equal((constraints[0].audio as MediaTrackConstraints).noiseSuppression, false);
    await session.requestMicrophonePermission(true);
    assert.equal((constraints[1].audio as MediaTrackConstraints).noiseSuppression, true);
    await session.selectMicrophone('mic-off', false);
    assert.equal((constraints[2].audio as MediaTrackConstraints).noiseSuppression, false);
    assert.deepEqual((constraints[2].audio as MediaTrackConstraints).deviceId, { exact: 'mic-off' });
    await session.selectMicrophone('mic-on', true);
    assert.equal((constraints[3].audio as MediaTrackConstraints).noiseSuppression, true);
    assert.deepEqual((constraints[3].audio as MediaTrackConstraints).deviceId, { exact: 'mic-on' });
  } finally {
    await session.close();
  }
});

test('applies independent clamped voice and transmission volumes with a shared mute', () => {
  const session = new MediaSession({
    mediaDevices: {} as MediaDevices,
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
  });
  const voice = { muted: false, volume: 1 } as HTMLAudioElement;
  const transmission = { muted: false, volume: 1 } as HTMLAudioElement;

  session.setVoicePlaybackVolume(0.35);
  session.setTransmissionPlaybackVolume(0.7);
  session.attachOutput(voice, transmission);
  assert.equal(voice.volume, 0.35);
  assert.equal(transmission.volume, 0.7);

  session.setVoicePlaybackVolume(1.4);
  session.setTransmissionPlaybackVolume(-0.2);
  assert.equal(voice.volume, 1);
  assert.equal(transmission.volume, 0);
  session.setVoicePlaybackVolume(Number.NaN);
  assert.equal(voice.volume, 1);

  session.setPlaybackMuted(true);
  assert.equal(voice.muted, true);
  assert.equal(transmission.muted, true);
});

test('persists independent voice and transmission volumes and tolerates malformed or unavailable storage', () => {
  const values = new Map<string, string>();
  const storage: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  saveVoicePlaybackVolume(storage, 0.42);
  saveTransmissionPlaybackVolume(storage, 0.73);
  assert.equal(loadVoicePlaybackVolume(storage), 0.42);
  assert.equal(loadTransmissionPlaybackVolume(storage), 0.73);
  assert.equal(values.get('larp-playback-volume'), '0.42');
  assert.equal(values.get('larp-transmission-playback-volume'), '0.73');
  saveVoicePlaybackVolume(storage, 1.5);
  assert.equal(loadVoicePlaybackVolume(storage), 1);
  values.set('larp-playback-volume', 'invalid');
  values.set('larp-transmission-playback-volume', 'invalid');
  assert.equal(loadVoicePlaybackVolume(storage), 1);
  assert.equal(loadTransmissionPlaybackVolume(storage), 1);
  const unavailable = {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
  };
  assert.equal(loadVoicePlaybackVolume(unavailable), 1);
  assert.equal(loadTransmissionPlaybackVolume(unavailable), 1);
  saveVoicePlaybackVolume(unavailable, 0.2);
  saveTransmissionPlaybackVolume(unavailable, 0.3);
});

test('applies one selected output device to both playback channels', async () => {
  const voiceSinkIds: string[] = [];
  const transmissionSinkIds: string[] = [];
  const voice = Object.assign({ muted: false, volume: 1 }, { setSinkId: async (sinkId: string) => { voiceSinkIds.push(sinkId); } }) as unknown as HTMLAudioElement;
  const transmission = Object.assign({ muted: false, volume: 1 }, { setSinkId: async (sinkId: string) => { transmissionSinkIds.push(sinkId); } }) as unknown as HTMLAudioElement;
  const session = new MediaSession({
    mediaDevices: { enumerateDevices: async () => [{ kind: 'audiooutput', deviceId: 'speaker-1' }] } as unknown as MediaDevices,
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
  });
  session.attachOutput(voice, transmission);

  assert.equal(await session.selectAudioOutput('speaker-1'), 'available');
  assert.deepEqual(voiceSinkIds, ['speaker-1']);
  assert.deepEqual(transmissionSinkIds, ['speaker-1']);
});

test('retoma a saída suspensa e executa tons curtos de chamada e mensagem', async () => {
  let frequency = 0;
  let stopTime = -1;
  let resumeCount = 0;
  const oscillator = Object.assign(new EventTarget(), {
    type: 'sine' as OscillatorType,
    frequency: { setValueAtTime: (value: number) => { frequency = value; } },
    connect: () => undefined,
    start: () => undefined,
    stop: (time?: number) => { stopTime = time ?? -1; },
    disconnect: () => undefined,
  }) as unknown as OscillatorNode;
  const gain = {
    gain: {
      setValueAtTime: () => undefined,
      exponentialRampToValueAtTime: () => undefined,
    },
    connect: () => undefined,
    disconnect: () => undefined,
  } as unknown as GainNode;
  let contextState: AudioContextState = 'suspended';
  const context = {
    get state() { return contextState; },
    currentTime: 0,
    destination: {} as AudioDestinationNode,
    resume: async () => {
      resumeCount += 1;
      contextState = 'running';
    },
    createOscillator: () => oscillator,
    createGain: () => gain,
    close: async () => { contextState = 'closed'; },
  } as unknown as AudioContext;
  const originalAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: class AudioContextStub {} });
  const session = new MediaSession({
    mediaDevices: {} as MediaDevices,
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
    audioContextFactory: () => context,
  });

  try {
    assert.equal(await session.playSafeTone(880, 220), true);
    assert.equal(resumeCount, 1);
    assert.equal(frequency, 880);
    assert.equal(stopTime, 0.22);
    assert.equal(await session.playSafeTone(660, 120), true);
    assert.equal(frequency, 660);
    assert.equal(stopTime, 0.12);
  } finally {
    await session.close();
    if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});
