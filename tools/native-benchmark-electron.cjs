'use strict';

const { app, session } = require('electron');
const { createHash, createPrivateKey, createPublicKey, sign: signBytes, verify: verifyBytes } = require('node:crypto');
const { createRequire } = require('node:module');
const { basename, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const http = require('node:http');

const GROUP_ID = 'benchmark-group';
const LOCAL_ID = 'benchmark-local';
const PEER_IDS = ['benchmark-peer-0', 'benchmark-peer-1', 'benchmark-peer-2', 'benchmark-peer-3', 'benchmark-peer-4', 'benchmark-peer-5'];
const PRIVATE_KEY_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const FIXED_CREATED_AT = '2026-01-01T00:00:00.000Z';

function safePathWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function readConfiguration() {
  const rootValue = process.env.LARP_BENCH_ROOT || '';
  if (!rootValue) throw new Error('missing benchmark root');
  const projectRoot = resolve(rootValue);
  const workDir = resolve(process.env.LARP_BENCH_WORKDIR || '');
  const databasePath = resolve(process.env.LARP_BENCH_DATABASE || '');
  const rawScale = process.env.LARP_BENCH_SCALE || '';
  const scale = Number(rawScale);
  const mode = process.env.LARP_BENCH_MODE || 'baseline';
  const backend = new URL(process.env.LARP_BENCH_BACKEND || '');
  const tempRootValue = process.env.LARP_BENCH_TEMP_ROOT || '';
  if (!['baseline', 'native'].includes(mode)) throw new Error('invalid benchmark mode');
  if (!tempRootValue) throw new Error('missing benchmark temp root');
  const tempRoot = resolve(tempRootValue);
  if (!projectRoot || !workDir || !databasePath
    || !safePathWithin(tempRoot, workDir)
    || !basename(workDir).startsWith('larp-native-bench-')
    || !safePathWithin(workDir, databasePath)
    || ![1_000, 50_000].includes(scale)
    || backend.protocol !== 'http:'
    || backend.hostname !== '127.0.0.1'
    || backend.username || backend.password || backend.pathname !== '/fixture'
    || backend.search || backend.hash) {
    throw new Error('invalid benchmark configuration');
  }
  return { projectRoot, workDir, databasePath, scale, mode, backend };
}

function getLoopbackFixture(url) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.get(url, { timeout: 3_000 }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2_048) request.destroy(new Error('fixture response too large'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        if (response.statusCode !== 200) return rejectPromise(new Error('fixture backend rejected request'));
        try {
          resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          rejectPromise(new Error('invalid fixture response'));
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('fixture backend timeout')));
    request.on('error', rejectPromise);
  });
}

