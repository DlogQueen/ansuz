import {
  computeOpenSlots,
  describeSlot,
  overlapsAny,
  spreadSlots,
} from '../src/receptionist/availability.js';
import { MAX_TURNS, mustEscalate, parseDecision } from '../src/receptionist/agent.js';
import { timezoneOffsetMinutes } from '../src/receptionist/callFlow.js';
import {
  isUsableSpeech,
  parseInboundCall,
  sayAndGather,
  sayAndHangUp,
  sayAndTransfer,
} from '../src/integrations/twilioVoice.js';
import type { AvailabilityRule, BusinessProfile } from '../src/receptionist/types.js';

/**
 * Offline checks for the receptionist (SKU 03). No network, no database, no
 * model — the slot engine and the escalation gate are pure functions precisely
 * so they can be tested this way.
 *
 * The two that matter most: a caller must never be offered a slot that is
 * already booked, and a caller in distress must be escalated whether or not
 * the model agrees. Both are checked below.
 *
 * Run with `npm run test:receptionist`.
 */

let failures = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

// --- fixtures ---------------------------------------------------------------
// Monday 2026-03-02, 09:00–17:00 UTC, 30-minute slots.
const MONDAY = new Date('2026-03-02T00:00:00Z');
const rules: AvailabilityRule[] = [1, 2, 3, 4, 5].map((weekday, index) => ({
  id: `rule-${index}`,
  business_id: 'biz',
  weekday,
  start_minute: 9 * 60,
  end_minute: 17 * 60,
}));

const business: BusinessProfile = {
  id: 'biz', created_at: '', updated_at: '', slug: 'test', name: 'Test Co',
  industry: null, phone_number: '+15550000000', timezone: 'UTC',
  voice: 'Warm and brief.', never_say: '', greeting: 'Hi!',
  escalate_to_human: ['pricing negotiation', 'refund'],
  transfer_number: null, appointment_minutes: 30, status: 'active', config: {},
};

// --- slot computation -------------------------------------------------------
const from = new Date('2026-03-02T08:00:00Z');
const to = new Date('2026-03-03T00:00:00Z');

const allSlots = computeOpenSlots({ rules, taken: [], from, to, slotMinutes: 30, leadMinutes: 0 });
check('slots: a full 9-5 day yields 16 half-hour slots', allSlots.length === 16);
check('slots: first is 09:00', allSlots[0]?.startsAt.toISOString() === '2026-03-02T09:00:00.000Z');
check('slots: last starts 16:30', allSlots[15]?.startsAt.toISOString() === '2026-03-02T16:30:00.000Z');
check('slots: none extend past closing', allSlots.every((s) => s.endsAt.getTime() <= new Date('2026-03-02T17:00:00Z').getTime()));
check('slots: sorted ascending', allSlots.every((s, i) => i === 0 || s.startsAt >= allSlots[i - 1].startsAt));

// The one that matters: a booked range must never be offered.
const taken = [{ startsAt: new Date('2026-03-02T10:00:00Z'), endsAt: new Date('2026-03-02T11:00:00Z') }];
const withTaken = computeOpenSlots({ rules, taken, from, to, slotMinutes: 30, leadMinutes: 0 });
check('slots: booked range removes exactly its slots', withTaken.length === 14);
check(
  'slots: no offered slot overlaps a booking',
  withTaken.every((slot) => !overlapsAny(slot, taken))
);
check(
  'slots: the 10:00 and 10:30 slots are gone',
  !withTaken.some((s) => s.startsAt.toISOString().includes('T10:'))
);
check('slots: 09:30 survives (abuts but does not overlap)', withTaken.some((s) => s.startsAt.toISOString() === '2026-03-02T09:30:00.000Z'));
check('slots: 11:00 survives (abuts the end)', withTaken.some((s) => s.startsAt.toISOString() === '2026-03-02T11:00:00.000Z'));

// Lead time: a caller at 09:58 must not be offered 10:00.
const lateCall = new Date('2026-03-02T09:58:00Z');
const leadSlots = computeOpenSlots({ rules, taken: [], from: lateCall, to, slotMinutes: 30, leadMinutes: 60 });
check('slots: lead time excludes the imminent slot', !leadSlots.some((s) => s.startsAt.toISOString() === '2026-03-02T10:00:00.000Z'));
check('slots: lead time keeps a slot an hour out', leadSlots.some((s) => s.startsAt.toISOString() === '2026-03-02T11:00:00.000Z'));

// Weekend: no rules for Sunday, so no slots.
const sunday = computeOpenSlots({
  rules, taken: [],
  from: new Date('2026-03-01T00:00:00Z'), to: new Date('2026-03-02T00:00:00Z'),
  slotMinutes: 30, leadMinutes: 0,
});
check('slots: closed days produce nothing', sunday.length === 0);

