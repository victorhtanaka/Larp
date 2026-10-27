import type { UserProfile, UserProfileUpdate } from '../shared/cloud-contracts';
import {
  USER_PROFILE_AVATAR_MAX_BYTES,
  USER_PROFILE_AVATAR_MAX_DATA_URI_LENGTH,
  USER_PROFILE_NAME_MAX_LENGTH,
} from '../shared/cloud-contracts';

const AVATAR_PREFIX = 'data:image/webp;base64,';
const BASE64_PAYLOAD = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function validWebp(bytes: Buffer): boolean {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;

  let offset = 12;
  let firstChunk = true;
  let hasImageChunk = false;
  while (offset + 8 <= bytes.length) {
    const chunkName = bytes.toString('ascii', offset, offset + 4);
    const chunkLength = bytes.readUInt32LE(offset + 4);
    const nextOffset = offset + 8 + chunkLength + (chunkLength & 1);
    if (nextOffset > bytes.length || (firstChunk && chunkLength === 0)
      || (chunkName === 'VP8X' && chunkLength !== 10)
      || (chunkName === 'VP8 ' && chunkLength < 10)
      || (chunkName === 'VP8L' && chunkLength < 5)) return false;
    if (firstChunk && chunkName !== 'VP8 ' && chunkName !== 'VP8L' && chunkName !== 'VP8X') return false;
    if (chunkName === 'VP8 ' || chunkName === 'VP8L') hasImageChunk = true;
    firstChunk = false;
    offset = nextOffset;
  }
  return !firstChunk && hasImageChunk && offset === bytes.length;
}

function normalizeDisplayName(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 256) throw new TypeError('Nome de perfil inválido.');
  const name = value.trim();
  if (!name) return null;
  if (Array.from(name).length > USER_PROFILE_NAME_MAX_LENGTH) {
    throw new TypeError(`O nome de perfil deve ter até ${USER_PROFILE_NAME_MAX_LENGTH} caracteres.`);
  }
  return name;
}

function normalizeAvatarData(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > USER_PROFILE_AVATAR_MAX_DATA_URI_LENGTH
    || !value.startsWith(AVATAR_PREFIX)) {
    throw new TypeError('A foto de perfil deve ser um thumbnail WebP válido.');
  }
  const payload = value.slice(AVATAR_PREFIX.length);
  if (payload.length === 0 || !BASE64_PAYLOAD.test(payload)) {
    throw new TypeError('A foto de perfil deve ser um thumbnail WebP válido.');
  }
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length > USER_PROFILE_AVATAR_MAX_BYTES || bytes.toString('base64') !== payload || !validWebp(bytes)) {
    throw new TypeError('A foto de perfil deve ser um thumbnail WebP de até 48 KiB.');
  }
  return value;
}

export function normalizeProfileFields(displayName: unknown, avatarData: unknown): UserProfileUpdate {
  return {
    displayName: normalizeDisplayName(displayName),
    avatarData: normalizeAvatarData(avatarData),
  };
}

export function profileUpdateFromIpc(input: unknown): UserProfileUpdate {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Dados do perfil inválidos.');
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes('displayName') || !keys.includes('avatarData')
    || !('displayName' in input) || !('avatarData' in input)) {
    throw new TypeError('Dados do perfil inválidos.');
  }
  return normalizeProfileFields(input.displayName, input.avatarData);
}

export function userProfileFrom(value: unknown, expectedUserId: string): UserProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !('userId' in value) || value.userId !== expectedUserId
    || !('displayName' in value) || !('avatarData' in value)) {
    throw new TypeError('O perfil retornado pelo serviço é inválido.');
  }
  return { userId: expectedUserId, ...normalizeProfileFields(value.displayName, value.avatarData) };
}
