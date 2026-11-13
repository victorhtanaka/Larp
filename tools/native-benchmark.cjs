'use strict';

const { spawn } = require('node:child_process');
const { createServer } = require('node:http');
const { basename, join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { copyFile, mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');

const SCALES = [1_000, 50_000];
const WARMUPS = 3;
const PAIRS = 30;

const FIXTURE = Object.freeze({
  version: 1,
  groupId: 'benchmark-group',
  localId: 'benchmark-local',
  peerIds: ['benchmark-peer-0', 'benchmark-peer-1', 'benchmark-peer-2', 'benchmark-peer-3', 'benchmark-peer-4', 'benchmark-peer-5'],
});

function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(probability * sorted.length) - 1)].toFixed(3));
}

function percentileSummary(values) {
  const available = values.filter(Number.isFinite);
  return { samples: available.length, p50Ms: quantile(available, 0.5), p95Ms: quantile(available, 0.95) };
}


function sanitizedEnvironment(repoRoot, workDir, profileDir, backendUrl, databasePath, scale, mode) {
  const env = {};
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC']) if (process.env[name]) env[name] = process.env[name];
  env.TEMP = workDir;
  env.TMP = workDir;
  env.USERPROFILE = profileDir;
  env.APPDATA = join(profileDir, 'Roaming');
  env.LOCALAPPDATA = join(profileDir, 'Local');
  env.LARP_BENCH_TEMP_ROOT = tmpdir();
  env.LARP_BENCH_ROOT = repoRoot;
  env.LARP_BENCH_WORKDIR = workDir;
  env.LARP_BENCH_DATABASE = databasePath;
  env.LARP_BENCH_BACKEND = backendUrl;
  env.LARP_BENCH_SCALE = String(scale);
  env.LARP_BENCH_MODE = mode;
  return env;
}

function runElectron(executable, args, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 180_000);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); rejectPromise(new Error('Could not launch isolated Electron worker.')); });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
}

