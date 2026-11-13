'use strict';

const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const { createRequire } = require('node:module');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const path = require('node:path');
const { app, safeStorage } = require('electron');
const electronTestRoot = process.env.LARP_NATIVE_ELECTRON_TEMP_ROOT || '';
if (!path.isAbsolute(electronTestRoot) || !path.basename(electronTestRoot).startsWith('larp-native-electron-test-')) {
  throw new Error('Native Electron smoke requires its isolated temporary root.');
}
const electronAppDataPath = path.join(electronTestRoot, 'app-data');
const electronUserDataPath = path.join(electronAppDataPath, 'Larp');
app.setPath('appData', electronAppDataPath);
app.setPath('userData', electronUserDataPath);

const projectRoot = path.resolve(__dirname, '..');
const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
projectRequire('tsx/cjs');
const { handleSecretsCall } = projectRequire(path.join(projectRoot, 'src/main/platform-secrets.ts'));
const addonPath = path.join(projectRoot, 'native/larp-core/dist/larp_core.node');
const addon = require(addonPath);
const { createNativeCore } = projectRequire(path.join(projectRoot, 'src/main/native-core.ts'));

function failure(code, message) {
  return JSON.stringify({ version: 1, ok: false, error: { code, message } });
}

async function hostCall(requestJson) {
  let call;
  try { call = JSON.parse(requestJson); } catch { return failure('INVALID_HOST_CALL', 'Malformed host request.'); }
  if (call?.version !== 1) return failure('INVALID_HOST_CALL', 'Unsupported host version.');
  if (call.kind === 'cloud' && call.op === 'dispose') return JSON.stringify({ version: 1, ok: true, value: { data: null, error: null } });
  if (call.kind !== 'secrets') return failure('TEST_HOST_OPERATION', 'Unexpected host operation.');
  try { return JSON.stringify(await handleSecretsCall(call)); } catch (error) {
    return failure('SECRET_STORAGE_FAILED', error instanceof Error ? error.message : 'Protected storage failed.');
  }
}

function request(core, op, payload) {
  return core.request({ version: 1, op, payload });
}

async function run() {
  assert.equal(typeof addon.openCore, 'function');
  assert.equal(await safeStorage.isAsyncEncryptionAvailable(), true, 'Electron safeStorage must be available');
  const userDataPath = path.join(electronTestRoot, 'native-user-data');
  await mkdir(userDataPath);
  let core;
  try {
    const pair = generateKeyPairSync('ed25519');
    const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const encryptedPrivateKey = (await safeStorage.encryptStringAsync(privateKeyPem)).toString('base64');
    await writeFile(path.join(userDataPath, 'identity.json'), JSON.stringify({ version: 1, encryptedPrivateKey, publicKey: publicKeyPem }), { flag: 'wx' });


    core = await createNativeCore(userDataPath, null, hostCall, () => {}, addonPath);
    const identity = await request(core, 'getPublicIdentity', {});
    assert.deepEqual(identity, { algorithm: 'Ed25519', publicKey: publicKeyPem });
    const messageBase64 = Buffer.from('native electron smoke — café \uD800', 'utf8').toString('base64');
    const signature = await request(core, 'signIdentityPayload', { payloadBase64: messageBase64 });
    assert.equal(signature.algorithm, 'Ed25519');
    assert.match(signature.signature, /^[A-Za-z0-9+/]+=*$/u);
    assert.equal(await request(core, 'verifyIdentityPayload', {
      payloadBase64: messageBase64, signature, publicKey: publicKeyPem,
    }), true);

    const identityRecord = JSON.parse(await readFile(path.join(userDataPath, 'identity.json'), 'utf8'));
    assert.deepEqual(Object.keys(identityRecord), ['version', 'encryptedPrivateKey', 'publicKey']);
    assert.equal(identityRecord.version, 1);
    assert.equal(identityRecord.publicKey, publicKeyPem);
    assert.equal(JSON.stringify(identityRecord).includes('PRIVATE KEY'), false);


    await core.close();
    core = await createNativeCore(userDataPath, null, hostCall, () => {}, addonPath);
    assert.deepEqual(await request(core, 'getPublicIdentity', {}), identity);
    await core.close();
    core = undefined;
    const corruptPath = path.join(userDataPath, 'corrupt-profile');
    await mkdir(corruptPath);
    const corruptIdentityPath = path.join(corruptPath, 'identity.json');
    const corruptIdentity = JSON.stringify({ version: 1, encryptedPrivateKey: 'AA==', publicKey: 'invalid' });
    await writeFile(corruptIdentityPath, corruptIdentity, { flag: 'wx' });
    let corruptCore;
    try {
      try {
        corruptCore = await createNativeCore(corruptPath, null, hostCall, () => {}, addonPath);
        await assert.rejects(() => request(corruptCore, 'getPublicIdentity', {}));
      } catch (error) {
        if (corruptCore || !(error instanceof Error) || !error.message.includes('larp-core:invalid-identity')) throw error;
      }
    } finally {
      if (corruptCore) await corruptCore.close();
    }
    assert.equal(await readFile(corruptIdentityPath, 'utf8'), corruptIdentity);
    return { version: 1, safeStorage: 'available', identity: 'preserved', reopen: 'passed', corruptIdentity: 'fail-closed' };
  } finally {
    if (core) await core.close();
  }
}

app.whenReady().then(run).then(
  (result) => process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0)),
  (error) => {
    process.stderr.write(`Native Electron smoke failed: ${error instanceof Error ? error.message : 'unknown error'}\n`, () => process.exit(1));
  },
);
