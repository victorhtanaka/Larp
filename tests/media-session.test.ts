import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaSession, supportsNoiseSuppression } from '../src/renderer/media/session';
import { loadNoiseSuppression, saveNoiseSuppression } from '../src/renderer/media/noise-suppression';
import {
  loadVoiceParticipantVolumes,
  loadVoicePlaybackVolume,
  loadTransmissionPlaybackVolume,
  saveTransmissionPlaybackVolume,
  saveVoiceParticipantVolumes,
  saveVoicePlaybackVolume,
} from '../src/renderer/media/playback-volume';

interface AudioOutputStub {
  muted: boolean;
  volume: number;
  autoplay: boolean;
  srcObject: MediaStream | null;
  paused: boolean;
  playCount: number;
  sinkIds: string[];
  play(): Promise<void>;
  pause(): void;
  setSinkId(sinkId: string): Promise<void>;
}

function createAudioOutputStub(): AudioOutputStub {
  return {
    muted: false,
    volume: 1,
    autoplay: false,
    srcObject: null,
    paused: true,
    playCount: 0,
    sinkIds: [],
    async play() { this.paused = false; this.playCount += 1; },
    pause() { this.paused = true; },
    async setSinkId(sinkId: string) { this.sinkIds.push(sinkId); },
  };
}

function createAudioStream(): MediaStream {
  const track = { readyState: 'live' } as MediaStreamTrack;
  return { getAudioTracks: () => [track] } as unknown as MediaStream;
}


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
test('marca o áudio da captura de tela como música e preserva a dica de vídeo', async () => {
  const videoTrack = Object.assign(new EventTarget(), { readyState: 'live', contentHint: '', stop: () => undefined }) as unknown as MediaStreamTrack;
  const audioTrack = Object.assign(new EventTarget(), { readyState: 'live', contentHint: '', stop: () => undefined }) as unknown as MediaStreamTrack;
  const stream = {
    getTracks: () => [videoTrack, audioTrack],
    getVideoTracks: () => [videoTrack],
    getAudioTracks: () => [audioTrack],
  } as unknown as MediaStream;
  const session = new MediaSession({
    mediaDevices: {} as MediaDevices,
    displaySourceProvider: {
      listSources: async () => [{ id: 'screen-1', name: 'Screen', kind: 'screen' }],
      capture: async () => stream,
    },
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
  });

  try {
    const capture = await session.startDisplayShare({ id: 'screen-1', name: 'Screen', kind: 'screen' }, { audio: true });
    assert.equal(capture.state, 'active');
    assert.equal(audioTrack.contentHint, 'music');
    assert.equal(videoTrack.contentHint, 'detail');
  } finally {
    await session.close();
  }
});

test('composes master and per-participant voice gains while keeping call mute separate from output mute', async () => {
  const voiceOutputs: AudioOutputStub[] = [];
  const session = new MediaSession({
    mediaDevices: {} as MediaDevices,
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
    audioElementFactory: () => {
      const output = createAudioOutputStub();
      voiceOutputs.push(output);
      return output as unknown as HTMLAudioElement;
    },
  });
  const transmission = createAudioOutputStub();
  session.setVoicePlaybackVolume(0.5);
  session.setVoiceParticipantVolume('alice', 0.4);
  session.setTransmissionPlaybackVolume(0.7);
  session.attachTransmissionOutput(transmission as unknown as HTMLAudioElement);
  await session.setVoiceOutput('alice', createAudioStream());
  const voice = voiceOutputs[0];
  assert.ok(voice);
  assert.equal(voice.volume, 0.2);
  assert.equal(transmission.volume, 0.7);
  assert.equal(voice.playCount, 1);

  session.setVoicePlaybackVolume(1.4);
  session.setVoiceParticipantVolume('alice', 1.5);
  assert.equal(voice.volume, 1);
  session.setVoicePlaybackVolume(Number.NaN);
  assert.equal(voice.volume, 1);

  session.setPlaybackMuted(true);
  assert.equal(voice.muted, true);
  assert.equal(transmission.muted, true);
  session.setVoicePlaybackMuted(true);
  session.setPlaybackMuted(false);
  assert.equal(voice.muted, true);
  assert.equal(transmission.muted, false);
  session.setVoicePlaybackMuted(false);
  assert.equal(voice.muted, false);
  session.removeVoiceOutput('alice');
  assert.equal(voice.paused, true);
  assert.equal(voice.srcObject, null);
});


