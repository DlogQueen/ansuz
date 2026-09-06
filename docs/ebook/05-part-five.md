# PART V — THE OUTSIDE WORLD

---

## Chapter 14: Two Signatures, or, Your Webhook Is Your Front Door

Two endpoints in this system are reachable by anyone on the internet:

```
POST /api/twilio/inbound
POST /api/stripe/webhook
```

They have to be. Twilio needs to deliver inbound texts. Stripe needs to report
completed payments. Neither will authenticate with a token you control — they sign
their requests, and verifying that signature *is* the authentication.

Think about what an unverified endpoint means here. Anyone who guesses the URL can:

- Forge an inbound message from any phone number
- Fabricate a `checkout.session.completed` event with any amount and any attribution
- Poison the sales table, which is the crew's ground truth, which corrupts every
  decision the manager makes downstream

That last one is worth dwelling on. The whole architecture rests on `sales` being
un-arguable. An unverified webhook makes it arguable by anyone with curl.

### Twilio: HMAC-SHA1 over URL plus sorted parameters

```typescript
export function verifyTwilioSignature(params: {
  signature: string | undefined;
  url: string;
  body: Record<string, string>;
  authToken?: string;
}): boolean {
  const authToken = params.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
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
```

The algorithm: take the full request URL, append every POST parameter sorted by key
(key immediately followed by value, no separators), HMAC-SHA1 with the auth token,
base64.

Three things to notice.

**The URL is part of the signature.** Which means it has to be the *exact* URL
Twilio was configured to call. Not the one derived from the `Host` header:

```typescript
function publicUrlFor(path: string): string {
  const base = process.env.BMDC_PUBLIC_URL;
  if (!base) {
    throw new Error('BMDC_PUBLIC_URL must be set to verify Twilio webhook signatures.');
  }
  return `${base.replace(/\/$/, '')}${path}`;
}
```

The `Host` header is attacker-controlled. If you build the URL from it, an attacker
who can set `Host` can make you compute a signature over a string they chose. The
URL comes from configuration, not from the request.

**`timingSafeEqual`, not `===`.** String comparison short-circuits at the first
differing byte, and the time it takes leaks how many bytes matched. Over enough
requests, that's a byte-by-byte reconstruction of the correct signature.
`timingSafeEqual` takes constant time regardless.

**The length check before it.** `timingSafeEqual` throws if the buffers differ in
length, so the explicit comparison prevents a crash on malformed input.

**It fails closed, loudly.** No token means `return false` — every inbound message
rejected. And it logs *why*, because the alternative is a silent 403 on everything
that looks like Twilio is broken. More on that in a moment.

### Stripe: HMAC-SHA256 over raw body, with a clock

