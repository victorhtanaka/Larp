'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

async function run() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'larp-native-electron-test-'));
  const profileRoot = join(tempRoot, 'windows-profile');
  let child;
  try {
    await Promise.all([
      mkdir(join(profileRoot, 'Roaming'), { recursive: true }),
      mkdir(join(profileRoot, 'Local'), { recursive: true }),
    ]);
    const env = {};
    for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    Object.assign(env, {
      TEMP: tempRoot,
      TMP: tempRoot,
      USERPROFILE: profileRoot,
      APPDATA: join(profileRoot, 'Roaming'),
      LOCALAPPDATA: join(profileRoot, 'Local'),
      LARP_NATIVE_ELECTRON_TEMP_ROOT: tempRoot,
    });

    const electronPath = require('electron');
    if (typeof electronPath !== 'string') throw new Error('Electron executable path is unavailable.');
    child = spawn(electronPath, [join(__dirname, 'native-core-electron.cjs')], {
      cwd: join(__dirname, '..'),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    let timedOut = false;
    const exit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 30_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    if (timedOut) throw new Error('Electron smoke did not exit within 30 seconds.');
    if (exit.code !== 0 || exit.signal) {
      throw new Error(`Electron smoke exited unsuccessfully: ${stderr.trim() || exit.signal || exit.code}`);
    }
    const outputLine = stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
    if (!outputLine) throw new Error('Electron smoke returned no result.');
    const result = JSON.parse(outputLine);
    assert.deepEqual(result, {
      version: 1,
      safeStorage: 'available',
      identity: 'preserved',
      reopen: 'passed',
      corruptIdentity: 'fail-closed',
    });
    process.stdout.write(`${outputLine}\n`);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await rm(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write(`Native Electron smoke supervisor failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exitCode = 1;
});