async function runWorker(electronPath, workerPath, repoRoot, backendUrl, scale, mode, pairIndex, phase) {
  const workDir = await mkdtemp(join(tmpdir(), 'larp-native-bench-'));
  const appDir = join(workDir, 'app');
  const profileDir = join(workDir, 'windows-profile');
  const userDataDir = join(workDir, 'electron-user-data');
  const databasePath = join(workDir, 'fixture.sqlite');
  try {
    await Promise.all([
      mkdir(appDir, { recursive: false }),
      mkdir(join(profileDir, 'Roaming'), { recursive: true }),
      mkdir(join(profileDir, 'Local'), { recursive: true }),
      mkdir(userDataDir, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(workerPath, join(appDir, 'main.cjs')),
      writeFile(join(appDir, 'package.json'), JSON.stringify({ name: 'larp-native-benchmark-worker', version: '0.0.0', private: true, main: 'main.cjs' }), { encoding: 'utf8', flag: 'wx' }),
    ]);
    const child = await runElectron(electronPath, [appDir, `--user-data-dir=${userDataDir}`], {
      cwd: repoRoot,
      env: sanitizedEnvironment(repoRoot, workDir, profileDir, backendUrl, databasePath, scale, mode),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.status !== 0 || child.signal) throw new Error(`Electron ${mode} worker failed at scale ${scale}, ${phase} ${pairIndex + 1}.`);
    const line = child.stdout.split(/\r?\n/u).map((item) => item.trim()).filter((item) => item.startsWith('{')).at(-1);
    if (!line) throw new Error(`Electron ${mode} worker returned no JSON at scale ${scale}, ${phase} ${pairIndex + 1}.`);
    const sample = JSON.parse(line);
    if (sample.version !== 2 || sample.mode !== mode || sample.scale !== scale || sample.authorCount !== FIXTURE.peerIds.length || sample.backend !== (mode === 'baseline' ? 'loopback' : 'none')) {
      throw new Error(`Electron ${mode} worker returned an invalid sample at scale ${scale}.`);
    }
    if (mode === 'baseline' && (sample.persistedMessages !== scale - FIXTURE.peerIds.length || sample.historyCount !== FIXTURE.peerIds.length * 100 || sample.ackAndGapRequestObserved !== true)) {
      throw new Error(`Baseline correctness checks failed at scale ${scale}.`);
    }
    if (mode === 'native' && sample.comparability?.status !== 'not-comparable') throw new Error('Native comparability blocker was not reported.');
    return sample;
  } finally {
    if (basename(workDir).startsWith('larp-native-bench-')) await rm(workDir, { recursive: true, force: true });
  }
}

function summarizeScale(pairs) {
  const baselineFields = ['sqliteOpenMs', 'fixtureGenerationMs', 'gapScanMs', 'historyReadMs', 'messageSigningMs', 'signedReceiveMs'];
  const baseline = Object.fromEntries(baselineFields.map((field) => [
    field,
    percentileSummary(pairs.map((pair) => pair.baseline[field])),
  ]));
  const native = Object.fromEntries(['nativeCoreOpenMs'].map((field) => [
    field,
    percentileSummary(pairs.map((pair) => pair.native[field])),
  ]));
  for (const operation of ['recentMessages', 'gapScan', 'historyRead']) {
    native[operation] = percentileSummary(pairs.map((pair) => pair.native.operationLatencies[operation]));
  }
  const processMetrics = {};
  for (const field of ['cpuUserMicros', 'cpuSystemMicros', 'rssBytes', 'eventLoopMeanMs', 'eventLoopP95Ms']) {
    for (const mode of ['baseline', 'native']) {
      const values = pairs.map((pair) => pair[mode].process[field]).filter(Number.isFinite);
      processMetrics[`${mode}.${field}`] = { samples: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) };
    }
  }
  return {
    perOperation: { baseline, native },
    perRunProcess: processMetrics,
    comparison: {
      status: 'not-comparable',
      reason: 'Native API operations run against an empty store because equivalent fixture seeding is unsupported; no paired percentile bootstrap was computed.',
    },
  };
}

async function main() {
  const repoRoot = resolve(__dirname, '..');
  const electronPath = require('electron');
  if (typeof electronPath !== 'string' || !electronPath.toLowerCase().endsWith('electron.exe')) throw new Error('Electron executable was not resolved.');
  const workerPath = join(repoRoot, 'tools', 'native-benchmark-electron.cjs');
  let fixtureRequests = 0;
  let rejectedRequests = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== '/fixture') {
      rejectedRequests += 1;
      response.writeHead(404, { 'content-length': '0' }).end();
      return;
    }
    fixtureRequests += 1;
    const body = JSON.stringify(FIXTURE);
    response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    response.end(body);
  });
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise); });
  try {
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw new Error('Loopback backend did not bind to 127.0.0.1.');
    const backendUrl = `http://127.0.0.1:${address.port}/fixture`;
    const results = [];
    for (const scale of SCALES) {
      const pairs = [];
      for (let pairIndex = 0; pairIndex < WARMUPS + PAIRS; pairIndex += 1) {
        const order = pairIndex % 2 === 0 ? ['baseline', 'native'] : ['native', 'baseline'];
        const pair = { pairIndex, warmup: pairIndex < WARMUPS, order };
        for (const mode of order) pair[mode] = await runWorker(electronPath, workerPath, repoRoot, backendUrl, scale, mode, pairIndex, pair.warmup ? 'warmup' : 'measured');
        if (!pair.warmup) pairs.push(pair);
      }
      results.push({
        scale,
        authors: FIXTURE.peerIds.length,
        expectedPersistedMessages: scale - FIXTURE.peerIds.length,
        warmups: WARMUPS,
        measuredPairs: PAIRS,
        metrics: summarizeScale(pairs),
        pairs,
      });
    }
    process.stdout.write(`${JSON.stringify({
      version: 2,
      scope: 'Paired TypeScript v5 baseline and public NativeCoreClient operations. Native workload seeding is not comparable; see each native sample blocker.',
      backend: { binding: '127.0.0.1', requests: fixtureRequests, rejectedRequests },
      temporaryDataOnly: true,
      comparison: {
        status: 'not-comparable',
        reason: 'Native samples use an empty store; no equivalent paired workload or confidence interval is reported.',
      },
      results,
    }, null, 2)}\n`);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Benchmark failed.'}\n`);
  process.exitCode = 1;
});
