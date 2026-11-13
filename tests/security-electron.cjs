'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

function requireLoopbackConfig() {
  const rawUrl = process.env.LARP_SUPABASE_URL;
  const publicKey = process.env.LARP_SUPABASE_ANON_KEY;
  if (typeof rawUrl !== 'string') throw new Error('LARP_SUPABASE_URL must explicitly configure a loopback backend');
  if (typeof publicKey !== 'string' || publicKey.trim().length === 0) {
    throw new Error('LARP_SUPABASE_ANON_KEY must explicitly provide public local key material');
  }
  const normalizedKey = publicKey.trim();

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('LARP_SUPABASE_URL must be a valid loopback URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Supabase backend must use HTTP(S)');
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase())) {
    throw new Error('Supabase backend must be loopback');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Supabase backend URL must not contain credentials or query parameters');
  }
  if (normalizedKey.startsWith('sb_secret_')) throw new Error('A public Supabase key is required');
  const jwtParts = normalizedKey.split('.');
  if (jwtParts.length === 3) {
    try {
      const claims = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString('utf8'));
      if (claims.role === 'service_role') throw new Error('A public Supabase key is required');
    } catch {
      throw new Error('LARP_SUPABASE_ANON_KEY must be valid public key material');
    }
  }
  return url;
}

const { app, BrowserWindow, session } = require('electron');
const appWillQuit = new Promise((resolve) => app.once('will-quit', resolve));

let backendUrl;
try {
  backendUrl = requireLoopbackConfig();
} catch {
  process.stderr.write('Electron security harness failed: invalid loopback backend configuration.\n');
  app.exit(1);
}

if (!backendUrl) {
  // app.exit terminates immediately without loading the application bundle.
} else {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const isLoopbackRequest = (requestUrl) => {
    try {
    const parsed = new URL(requestUrl);
    return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

async function waitForMainWindow(timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        const hasBridge = await window.webContents.executeJavaScript('Boolean(window.larp && window.larp.getCloudStatus)');
        if (hasBridge) return window;
      } catch { /* The renderer has not loaded yet. */ }
    }
    await sleep(100);
  }
  throw new Error('Timed out waiting for the application bridge');
}

async function expectForeignRejection(window, expression) {
  const result = await window.webContents.executeJavaScript(`(async () => {
    try { await (${expression}); return { rejected: false, authorizedError: false }; }
    catch (error) { return { rejected: true, authorizedError: String(error && error.message || '').includes('Origem IPC não autorizada') }; }
  })()`);
  assert.equal(result.rejected, true, 'Foreign-window bridge call unexpectedly resolved');
  assert.equal(result.authorizedError, true, 'Foreign-window bridge call did not fail at the trusted-frame boundary');
}

async function main() {
  let temporaryRoot;
  let server;
  let exitError;
  try {
    temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'larp-security-electron-'));
    app.setPath('appData', temporaryRoot);
    await app.whenReady();
    await fs.mkdir(path.join(temporaryRoot, 'Larp-dev'), { recursive: true });

    const defaultSession = session.defaultSession;
    defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      let allowed = false;
      try {
        const parsed = new URL(details.url);
        allowed = isLoopbackRequest(details.url)
          || parsed.protocol === 'file:'
          || parsed.protocol === 'data:'
          || parsed.protocol === 'blob:'
          || parsed.protocol === 'about:';
      } catch { /* Invalid and non-loopback requests are denied. */ }
      callback({ cancel: !allowed });
    });

    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end('<!doctype html><html><head><meta charset="utf-8"></head><body>foreign-window fixture</body></html>');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    const buildDirectory = path.join(__dirname, '..', '.vite', 'build');
    const mainEntry = path.join(buildDirectory, 'main.cjs');
    const preloadPath = path.join(buildDirectory, 'preload.cjs');
    await Promise.all([fs.access(mainEntry), fs.access(preloadPath)]);

    require(mainEntry);
    await app.whenReady();
    const mainWindow = await waitForMainWindow();

    const legitimate = await mainWindow.webContents.executeJavaScript(`(async () => {
      const status = await window.larp.getCloudStatus();
      const identity = await window.larp.getPublicIdentity();
      const payload = 'security-harness-identity-signing-check';
      const signature = await window.larp.signIdentityPayload(payload);
      const verified = await window.larp.verifyIdentityPayload(payload, signature, identity.publicKey);
      const cachedGroups = await window.larp.getCachedCloudGroups();
      return {
        statusAvailable: Boolean(status && typeof status.state === 'string'),
        identityAvailable: Boolean(identity && typeof identity.publicKey === 'string'),
        signatureVerified: verified === true,
        cachedGroupsAvailable: Array.isArray(cachedGroups),
      };
    })()`);
    assert.equal(legitimate.statusAvailable, true, 'Legitimate cloud status bridge call failed');
    assert.equal(legitimate.identityAvailable, true, 'Legitimate identity bridge call failed');
    assert.equal(legitimate.signatureVerified, true, 'Legitimate identity signing bridge call failed');
    assert.equal(legitimate.cachedGroupsAvailable, true, 'Legitimate local cache bridge call failed');

    const foreignWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await foreignWindow.loadURL(`http://127.0.0.1:${address.port}/foreign-fixture`);
    await expectForeignRejection(foreignWindow, "window.larp.signIdentityPayload('foreign-signing-attempt')");
    await expectForeignRejection(foreignWindow, 'window.larp.persistOutgoingEnvelope({})');
    await expectForeignRejection(foreignWindow, 'window.larp.persistVerifiedEnvelope({})');

    const stillFunctional = await mainWindow.webContents.executeJavaScript('window.larp.getCachedCloudGroups().then(Array.isArray)');
    assert.equal(stillFunctional, true, 'Legitimate window stopped functioning after foreign-window checks');
  } catch (error) {
    exitError = error;
  } finally {
    if (app.isReady()) {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.destroy();
      }
      app.quit();
      try {
        await Promise.race([
          appWillQuit,
          sleep(5_000).then(() => { throw new Error('Timed out waiting for Electron to quit'); }),
        ]);
      } catch (error) {
        if (!exitError) exitError = error;
      }
    }
    if (server) {
      await new Promise((resolve) => server.close((error) => {
        if (error && !exitError) exitError = error;
        resolve();
      }));
    }
    if (temporaryRoot) {
      try {
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      } catch (error) {
        if (!exitError) exitError = error;
      }
    }
  }

  if (exitError) {
    process.stderr.write('Electron security harness failed.\n');
    process.exitCode = 1;
  } else {
    process.stdout.write('Electron security harness passed.\n');
  }
}

  void main().catch(() => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.destroy();
    }
    process.stderr.write('Electron security harness failed.\n');
    app.exit(1);
  });
}