test('persists voice, transmission, and per-participant volumes and tolerates malformed storage', () => {
  const values = new Map<string, string>();
  const storage: Pick<Storage, 'getItem' | 'setItem'> = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
  saveVoicePlaybackVolume(storage, 0.42);
  saveTransmissionPlaybackVolume(storage, 0.73);
  saveVoiceParticipantVolumes(storage, { alice: 0.25, bob: 1.4 });
  assert.equal(loadVoicePlaybackVolume(storage), 0.42);
  assert.equal(loadTransmissionPlaybackVolume(storage), 0.73);
  assert.deepEqual(loadVoiceParticipantVolumes(storage), { alice: 0.25, bob: 1 });
  assert.equal(values.get('larp-playback-volume'), '0.42');
  assert.equal(values.get('larp-transmission-playback-volume'), '0.73');
  assert.equal(values.get('larp-voice-participant-volumes'), '{"alice":0.25,"bob":1}');
  values.set('larp-playback-volume', 'invalid');
  values.set('larp-transmission-playback-volume', 'invalid');
  values.set('larp-voice-participant-volumes', '{"alice":null,"bob":-1,"":0.5,"x":2}');
  assert.equal(loadVoicePlaybackVolume(storage), 1);
  assert.equal(loadTransmissionPlaybackVolume(storage), 1);
  assert.deepEqual(loadVoiceParticipantVolumes(storage), { bob: 0, x: 1 });
  const unavailable = {
    getItem: () => { throw new Error('storage denied'); },
    setItem: () => { throw new Error('storage denied'); },
  };
  assert.equal(loadVoicePlaybackVolume(unavailable), 1);
  assert.equal(loadTransmissionPlaybackVolume(unavailable), 1);
  assert.deepEqual(loadVoiceParticipantVolumes(unavailable), {});
  saveVoicePlaybackVolume(unavailable, 0.2);
  saveTransmissionPlaybackVolume(unavailable, 0.3);
  saveVoiceParticipantVolumes(unavailable, { alice: 0.4 });
});


test('routes each participant voice output and transmission output to the selected device', async () => {
  const outputs: AudioOutputStub[] = [];
  const session = new MediaSession({
    mediaDevices: { enumerateDevices: async () => [{ kind: 'audiooutput', deviceId: 'speaker-1' }] } as unknown as MediaDevices,
    mesh: { attachTrack: () => undefined, detachTrack: () => undefined },
    audioElementFactory: () => {
      const output = createAudioOutputStub();
      outputs.push(output);
      return output as unknown as HTMLAudioElement;
    },
  });
  const transmission = createAudioOutputStub();
  session.attachTransmissionOutput(transmission as unknown as HTMLAudioElement);
  session.setVoiceParticipantVolume('alice', 0.4);
  await session.setVoiceOutput('alice', createAudioStream());
  await session.setVoiceOutput('bob', createAudioStream());

  assert.equal(await session.selectAudioOutput('speaker-1'), 'available');
  session.removeVoiceOutput('alice');
  await session.setVoiceOutput('alice', createAudioStream());
  assert.equal(outputs.length, 3);
  assert.equal(outputs[2].volume, 0.4);
  assert.deepEqual(outputs.map((output) => output.sinkIds), [['speaker-1'], ['speaker-1'], ['speaker-1']]);
  assert.deepEqual(transmission.sinkIds, ['speaker-1']);
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