```typescript
export function verifyStripeSignature(params: {
  rawBody: string;
  signatureHeader: string | undefined;
  secret?: string;
  toleranceSeconds?: number;
}): StripeEvent {
  const secret = params.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('STRIPE_WEBHOOK_SECRET must be set to verify Stripe webhooks.');
  if (!params.signatureHeader) throw new Error('Missing Stripe-Signature header.');

  const parts = params.signatureHeader.split(',').reduce<Record<string, string[]>>((acc, part) => {
    const [key, value] = part.split('=');
    if (!key || !value) return acc;
    (acc[key.trim()] ??= []).push(value.trim());
    return acc;
  }, {});

  const timestamp = parts.t?.[0];
  const signatures = parts.v1 ?? [];
  if (!timestamp || signatures.length === 0) throw new Error('Malformed Stripe-Signature header.');

  const tolerance = params.toleranceSeconds ?? 300;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > tolerance) {
    throw new Error('Stripe webhook timestamp outside tolerance (possible replay).');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${params.rawBody}`, 'utf8')
    .digest('hex');

  const matched = signatures.some((signature) => {
    const provided = Buffer.from(signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    return provided.length === expectedBuffer.length && timingSafeEqual(provided, expectedBuffer);
  });
  if (!matched) throw new Error('Stripe signature verification failed.');

  return JSON.parse(params.rawBody) as StripeEvent;
}
```

Different from Twilio in three meaningful ways.

**It signs the raw body.** Not parsed-and-re-serialized — the actual bytes. Which
means the route handler must not parse the JSON before verification:

```typescript
// Stripe signs the raw bytes -- parsing and re-serializing would break
// verification, so the raw string is what gets passed through.
const rawBody = await readTextBody(req);
```

If you `JSON.parse()` and then `JSON.stringify()`, key order can change, whitespace
disappears, and the bytes no longer match. The signature fails and you spend an
afternoon confused. There's a test for this specific case.

**There's a timestamp tolerance.** Five minutes. Without it, a captured webhook
request is valid forever — record one legitimate `checkout.session.completed` and
you can replay it indefinitely, booking a phantom sale each time. (The unique index
on `stripe_session_id` also catches this, which is the point of defense in depth:
two independent mechanisms, either one sufficient.)

**Multiple `v1` signatures are supported.** During secret rotation Stripe sends
signatures for both the old and new secret. Parsing them into an array and checking
`.some()` means rotation doesn't cause an outage.

**It throws rather than returning false.** Stripe verification returns the *parsed
event* on success, so there's no useful "false" value. Throwing with a specific
message — malformed header, outside tolerance, verification failed — means the logs
tell you which thing went wrong.

### Both are tested offline

```
PASS  twilio: valid signature accepted
PASS  twilio: tampered body rejected
PASS  twilio: wrong url rejected
PASS  twilio: missing signature rejected
PASS  twilio: garbage signature rejected
PASS  stripe: valid signature accepted
PASS  stripe: bad signature rejected
PASS  stripe: replayed old timestamp rejected
PASS  stripe: re-serialized body rejected
PASS  stripe: missing header rejected
```

Ten assertions, no network, no credentials, runs in under a second. The tests
construct valid signatures with the same crypto primitives and then verify that
tampering with each component causes rejection.

If you write one test suite in a system like this, write this one.

### The Takeaway

**When an endpoint must be publicly reachable, the signature is the authentication —
treat it with the seriousness that implies.**

Constant-time comparison. Raw bytes. Timestamp tolerance. URL from config, never
from headers. Fail closed, and log loudly enough that a misconfiguration looks like
a misconfiguration rather than a mystery.

---

## Chapter 15: Consent, Enforced Three Times

The charter says never message someone who hasn't opted in. Here's what actually
enforces it.

### Gate one: the query

```typescript
export async function listReachableLeads(params: {
  segment?: string;
  limit?: number;
}): Promise<Lead[]> {
  let query = client
    .from('leads')
    .select('*')
    .eq('consent_status', 'opted_in')
    .not('phone', 'is', null)
    .not('stage', 'in', '("won","lost")')
    .order('score', { ascending: false })
    .limit(params.limit ?? 25);
  // ...
}
```

Non-consenting leads never enter the outreach loop. They aren't filtered later —
they're never fetched.

### Gate two: the check immediately before sending

```typescript
for (const lead of leads) {
  result.attempted += 1;

  if (lead.consent_status !== 'opted_in' || !lead.phone) {
    result.skipped += 1;
    continue;
  }
  // ...send
}
```

This is redundant. `listReachableLeads` already guaranteed it. The comment explains
why it's there anyway:

```typescript
/**
 * `listReachableLeads` already filters to opted-in leads, but the per-lead
 * check below is deliberately redundant: this is the last gate before a real
 * message reaches a real person, and a query that silently changes shape one
 * day shouldn't be the only thing standing there.
 */
```

Someone will eventually refactor that query. Add a parameter, change a filter,
optimize something. The redundant check costs one comparison per lead and survives
that refactor.

**Redundancy is not always waste. At the boundary where software reaches a human,
it's cheap insurance.**

### Gate three: the one-way door

Covered in Chapter 6 — `setLeadConsent` throws when asked to move a lead out of
`opted_out`. No code path restores consent programmatically.

### Plus: STOP never reaches the model

```typescript
export async function handleInboundMessage(message: InboundMessage): Promise<InboundResult> {
  const intent = classifyInboundKeyword(message.body);

  // ...find or create lead, record the inbound message...

  if (intent === 'stop') {
    await setLeadConsent({ leadId: lead.id, status: 'opted_out', source: 'sms_keyword' });
    await setLeadStage(lead.id, 'lost');
    return { reply: STOP_CONFIRMATION, intent, leadId: lead.id };
  }
  // ...only after this does anything reach an agent
}
```

An opt-out is a state change, not a conversation. It's applied immediately by
deterministic code, confirmed with a fixed string, and returned — before any agent
is consulted.

If STOP went through the model, then STOP handling depends on the model behaving
correctly, and the failure mode is continuing to message someone who told you to
stop. That's not a failure you get to have.

### The keyword classifier, and one careful detail

```typescript
const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'revoke']);
const START_KEYWORDS = new Set(['start', 'unstop', 'yes', 'subscribe']);
const HELP_KEYWORDS = new Set(['help', 'info']);

