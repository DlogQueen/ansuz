import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Twilio, over the REST API directly rather than the `twilio` npm package --
 * the crew needs exactly two things (send a message, verify an inbound
 * webhook) and both are a few lines of fetch/crypto, which is a better trade
 * than a large dependency for the rest of the repo to carry.
 *
 * Credentials stay server-side only; nothing here is importable from `web/`.
 */

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  messagingServiceSid?: string;
}

export function getTwilioCredentials(): TwilioCredentials {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!accountSid || !authToken) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set to send messages.');
  }
  if (!fromNumber && !process.env.TWILIO_MESSAGING_SERVICE_SID) {
    throw new Error(
      'Either TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID must be set to send messages.'
    );
  }
  return {
    accountSid,
    authToken,
    fromNumber: fromNumber ?? '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
  };
}

export function isTwilioConfigured(): boolean {
  try {
    getTwilioCredentials();
    return true;
  } catch {
    return false;
  }
}

export interface SendMessageResult {
  sid: string;
  status: string;
}

/**
 * Send an SMS or WhatsApp message. `channel: 'whatsapp'` just prefixes both
 * numbers with `whatsapp:` -- Twilio treats it as the same Messages resource.
 *
 * This is deliberately a dumb transport: it does not check consent. Consent is
 * enforced one level up in src/crew/pipeline.ts, which is the only thing that
 * should be calling this for outbound marketing.
 */
export async function sendMessage(params: {
  to: string;
  body: string;
  channel?: 'sms' | 'whatsapp';
}): Promise<SendMessageResult> {
  const credentials = getTwilioCredentials();
  const channel = params.channel ?? 'sms';
  const prefix = channel === 'whatsapp' ? 'whatsapp:' : '';

  const form = new URLSearchParams({
    To: `${prefix}${params.to}`,
    Body: params.body,
  });
  // A Messaging Service handles sender pools, opt-out keywords and compliance
  // registration on Twilio's side, so prefer it when one is configured.
  if (credentials.messagingServiceSid && channel === 'sms') {
    form.set('MessagingServiceSid', credentials.messagingServiceSid);
  } else {
    form.set('From', `${prefix}${credentials.fromNumber}`);
  }

  const auth = Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64');
  const response = await fetch(
    `${TWILIO_API_BASE}/Accounts/${credentials.accountSid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    }
  );

  if (!response.ok) {
    throw new Error(`Twilio send failed (${response.status}): ${await response.text()}`);
  }

  const data = (await response.json()) as { sid: string; status: string };
  return { sid: data.sid, status: data.status };
}

/**
 * Validate Twilio's `X-Twilio-Signature` header.
 *
 * Twilio signs the full request URL concatenated with the POST body's
 * parameters sorted by key (key immediately followed by value, no separators),
 * HMAC-SHA1 with the auth token, base64. Without this check, anyone who
 * guesses the webhook URL can forge an inbound "STOP" -- or worse, a fake
 * buying signal -- straight into the crew's decision loop.
 *
 * `url` must be the exact public URL Twilio was configured to call, including
 * protocol and any query string. Behind a proxy that terminates TLS, derive it
 * from the forwarded headers, not from req.url.
 */
export function verifyTwilioSignature(params: {
  signature: string | undefined;
  url: string;
  body: Record<string, string>;
  authToken?: string;
}): boolean {
  const authToken = params.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!authToken || !params.signature) return false;

  const payload = Object.keys(params.body)
    .sort()
    .reduce((acc, key) => acc + key + params.body[key], params.url);

  const expected = createHmac('sha1', authToken).update(Buffer.from(payload, 'utf8')).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(params.signature, 'base64');
  } catch {
    return false;
  }

  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export interface InboundMessage {
  from: string;
  to: string;
  body: string;
  messageSid: string;
  channel: 'sms' | 'whatsapp';
}

/** Parse Twilio's form-encoded inbound webhook into something typed. */
export function parseInboundMessage(body: Record<string, string>): InboundMessage {
  const from = body.From ?? '';
  const isWhatsApp = from.startsWith('whatsapp:');
  return {
    from: from.replace(/^whatsapp:/, ''),
    to: (body.To ?? '').replace(/^whatsapp:/, ''),
    body: body.Body ?? '',
    messageSid: body.MessageSid ?? body.SmsMessageSid ?? '',
    channel: isWhatsApp ? 'whatsapp' : 'sms',
  };
}

// Carrier- and Twilio-recognized keywords. Handled locally as well as by
// Twilio's Messaging Service so the crew's own database reflects the opt-out
// immediately, rather than only Twilio's suppression list.
const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke']);
const START_KEYWORDS = new Set(['start', 'unstop', 'yes', 'subscribe']);
const HELP_KEYWORDS = new Set(['help', 'info']);

export type InboundIntent = 'stop' | 'start' | 'help' | 'reply';

export function classifyInboundKeyword(body: string): InboundIntent {
  const normalized = body.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (STOP_KEYWORDS.has(normalized)) return 'stop';
  if (START_KEYWORDS.has(normalized)) return 'start';
  if (HELP_KEYWORDS.has(normalized)) return 'help';
  return 'reply';
}

/** Minimal TwiML response. Twilio expects XML, empty `<Response/>` = no reply. */
export function twimlResponse(message?: string): string {
  if (!message) return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escaped}</Message></Response>`;
}
