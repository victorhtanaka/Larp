import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeProfileFields, profileUpdateFromIpc, userProfileFrom } from '../src/main/profile-validation';
import { USER_PROFILE_AVATAR_MAX_BYTES } from '../src/shared/cloud-contracts';

const WEBP_FIXTURE = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89';

function webpDataUri(byteLength: number): string {
  const chunkLength = byteLength - 20;
  assert.ok(chunkLength >= 10 && chunkLength % 2 === 0);
  const bytes = Buffer.alloc(byteLength);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(byteLength - 8, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8 ', 12, 'ascii');
  bytes.writeUInt32LE(chunkLength, 16);
  Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00]).copy(bytes, 20);
  return `data:image/webp;base64,${bytes.toString('base64')}`;
}

test('profile names normalize whitespace and enforce 32 Unicode characters', () => {
  assert.deepEqual(normalizeProfileFields('  Lía  ', null), { displayName: 'Lía', avatarData: null });
  assert.deepEqual(normalizeProfileFields('   ', null), { displayName: null, avatarData: null });
  assert.equal(normalizeProfileFields('😀'.repeat(32), null).displayName, '😀'.repeat(32));
  assert.throws(() => normalizeProfileFields('😀'.repeat(33), null), /até 32 caracteres/u);
});

test('profile avatar accepts a WebP thumbnail at 48 KiB and rejects a larger or malformed payload', () => {
  const exactLimit = webpDataUri(USER_PROFILE_AVATAR_MAX_BYTES);
  assert.equal(normalizeProfileFields(null, exactLimit).avatarData, exactLimit);
  assert.throws(() => normalizeProfileFields(null, webpDataUri(USER_PROFILE_AVATAR_MAX_BYTES + 2)), /48 KiB/u);
  assert.throws(() => normalizeProfileFields(null, 'data:image/png;base64,UklGRg=='), /WebP/u);
  assert.throws(() => normalizeProfileFields(null, 'data:image/webp;base64,not-base64'), /WebP/u);
  assert.equal(normalizeProfileFields(null, WEBP_FIXTURE).avatarData, WEBP_FIXTURE);
});

test('profile IPC contract rejects caller identity and unrelated fields', () => {
  assert.deepEqual(profileUpdateFromIpc({ displayName: '  Ana  ', avatarData: null }), {
    displayName: 'Ana',
    avatarData: null,
  });
  assert.throws(() => profileUpdateFromIpc({ userId: 'another-user', displayName: 'Ana', avatarData: null }), /Dados do perfil inválidos/u);
  assert.throws(() => profileUpdateFromIpc({ displayName: 'Ana', avatarData: null, role: 'owner' }), /Dados do perfil inválidos/u);
});

test('cached and remote profiles must match their authenticated member', () => {
  const profile = { userId: 'user-a', displayName: 'Ana', avatarData: null };
  assert.deepEqual(userProfileFrom(profile, 'user-a'), profile);
  assert.throws(() => userProfileFrom(profile, 'user-b'), /perfil retornado/u);
});
