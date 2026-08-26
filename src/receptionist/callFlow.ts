import {
  isUsableSpeech,
  sayAndGather,
  sayAndHangUp,
  sayAndTransfer,
  type InboundCall,
} from '../integrations/twilioVoice.js';
import { computeOpenSlots, describeSlot, spreadSlots } from './availability.js';
import { MAX_TURNS, decideResponse, mustEscalate } from './agent.js';
import {
  SlotTakenError,
  appendTurns,
  bookAppointment,
  finishCallSession,
  getBusinessById,
  getBusinessByPhone,
  getCallSession,
  getTakenRanges,
  listAvailabilityRules,
  startCallSession,
  takeMessage,
} from './store.js';
import type { BusinessProfile, TimeRange, TranscriptTurn } from './types.js';

/**
 * One inbound call, turn by turn.
 *
 * Twilio calls `/api/twilio/voice` when the phone rings and
 * `/api/twilio/voice/turn` after each thing the caller says. Both land here.
 * Every branch returns TwiML, and every branch that ends the call writes an
 * outcome to `call_sessions` — a call that just stops without a recorded
 * outcome is a call the business can't audit.
 */

const HOURS_AHEAD = 14 * 24;

/** Rings: greet and start listening. */
export async function handleIncomingCall(params: {
  call: InboundCall;
  turnUrl: string;
}): Promise<string> {
  const business = await getBusinessByPhone(params.call.to);

  if (!business) {
    // A number pointed at this server with no profile behind it. Say something
    // human rather than leaking configuration detail down the phone.
    console.error(`[receptionist] no active business profile for ${params.call.to}`);
    return sayAndHangUp(
      "Sorry, this line isn't taking calls right now. Please try again later."
    );
  }

  await startCallSession({
    businessId: business.id,
    callSid: params.call.callSid,
    fromNumber: params.call.from,
    toNumber: params.call.to,
  });

  await appendTurns({
    callSid: params.call.callSid,
    turns: [{ role: 'receptionist', text: business.greeting, at: new Date().toISOString() }],
  });

  return sayAndGather({ say: business.greeting, actionUrl: params.turnUrl });
}

/** The caller said something. Decide and reply. */
export async function handleCallerTurn(params: {
  call: InboundCall;
  turnUrl: string;
  silent?: boolean;
  now?: Date;
}): Promise<string> {
  const now = params.now ?? new Date();
  const session = await getCallSession(params.call.callSid);

  if (!session || !session.business_id) {
    return sayAndHangUp('Sorry, something went wrong on our end. Please call back.');
  }

  const business = await getBusinessById(session.business_id);
  if (!business) {
    return sayAndHangUp('Sorry, something went wrong on our end. Please call back.');
  }

  // Nothing heard: one re-prompt, then hang up rather than looping forever on
  // a call where the caller has already walked away.
  if (params.silent || !isUsableSpeech(params.call)) {
    if (session.turns >= 1) {
      await finishCallSession({ callSid: params.call.callSid, outcome: 'abandoned' });
      return sayAndHangUp("I didn't catch that, so I'll let you go. Please call back any time.");
    }
    return sayAndGather({
      say: "Sorry, I didn't catch that. Could you say that again?",
      actionUrl: params.turnUrl,
    });
  }

  const callerSaid = params.call.speechResult as string;
  const callerTurn: TranscriptTurn = {
    role: 'caller',
    text: callerSaid,
    at: now.toISOString(),
  };

  // Escalation is checked before the model runs. See agent.ts -- this is the
  // code-level gate, not the prompt-level request.
  const escalation = mustEscalate({ callerSaid, business });
  if (escalation.escalate) {
    return endWithEscalation({
      call: params.call,
      business,
      sessionId: session.id,
      callerTurn,
      reason: escalation.reason ?? 'escalation rule',
    });
  }

  if (session.turns >= MAX_TURNS) {
    return endWithEscalation({
      call: params.call,
      business,
      sessionId: session.id,
      callerTurn,
      reason: `turn limit (${MAX_TURNS}) reached without resolution`,
    });
  }

  const offset = timezoneOffsetMinutes(business.timezone);
  const slots = await openSlotsFor(business, now, offset);
  const offered = spreadSlots(slots, 3);

  let decision;
  try {
    decision = await decideResponse({
      business,
      transcript: session.transcript,
      callerSaid,
      offeredSlots: offered,
      timezoneOffsetMinutes: offset,
      now,
    });
  } catch (error) {
    // The model failed mid-call. The caller is on the line; hand them to a
    // person rather than leaving them listening to nothing.
    console.error('[receptionist] decision failed:', error instanceof Error ? error.message : error);
    return endWithEscalation({
      call: params.call,
      business,
      sessionId: session.id,
      callerTurn,
      reason: 'model error during call',
    });
  }

  const turns: TranscriptTurn[] = [
    callerTurn,
    { role: 'receptionist', text: decision.say, at: new Date().toISOString() },
  ];

  if (decision.intent === 'escalate') {
    await appendTurns({ callSid: params.call.callSid, turns });
    return endWithEscalation({
      call: params.call,
      business,
      sessionId: session.id,
      callerTurn: null,
      reason: 'agent chose to escalate',
      say: decision.say,
    });
  }

  if (decision.intent === 'message' && decision.message) {
    await appendTurns({ callSid: params.call.callSid, turns });
    await takeMessage({
      businessId: business.id,
      callSessionId: session.id,
      callerPhone: params.call.from,
      callerName: decision.callerName,
      message: decision.message,
      urgency: decision.urgency,
    });
    await finishCallSession({ callSid: params.call.callSid, outcome: 'message_taken' });
    return sayAndHangUp(decision.say);
  }

  if (decision.intent === 'book' && decision.chosenSlotIndex !== null) {
    const slot = offered[decision.chosenSlotIndex];
    try {
      const appointment = await bookAppointment({
        businessId: business.id,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
        callerPhone: params.call.from,
        callerName: decision.callerName,
        purpose: decision.purpose,
      });

      const confirmation = `${decision.say} You're booked for ${describeSlot(slot, offset, now)}. Goodbye.`;
      await appendTurns({
        callSid: params.call.callSid,
        turns: [
          callerTurn,
          { role: 'receptionist', text: confirmation, at: new Date().toISOString() },
        ],
      });
      await finishCallSession({
        callSid: params.call.callSid,
        outcome: 'booked',
        appointmentId: appointment.id,
      });
      return sayAndHangUp(confirmation);
    } catch (error) {
      if (error instanceof SlotTakenError) {
        // Someone else took it between offering and booking. Recover in the
        // conversation instead of failing the call.
        const remaining = spreadSlots(
          (await openSlotsFor(business, now, offset)).filter(
            (candidate) => candidate.startsAt.getTime() !== slot.startsAt.getTime()
          ),
          2
        );
        const say =
          remaining.length > 0
            ? `Sorry — that time was just taken. I can do ${remaining
                .map((candidate) => describeSlot(candidate, offset, now))
                .join(' or ')}. Would either work?`
            : "Sorry — that time was just taken, and I don't have another opening right now. Can I take a message?";
        await appendTurns({
          callSid: params.call.callSid,
          turns: [callerTurn, { role: 'receptionist', text: say, at: new Date().toISOString() }],
        });
        return sayAndGather({ say, actionUrl: params.turnUrl });
      }
      throw error;
    }
  }

  await appendTurns({ callSid: params.call.callSid, turns });

  if (decision.endCall || decision.intent === 'goodbye') {
    await finishCallSession({ callSid: params.call.callSid, outcome: 'answered' });
    return sayAndHangUp(decision.say);
  }

  return sayAndGather({ say: decision.say, actionUrl: params.turnUrl });
}

