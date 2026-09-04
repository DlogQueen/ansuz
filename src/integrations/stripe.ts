import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe over the REST API directly, for the same reason as Twilio: the crew
 * needs a product, a price, a payment link, a checkout session and a verified
 * webhook -- all form-encoded POSTs and one HMAC check.
 *
 * STRIPE_SECRET_KEY never leaves the server. The browser and the SMS recipient
 * only ever see a payment link / checkout URL.
 */

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

function getSecretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY must be set to create or read Stripe objects.');
  }
  return key;
}

export function isStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

/**
 * Stripe's API is form-encoded with bracket notation for nested values
 * (`line_items[0][price]`, `metadata[lead_id]`). Flatten arbitrary nesting
 * once here so callers can pass plain objects.
 */
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

async function stripeRequest<T>(
  path: string,
  params: Record<string, unknown> = {},
  method: 'POST' | 'GET' = 'POST'
): Promise<T> {
  const form = toForm(params);
  const url =
    method === 'GET' && form.toString()
      ? `${STRIPE_API_BASE}${path}?${form.toString()}`
      : `${STRIPE_API_BASE}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: method === 'POST' ? form.toString() : undefined,
  });

  if (!response.ok) {
    throw new Error(`Stripe ${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as T;
}

export interface StripeOfferObjects {
  productId: string;
  priceId: string;
  paymentLinkUrl: string | null;
}

/**
 * Turn one of the crew's offers into something a person can actually pay for:
 * product -> price -> payment link. The payment link is what goes out over SMS
 * (a reusable URL, no per-lead session needed), while
 * `createCheckoutSession()` below is for when a specific lead needs to be
 * attributed to a specific campaign.
 */
export async function createOfferProducts(params: {
  name: string;
  description: string;
  priceCents: number;
  currency?: string;
  metadata?: Record<string, string>;
}): Promise<StripeOfferObjects> {
  const product = await stripeRequest<{ id: string }>('/products', {
    name: params.name,
    description: params.description,
    metadata: params.metadata ?? {},
  });

  const price = await stripeRequest<{ id: string }>('/prices', {
    product: product.id,
    unit_amount: params.priceCents,
    currency: params.currency ?? 'usd',
  });

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
    console.warn(
      '[stripe] payment link creation failed, falling back to checkout sessions:',
      error instanceof Error ? error.message : error
    );
  }

  return { productId: product.id, priceId: price.id, paymentLinkUrl };
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/**
 * A per-lead checkout session. The metadata is what makes revenue attribution
 * work: the webhook reads `lead_id` / `campaign_id` / `offer_id` back off the
 * session and writes them into `sales`, which is what the crew's fitness and
 * gap-validation logic is computed from.
 */
export async function createCheckoutSession(params: {
  priceId: string;
  leadId: string;
  campaignId: string | null;
  offerId: string;
  successUrl?: string;
  cancelUrl?: string;
  customerEmail?: string;
}): Promise<CheckoutSession> {
  const baseUrl = process.env.BMDC_PUBLIC_URL ?? 'https://example.com';
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

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Verify Stripe's `Stripe-Signature` header against the raw request body.
 *
 * Must be given the *raw* body string -- re-serializing parsed JSON changes
 * the bytes and the signature will never match. The tolerance check rejects
 * replayed events; without it a captured webhook could be re-sent forever to
 * book phantom sales.
 */
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
  if (!timestamp || signatures.length === 0) {
    throw new Error('Malformed Stripe-Signature header.');
  }

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
