import { asArray, asString, think } from './agent.js';
import { storeSocialPost } from './store.js';
import type { CrewAgent, Lead, MarketGap, Offer, OutreachMessage, SocialPost } from './types.js';

/**
 * BMDC-SIGNAL: the crew's outbound voice -- social drafts and the SMS copy the
 * outreach pipeline sends.
 *
 * Social posts are stored as drafts, never auto-published: publishing is the
 * one step in this crew that reaches an audience the crew can't take a message
 * back from, so it stays behind a human approval by default.
 */

const SMS_MAX_CHARS = 320; // ~2 segments; longer copy gets truncated by carriers.

const VARIANT_SCHEMA = `{
  "variants": [
    {
      "label": "one-word name for the angle being tested",
      "hypothesis": "what this variant is testing, stated so the sales numbers can refute it",
      "body": "the SMS text itself"
    }
  ]
}`;

export interface OutreachVariant {
  label: string;
  hypothesis: string;
  body: string;
}

/**
 * Write SMS variants for an offer. Variants differ on angle, not wording --
 * the crew compares them against realized sales, and two paraphrases of the
 * same pitch teach it nothing.
 */
export async function writeOutreachVariants(params: {
  agent: CrewAgent;
  cycleId: string | null;
  gap: MarketGap;
  offer: Offer;
  count?: number;
}): Promise<OutreachVariant[]> {
  const count = params.count ?? 2;
  const link = params.offer.payment_link_url;

  return think<OutreachVariant[]>({
    agent: params.agent,
    cycleId: params.cycleId,
    kind: 'write-outreach',
    memoryQuery: `SMS copy that sold to ${params.gap.segment}`,
    schema: VARIANT_SCHEMA,
    task: `Write ${count} SMS variants pitching this offer to leads who opted in.

Segment: ${params.gap.segment}
Their unmet need: ${params.gap.description}
Offer: ${params.offer.name} — ${params.offer.pitch}
Price: $${(params.offer.price_cents / 100).toFixed(2)}
${link ? `Checkout link to include verbatim: ${link}` : 'A checkout link will be appended by the sender; do not invent one.'}

Constraints:
- Under ${SMS_MAX_CHARS} characters including the link.
- Reference why they opted in; these are people who asked to hear from this crew.
- End with "Reply STOP to opt out."
- Each variant must test a genuinely different angle from the others.
- Do not state a discount, deadline, or result that isn't in the offer above.`,
    parse: (value) => {
      const variants = asArray((value as { variants?: unknown }).variants, 'variants');
      if (variants.length === 0) throw new Error('No variants returned');
      return variants.slice(0, count).map((raw) => {
        const variant = raw as Record<string, unknown>;
        return {
          label: asString(variant.label, 'label').toLowerCase().replace(/\s+/g, '-').slice(0, 24),
          hypothesis: asString(variant.hypothesis, 'hypothesis'),
          body: enforceOptOut(asString(variant.body, 'body')),
        };
      });
    },
  });
}

/**
 * A missing opt-out line is a compliance failure, not a copy nit, so it's
 * repaired here rather than left to the model getting it right every time.
 */
function enforceOptOut(body: string): string {
  if (/\bstop\b/i.test(body)) return body;
  return `${body.trimEnd()} Reply STOP to opt out.`;
}

const REPLY_SCHEMA = `{
  "reply": "the SMS to send back, under 320 characters",
  "intent": "one of: interested | question | objection | not_interested | unclear",
  "send_checkout": true
}`;

export interface ReplyDecision {
  reply: string;
  intent: 'interested' | 'question' | 'objection' | 'not_interested' | 'unclear';
  sendCheckout: boolean;
}

/**
 * Respond to an inbound reply from a lead. Returns both the message and a read
 * on where the lead now stands, so the pipeline can move their stage and
 * decide whether to send a checkout link.
 */
