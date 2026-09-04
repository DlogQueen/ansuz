import { createHmac } from 'node:crypto';
import {
  verifyTwilioSignature,
  parseInboundMessage,
  classifyInboundKeyword,
  twimlResponse,
  getTwilioCredentials,
  canVerifyTwilioWebhooks,
} from '../src/integrations/twilio.js';
import { verifyStripeSignature } from '../src/integrations/stripe.js';
import { extractJson } from '../src/crew/agent.js';

/**
 * Offline checks for BMDC's security-critical and parsing logic -- the parts
 * that are pure functions and therefore actually testable without Twilio,
 * Stripe, Supabase or a model in the loop.
 *
 * The webhook signature checks are the ones that matter most: those endpoints
 * are publicly reachable by necessity, so the signature is the only thing
 * standing between the open internet and the crew's decision loop.
 *
 * Run with `npm run test:bmdc`. No credentials or network access required.
 */

let failures = 0;
function check(name: string, condition: boolean): void {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) failures += 1;
}

// --- Twilio signature -------------------------------------------------------
const token = 'test-auth-token';
const url = 'https://example.com/api/twilio/inbound';
const body = { From: '+15551234567', To: '+15559876543', Body: 'STOP', MessageSid: 'SM123' };
const payload = Object.keys(body)
  .sort()
  .reduce((acc, key) => acc + key + (body as Record<string, string>)[key], url);
const goodSig = createHmac('sha1', token).update(Buffer.from(payload, 'utf8')).digest('base64');

check('twilio: valid signature accepted', verifyTwilioSignature({ signature: goodSig, url, body, authToken: token }));
check('twilio: tampered body rejected', !verifyTwilioSignature({ signature: goodSig, url, body: { ...body, Body: 'YES' }, authToken: token }));
check('twilio: wrong url rejected', !verifyTwilioSignature({ signature: goodSig, url: 'https://evil.com/api/twilio/inbound', body, authToken: token }));
check('twilio: missing signature rejected', !verifyTwilioSignature({ signature: undefined, url, body, authToken: token }));
check('twilio: garbage signature rejected', !verifyTwilioSignature({ signature: 'not-base64!!!', url, body, authToken: token }));

// --- Twilio parsing ---------------------------------------------------------
const inbound = parseInboundMessage({ From: 'whatsapp:+15551234567', To: 'whatsapp:+15559876543', Body: 'hi', MessageSid: 'SM9' });
check('twilio: whatsapp prefix stripped', inbound.from === '+15551234567' && inbound.channel === 'whatsapp');
check('twilio: sms channel detected', parseInboundMessage({ From: '+1555', Body: 'x' }).channel === 'sms');

check('keyword: STOP', classifyInboundKeyword('STOP') === 'stop');
check('keyword: "stop." punctuation', classifyInboundKeyword(' stop. ') === 'stop');
check('keyword: unsubscribe', classifyInboundKeyword('Unsubscribe') === 'stop');
check('keyword: start', classifyInboundKeyword('START') === 'start');
check('keyword: help', classifyInboundKeyword('help') === 'help');
check('keyword: normal reply', classifyInboundKeyword('tell me more about pricing') === 'reply');
check('keyword: "stop by later" is a reply, not an opt-out', classifyInboundKeyword('stop by later') === 'reply');

check('twiml: empty response', twimlResponse() === '<?xml version="1.0" encoding="UTF-8"?><Response/>');
check('twiml: escapes markup', twimlResponse('a & b <c>').includes('a &amp; b &lt;c&gt;'));

