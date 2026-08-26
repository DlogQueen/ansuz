import { getServiceClient } from '../lib/supabaseClient.js';
import type {
  Appointment,
  AvailabilityRule,
  BusinessProfile,
  CallOutcome,
  CallSession,
  TakenMessage,
  TimeRange,
  TranscriptTurn,
} from './types.js';

/** Database access for the receptionist. Service-role only, same as the crew. */

// --- business profiles ----------------------------------------------------

export async function getBusinessByPhone(phoneNumber: string): Promise<BusinessProfile | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('business_profiles')
    .select('*')
    .eq('phone_number', phoneNumber)
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  return (data as BusinessProfile) ?? null;
}

export async function getBusinessById(id: string): Promise<BusinessProfile | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('business_profiles')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as BusinessProfile) ?? null;
}

export async function getBusinessBySlug(slug: string): Promise<BusinessProfile | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('business_profiles')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return (data as BusinessProfile) ?? null;
}

export async function upsertBusiness(params: {
  slug: string;
  name: string;
  industry?: string;
  phoneNumber?: string;
  timezone?: string;
  voice?: string;
  neverSay?: string;
  greeting?: string;
  transferNumber?: string;
  appointmentMinutes?: number;
}): Promise<BusinessProfile> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('business_profiles')
    .upsert(
      {
        slug: params.slug,
        name: params.name,
        industry: params.industry ?? null,
        phone_number: params.phoneNumber ?? null,
        timezone: params.timezone ?? 'America/New_York',
        ...(params.voice ? { voice: params.voice } : {}),
        ...(params.neverSay ? { never_say: params.neverSay } : {}),
        ...(params.greeting ? { greeting: params.greeting } : {}),
        transfer_number: params.transferNumber ?? null,
        ...(params.appointmentMinutes ? { appointment_minutes: params.appointmentMinutes } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slug' }
    )
    .select()
    .single();
  if (error) throw error;
  return data as BusinessProfile;
}

export async function listBusinesses(): Promise<BusinessProfile[]> {
  const client = getServiceClient();
  const { data, error } = await client.from('business_profiles').select('*').order('name');
  if (error) throw error;
  return data as BusinessProfile[];
}

// --- availability ---------------------------------------------------------

export async function listAvailabilityRules(businessId: string): Promise<AvailabilityRule[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('availability_rules')
    .select('*')
    .eq('business_id', businessId);
  if (error) throw error;
  return data as AvailabilityRule[];
}

export async function setWeeklyHours(params: {
  businessId: string;
  weekdays: number[];
  startMinute: number;
  endMinute: number;
  replace?: boolean;
}): Promise<void> {
  const client = getServiceClient();
  if (params.replace) {
    const { error } = await client
      .from('availability_rules')
      .delete()
      .eq('business_id', params.businessId);
    if (error) throw error;
  }
  const rows = params.weekdays.map((weekday) => ({
    business_id: params.businessId,
    weekday,
    start_minute: params.startMinute,
    end_minute: params.endMinute,
  }));
  const { error } = await client.from('availability_rules').insert(rows);
  if (error) throw error;
}

/** Booked appointments + one-off closures in a window, via booked_ranges(). */
export async function getTakenRanges(params: {
  businessId: string;
  from: Date;
  to: Date;
}): Promise<TimeRange[]> {
  const client = getServiceClient();
  const { data, error } = await client.rpc('booked_ranges', {
    p_business_id: params.businessId,
    p_from: params.from.toISOString(),
    p_to: params.to.toISOString(),
  });
  if (error) throw error;
  return (data as Array<{ starts_at: string; ends_at: string }>).map((row) => ({
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
  }));
}

// --- appointments ---------------------------------------------------------

export class SlotTakenError extends Error {
  constructor() {
    super('That time was just taken.');
    this.name = 'SlotTakenError';
  }
}

/**
 * Book an appointment.
 *
 * The overlap check lives in the database (an exclusion constraint, see
 * 0003_receptionist.sql), so a race between two simultaneous callers is
 * resolved by Postgres rather than by whoever read the calendar last.
 * Violation code 23P01 is `exclusion_violation` -- translated here into a
 * typed error the call flow can recover from by offering another slot.
 */
export async function bookAppointment(params: {
  businessId: string;
  startsAt: Date;
  endsAt: Date;
  callerPhone?: string | null;
  callerName?: string | null;
  purpose?: string | null;
  leadId?: string | null;
  notes?: string | null;
}): Promise<Appointment> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('appointments')
    .insert({
      business_id: params.businessId,
      starts_at: params.startsAt.toISOString(),
      ends_at: params.endsAt.toISOString(),
      caller_phone: params.callerPhone ?? null,
      caller_name: params.callerName ?? null,
      purpose: params.purpose ?? null,
      lead_id: params.leadId ?? null,
      notes: params.notes ?? null,
    })
    .select()
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23P01') throw new SlotTakenError();
    throw error;
  }
  return data as Appointment;
}

