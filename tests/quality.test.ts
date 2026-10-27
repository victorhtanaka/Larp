import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaQualityController, type QualityPeer } from '../src/renderer/media/quality';

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
  assert.equal(motion.parameters.encodings?.[0]?.maxFramerate, 60);
  assert.equal(text.parameters.encodings?.[0]?.maxFramerate, 30);
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
  assert.equal(constrained.parameters.encodings?.[0]?.maxFramerate, 39);
  assert.equal(constrained.parameters.encodings?.[0]?.scaleResolutionDownBy, 1.5);
  assert.equal(other.parameters.encodings?.[0]?.maxFramerate, 30);
});
test('limita o envio de áudio de microfone e tela a 96 kb/s sem alterar vídeo', async () => {
  const controller = new MediaQualityController();
  const microphone = createSender('audio');
  const screenAudio = createSender('audio', 128_000);
  const video = createSender('video');

  assert.equal(await controller.configureAudioSender(microphone.sender), true);
  assert.equal(microphone.parameters.encodings?.[0]?.maxBitrate, 96_000);
  assert.equal(microphone.setCalls, 1);
  assert.equal(await controller.configureAudioSender(screenAudio.sender), true);
  assert.equal(screenAudio.parameters.encodings?.[0]?.maxBitrate, 96_000);
  assert.equal(screenAudio.setCalls, 1);
  assert.equal(await controller.configureAudioSender(video.sender), false);
  assert.equal(video.setCalls, 0);
});

