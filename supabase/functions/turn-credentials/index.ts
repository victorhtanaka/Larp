import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: corsHeaders });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse(405, { error: 'method_not_allowed' });

  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return jsonResponse(401, { error: 'authentication_required' });

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const configuredUrls = Deno.env.get('EXPRESSTURN_URLS');
  const username = Deno.env.get('EXPRESSTURN_USERNAME');
  const credential = Deno.env.get('EXPRESSTURN_CREDENTIAL');
  if (!supabaseUrl || !anonKey || !configuredUrls || !username || !credential) {
    return jsonResponse(503, { error: 'turn_not_configured' });
  }

  const urls = configuredUrls.split(',').map((url) => url.trim()).filter(Boolean);
  if (urls.length < 1 || urls.length > 4 || urls.some((url) => !/^turns?:/u.test(url) || url.length > 256)
    || username.length > 256 || credential.length > 1024) {
    return jsonResponse(503, { error: 'turn_configuration_invalid' });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, { error: 'invalid_request' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || !('groupId' in body) || typeof body.groupId !== 'string' || !uuidPattern.test(body.groupId)) {
    return jsonResponse(400, { error: 'invalid_group' });
  }

  try {
    const client = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
      global: { headers: { Authorization: authorization } },
    });
    const { data: userResult, error: authError } = await client.auth.getUser();
    if (authError || !userResult.user) return jsonResponse(401, { error: 'authentication_required' });
    const { data: membership, error: membershipError } = await client
      .from('larp_group_members')
      .select('group_id')
      .eq('group_id', body.groupId)
      .eq('user_id', userResult.user.id)
      .maybeSingle();
    if (membershipError) return jsonResponse(503, { error: 'membership_check_unavailable' });
    if (!membership) return jsonResponse(403, { error: 'group_membership_required' });

    return jsonResponse(200, {
      servers: [{ urls, username, credential }],
    });
  } catch {
    return jsonResponse(503, { error: 'turn_credentials_unavailable' });
  }
});