export function classifyInboundKeyword(body: string): InboundIntent {
  const normalized = body.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (STOP_KEYWORDS.has(normalized)) return 'stop';
  if (START_KEYWORDS.has(normalized)) return 'start';
  if (HELP_KEYWORDS.has(normalized)) return 'help';
  return 'reply';
}
```

The normalization strips everything that isn't a letter, so `"STOP."`, `" stop "`,
and `"Stop!"` all match.

But look at what it does *not* do: it doesn't search for "stop" inside the message.
It compares the **whole normalized message** against the set.

```
PASS  keyword: "stop by later" is a reply, not an opt-out
```

"Stop by later!" is an enthusiastic customer suggesting a visit. A substring match
would opt them out and mark them lost. Exact-match-after-normalization gets it
right, and there's a test asserting it, because this is precisely the kind of thing
that gets "optimized" into a `.includes()` by someone in a hurry.

### The `START` case, and refusing to re-engage

```typescript
if (intent === 'start') {
  // `setLeadConsent` refuses to walk back a prior opt-out; treat that refusal
  // as the correct outcome and stay silent rather than re-engaging.
  try {
    await setLeadConsent({ leadId: lead.id, status: 'opted_in', source: 'sms_keyword' });
    return { reply: "You're subscribed. Reply STOP any time to opt out.", intent, leadId: lead.id };
  } catch {
    return { reply: null, intent: 'stop', leadId: lead.id };
  }
}
```

Someone who previously opted out texts START. The consent function throws. The
catch returns `reply: null` — silence.

This is a deliberate, slightly counterintuitive choice. Twilio's own Messaging
Service handles START/STOP at the carrier level, and a genuine re-subscribe flows
through there. Our database staying at `opted_out` until a human changes it is the
conservative position, and silence is the conservative response.

### One import rule keeps all of this true

Everything that sends marketing goes through `pipeline.ts`. The Twilio wrapper
(`sendMessage`) is a dumb transport that will send to anyone — it's documented as
such:

```typescript
/**
 * This is deliberately a dumb transport: it does not check consent. Consent is
 * enforced one level up in src/crew/pipeline.ts, which is the only thing that
 * should be calling this for outbound marketing.
 */
```

And the pipeline module states the rule for future contributors:

```typescript
/**
 * Keep it that way: if a future agent needs to send outbound, give it a
 * function in this file rather than a direct import of `sendMessage`.
 */
