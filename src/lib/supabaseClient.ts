import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let serviceClient: SupabaseClient | null = null;
let anonClient: SupabaseClient | null = null;

/**
 * Server-side client using the service_role key. Bypasses RLS, so this is
 * what the memory read/write functions use. Never import this into
 * browser-facing code.
 */
export function getServiceClient(): SupabaseClient {
  if (serviceClient) return serviceClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to use the service client.'
    );
  }

  serviceClient = createClient(url, key, { auth: { persistSession: false } });
  return serviceClient;
}

/**
 * Browser-safe client using the anon key. short_term_memory and
 * long_term_memory have no policies for this role, so it cannot read or
 * write memory -- it's here for whatever client-facing Supabase use
 * later phases (scene state, auth, etc.) end up needing.
 */
export function getAnonClient(): SupabaseClient {
  if (anonClient) return anonClient;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_ANON_KEY must be set to use the anon client.');
  }

  anonClient = createClient(url, key, { auth: { persistSession: false } });
  return anonClient;
}
