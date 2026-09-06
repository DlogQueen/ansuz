/**
 * Read-only API behind the owner's console app.
 *
 * This is the most sensitive surface in the receptionist: it returns call
 * transcripts, callers' phone numbers, and what they said. Everything here is
 * therefore read-only and behind a shared token, and the token is required
 * rather than optional — an unset RECEPTIONIST_CONSOLE_TOKEN disables the API
 * instead of opening it, because the failure mode of getting that backwards is
 * publishing customers' phone calls.
 *
 * It is deliberately not a general query API. Each endpoint answers one
 * question the owner actually asks: what happened today, who is booked, who is
 * waiting on a call back.
 */
import { timingSafeEqual } from 'node:crypto';
import {
  getBusinessBySlug,
  getReceptionistPerformance,
  listBusinesses,
  listUnhandledMessages,
  listUpcomingAppointments,
} from './store.js';
import { getServiceClient } from '../lib/supabaseClient.js';
import type { CallSession } from './types.js';

export interface ConsoleResult {
  status: number;
  body: unknown;
}

/**
 * The console app is packaged, so it calls this API from its own origin rather
 * than the server's. Capacitor serves the bundle from https://localhost on
 * Android and capacitor://localhost on iOS; a browser tab during development
 * is http://localhost:<port>.
 *
 * Echoing only these origins rather than "*" matters here: a wildcard on an
 * endpoint that returns call transcripts would let any page the owner happens
 * to visit read them, since the browser would attach nothing but the request
 * would still be cross-origin readable if the token ever leaked into one.
 */
export function consoleAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  if (origin === 'https://localhost' || origin === 'capacitor://localhost') return origin;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return origin;
  return null;
}

const unauthorized: ConsoleResult = { status: 401, body: { error: 'unauthorized' } };

/**
 * Constant-time bearer check. Returns false when no token is configured, so a
 * deploy that forgets the variable serves nothing rather than everything.
 */
export function isConsoleAuthorized(header: string | undefined): boolean {
  const expected = process.env.RECEPTIONIST_CONSOLE_TOKEN;
  if (!expected) {
    console.error(
      '[console] RECEPTIONIST_CONSOLE_TOKEN is not set — the console API is disabled. ' +
        'Set it to a long random string and put the same value in the app.'
    );
    return false;
  }
  if (!header?.startsWith('Bearer ')) return false;

  const provided = Buffer.from(header.slice('Bearer '.length), 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (provided.length !== want.length) return false;
  return timingSafeEqual(provided, want);
}

/** Recent calls, newest first. Transcript included — that is the point of it. */
async function listRecentCalls(businessId: string, limit: number): Promise<CallSession[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('call_sessions')
    .select('*')
    .eq('business_id', businessId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data as CallSession[];
}

/**
 * Routes `/api/console/*`. Returns null when the path is not ours, so the
 * server can fall through to its other handlers.
 */
export async function handleConsoleRequest(params: {
  method: string;
  url: string;
  authorization: string | undefined;
}): Promise<ConsoleResult | null> {
  const url = new URL(params.url, 'http://console.local');
  if (!url.pathname.startsWith('/api/console/')) return null;
  if (params.method !== 'GET') return { status: 405, body: { error: 'method not allowed' } };
  if (!isConsoleAuthorized(params.authorization)) return unauthorized;

  const route = url.pathname.slice('/api/console/'.length);

  // Lets the app confirm the token and URL are right before it shows anything,
  // so a misconfigured app says so instead of looking merely empty.
  if (route === 'ping') {
    const businesses = await listBusinesses();
    return {
      status: 200,
      body: {
        ok: true,
        businesses: businesses.map((b) => ({ slug: b.slug, name: b.name, status: b.status })),
      },
    };
  }

  const slug = url.searchParams.get('business');
  if (!slug) return { status: 400, body: { error: 'business query parameter is required' } };

  const business = await getBusinessBySlug(slug);
  if (!business) return { status: 404, body: { error: `no business with slug "${slug}"` } };

  if (route === 'summary') {
    const [performance, appointments, messages] = await Promise.all([
      getReceptionistPerformance(business.id),
      listUpcomingAppointments({ businessId: business.id, limit: 5 }),
      listUnhandledMessages(business.id),
    ]);
    return {
      status: 200,
      body: {
        business: {
          slug: business.slug,
          name: business.name,
          status: business.status,
          timezone: business.timezone,
          phone_number: business.phone_number,
        },
        performance,
        next_appointments: appointments,
        unhandled_messages: messages.length,
      },
    };
  }

  if (route === 'appointments') {
    return {
      status: 200,
      body: { appointments: await listUpcomingAppointments({ businessId: business.id, limit: 50 }) },
    };
  }

  if (route === 'messages') {
    return { status: 200, body: { messages: await listUnhandledMessages(business.id) } };
  }

  if (route === 'calls') {
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
    return { status: 200, body: { calls: await listRecentCalls(business.id, limit) } };
  }

  return { status: 404, body: { error: 'unknown console route' } };
}