// --- spread -----------------------------------------------------------------
const multiDay = computeOpenSlots({
  rules, taken: [], from: new Date('2026-03-02T00:00:00Z'), to: new Date('2026-03-06T00:00:00Z'),
  slotMinutes: 30, leadMinutes: 0, limit: 100,
});
const spread = spreadSlots(multiDay, 3);
check('spread: returns the requested count', spread.length === 3);
check(
  'spread: picks different days rather than three consecutive slots',
  new Set(spread.map((s) => s.startsAt.toISOString().slice(0, 10))).size === 3
);
check('spread: returns everything when fewer than asked', spreadSlots(multiDay.slice(0, 2), 3).length === 2);

// Regression: spreadSlots must group by the business's LOCAL day, not the UTC
// one. At UTC-8 a 9am and a 4pm slot on the same local Monday sit on different
// UTC dates -- grouping by UTC "spread" them as two days, so the caller was
// offered two Monday times believing they were Monday and Tuesday.
const WEST = -480;
const westSlots = computeOpenSlots({
  rules, taken: [],
  from: new Date('2026-03-02T00:00:00Z'), to: new Date('2026-03-07T00:00:00Z'),
  slotMinutes: 60, leadMinutes: 0, timezoneOffsetMinutes: WEST, limit: 100,
});
const westSpread = spreadSlots(westSlots, 3, WEST);
const localDayCount = new Set(
  westSpread.map((s) => new Date(s.startsAt.getTime() + WEST * 60_000).toISOString().slice(0, 10))
).size;
check('spread: groups by local day, not UTC day (UTC-8 business)', localDayCount === 3);
check(
  'slots: UTC-8 business only opens during local 9-5',
  westSlots.every((s) => {
    const h = new Date(s.startsAt.getTime() + WEST * 60_000).getUTCHours();
    return h >= 9 && h < 17;
  })
);

// --- spoken formatting ------------------------------------------------------
const noon = { startsAt: new Date('2026-03-02T12:00:00Z'), endsAt: new Date('2026-03-02T12:30:00Z') };
check('describe: "today" for same day', describeSlot(noon, 0, new Date('2026-03-02T08:00:00Z')).startsWith('today at 12 PM'));
check('describe: "tomorrow" for next day', describeSlot(noon, 0, new Date('2026-03-01T08:00:00Z')).startsWith('tomorrow at'));
check('describe: weekday name within the week', describeSlot(noon, 0, new Date('2026-02-27T08:00:00Z')).startsWith('Monday at'));
check('describe: no minutes on the hour', describeSlot(noon, 0, new Date('2026-03-02T08:00:00Z')).includes('12 PM'));
check(
  'describe: minutes shown when not on the hour',
  describeSlot({ startsAt: new Date('2026-03-02T14:15:00Z'), endsAt: new Date('2026-03-02T14:45:00Z') }, 0, new Date('2026-03-02T08:00:00Z')).includes('2:15 PM')
);
check(
  'describe: midnight reads as 12 AM, not 0 AM',
  describeSlot({ startsAt: new Date('2026-03-02T00:00:00Z'), endsAt: new Date('2026-03-02T00:30:00Z') }, 0, new Date('2026-03-02T00:00:00Z')).includes('12 AM')
);

// --- timezone ---------------------------------------------------------------
check('timezone: UTC is zero', timezoneOffsetMinutes('UTC', MONDAY) === 0);
check('timezone: New York in March is -300 or -240', [-300, -240].includes(timezoneOffsetMinutes('America/New_York', MONDAY)));
check('timezone: unknown zone falls back to 0 without throwing', timezoneOffsetMinutes('Not/AZone', MONDAY) === 0);

// --- escalation (the safety gate) -------------------------------------------
check('escalate: chest pain', mustEscalate({ callerSaid: 'I have chest pain', business }).escalate);
check('escalate: emergency', mustEscalate({ callerSaid: 'This is an emergency!', business }).escalate);
check('escalate: lawyer', mustEscalate({ callerSaid: 'I want to speak to my lawyer', business }).escalate);
check('escalate: case-insensitive', mustEscalate({ callerSaid: 'EMERGENCY', business }).escalate);
check('escalate: business topic — refund', mustEscalate({ callerSaid: 'I want a refund', business }).escalate);
check('escalate: business topic — pricing negotiation', mustEscalate({ callerSaid: 'can we do a pricing negotiation', business }).escalate);
check('escalate: ordinary booking request does not escalate', !mustEscalate({ callerSaid: 'I would like to book an appointment tomorrow', business }).escalate);
check('escalate: reason is reported', (mustEscalate({ callerSaid: 'emergency', business }).reason ?? '').length > 0);

// --- decision parsing (the booking guard) -----------------------------------
const booking = parseDecision({ say: 'Great, booking that.', intent: 'book', chosen_slot_index: 1, end_call: true }, 3);
check('decision: valid slot index accepted', booking.chosenSlotIndex === 1);
check('decision: end_call carried through', booking.endCall === true);

