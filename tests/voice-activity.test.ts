import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceActivityMonitor } from '../src/renderer/media/voice-activity';

class FakeTrack extends EventTarget {
  readonly kind = 'audio';
}

class FakeAnalyser {
  fftSize = 8;
  loud = false;
  getFloatTimeDomainData(samples: Float32Array): void { samples.fill(this.loud ? 0.5 : 0); }
}

function setup() {
  const analysers: FakeAnalyser[] = [];
  let closed = false;
  const context = {
    createAnalyser: () => { const analyser = new FakeAnalyser(); analysers.push(analyser); return analyser; },
    createMediaStreamSource: () => ({ connect: () => undefined, disconnect: () => undefined }),
    close: async () => { closed = true; },
  } as unknown as AudioContext;
  const changes: string[][] = [];
  const monitor = new VoiceActivityMonitor({
    onActiveSpeakers: (ids) => changes.push([...ids].sort()),
    audioContextFactory: () => context,
    mediaStreamFactory: () => ({}) as MediaStream,
  });
  return { monitor, analysers, changes, isClosed: () => closed };
}

test('uses entry and exit hysteresis to report active speakers', () => {
  const { monitor, analysers, changes } = setup();
  const track = new FakeTrack() as unknown as MediaStreamTrack;
  monitor.addTrack('alice', track);
  analysers[0].loud = true;
  monitor.sample();
  assert.deepEqual([...monitor.activeSpeakers], []);
  monitor.sample();
  assert.deepEqual([...monitor.activeSpeakers], ['alice']);
  analysers[0].loud = false;
  monitor.sample();
  monitor.sample();
  assert.deepEqual([...monitor.activeSpeakers], ['alice']);
  monitor.sample();
  assert.deepEqual([...monitor.activeSpeakers], []);
  assert.deepEqual(changes, [['alice'], []]);
});

test('combines multiple tracks for one participant and removes only after the last ends', () => {
  const { monitor, analysers } = setup();
  const first = new FakeTrack() as unknown as MediaStreamTrack;
  const second = new FakeTrack() as unknown as MediaStreamTrack;
  monitor.addTrack('alice', first);
  monitor.addTrack('alice', second);
  analysers[0].loud = true;
  monitor.sample(); monitor.sample();
  analysers[0].loud = false;
  analysers[1].loud = true;
  monitor.sample();
  assert.deepEqual([...monitor.activeSpeakers], ['alice']);
  first.dispatchEvent(new Event('ended'));
  assert.deepEqual([...monitor.activeSpeakers], ['alice']);
  second.dispatchEvent(new Event('ended'));
  assert.deepEqual([...monitor.activeSpeakers], []);
});

test('close disconnects analysis and context without stopping caller-owned tracks', async () => {
  const { monitor, analysers, isClosed } = setup();
  const track = Object.assign(new FakeTrack(), { stopped: false, stop() { this.stopped = true; } }) as unknown as MediaStreamTrack;
  monitor.addTrack('alice', track);
  analysers[0].loud = true;
  monitor.sample(); monitor.sample();
  await monitor.close();
  assert.equal(isClosed(), true);
  assert.equal((track as unknown as { stopped: boolean }).stopped, false);
  assert.deepEqual([...monitor.activeSpeakers], []);
  monitor.sample();
  assert.deepEqual([...monitor.activeSpeakers], []);
});
