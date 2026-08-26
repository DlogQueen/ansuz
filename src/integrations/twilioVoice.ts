/**
 * Twilio Voice, via `<Gather input="speech">` rather than bidirectional media
 * streams.
 *
 * The tradeoff, stated plainly: media streams give lower latency and let the
 * caller interrupt, but need a WebSocket bridge, an audio codec path, and a
 * realtime model connection held open for the whole call. Gather is turn-based
 * — Twilio does speech-to-text and posts the result to a webhook, we reply
 * with what to say next. Higher latency per turn, no barge-in, but it runs on
 * the HTTP server that already exists and fails in ways that are easy to see.
 *
 * For booking an appointment, turn-based is the right shape: the conversation
 * is a short sequence of questions with a structured outcome, not free-form
 * chat. The realtime path (src/llm/xaiVoice.ts already speaks it) is the
 * upgrade, not the prerequisite.
 */

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';

export interface SayOptions {
  /** Twilio TTS voice. Polly voices sound markedly better than the default. */
  voice?: string;
  language?: string;
}

const DEFAULT_VOICE = 'Polly.Joanna-Neural';

/**
 * Say something, then listen for the caller's reply.
 *
 * `speechTimeout: 'auto'` lets Twilio decide when the caller has stopped
 * talking rather than waiting a fixed interval — noticeably less awkward than
 * a hard timeout, which either cuts people off or leaves dead air.
 */
export function sayAndGather(params: {
  say: string;
  actionUrl: string;
  options?: SayOptions;
  timeoutSeconds?: number;
}): string {
  const voice = params.options?.voice ?? DEFAULT_VOICE;
  const language = params.options?.language ?? 'en-US';
  return (
    `${XML_HEADER}<Response>` +
    `<Gather input="speech" action="${escapeXml(params.actionUrl)}" method="POST" ` +
    `speechTimeout="auto" timeout="${params.timeoutSeconds ?? 6}" language="${escapeXml(language)}">` +
    `<Say voice="${escapeXml(voice)}">${escapeXml(params.say)}</Say>` +
    `</Gather>` +
    // Reached only if the caller says nothing at all. Re-prompting once beats
    // hanging up on someone who was distracted for four seconds.
    `<Redirect method="POST">${escapeXml(params.actionUrl)}?silent=1</Redirect>` +
    `</Response>`
  );
}

/** Say something and hang up. */
export function sayAndHangUp(say: string, options?: SayOptions): string {
  const voice = options?.voice ?? DEFAULT_VOICE;
  return (
    `${XML_HEADER}<Response>` +
    `<Say voice="${escapeXml(voice)}">${escapeXml(say)}</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

/**
 * Say something, then transfer to a human.
 *
 * `<Dial>` falls through to the next verb if the transfer fails or nobody
 * picks up, so the fallback line matters — without it a failed transfer is
 * silence followed by a dropped call, which is worse than never having
 * offered.
 */
export function sayAndTransfer(params: {
  say: string;
  transferNumber: string;
  fallbackSay?: string;
  options?: SayOptions;
}): string {
  const voice = params.options?.voice ?? DEFAULT_VOICE;
  const fallback =
    params.fallbackSay ??
    "I wasn't able to reach anyone just now. I've made a note and someone will call you back.";
  return (
    `${XML_HEADER}<Response>` +
    `<Say voice="${escapeXml(voice)}">${escapeXml(params.say)}</Say>` +
    `<Dial timeout="25">${escapeXml(params.transferNumber)}</Dial>` +
    `<Say voice="${escapeXml(voice)}">${escapeXml(fallback)}</Say>` +
    `<Hangup/>` +
    `</Response>`
  );
}

export interface InboundCall {
  callSid: string;
  from: string;
  to: string;
  /** Present on <Gather> callbacks; absent on the initial call webhook. */
  speechResult: string | null;
  /** Twilio's confidence in the transcription, 0..1, when provided. */
  confidence: number | null;
  callStatus: string | null;
}

export function parseInboundCall(body: Record<string, string>): InboundCall {
  const confidence = body.Confidence !== undefined ? Number(body.Confidence) : NaN;
  return {
    callSid: body.CallSid ?? '',
    from: body.From ?? '',
    to: body.To ?? '',
    speechResult: body.SpeechResult?.trim() ? body.SpeechResult.trim() : null,
    confidence: Number.isFinite(confidence) ? confidence : null,
    callStatus: body.CallStatus ?? null,
  };
}

/**
 * Below this, treat the transcription as unheard and ask the caller to repeat.
 *
 * Acting on a low-confidence transcript is how a receptionist books the wrong
 * day: Twilio returns something plausible, the model treats it as fact, and
 * nobody finds out until the caller doesn't show up. Asking again costs one
 * turn.
 */
export const MIN_SPEECH_CONFIDENCE = 0.4;

export function isUsableSpeech(call: InboundCall): boolean {
  if (!call.speechResult) return false;
  if (call.confidence === null) return true; // Twilio omits it sometimes; don't punish that.
  return call.confidence >= MIN_SPEECH_CONFIDENCE;
}
