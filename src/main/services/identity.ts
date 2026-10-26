import { safeStorage } from 'electron';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { IdentitySignature, PublicIdentity } from '../../shared/cloud-contracts';

interface PersistedIdentity {
  version: 1;
  encryptedPrivateKey: string;
  publicKey: string;
}

export interface IdentityManager {
  getOrCreate(): Promise<PublicIdentity>;
  sign(message: string | Uint8Array): Promise<IdentitySignature>;
  verify(message: string | Uint8Array, signature: IdentitySignature, publicKey?: string): Promise<boolean>;
}

export class IdentityStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'IdentityStorageError';
  }
}

export function createIdentityManager(storagePath: string): IdentityManager {
  let cached: PersistedIdentity | undefined;
  let loading: Promise<PersistedIdentity> | undefined;

  async function loadOrCreate(): Promise<PersistedIdentity> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new IdentityStorageError('A criptografia protegida do Windows não está disponível; a identidade foi desativada.');
    }
    let existing: PersistedIdentity | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(storagePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !('version' in parsed) || !('encryptedPrivateKey' in parsed) || !('publicKey' in parsed)
        || parsed.version !== 1 || typeof parsed.encryptedPrivateKey !== 'string' || parsed.encryptedPrivateKey.length > 16_384
        || typeof parsed.publicKey !== 'string' || parsed.publicKey.length < 1 || parsed.publicKey.length > 4096) {
        throw new Error('Invalid identity file.');
      }
      const ciphertext = Buffer.from(parsed.encryptedPrivateKey, 'base64');
      if (ciphertext.length === 0 || ciphertext.toString('base64') !== parsed.encryptedPrivateKey) throw new Error('Invalid encrypted identity data.');
      const privateKey = safeStorage.decryptString(ciphertext);
      const derivedPublic = createPublicKey(createPrivateKey(privateKey)).export({ type: 'spki', format: 'pem' }).toString();
      if (derivedPublic !== parsed.publicKey) throw new Error('Identity key pair mismatch.');
      existing = { version: 1, encryptedPrivateKey: parsed.encryptedPrivateKey, publicKey: parsed.publicKey };
    } catch (error) {
      const missing = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      if (!missing) throw new IdentityStorageError('A identidade armazenada não pôde ser carregada com segurança.', { cause: error });
    }
    if (existing) return existing;

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const record: PersistedIdentity = {
      version: 1,
      encryptedPrivateKey: safeStorage.encryptString(privatePem).toString('base64'),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
    await mkdir(dirname(storagePath), { recursive: true });
    const temporaryPath = `${storagePath}.${process.pid}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, storagePath);
    } catch (error) {
      throw new IdentityStorageError('Não foi possível salvar a identidade criptografada.', { cause: error });
    }
    return record;
  }

  async function get(): Promise<PersistedIdentity> {
    if (!cached) loading ??= loadOrCreate().finally(() => { loading = undefined; });
    cached ??= await loading!;
    return cached;
  }

  return {
    async getOrCreate() {
      const record = await get();
      return { algorithm: 'Ed25519', publicKey: record.publicKey };
    },
    async sign(message) {
      const record = await get();
      const privateKey = safeStorage.decryptString(Buffer.from(record.encryptedPrivateKey, 'base64'));
      return { algorithm: 'Ed25519', signature: signBytes(null, Buffer.from(message), createPrivateKey(privateKey)).toString('base64') };
    },
    async verify(message, signature, publicKey) {
      if (signature.algorithm !== 'Ed25519') return false;
      try {
        const key = publicKey ?? (await get()).publicKey;
        return verifyBytes(null, Buffer.from(message), createPublicKey(key), Buffer.from(signature.signature, 'base64'));
      } catch {
        return false;
      }
    },
  };
}
