import { app, safeStorage } from 'electron';
import type { HostCall, JsonResponse } from '../shared/native-core-contracts';

let ready: Promise<void> | undefined;
function afterReady(): Promise<void> {
  ready ??= app.whenReady().then(() => undefined);
  return ready;
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new TypeError('Expected canonical base64 data.');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) throw new TypeError('Expected canonical base64 data.');
  return decoded;
}

export async function handleSecretsCall(call: Extract<HostCall, { kind: 'secrets' }>): Promise<JsonResponse> {
  await afterReady();
  if (call.op === 'available') return { version: 1, ok: true, value: await safeStorage.isAsyncEncryptionAvailable() };
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('Protected platform encryption is unavailable.');
  if (call.op === 'encrypt') {
    const plaintext = decodeBase64(call.payload.plaintextBase64).toString('utf8');
    const encrypted = await safeStorage.encryptStringAsync(plaintext);
    return { version: 1, ok: true, value: { ciphertextBase64: encrypted.toString('base64') } };
  }
  const ciphertext = decodeBase64(call.payload.ciphertextBase64);
  const decrypted = await safeStorage.decryptStringAsync(ciphertext);
  return {
    version: 1,
    ok: true,
    value: { plaintextBase64: Buffer.from(decrypted.result, 'utf8').toString('base64'), shouldReEncrypt: decrypted.shouldReEncrypt },
  };
}
