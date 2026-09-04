import { chatCompletion, type ChatMessage } from '../llm/chat.js';
import { asString, extractJson } from '../crew/agent.js';
import { describeSlot } from './availability.js';
import type {
  BusinessProfile,
  ReceptionistDecision,
  TimeRange,
  TranscriptTurn,
} from './types.js';

/**
 * The receptionist agent.
 *
 * Same shape as the crew's `think()` -- charter, mandate, structured output --
 * but it does not go through it, for one reason: `think()` retrieves long-term
 * memory before every call, and a person waiting on a phone line cannot afford
 * an embedding round trip plus a vector search between their sentence and the
 * reply. Latency is a product requirement here in a way it isn't for a cycle
 * that runs every fifteen minutes.
 *
 * What it keeps: structured JSON output, a charter it can't talk past, and a
 * full transcript written to call_sessions for audit.
 */

export const RECEPTIONIST_CHARTER = `You are an AI receptionist answering a live phone call.

These hold on every call, without exception:
- You are an AI. If the caller asks whether they are talking to a person, say plainly
  that you are an AI assistant. Never imply otherwise.
- Never invent a price, a policy, an availability, or a fact about the business. If you
  weren't given it, say you'll have someone follow up.
- Only offer appointment times from the list you are given. Never suggest a time that
  isn't on it, even if the caller asks for one.
- If the caller sounds distressed, angry, or is describing an emergency, stop trying to
  handle it and escalate.
- Keep replies short. This is spoken aloud over a phone -- two sentences is usually
  right, four is too many. No lists, no bullet points, no URLs, no email addresses
  unless the caller asks you to spell one.
- You reply with JSON only, matching the schema given. No markdown, no commentary.`;

const DECISION_SCHEMA = `{
  "say": "what to say back, spoken aloud, 1-2 short sentences",
  "intent": "one of: book | reschedule | cancel | question | message | escalate | goodbye",
  "chosen_slot_index": null,
  "caller_name": null,
  "purpose": null,
  "message": null,
  "urgency": "normal",
  "end_call": false
}`;

export async function decideResponse(params: {
  business: BusinessProfile;
  transcript: TranscriptTurn[];
  callerSaid: string;
  offeredSlots: TimeRange[];
  timezoneOffsetMinutes: number;
  now?: Date;
}): Promise<ReceptionistDecision> {
  const now = params.now ?? new Date();

  const slotBlock =
    params.offeredSlots.length > 0
      ? params.offeredSlots
          .map((slot, index) => `  ${index}: ${describeSlot(slot, params.timezoneOffsetMinutes, now)}`)
          .join('\n')
      : '  (no times are currently available to offer)';

  const history = params.transcript
    .map((turn) => `${turn.role === 'caller' ? 'CALLER' : 'YOU'}: ${turn.text}`)
    .join('\n');

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `${RECEPTIONIST_CHARTER}

You are answering calls for ${params.business.name}${
        params.business.industry ? ` (${params.business.industry})` : ''
      }.

How this business sounds: ${params.business.voice}
${params.business.never_say ? `\nNever say or discuss: ${params.business.never_say}` : ''}

Appointment times you may offer, by index — you may ONLY offer these:
${slotBlock}

To book a time, set "intent" to "book" and "chosen_slot_index" to the index above that
the caller agreed to. Do not set it until they have actually chosen; a caller asking
"what do you have?" has not chosen.

If they want something you cannot do — a price negotiation, a complaint, anything legal
or medical, or anything you have no information about — set "intent" to "escalate".
If they just want to leave word for someone, set "intent" to "message" and put what they
said in "message".

Reply with ONLY a JSON object of exactly this shape:
${DECISION_SCHEMA}`,
    },
    {
      role: 'user',
      content: history
        ? `Call so far:\n${history}\n\nCALLER just said: ${params.callerSaid}`
        : `CALLER just said: ${params.callerSaid}`,
    },
  ];

  const raw = await chatCompletion(messages);
  return parseDecision(extractJson(raw), params.offeredSlots.length);
}

export function parseDecision(value: unknown, slotCount: number): ReceptionistDecision {
  const decision = value as Record<string, unknown>;
  const allowed: ReceptionistDecision['intent'][] = [
    'book', 'reschedule', 'cancel', 'question', 'message', 'escalate', 'goodbye',
  ];
  const intentRaw = typeof decision.intent === 'string' ? decision.intent.trim() : '';
  const intent = (allowed as string[]).includes(intentRaw)
    ? (intentRaw as ReceptionistDecision['intent'])
    : 'question';

  // Slot index is clamped to what was actually offered. A model that returns
  // index 7 when three slots exist must not book anything -- offering a time
  // that was never on the list is the failure this guard exists for.
  let chosenSlotIndex: number | null = null;
  const rawIndex = decision.chosen_slot_index;
  if (rawIndex !== null && rawIndex !== undefined) {
    const parsed = Math.trunc(Number(rawIndex));
    if (Number.isFinite(parsed) && parsed >= 0 && parsed < slotCount) chosenSlotIndex = parsed;
  }

  return {
    say: asString(decision.say, 'say'),
    intent,
    chosenSlotIndex: intent === 'book' ? chosenSlotIndex : null,
    callerName: nullableString(decision.caller_name),
    purpose: nullableString(decision.purpose),
    message: nullableString(decision.message),
    urgency: decision.urgency === 'urgent' ? 'urgent' : 'normal',
    endCall: decision.end_call === true,
  };
}

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Escalation, checked before the model is consulted.
 *
 * The charter asks the agent to escalate these; this makes it happen whether
 * or not the agent agrees. Same principle as the crew's consent gates: the
 * things that must not be handled by an AI are enforced in code, and the
 * prompt is there so the agent doesn't try in the first place.
 *
 * Kept deliberately blunt -- substring matching on the business's configured
 * topics plus a fixed emergency list. A false positive transfers a caller to a
 * human, which is a small cost. A false negative has an AI handling a medical
 * emergency, which is not.
 */
const ALWAYS_ESCALATE = [
  'emergency', 'ambulance', 'suicide', 'kill myself', 'overdose', 'bleeding',
  'chest pain', "can't breathe", 'cant breathe', 'lawyer', 'lawsuit', 'sue you',
  'police',
];

export function mustEscalate(params: {
  callerSaid: string;
  business: BusinessProfile;
}): { escalate: boolean; reason: string | null } {
  const text = params.callerSaid.toLowerCase();

  for (const phrase of ALWAYS_ESCALATE) {
    if (text.includes(phrase)) return { escalate: true, reason: `matched safety term: ${phrase}` };
  }
  for (const topic of params.business.escalate_to_human) {
    const normalized = topic.trim().toLowerCase();
    if (normalized && text.includes(normalized)) {
      return { escalate: true, reason: `business escalation topic: ${topic}` };
    }
  }
  return { escalate: false, reason: null };
}

/**
 * Turn limit. A caller who has gone ten rounds without resolution is not
 * having a good experience, and an AI that keeps trying is making it worse.
 * Past this, hand off.
 */
export const MAX_TURNS = 10;