function createSyntheticIdentity(participantId) {
  const seed = createHash('sha256').update(`larp-native-benchmark-v1:${participantId}`).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([PRIVATE_KEY_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  return {
    publicKey,
    signer: {
      participantId,
      sign: async (bytes) => ({
        algorithm: 'Ed25519',
        signature: signBytes(null, Buffer.from(bytes), privateKey).toString('base64'),
      }),
    },
  };
}

const verifier = {
  verify: async (_participantId, bytes, signature, publicKey) => {
    if (!publicKey) return false;
    try {
      return verifyBytes(
        null,
        Buffer.from(bytes),
        createPublicKey(publicKey),
        Buffer.from(signature.signature, 'base64'),
      );
    } catch {
      return false;
    }
  },
};
async function runNativeBenchmark(config) {
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const cpuStart = process.cpuUsage();
  const projectRequire = createRequire(join(config.projectRoot, 'package.json'));
  projectRequire('tsx/cjs');
  const { createNativeCore } = projectRequire(join(config.projectRoot, 'src/main/native-core.ts'));
  const nativeCoreOpenStart = performance.now();
  const client = await createNativeCore(
    join(config.workDir, 'native-user-data'),
    null,
    async () => JSON.stringify({ version: 1, ok: false, error: { code: 'benchmark-disabled', message: 'Network and host integrations are disabled.' } }),
    () => {},
  );
  const nativeCoreOpenMs = performance.now() - nativeCoreOpenStart;
  const operationLatencies = {};
  try {
    for (const [name, request, expected] of [
      ['recentMessages', { version: 1, op: 'getRecentMessages', payload: { groupId: GROUP_ID, perAuthorLimit: 100 } }, []],
      ['gapScan', { version: 1, op: 'getHighestContiguousSequence', payload: { groupId: GROUP_ID, authorId: PEER_IDS[0] } }, 0],
      ['historyRead', { version: 1, op: 'readMissingEnvelopes', payload: { groupId: GROUP_ID, authorId: PEER_IDS[0], afterSequence: 0, throughSequence: 100, limit: 100 } }, []],
    ]) {
      const start = performance.now();
      const response = await client.request(request);
      operationLatencies[name] = performance.now() - start;
      const emptyArray = Array.isArray(expected) && Array.isArray(response) && response.length === 0;
      if (!emptyArray && response !== expected) throw new Error('native empty-store response mismatch');
    }
  } finally {
    await client.close();
  }
  eventLoop.disable();
  const cpu = process.cpuUsage(cpuStart);
  return {
    version: 2, mode: 'native',
    runtime: { electron: process.versions.electron, node: process.versions.node },
    scale: config.scale, authorCount: PEER_IDS.length, nativeCoreOpenMs, operationLatencies,
    process: {
      rssBytes: process.memoryUsage().rss,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
      eventLoopMeanMs: Number((eventLoop.mean / 1e6).toFixed(3)),
      eventLoopP95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(3)),
    },
    persistedMessages: null, historyCount: null, gapSequence: null, ackAndGapRequestObserved: null,
    metricsAvailability: {
      wal: 'unavailable: no benchmark workload can be persisted into native storage through supported operations',
    },
    comparability: {
      status: 'not-comparable',
      blocker: 'The public native API has no operation to seed cached cloud-member public keys. persistVerifiedEnvelope requires those cached keys; persistOutgoingEnvelope requires an authenticated cloud session and local identity. Reaching either prerequisite would require live cloud access or unsupported direct storage mutation. Native samples therefore contain native-core-open and empty-store API timings only, not baseline-workload measurements.',
    },
    backend: 'none',
  };
}


async function runBenchmark(config = readConfiguration()) {
  if (config.mode === 'native') return runNativeBenchmark(config);
  const cpuStart = process.cpuUsage();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  const projectRequire = createRequire(join(config.projectRoot, 'package.json'));
  projectRequire('tsx/cjs');
  const { createPeerMessageStore } = projectRequire(join(config.projectRoot, 'tools/legacy-peer-message-store.ts'));
  const { MessageSynchronizer } = projectRequire(join(config.projectRoot, 'src/renderer/rtc/message-sync.ts'));
  const { signProtocolEnvelope, WEBRTC_PROTOCOL_VERSION } = projectRequire(join(config.projectRoot, 'src/shared/webrtc-protocol.ts'));
  const NativeDatabase = projectRequire('better-sqlite3');
  const fixture = await getLoopbackFixture(config.backend);
  if (!fixture || fixture.version !== 1 || fixture.groupId !== GROUP_ID
    || fixture.localId !== LOCAL_ID || JSON.stringify(fixture.peerIds) !== JSON.stringify(PEER_IDS)) {
    throw new Error('unexpected loopback fixture');
  }

  const identities = new Map([[LOCAL_ID, createSyntheticIdentity(LOCAL_ID)]]);
  for (const peerId of PEER_IDS) identities.set(peerId, createSyntheticIdentity(peerId));
  const sqliteOpenStart = performance.now();
  const database = new NativeDatabase(config.databasePath);
  database.exec(`
    CREATE TABLE peer_messages (
      message_id TEXT PRIMARY KEY NOT NULL,
      group_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      envelope_json TEXT NOT NULL,
      UNIQUE (group_id, author_id, sequence)
    );
    CREATE TABLE peer_message_acks (
      group_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      author_id TEXT NOT NULL,
      recipient_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      PRIMARY KEY (group_id, message_id, sequence, recipient_id)
    );
    PRAGMA user_version = 5;
  `);
  const sqliteOpenMs = performance.now() - sqliteOpenStart;
  let closed = false;
  try {
    const store = createPeerMessageStore(database, LOCAL_ID);
    const baseSequenceCount = Math.floor(config.scale / PEER_IDS.length);
    const remainder = config.scale % PEER_IDS.length;
    const perAuthorSequenceCounts = new Map(PEER_IDS.map((peerId, index) => [
      peerId,
      baseSequenceCount + (index < remainder ? 1 : 0),
    ]));
    const minimumSequenceCount = Math.min(...perAuthorSequenceCounts.values());
    const gapSequence = Math.floor(minimumSequenceCount * 0.75) + 1;
    const firstAuthorSequenceCount = perAuthorSequenceCounts.get(PEER_IDS[0]);
    if (firstAuthorSequenceCount === undefined) throw new Error('benchmark author fixture is invalid');
    const fixtureStart = performance.now();
    let persistedMessages = 0;
    for (const peerId of PEER_IDS) {
      const signer = identities.get(peerId).signer;
      for (let sequence = 1; sequence <= perAuthorSequenceCounts.get(peerId); sequence += 1) {
        if (sequence === gapSequence) continue;
        const message = await signProtocolEnvelope({
          version: WEBRTC_PROTOCOL_VERSION,
          kind: 'chat',
          groupId: GROUP_ID,
          senderId: peerId,
          messageId: `${peerId}-${String(sequence).padStart(5, '0')}`,
          sequence,
          content: 'synthetic benchmark message',
          createdAt: FIXED_CREATED_AT,
        }, signer);
        const disposition = await store.persistVerifiedIncoming(message);
        if (disposition !== 'inserted') throw new Error('fixture message insertion failed');
        persistedMessages += 1;
      }
    }
    if (persistedMessages !== config.scale - PEER_IDS.length) throw new Error('synthetic message count mismatch');
    const fixtureGenerationMs = performance.now() - fixtureStart;
    const checkDatabase = new NativeDatabase(config.databasePath, { readonly: true, fileMustExist: true });
    try {
      const userVersion = checkDatabase.pragma('user_version', { simple: true });
      const actualCount = checkDatabase.prepare('SELECT count(*) FROM peer_messages').pluck().get();
      if (userVersion !== 5 || actualCount !== persistedMessages) throw new Error('synthetic SQLite fixture mismatch');
    } finally {
      checkDatabase.close();
    }

    const gapScanStart = performance.now();
    let contiguousSequenceSum = 0;
    for (const peerId of PEER_IDS) {
      const contiguous = await store.getHighestContiguousSequence(GROUP_ID, peerId);
      if (contiguous !== gapSequence - 1) throw new Error('synthetic sequence gap mismatch');
      contiguousSequenceSum += contiguous;
    }
    const gapScanMs = performance.now() - gapScanStart;

    const historyStart = performance.now();
    const history = [];
    for (const peerId of PEER_IDS) {
      history.push(...await store.readMissing(GROUP_ID, peerId, 0, Number.MAX_SAFE_INTEGER, 100));
    }
    const historyReadMs = performance.now() - historyStart;
    if (history.length !== PEER_IDS.length * Math.min(100, gapSequence - 1)) {
      throw new Error('cached history prefix mismatch');
    }

    const outboundKinds = [];
    const synchronizer = new MessageSynchronizer({
      groupId: GROUP_ID,
      localParticipantId: LOCAL_ID,
      signer: identities.get(LOCAL_ID).signer,
      verifier,
      store,
      isGroupMember: async (groupId, participantId) => groupId === GROUP_ID && identities.has(participantId),
      getGroupMemberIds: async (groupId) => groupId === GROUP_ID ? [...identities.keys()] : [],
      getMemberPublicKey: async (groupId, participantId) => groupId === GROUP_ID
        ? identities.get(participantId)?.publicKey
        : undefined,
      getPeerIds: () => [PEER_IDS[0]],
      sendToPeer: async (_peerId, envelope) => { outboundKinds.push(envelope.kind); },
    });
    const messageSigningStart = performance.now();
    const nextMessage = await signProtocolEnvelope({
      version: WEBRTC_PROTOCOL_VERSION,
      kind: 'chat',
      groupId: GROUP_ID,
      senderId: PEER_IDS[0],
      messageId: `${PEER_IDS[0]}-${String(firstAuthorSequenceCount + 1).padStart(5, '0')}`,
      sequence: firstAuthorSequenceCount + 1,
      content: 'synthetic benchmark message',
      createdAt: FIXED_CREATED_AT,
    }, identities.get(PEER_IDS[0]).signer);
    const messageSigningMs = performance.now() - messageSigningStart;
    const incomingStart = performance.now();
    await synchronizer.receive(PEER_IDS[0], JSON.stringify(nextMessage));
    const incomingReceiveMs = performance.now() - incomingStart;
    if (!outboundKinds.includes('ack') || !outboundKinds.includes('sync-request')) {
      throw new Error('known gap did not produce ACK and sync request');
    }

    eventLoop.disable();
    const cpu = process.cpuUsage(cpuStart);
    const result = {
      version: 2,
      mode: 'baseline',
      runtime: { electron: process.versions.electron, node: process.versions.node },
      sqliteOpenMs: Number(sqliteOpenMs.toFixed(3)),
      scale: config.scale,
      persistedMessages,
      authorCount: PEER_IDS.length,
      gapSequence,
      contiguousSequenceSum,
      historyCount: history.length,
      fixtureGenerationMs: Number(fixtureGenerationMs.toFixed(3)),
      gapScanMs: Number(gapScanMs.toFixed(3)),
      historyReadMs: Number(historyReadMs.toFixed(3)),
      messageSigningMs: Number(messageSigningMs.toFixed(3)),
      signedReceiveMs: Number(incomingReceiveMs.toFixed(3)),
      ackAndGapRequestObserved: true,
      process: {
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
        rssBytes: process.memoryUsage().rss,
        eventLoopMeanMs: Number((eventLoop.mean / 1e6).toFixed(3)),
        eventLoopP95Ms: Number((eventLoop.percentile(95) / 1e6).toFixed(3)),
      },
      metricsAvailability: { wal: 'unavailable: baseline database uses SQLite default journal mode; WAL metrics do not apply' },
      backend: 'loopback',
    };
    database.close();
    closed = true;
    return result;
  } finally {
    if (!closed) database.close();
  }
}

const tempRootValue = process.env.LARP_BENCH_TEMP_ROOT || '';
const tempRoot = resolve(tempRootValue);
const workDir = resolve(process.env.LARP_BENCH_WORKDIR || '');
if (!workDir || !safePathWithin(tempRoot, workDir) || !basename(workDir).startsWith('larp-native-bench-')) {
  process.stderr.write('NATIVE_BENCH_REJECTED\n');
  app.exit(2);
} else {
  const profilePath = join(workDir, 'electron-user-data');
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.setPath('userData', profilePath);
  app.whenReady().then(() => {
    const config = readConfiguration();
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        allowed = details.method === 'GET' && details.url === config.backend.href;
      } catch {}
      callback({ cancel: !allowed });
    });
    return runBenchmark(config);
  }).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => app.exit(0));
  }).catch(() => {
    process.stderr.write('NATIVE_BENCH_FAILED\n');
    app.exit(1);
  });
}
