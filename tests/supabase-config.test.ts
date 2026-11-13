import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSupabaseClientConfiguration } from '../src/main/supabase-config';

async function withConfigEnvironment<T>(action: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.LARP_SUPABASE_URL;
  const previousKey = process.env.LARP_SUPABASE_ANON_KEY;
  delete process.env.LARP_SUPABASE_URL;
  delete process.env.LARP_SUPABASE_ANON_KEY;
  try { return await action(); } finally {
    if (previousUrl === undefined) delete process.env.LARP_SUPABASE_URL;
    else process.env.LARP_SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.LARP_SUPABASE_ANON_KEY;
    else process.env.LARP_SUPABASE_ANON_KEY = previousKey;
  }
}

test('configuration accepts HTTPS and localhost HTTP, with environment overrides', async () => {
  await withConfigEnvironment(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'larp-supabase-config-'));
    try {
      const path = join(directory, 'config.json');
      await writeFile(path, JSON.stringify({ supabaseUrl: 'https://project.example', supabaseAnonKey: 'local-public-key' }));
      assert.deepEqual(await loadSupabaseClientConfiguration(path), {
        status: 'configured', url: 'https://project.example', anonKey: 'local-public-key',
      });
      process.env.LARP_SUPABASE_URL = 'http://localhost:54321';
      process.env.LARP_SUPABASE_ANON_KEY = 'environment-public-key';
      assert.deepEqual(await loadSupabaseClientConfiguration(path), {
        status: 'configured', url: 'http://localhost:54321', anonKey: 'environment-public-key',
      });
      process.env.LARP_SUPABASE_URL = 'http://127.0.0.1:54321';
      assert.deepEqual(await loadSupabaseClientConfiguration(path), {
        status: 'configured', url: 'http://127.0.0.1:54321', anonKey: 'environment-public-key',
      });
      process.env.LARP_SUPABASE_URL = 'http://[::1]:54321';
      assert.deepEqual(await loadSupabaseClientConfiguration(path), {
        status: 'configured', url: 'http://[::1]:54321', anonKey: 'environment-public-key',
      });
      process.env.LARP_SUPABASE_URL = 'http://remote.example';
      await assert.rejects(loadSupabaseClientConfiguration(path), /must use HTTPS/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('configuration rejects administrative keys and credential-bearing URLs', async () => {
  await withConfigEnvironment(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'larp-supabase-config-'));
    try {
      const path = join(directory, 'config.json');
      const payload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
      await writeFile(path, JSON.stringify({ supabaseUrl: 'https://project.example', supabaseAnonKey: `a.${payload}.c` }));
      await assert.rejects(loadSupabaseClientConfiguration(path), /service-role credentials are not allowed/u);
      await writeFile(path, JSON.stringify({ supabaseUrl: 'https://user:password@project.example', supabaseAnonKey: 'public' }));
      await assert.rejects(loadSupabaseClientConfiguration(path), /must use HTTPS and must not contain credentials/u);
      await writeFile(path, JSON.stringify({ supabaseUrl: 'http://project.example', supabaseAnonKey: 'public' }));
      await assert.rejects(loadSupabaseClientConfiguration(path), /must use HTTPS/u);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('missing local config remains explicitly not configured', async () => {
  await withConfigEnvironment(async () => {
    const directory = await mkdtemp(join(tmpdir(), 'larp-supabase-config-missing-'));
    try {
      const result = await loadSupabaseClientConfiguration(join(directory, 'missing.json'));
      assert.deepEqual(result, { status: 'not-configured', missing: ['url', 'anonKey'] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
