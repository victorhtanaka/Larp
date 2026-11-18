import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CpuPressureTracker, displayCaptureConstraints, MediaQualityController, type QualityPeer } from '../src/renderer/media/quality';

function createSender(kind: 'audio' | 'video', maxBitrate?: number) {
  const track = { kind, contentHint: '' } as MediaStreamTrack;
  let parameters = { encodings: [maxBitrate === undefined ? {} : { maxBitrate }] } as RTCRtpSendParameters;
  let setCalls = 0;
  const sender = {
    track,
    getParameters: () => structuredClone(parameters),
    setParameters: async (next: RTCRtpSendParameters) => {
      parameters = next;
      setCalls += 1;
    },
  } as unknown as RTCRtpSender;
  return { sender, track, get parameters() { return parameters; }, get setCalls() { return setCalls; } };
}

test('respeita o orçamento agregado, o teto por espectador e a prioridade dos modos', async () => {
  const controller = new MediaQualityController({ totalVideoBitrate: 10_000_000, maxVideoBitratePerPeer: 8_000_000 });
  const motion = createSender('video');
  const text = createSender('video');
  const audio = createSender('audio');
  const allocation = await controller.allocate([
    { peerId: 'movement-peer', sender: motion.sender, content: 'motion' },
    { peerId: 'text-peer', sender: text.sender, content: 'text' },
    { peerId: 'audio-peer', sender: audio.sender, content: 'motion' },
  ]);

  assert.ok(allocation['movement-peer'] > allocation['text-peer']);
  assert.ok(Object.values(allocation).reduce((sum, value) => sum + value, 0) <= 10_000_000);
  assert.ok(Object.values(allocation).every((value) => value <= 8_000_000));
  assert.equal(motion.parameters.encodings?.[0]?.maxFramerate, 45);
  assert.equal(text.parameters.encodings?.[0]?.maxFramerate, 22);
  assert.equal(motion.track.contentHint, 'motion');
  assert.equal(text.track.contentHint, 'text');
  assert.equal(audio.setCalls, 0);
  assert.equal(audio.track.contentHint, '');
});

test('limita bitrate pela rota medida e reduz FPS quando o codificador informa pressão de CPU', async () => {
  const controller = new MediaQualityController({ totalVideoBitrate: 6_000_000, maxVideoBitratePerPeer: 8_000_000 });
  const constrained = createSender('video');
  const other = createSender('video');
  const peers: QualityPeer[] = [
    { peerId: 'constrained-peer', sender: constrained.sender, content: 'motion', availableOutgoingBitrate: 1_000_000, cpuPressure: 'high' },
    { peerId: 'other-peer', sender: other.sender, content: 'text', availableOutgoingBitrate: 20_000_000 },
  ];

  const allocation = await controller.allocate(peers);
  assert.ok(allocation['constrained-peer'] <= 1_000_000);
  assert.ok(Object.values(allocation).reduce((sum, value) => sum + value, 0) <= 6_000_000);
  assert.equal(constrained.parameters.encodings?.[0]?.maxFramerate, 29);
  assert.equal(constrained.parameters.encodings?.[0]?.scaleResolutionDownBy, 1.5);
  assert.equal(other.parameters.encodings?.[0]?.maxFramerate, 22);
});
test('aplica tetos de bitrate distintos para voz e transmissão sem alterar vídeo', async () => {
  const controller = new MediaQualityController();
  const microphone = createSender('audio');
  const screenAudio = createSender('audio', 256_000);
  const video = createSender('video');

  assert.equal(await controller.configureAudioSender(microphone.sender, 'voice'), true);
  assert.equal(microphone.parameters.encodings?.[0]?.maxBitrate, 96_000);
  assert.equal(microphone.setCalls, 1);
  assert.equal(await controller.configureAudioSender(screenAudio.sender, 'transmission'), true);
  assert.equal(screenAudio.parameters.encodings?.[0]?.maxBitrate, 192_000);
  assert.equal(screenAudio.setCalls, 1);
  assert.equal(await controller.configureAudioSender(video.sender, 'voice'), false);
  assert.equal(video.setCalls, 0);
});