async function endWithEscalation(params: {
  call: InboundCall;
  business: BusinessProfile;
  sessionId: string;
  callerTurn: TranscriptTurn | null;
  reason: string;
  say?: string;
}): Promise<string> {
  const transferring = Boolean(params.business.transfer_number);
  const say =
    params.say ??
    (transferring
      ? "Let me get someone who can help with that. One moment."
      : "That's something I should have a person handle. I'll take your details and someone will call you back.");

  if (params.callerTurn) {
    await appendTurns({
      callSid: params.call.callSid,
      turns: [params.callerTurn, { role: 'receptionist', text: say, at: new Date().toISOString() }],
    });
  }

  await finishCallSession({
    callSid: params.call.callSid,
    outcome: 'escalated',
    escalationReason: params.reason,
  });

  if (!transferring) {
    // No transfer number configured: record it so the business has a callback
    // list rather than an escalation that went nowhere.
    await takeMessage({
      businessId: params.business.id,
      callSessionId: params.sessionId,
      callerPhone: params.call.from,
      callerName: null,
      message: `Escalated call needing a human. Reason: ${params.reason}. Caller said: ${
        params.callerTurn?.text ?? '(see transcript)'
      }`,
      urgency: 'urgent',
    });
    return sayAndHangUp(say);
  }

  return sayAndTransfer({ say, transferNumber: params.business.transfer_number as string });
}

async function openSlotsFor(
  business: BusinessProfile,
  now: Date,
  offsetMinutes: number
): Promise<TimeRange[]> {
  const from = now;
  const to = new Date(now.getTime() + HOURS_AHEAD * 60 * 60 * 1000);
  const [rules, taken] = await Promise.all([
    listAvailabilityRules(business.id),
    getTakenRanges({ businessId: business.id, from, to }),
  ]);

  return computeOpenSlots({
    rules,
    taken,
    from,
    to,
    slotMinutes: business.appointment_minutes,
    timezoneOffsetMinutes: offsetMinutes,
    limit: 40,
  });
}

/**
 * Offset from UTC for an IANA zone, in minutes, at the current instant.
 *
 * Derived from Intl rather than hardcoded, so it follows daylight saving
 * without a table to maintain. A receptionist that books an hour off for six
 * months of the year is worse than no receptionist.
 */
export function timezoneOffsetMinutes(timeZone: string, at = new Date()): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts = Object.fromEntries(
      formatter.formatToParts(at).filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    ) as Record<string, string>;

    const asUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second)
    );
    return Math.round((asUtc - at.getTime()) / 60000);
  } catch {
    console.warn(`[receptionist] unknown timezone "${timeZone}", treating as UTC`);
    return 0;
  }
}