export async function cancelAppointment(appointmentId: string): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', appointmentId);
  if (error) throw error;
}

export async function listUpcomingAppointments(params: {
  businessId: string;
  limit?: number;
}): Promise<Appointment[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('appointments')
    .select('*')
    .eq('business_id', params.businessId)
    .neq('status', 'cancelled')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at')
    .limit(params.limit ?? 25);
  if (error) throw error;
  return data as Appointment[];
}

export async function findAppointmentByPhone(params: {
  businessId: string;
  callerPhone: string;
}): Promise<Appointment | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('appointments')
    .select('*')
    .eq('business_id', params.businessId)
    .eq('caller_phone', params.callerPhone)
    .eq('status', 'booked')
    .gte('starts_at', new Date().toISOString())
    .order('starts_at')
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Appointment) ?? null;
}

// --- call sessions --------------------------------------------------------

export async function startCallSession(params: {
  businessId: string | null;
  callSid: string;
  fromNumber: string;
  toNumber: string;
}): Promise<CallSession> {
  const client = getServiceClient();
  // Upsert on call_sid: Twilio can retry a webhook, and a retry must continue
  // the same call rather than starting a second one.
  const { data, error } = await client
    .from('call_sessions')
    .upsert(
      {
        business_id: params.businessId,
        call_sid: params.callSid,
        from_number: params.fromNumber,
        to_number: params.toNumber,
      },
      { onConflict: 'call_sid' }
    )
    .select()
    .single();
  if (error) throw error;
  return data as CallSession;
}

export async function getCallSession(callSid: string): Promise<CallSession | null> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('call_sessions')
    .select('*')
    .eq('call_sid', callSid)
    .maybeSingle();
  if (error) throw error;
  return (data as CallSession) ?? null;
}

export async function appendTurns(params: {
  callSid: string;
  turns: TranscriptTurn[];
}): Promise<void> {
  const client = getServiceClient();
  const session = await getCallSession(params.callSid);
  if (!session) return;

  const { error } = await client
    .from('call_sessions')
    .update({
      transcript: [...session.transcript, ...params.turns],
      turns: session.turns + params.turns.filter((turn) => turn.role === 'caller').length,
    })
    .eq('call_sid', params.callSid);
  if (error) throw error;
}

export async function finishCallSession(params: {
  callSid: string;
  outcome: CallOutcome;
  appointmentId?: string | null;
  escalationReason?: string | null;
}): Promise<void> {
  const client = getServiceClient();
  const { error } = await client
    .from('call_sessions')
    .update({
      ended_at: new Date().toISOString(),
      outcome: params.outcome,
      appointment_id: params.appointmentId ?? null,
      escalation_reason: params.escalationReason ?? null,
    })
    .eq('call_sid', params.callSid);
  if (error) throw error;
}

// --- messages -------------------------------------------------------------

export async function takeMessage(params: {
  businessId: string;
  callSessionId: string | null;
  callerPhone: string | null;
  callerName: string | null;
  message: string;
  urgency: 'normal' | 'urgent';
}): Promise<TakenMessage> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('messages_taken')
    .insert({
      business_id: params.businessId,
      call_session_id: params.callSessionId,
      caller_phone: params.callerPhone,
      caller_name: params.callerName,
      message: params.message,
      urgency: params.urgency,
    })
    .select()
    .single();
  if (error) throw error;
  return data as TakenMessage;
}

export async function listUnhandledMessages(businessId: string): Promise<TakenMessage[]> {
  const client = getServiceClient();
  const { data, error } = await client
    .from('messages_taken')
    .select('*')
    .eq('business_id', businessId)
    .eq('handled', false)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as TakenMessage[];
}

export async function getReceptionistPerformance(businessId: string): Promise<{
  calls: number;
  booked: number;
  messages_taken: number;
  escalated: number;
  abandoned: number;
}> {
  const client = getServiceClient();
  const { data, error } = await client.rpc('receptionist_performance', {
    p_business_id: businessId,
  });
  if (error) throw error;
  const rows = data as Array<Record<string, number>>;
  return (rows[0] as never) ?? { calls: 0, booked: 0, messages_taken: 0, escalated: 0, abandoned: 0 };
}
