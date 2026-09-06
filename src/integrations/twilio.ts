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
  /** Always the AC... account SID -- it's in the REST path regardless of auth. */
  accountSid: string;
  /** Basic-auth username: the API key SID (SK...) when one is set, else the account SID. */
  authUser: string;
  /** Basic-auth password: the API key secret when set, else the account auth token. */
  authPassword: string;
  fromNumber: string;
  messagingServiceSid?: string;
}

/**
 * Two credential styles, and the distinction matters:
 *
 *   * Account SID (AC...) + Auth Token -- the account's root credentials.
 *   * API Key SID (SK...) + secret -- scoped, revocable without rotating the
 *     account's auth token. Preferred for sending.
 *
 * An API key authenticates requests but does NOT replace the account SID: the
 * REST path is /Accounts/{AC...}/Messages.json either way, so TWILIO_ACCOUNT_SID
 * is required even when using an API key.
 *
 * And it cannot replace the auth token for *webhooks* -- Twilio signs inbound
 * requests with the account auth token, so verifyTwilioSignature() needs
 * TWILIO_AUTH_TOKEN specifically. Sending can work with an API key alone;
 * receiving verified replies cannot.
 */
export function getTwilioCredentials(): TwilioCredentials {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const apiKeySid = process.env.TWILIO_API_KEY_SID;
  const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid) {
    throw new Error(
      'TWILIO_ACCOUNT_SID (AC...) must be set -- it is part of the REST path even when authenticating with an API key.'
    );
  }
  if (!accountSid.startsWith('AC')) {
    throw new Error(
      `TWILIO_ACCOUNT_SID must be the account SID starting with "AC" (got "${accountSid.slice(0, 2)}..."). ` +
        'An API key SID starts with "SK" and belongs in TWILIO_API_KEY_SID.'
    );
  }

  if (apiKeySid && !apiKeySecret) {
    throw new Error('TWILIO_API_KEY_SID is set but TWILIO_API_KEY_SECRET is missing.');
  }
  if (!apiKeySid && !authToken) {
    throw new Error(
      'Set either TWILIO_API_KEY_SID + TWILIO_API_KEY_SECRET, or TWILIO_AUTH_TOKEN, to send messages.'
    );
  }

  if (!fromNumber && !process.env.TWILIO_MESSAGING_SERVICE_SID) {
    throw new Error(
      'Either TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID must be set to send messages.'
    );
  }

  return {
    accountSid,
    authUser: apiKeySid ?? accountSid,
    authPassword: apiKeySecret ?? authToken ?? '',
    fromNumber: fromNumber ?? '',
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
  };
}

/**
 * Whether inbound webhooks can be verified. Separate from
 * isTwilioConfigured(): an API-key-only setup can send but cannot verify a
 * reply, and the server refuses unverified inbound rather than trusting it --
 * so this is worth surfacing before a campaign goes out, not after the first
 * STOP fails to register.
 */
export function canVerifyTwilioWebhooks(): boolean {
  return Boolean(process.env.TWILIO_AUTH_TOKEN);
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

  // Auth user/password may be an API key pair; the path always uses the AC sid.
  const auth = Buffer.from(`${credentials.authUser}:${credentials.authPassword}`).toString('base64');
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
  if (!authToken) {
    // Fails closed, but say why: an API key secret cannot substitute here, and
    // silently rejecting every inbound message looks like a Twilio problem
    // rather than a missing variable.
    console.error(
      '[twilio] TWILIO_AUTH_TOKEN is not set — inbound webhooks cannot be verified and will be rejected. ' +
        'Twilio signs webhooks with the account auth token; an API key secret will not work for this.'
    );
    return false;
  }
  if (!params.signature) return false;

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