```

One choke point. One file to audit. If you want to know every way this system can
message a human, you read one module.

### The Takeaway

**Enforce the thing that must never happen at every layer that could prevent it,
and put the enforcement where a refactor will trip over it.**

Three gates isn't paranoia; it's acknowledging that the query will change, the loop
will be rewritten, and the person doing it won't have read this book. Design so
that being wrong requires defeating all three.

---

## Chapter 16: Payments, Attribution, and the Metadata That Carries Everything

The Stripe integration is 220 lines and does exactly five things: create a product,
create a price, create a payment link, create a checkout session, and verify a
webhook.

No SDK. The Stripe npm package is excellent and large; five form-encoded POSTs and
one HMAC don't justify it in a repo where nothing else needs it.

### Form encoding with bracket notation

Stripe's API isn't JSON. It's `application/x-www-form-urlencoded` with brackets for
nesting: `line_items[0][price]`, `metadata[lead_id]`.

```typescript
function toForm(params: Record<string, unknown>, prefix = ''): URLSearchParams {
  const form = new URLSearchParams();
  const append = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => append(`${key}[${index}]`, item));
    } else if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        append(`${key}[${childKey}]`, childValue);
      }
    } else {
      form.append(key, String(value));
    }
  };

  for (const [key, value] of Object.entries(params)) {
    append(prefix ? `${prefix}[${key}]` : key, value);
  }
  return form;
}
```

Recursive, handles arbitrary nesting, skips nulls. Written once, and it's why the
rest of the file reads like normal object code.

### Attribution: the load-bearing metadata

This is the most important part of the payment integration, and it's easy to miss.

```typescript
export async function createCheckoutSession(params: {
  priceId: string;
  leadId: string;
  campaignId: string | null;
  offerId: string;
  // ...
}): Promise<CheckoutSession> {
  const session = await stripeRequest<{ id: string; url: string }>('/checkout/sessions', {
    mode: 'payment',
    line_items: [{ price: params.priceId, quantity: 1 }],
    success_url: params.successUrl ?? `${baseUrl}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: params.cancelUrl ?? `${baseUrl}/`,
    customer_email: params.customerEmail,
    metadata: {
      lead_id: params.leadId,
      campaign_id: params.campaignId ?? '',
      offer_id: params.offerId,
    },
  });
  return { id: session.id, url: session.url };
}
```

Three IDs go into `metadata` when the session is created. When the payment
completes, Stripe sends those same three IDs back on the webhook event, and the
handler reads them:

```typescript
const metadata = session.metadata ?? {};
const leadId = metadata.lead_id || null;
const campaignId = metadata.campaign_id || null;
const offerId = metadata.offer_id || null;

await recordSale({
  leadId, offerId, campaignId,
  stripeSessionId: session.id,
  amountCents: session.amount_total ?? 0,
  // ...
});
```

**That round trip is what makes the entire adaptive loop work.**

Without it, sales arrive with no campaign attached. `campaign_performance()` returns
zero revenue for every campaign. Every variant looks identical. Fitness measures
nothing. The manager has no basis for any decision, and the system degrades into an
expensive random-message generator.

I tested this specific path against the live Stripe API before trusting it —
created a real session with real metadata, fetched it back, and asserted the three
IDs and the amount survived:

```
--- attribution metadata round-trip ---
  metadata:     {"campaign_id":"...0002","lead_id":"...0001","offer_id":"smoke-test"}
  amount_total: 7900 usd

PASS: attribution survives the round trip; revenue would be credited correctly.
```

If you build one thing from this book and verify one thing about it, verify that
your attribution survives the round trip through the payment provider.

### Draft offers cannot be pitched

```typescript
if (params.offer.status !== 'live') {
  console.warn(
    `[crew] offer "${params.offer.name}" is ${params.offer.status}, not live -- refusing to pitch something nobody can buy.`
  );
  return result;
}
```

An offer only becomes `live` when its Stripe product, price, and payment link exist.
Until then, outreach refuses to send.

The failure this prevents: the crew writes beautiful copy for something with no
checkout URL, texts a hundred interested people, and every one of them hits a dead
end. You get one shot at a warm lead. Spending it on a broken funnel is worse than
not sending at all.

### Payment link failure is soft; product failure is hard

```typescript
let paymentLinkUrl: string | null = null;
try {
  const link = await stripeRequest<{ url: string }>('/payment_links', {
    line_items: [{ price: price.id, quantity: 1 }],
    metadata: params.metadata ?? {},
  });
  paymentLinkUrl = link.url;
} catch (error) {
  // Payment Links need the feature enabled on the account; the product and
  // price are still usable via Checkout Sessions, so this is a soft failure.
  console.warn('[stripe] payment link creation failed, falling back to checkout sessions:', /* ... */);
}
```

Product and price creation failing throws — without those, nothing can be sold.
Payment link failing is caught, because per-lead checkout sessions still work
without it.

The distinction is whether the system can still do its job. If yes, degrade and
log. If no, fail.

### The Takeaway

**Attribution metadata is the nervous system of an adaptive commercial system.
Verify the round trip before you trust anything downstream of it.**

Everything the crew believes about which campaign works, which agent is earning,
and which market gap is real is computed from data that has to survive a trip
through a third party's API and come back intact. That trip is a single point of
failure for the entire feedback loop, and it fails silently — you get sales, they
just aren't attached to anything.