export async function respondToLead(params: {
  agent: CrewAgent;
  cycleId: string | null;
  lead: Lead;
  offer: Offer | null;
  conversation: OutreachMessage[];
}): Promise<ReplyDecision> {
  const transcript = params.conversation
    .map((message) => `${message.direction === 'outbound' ? 'CREW' : 'LEAD'}: ${message.body}`)
    .join('\n');

  return think<ReplyDecision>({
    agent: params.agent,
    cycleId: params.cycleId,
    kind: 'respond-to-lead',
    memoryQuery: `handling replies from ${params.lead.segment ?? 'leads'}`,
    schema: REPLY_SCHEMA,
    task: `Reply to this lead.

Lead: ${params.lead.name ?? 'unnamed'}${params.lead.segment ? ` (${params.lead.segment})` : ''}, stage: ${params.lead.stage}
${params.offer ? `Offer on the table: ${params.offer.name} — ${params.offer.pitch} ($${(params.offer.price_cents / 100).toFixed(2)})` : 'No offer is currently attached to this conversation.'}

Conversation so far:
${transcript || '(no prior messages)'}

Set "send_checkout" true only if this person has actually signalled they want to buy.
Pushing a payment link at someone who asked a question is how a crew loses a sale.
If they've said no, accept it: a graceful close is the correct outcome, and set intent
to not_interested.`,
    parse: (value) => {
      const decision = value as Record<string, unknown>;
      const intent = asString(decision.intent, 'intent') as ReplyDecision['intent'];
      const allowed: ReplyDecision['intent'][] = [
        'interested',
        'question',
        'objection',
        'not_interested',
        'unclear',
      ];
      return {
        reply: asString(decision.reply, 'reply'),
        intent: allowed.includes(intent) ? intent : 'unclear',
        sendCheckout: decision.send_checkout === true && intent === 'interested',
      };
    },
  });
}

const SOCIAL_SCHEMA = `{
  "posts": [
    {
      "platform": "one of: x | instagram | linkedin | tiktok",
      "body": "the post text",
      "hashtags": ["without the # symbol"]
    }
  ]
}`;

/** Draft social posts for a campaign. Stored as drafts pending approval. */
export async function draftSocialPosts(params: {
  agent: CrewAgent;
  cycleId: string | null;
  gap: MarketGap;
  offer: Offer;
  campaignId: string | null;
  count?: number;
}): Promise<SocialPost[]> {
  const count = params.count ?? 3;

  const drafts = await think<Array<{ platform: string; body: string; hashtags: string[] }>>({
    agent: params.agent,
    cycleId: params.cycleId,
    kind: 'draft-social',
    memoryQuery: `social content for ${params.gap.segment}`,
    schema: SOCIAL_SCHEMA,
    task: `Draft ${count} social posts that pull ${params.gap.segment} toward this offer.

Their unmet need: ${params.gap.description}
Offer: ${params.offer.name} — ${params.offer.pitch}

Write for the platform you choose for each post -- what works on LinkedIn does not work
on TikTok. Lead with the problem, not the product. No invented testimonials, metrics,
or customer quotes.`,
    parse: (value) => {
      const posts = asArray((value as { posts?: unknown }).posts, 'posts');
      return posts.slice(0, count).map((raw) => {
        const post = raw as Record<string, unknown>;
        return {
          platform: asString(post.platform, 'platform').toLowerCase(),
          body: asString(post.body, 'body'),
          hashtags: Array.isArray(post.hashtags)
            ? post.hashtags.map((tag) => String(tag).replace(/^#/, ''))
            : [],
        };
      });
    },
  });

  const stored: SocialPost[] = [];
  for (const draft of drafts) {
    stored.push(
      await storeSocialPost({
        campaignId: params.campaignId,
        createdBy: params.agent.id,
        platform: draft.platform,
        body: draft.body,
        hashtags: draft.hashtags,
      })
    );
  }
  return stored;
}
