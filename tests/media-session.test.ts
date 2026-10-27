import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaSession, supportsNoiseSuppression } from '../src/renderer/media/session';
import { loadNoiseSuppression, saveNoiseSuppression } from '../src/renderer/media/noise-suppression';
import { loadPlaybackVolume, savePlaybackVolume } from '../src/renderer/media/playback-volume';


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

test('clamps playback volume and applies it to the audio output', () => {
  const session = new MediaSession({
    mediaDevices: {} as MediaDevices,
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
  });
  const output = { muted: false, volume: 1 } as HTMLAudioElement;

  session.setPlaybackVolume(0.35);
  session.attachOutput(output);
  assert.equal(output.volume, 0.35);

  session.setPlaybackVolume(1.4);
  assert.equal(output.volume, 1);
  session.setPlaybackVolume(-0.2);
  assert.equal(output.volume, 0);
  session.setPlaybackVolume(Number.NaN);
  assert.equal(output.volume, 0);
});

test('persiste e restaura o volume no armazenamento local do perfil', () => {
  const values = new Map<string, string>();
  const storage: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };

  savePlaybackVolume(storage, 0.42);
  assert.equal(loadPlaybackVolume(storage), 0.42);
  savePlaybackVolume(storage, 1.5);
  assert.equal(loadPlaybackVolume(storage), 1);
  values.set('larp-playback-volume', 'invalid');
  assert.equal(loadPlaybackVolume(storage), 1);
});

test('retoma a saída suspensa e toca o tom usado ao entrar alguém na chamada', async () => {
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
  } finally {
    await session.close();
    if (originalAudioContext) Object.defineProperty(globalThis, 'AudioContext', originalAudioContext);
    else Reflect.deleteProperty(globalThis, 'AudioContext');
  }
});
