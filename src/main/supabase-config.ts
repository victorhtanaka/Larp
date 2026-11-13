import { readFile } from 'node:fs/promises';
import type { CloudConfigurationStatus } from '../shared/cloud-contracts';

interface LocalCloudConfig { supabaseUrl?: string; supabaseAnonKey?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectAdministrativeKey(key: string): void {
  if (key.startsWith('sb_secret_')) {
    throw new Error('Supabase service-role credentials are not allowed in the desktop client.');
  }
  const segments = key.split('.');
  if (segments.length !== 3) return;
  try {
    const claims: unknown = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    if (isRecord(claims) && claims.role === 'service_role') {
      throw new Error('Supabase service-role credentials are not allowed in the desktop client.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Supabase service-role')) throw error;
  }
}

export async function loadSupabaseClientConfiguration(localConfigPath?: string): Promise<CloudConfigurationStatus> {
  let local: LocalCloudConfig = {};
  if (localConfigPath) {
    try {
      const parsed: unknown = JSON.parse(await readFile(localConfigPath, 'utf8'));
      if (!isRecord(parsed)
        || (Object.hasOwn(parsed, 'supabaseUrl') && typeof parsed.supabaseUrl !== 'string')
        || (Object.hasOwn(parsed, 'supabaseAnonKey') && typeof parsed.supabaseAnonKey !== 'string')) {
        throw new Error('Invalid local cloud configuration.');
      }
      if (typeof parsed.supabaseUrl === 'string') local.supabaseUrl = parsed.supabaseUrl;
      if (typeof parsed.supabaseAnonKey === 'string') local.supabaseAnonKey = parsed.supabaseAnonKey;
    } catch (error) {
      const missingFile = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      if (!missingFile) throw new Error('Local cloud configuration could not be read.', { cause: error });
    }
  }

  const url = (process.env.LARP_SUPABASE_URL || local.supabaseUrl)?.trim();
  const anonKey = (process.env.LARP_SUPABASE_ANON_KEY || local.supabaseAnonKey)?.trim();
  if (anonKey) rejectAdministrativeKey(anonKey);
  const missing: ('url' | 'anonKey')[] = [];
  if (!url) missing.push('url');
  if (!anonKey) missing.push('anonKey');
  if (missing.length) return { status: 'not-configured', missing };
  if (!url || !anonKey) return { status: 'not-configured', missing: ['url', 'anonKey'] };

  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Supabase URL in local configuration is invalid.'); }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback))
    || parsed.username || parsed.password) {
    throw new Error('Supabase URL must use HTTPS and must not contain credentials.');
  }
  return { status: 'configured', url, anonKey };
}
