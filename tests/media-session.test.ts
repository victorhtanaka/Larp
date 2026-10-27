import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MediaSession } from '../src/renderer/media/session';
import { loadPlaybackVolume, savePlaybackVolume } from '../src/renderer/media/playback-volume';

test('aplica volume salvo ao anexar a saída e limita valores ao intervalo reproduzível', () => {
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