// --- Twilio credential shapes -----------------------------------------------
// An SK... api key sid in TWILIO_ACCOUNT_SID authenticates fine but 401s on
// every request, because the REST path needs the AC... sid. Easy mistake (both
// are "the Twilio SID" in casual use), so it's caught with a named error.
function withEnv(vars: Record<string, string | undefined>, fn: () => unknown): unknown {
  const saved = Object.keys(vars).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function credentialCase(name: string, vars: Record<string, string | undefined>, expect: 'ok' | RegExp): void {
  withEnv({ ...vars }, () => {
    try {
      const credentials = getTwilioCredentials();
      check(name, expect === 'ok' && credentials.accountSid.startsWith('AC'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      check(name, expect !== 'ok' && expect.test(message));
    }
  });
}

const BASE = {
  TWILIO_ACCOUNT_SID: 'AC00000000000000000000000000000000',
  TWILIO_AUTH_TOKEN: undefined,
  TWILIO_API_KEY_SID: undefined,
  TWILIO_API_KEY_SECRET: undefined,
  TWILIO_FROM_NUMBER: '+15551234567',
  TWILIO_MESSAGING_SERVICE_SID: undefined,
};

credentialCase('twilio creds: api key pair accepted', { ...BASE, TWILIO_API_KEY_SID: 'SK1', TWILIO_API_KEY_SECRET: 's' }, 'ok');
credentialCase('twilio creds: auth token accepted', { ...BASE, TWILIO_AUTH_TOKEN: 't' }, 'ok');
credentialCase('twilio creds: SK in ACCOUNT_SID rejected by name', { ...BASE, TWILIO_ACCOUNT_SID: 'SKf55d18ef', TWILIO_AUTH_TOKEN: 't' }, /must be the account SID starting with "AC"/);
credentialCase('twilio creds: api key sid without secret rejected', { ...BASE, TWILIO_API_KEY_SID: 'SK1' }, /TWILIO_API_KEY_SECRET is missing/);
credentialCase('twilio creds: no auth at all rejected', { ...BASE }, /Set either TWILIO_API_KEY_SID/);
credentialCase('twilio creds: missing account sid rejected', { ...BASE, TWILIO_ACCOUNT_SID: undefined, TWILIO_AUTH_TOKEN: 't' }, /TWILIO_ACCOUNT_SID \(AC\.\.\.\) must be set/);
credentialCase('twilio creds: no sender rejected', { ...BASE, TWILIO_AUTH_TOKEN: 't', TWILIO_FROM_NUMBER: undefined }, /TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID/);

// An api-key-only setup can send but cannot verify inbound webhooks, since
// Twilio signs those with the account auth token.
withEnv({ TWILIO_AUTH_TOKEN: undefined }, () => {
  check('twilio: webhook verification unavailable without auth token', !canVerifyTwilioWebhooks());
});
withEnv({ TWILIO_AUTH_TOKEN: 'present' }, () => {
  check('twilio: webhook verification available with auth token', canVerifyTwilioWebhooks());
});

// --- Stripe signature -------------------------------------------------------
const secret = 'whsec_test';
const rawBody = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } });
const ts = Math.floor(Date.now() / 1000);
const stripeSig = createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');

try {
  const event = verifyStripeSignature({ rawBody, signatureHeader: `t=${ts},v1=${stripeSig}`, secret });
  check('stripe: valid signature accepted', event.type === 'checkout.session.completed');
} catch (error) {
  check(`stripe: valid signature accepted (${error})`, false);
}

function expectThrow(name: string, fn: () => unknown): void {
  try {
    fn();
    check(name, false);
  } catch {
    check(name, true);
  }
}
expectThrow('stripe: bad signature rejected', () =>
  verifyStripeSignature({ rawBody, signatureHeader: `t=${ts},v1=${'0'.repeat(64)}`, secret })
);
expectThrow('stripe: replayed old timestamp rejected', () => {
  const old = ts - 4000;
  const oldSig = createHmac('sha256', secret).update(`${old}.${rawBody}`, 'utf8').digest('hex');
  return verifyStripeSignature({ rawBody, signatureHeader: `t=${old},v1=${oldSig}`, secret });
});
expectThrow('stripe: re-serialized body rejected', () =>
  verifyStripeSignature({ rawBody: JSON.stringify(JSON.parse(rawBody), null, 2), signatureHeader: `t=${ts},v1=${stripeSig}`, secret })
);
expectThrow('stripe: missing header rejected', () =>
  verifyStripeSignature({ rawBody, signatureHeader: undefined, secret })
);

// --- JSON extraction --------------------------------------------------------
check('json: plain object', (extractJson('{"a":1}') as { a: number }).a === 1);
check('json: fenced', (extractJson('```json\n{"a":2}\n```') as { a: number }).a === 2);
check('json: prose-wrapped', (extractJson('Sure! {"a":3} hope that helps') as { a: number }).a === 3);
check('json: nested braces', (extractJson('x {"a":{"b":4}} y') as { a: { b: number } }).a.b === 4);
expectThrow('json: non-json throws', () => extractJson('no json here'));

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
