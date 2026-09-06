export interface BusinessProfile {
  id: string;
  created_at: string;
  updated_at: string;
  slug: string;
  name: string;
  industry: string | null;
  phone_number: string | null;
  timezone: string;
  voice: string;
  never_say: string;
  greeting: string;
  escalate_to_human: string[];
  transfer_number: string | null;
  appointment_minutes: number;
  status: 'active' | 'paused';
  config: Record<string, unknown>;
}

export interface AvailabilityRule {
  id: string;
  business_id: string;
  /** 0 = Sunday, matching JS Date#getDay(). */
  weekday: number;
  start_minute: number;
  end_minute: number;
}

export interface TimeRange {
  startsAt: Date;
  endsAt: Date;
}

export type AppointmentStatus = 'booked' | 'confirmed' | 'cancelled' | 'completed' | 'no_show';

export interface Appointment {
  id: string;
  created_at: string;
  business_id: string;
  lead_id: string | null;
  caller_phone: string | null;
  caller_name: string | null;
  purpose: string | null;
  starts_at: string;
  ends_at: string;
  status: AppointmentStatus;
  booked_by: string;
  notes: string | null;
}

export type CallOutcome =
  | 'in_progress'
  | 'booked'
  | 'message_taken'
  | 'escalated'
  | 'answered'
  | 'abandoned';

export interface TranscriptTurn {
  role: 'caller' | 'receptionist';
  text: string;
  at: string;
}

export interface CallSession {
  id: string;
  created_at: string;
  ended_at: string | null;
  business_id: string | null;
  call_sid: string | null;
  from_number: string | null;
  to_number: string | null;
  transcript: TranscriptTurn[];
  outcome: CallOutcome;
  appointment_id: string | null;
  escalation_reason: string | null;
  turns: number;
}

export interface TakenMessage {
  id: string;
  created_at: string;
  business_id: string;
  call_session_id: string | null;
  caller_phone: string | null;
  caller_name: string | null;
  message: string;
  urgency: 'normal' | 'urgent';
  handled: boolean;
}

/** What the receptionist decided to do with one caller turn. */
export interface ReceptionistDecision {
  /** What to say back, spoken aloud. */
  say: string;
  intent: 'book' | 'reschedule' | 'cancel' | 'question' | 'message' | 'escalate' | 'goodbye';
  /** Slot the caller picked, as an index into the offered slots. Null if none. */
  chosenSlotIndex: number | null;
  callerName: string | null;
  purpose: string | null;
  /** Set when intent is 'message' -- what to write down for the human. */
  message: string | null;
  urgency: 'normal' | 'urgent';
  /** True when the receptionist believes the call is finished. */
  endCall: boolean;
}
