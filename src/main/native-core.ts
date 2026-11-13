import { createRequire } from 'node:module';
import { join } from 'node:path';
import type {
  CoreRequest,
  HostCallFunction,
  NativeCloudConfiguration,
  NativeLarpCore,
} from '../shared/native-core-contracts';

const CONTRACT_VERSION = 1;
const MAX_NATIVE_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_NATIVE_RESPONSE_BYTES = 8 * 1024 * 1024;
const requireFromThisModule = createRequire(__filename);

interface NativeAddon {
  openCore(userDataPath: string, cloudConfig: NativeCloudConfiguration | null, hostCall: (error: Error | null, requestJson: string) => Promise<string>, onCoreEvent: (error: Error | null, eventJson: string) => void): Promise<NativeLarpCore>;
}

export class NativeCoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'NativeCoreError';
  }
}
function normalizeNativeError(error: unknown): NativeCoreError {
  if (error instanceof NativeCoreError) return error;
  if (error instanceof Error) {
    const match = /^larp-core:([a-z0-9-]+)(?::\s*(.*))?$/i.exec(error.message);
    if (match) return new NativeCoreError(match[1]!, match[2] || 'The native core operation failed.');
  }
  return new NativeCoreError('native-failure', 'The native core operation failed.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function decodeResponse(raw: unknown): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_NATIVE_RESPONSE_BYTES) {
    throw new NativeCoreError('invalid-response', 'The native core returned an invalid response size.');
  }
  let response: unknown;
  try { response = JSON.parse(raw); } catch {
    throw new NativeCoreError('invalid-response', 'The native core returned malformed JSON.');
  }
  if (!isRecord(response) || response.version !== CONTRACT_VERSION || typeof response.ok !== 'boolean') {
    throw new NativeCoreError('invalid-response', 'The native core response envelope is invalid.');
  }
  if (response.ok) {
    if (!hasExactKeys(response, ['version', 'ok', 'value'])) {
      throw new NativeCoreError('invalid-response', 'The native success response has an invalid shape.');
    }
    return response.value;
  }
  if (!hasExactKeys(response, ['version', 'ok', 'error']) || !isRecord(response.error)
    || !hasExactKeys(response.error, ['code', 'message'])
    || typeof response.error.code !== 'string' || typeof response.error.message !== 'string') {
    throw new NativeCoreError('invalid-response', 'The native error response has an invalid shape.');
  }
  throw new NativeCoreError(response.error.code, response.error.message);
}

function defaultAddonPath(): string {
  if (process.versions.electron) {
    const electron = requireFromThisModule('electron') as { app?: { isPackaged?: boolean } };
    if (electron.app?.isPackaged) {
      const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
      if (!resourcesPath) throw new Error('The packaged native core resource path is unavailable.');
      return join(resourcesPath, 'larp_core.node');
    }
  }
  return join(__dirname, '../../native/larp-core/dist/larp_core.node');
}

export class NativeCoreClient {
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  constructor(private readonly native: NativeLarpCore) {}

  request(request: CoreRequest): Promise<unknown> {
    if (this.closed) return Promise.reject(new NativeCoreError('closed', 'The native core is closed.'));
    let serialized: string;
    try {
      const encoded = JSON.stringify(request);
      if (typeof encoded !== 'string') throw new TypeError('Native request is not serializable.');
      serialized = encoded;
    } catch {
      return Promise.reject(new NativeCoreError('invalid-request', 'The native request could not be serialized.'));
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_NATIVE_REQUEST_BYTES) {
      return Promise.reject(new NativeCoreError('input-too-large', 'The native request exceeds the permitted size.'));
    }

    let operation: Promise<unknown>;
    try {
      operation = this.native.request(serialized).then(decodeResponse).catch((error: unknown) => {
        throw normalizeNativeError(error);
      });
    } catch (error) {
      return Promise.reject(normalizeNativeError(error));
    }
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  ingestCloudEvent(subscriptionId: string, epoch: number, eventJson: string): Promise<void> {
    if (this.closed) return Promise.reject(new NativeCoreError('closed', 'The native core is closed.'));
    let operation: Promise<void>;
    try {
      operation = this.native.ingestCloudEvent(subscriptionId, epoch, eventJson).catch((error: unknown) => {
        throw normalizeNativeError(error);
      });
    } catch (error) {
      return Promise.reject(normalizeNativeError(error));
    }
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  cancelSubscription(subscriptionId: string, epoch: number): Promise<void> {
    return this.ingestCloudEvent(subscriptionId, epoch, '{"kind":"cancel"}');
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await Promise.allSettled([...this.pending]);
      await this.native.close();
    })();
    return this.closePromise;
  }
}

export async function createNativeCore(
  userDataPath: string,
  cloudConfig: NativeCloudConfiguration | null,
  hostCall: HostCallFunction,
  onCoreEvent: (eventJson: string) => void,
  addonPath = defaultAddonPath(),
): Promise<NativeCoreClient> {
  const addon = requireFromThisModule(addonPath) as Partial<NativeAddon>;
  if (typeof addon.openCore !== 'function') throw new Error('The native core addon does not export openCore.');
  const routeHostCall = (error: Error | null, requestJson: string): Promise<string> => {
    if (error !== null) return Promise.reject(error);
    return hostCall(requestJson);
  };
  const routeEvent = (error: Error | null, eventJson: string): void => {
    if (error !== null) {
      console.error('The native core event callback failed.', error);
      return;
    }
    try { onCoreEvent(eventJson); } catch (cause) { console.error('The native core event could not be routed.', cause); }
  };
  const native = await addon.openCore(userDataPath, cloudConfig, routeHostCall, routeEvent);
  return new NativeCoreClient(native);
}