check(
  'decision: out-of-range slot index refused (never book an unoffered time)',
  parseDecision({ say: 'ok', intent: 'book', chosen_slot_index: 7 }, 3).chosenSlotIndex === null
);
check(
  'decision: negative slot index refused',
  parseDecision({ say: 'ok', intent: 'book', chosen_slot_index: -1 }, 3).chosenSlotIndex === null
);
check(
  'decision: slot index ignored unless intent is book',
  parseDecision({ say: 'ok', intent: 'question', chosen_slot_index: 1 }, 3).chosenSlotIndex === null
);
check(
  'decision: no slots offered means nothing bookable',
  parseDecision({ say: 'ok', intent: 'book', chosen_slot_index: 0 }, 0).chosenSlotIndex === null
);
check(
  'decision: unknown intent falls back to question, not book',
  parseDecision({ say: 'ok', intent: 'improvise' }, 3).intent === 'question'
);
check('decision: urgency defaults to normal', parseDecision({ say: 'ok', intent: 'message' }, 0).urgency === 'normal');
check('decision: urgent honored', parseDecision({ say: 'ok', intent: 'message', urgency: 'urgent' }, 0).urgency === 'urgent');
check('decision: blank name becomes null', parseDecision({ say: 'ok', intent: 'question', caller_name: '   ' }, 0).callerName === null);

try {
  parseDecision({ intent: 'question' }, 0);
  check('decision: missing "say" throws', false);
} catch {
  check('decision: missing "say" throws', true);
}

check('turn limit is a sane number', MAX_TURNS > 2 && MAX_TURNS <= 20);

// --- silent-caller loop -----------------------------------------------------
// Regression: the silent branch used to gate on session.turns, which only
// counts CALLER turns. A silent turn appends nothing, so the counter never
// moved and the call re-prompted forever -- an open line billing per minute
// with nobody on it. The re-prompt is now recorded in the transcript, so the
// second silence can see the first.
const REPROMPT_TEXT = "Sorry, I didn't catch that. Could you say that again?";
function wouldHangUp(transcript: Array<{ role: string; text: string }>): boolean {
  return transcript.some((t) => t.role === 'receptionist' && t.text === REPROMPT_TEXT);
}
check('silence: first silent turn re-prompts', !wouldHangUp([{ role: 'receptionist', text: 'Hi!' }]));
check(
  'silence: second silent turn hangs up (no infinite loop)',
  wouldHangUp([{ role: 'receptionist', text: 'Hi!' }, { role: 'receptionist', text: REPROMPT_TEXT }])
);
check(
  'silence: a caller who spoke once then went quiet still gets one re-prompt',
  !wouldHangUp([
    { role: 'receptionist', text: 'Hi!' },
    { role: 'caller', text: 'hello' },
    { role: 'receptionist', text: 'How can I help?' },
  ])
);

// --- TwiML ------------------------------------------------------------------
const gather = sayAndGather({ say: 'How can I help?', actionUrl: 'https://x.test/turn' });
check('twiml: gather uses speech input', gather.includes('input="speech"'));
check('twiml: gather posts to the action url', gather.includes('action="https://x.test/turn"'));
check('twiml: gather has a silent-caller redirect', gather.includes('silent=1'));
check('twiml: escapes the spoken text', sayAndGather({ say: 'Tom & "Jerry" <co>', actionUrl: 'https://x.test/t' }).includes('Tom &amp; &quot;Jerry&quot; &lt;co&gt;'));
check('twiml: hangup ends the call', sayAndHangUp('Bye').includes('<Hangup/>'));
check('twiml: transfer dials the number', sayAndTransfer({ say: 'One moment', transferNumber: '+15551112222' }).includes('<Dial timeout="25">+15551112222</Dial>'));
check(
  'twiml: transfer has a fallback line after Dial (a failed transfer is not silence)',
  (() => {
    const xml = sayAndTransfer({ say: 'One moment', transferNumber: '+1555' });
    return xml.indexOf('</Dial>') < xml.lastIndexOf('<Say');
  })()
);

// --- inbound call parsing ---------------------------------------------------
const initial = parseInboundCall({ CallSid: 'CA1', From: '+15551234567', To: '+15550000000', CallStatus: 'ringing' });
check('call: initial webhook has no speech', initial.speechResult === null && initial.callSid === 'CA1');
check('call: unusable when no speech', !isUsableSpeech(initial));

const heard = parseInboundCall({ CallSid: 'CA1', From: '+1', To: '+2', SpeechResult: '  book me in  ', Confidence: '0.92' });
check('call: speech trimmed', heard.speechResult === 'book me in');
check('call: high confidence usable', isUsableSpeech(heard));
check(
  'call: low confidence rejected (never act on a bad transcript)',
  !isUsableSpeech(parseInboundCall({ CallSid: 'C', From: '+1', To: '+2', SpeechResult: 'tuesday', Confidence: '0.11' }))
);
check(
  'call: missing confidence treated as usable',
  isUsableSpeech(parseInboundCall({ CallSid: 'C', From: '+1', To: '+2', SpeechResult: 'tuesday' }))
);

console.log(failures === 0 ? '\nAll receptionist checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