test('mantém a preferência de codecs do navegador entre os compatíveis', () => {
  const original = globalThis.RTCRtpSender;
  const codecs = [
    { mimeType: 'video/VP8' },
    { mimeType: 'video/AV1' },
    { mimeType: 'video/H264' },
  ];
  let selected: typeof codecs = [];
  try {
    globalThis.RTCRtpSender = { getCapabilities: () => ({ codecs }) } as unknown as typeof RTCRtpSender;
    const transceiver = { setCodecPreferences: (value: typeof codecs) => { selected = value; } } as unknown as RTCRtpTransceiver;
    assert.equal(new MediaQualityController().setCompatibleVideoCodecs(transceiver, ['video/av1', 'video/vp8']), true);
    assert.deepEqual(selected.map((codec) => codec.mimeType), ['video/VP8', 'video/AV1']);
  } finally {
    globalThis.RTCRtpSender = original;
  }
});

test('mantém pressão até três amostras consecutivas de recuperação válidas', () => {
  const tracker = new CpuPressureTracker();
  assert.equal(tracker.update(84, false), 'unknown');
  assert.equal(tracker.update(85, false), 'high');
  assert.equal(tracker.update(69, false), 'high');
  assert.equal(tracker.update(null, false), 'high');
  assert.equal(tracker.update(69, false), 'high');
  assert.equal(tracker.update(70, false), 'high');
  assert.equal(tracker.update(69, false), 'high');
  assert.equal(tracker.update(69, false), 'high');
  assert.equal(tracker.update(69, false), 'unknown');
  assert.equal(tracker.update(null, true), 'high');
  assert.equal(tracker.update(60, false), 'high');
  assert.equal(tracker.update(60, true), 'high');
  assert.equal(tracker.update(NaN, false), 'high');
  assert.equal(tracker.update(60, false), 'high');
  assert.equal(tracker.update(60, false), 'high');
  assert.equal(tracker.update(60, false), 'unknown');
});

test('limita a captura conforme o modo, espectadores e pressão de CPU', () => {
  assert.deepEqual(displayCaptureConstraints('motion', 1, 'unknown'), {
    width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 60 },
  });
  assert.deepEqual(displayCaptureConstraints('text', 1, 'unknown').frameRate, { max: 30 });
  assert.deepEqual(displayCaptureConstraints('motion', 2, 'unknown').frameRate, { max: 30 });
  assert.deepEqual(displayCaptureConstraints('motion', 1, 'high'), {
    width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 20 },
  });
});

test('reduz FPS com mais espectadores sem mudar bitrate limitado por peer e evita reaplicações', async () => {
  const controller = new MediaQualityController({ totalVideoBitrate: 10_000_000, maxVideoBitratePerPeer: 1_000_000 });
  const first = createSender('video');
  const second = createSender('video');
  const firstPeer: QualityPeer = { peerId: 'first', sender: first.sender, content: 'motion' };
  const secondPeer: QualityPeer = { peerId: 'second', sender: second.sender, content: 'motion' };

  assert.equal((await controller.allocate([firstPeer])).first, 1_000_000);
  assert.equal(first.parameters.encodings[0].maxFramerate, 60);
  assert.equal((await controller.allocate([firstPeer, secondPeer])).first, 1_000_000);
  assert.equal(first.parameters.encodings[0].maxFramerate, 45);
  assert.equal(second.parameters.encodings[0].maxFramerate, 45);
  assert.equal(first.setCalls, 2);
  assert.equal(second.setCalls, 1);
  assert.deepEqual(await controller.allocate([firstPeer, secondPeer]), { first: 1_000_000, second: 1_000_000 });
  assert.equal(first.setCalls, 2);
  assert.equal(second.setCalls, 1);
  await controller.allocate([firstPeer]);
  assert.equal(first.parameters.encodings[0].maxFramerate, 60);
  assert.equal(first.setCalls, 3);
});

test('expõe telemetria do codificador somente quando presente no outbound de vídeo', async () => {
  const controller = new MediaQualityController();
  const video = createSender('video');
  let outbound: Record<string, unknown> = {
    id: 'video', type: 'outbound-rtp', kind: 'video',
    encoderImplementation: 'libvpx', powerEfficientEncoder: false,
  };
  video.sender.getStats = async () => new Map([['video', outbound]]) as unknown as RTCStatsReport;
  const peer: QualityPeer = { peerId: 'peer', sender: video.sender, content: 'motion' };
  const measured = await controller.getPeerStats(peer);
  assert.deepEqual(measured.encoderImplementation, { value: 'libvpx', source: 'measured' });
  assert.deepEqual(measured.powerEfficientEncoder, { value: false, source: 'measured' });

  outbound = { id: 'video', type: 'outbound-rtp', kind: 'video' };
  const missing = await controller.getPeerStats(peer);
  assert.deepEqual(missing.encoderImplementation, { value: null, source: 'unavailable' });
  assert.deepEqual(missing.powerEfficientEncoder, { value: null, source: 'unavailable' });
});
