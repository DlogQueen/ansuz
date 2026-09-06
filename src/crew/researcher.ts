import { asArray, asNumber, asString, rememberLearning, think } from './agent.js';
import { storeMarketGap, storeOffer, attachStripeToOffer, getCampaignPerformance } from './store.js';
import { createOfferProducts, isStripeConfigured } from '../integrations/stripe.js';
import type { CrewAgent, MarketGap, Offer } from './types.js';

/**
 * BMDC-PROSPECT: market gap research and offer generation.
 *
 * The research is grounded rather than free-associative -- the agent is handed
 * what actually happened (campaign performance, which segments replied, what
 * sold) and asked to reason from it. That's the difference between a crew that
 * adapts and one that generates a fresh batch of plausible-sounding gaps every
 * cycle and never converges.
 */

export interface GapProposal {
  title: string;
  segment: string;
  description: string;
  evidence: string[];
  confidence: number;
}

const GAP_SCHEMA = `{
  "gaps": [
    {
      "title": "short name for the gap",
      "segment": "the specific group of people, named concretely",
      "description": "what they need, what they do instead today, why that's inadequate",
      "evidence": ["each item cites something from the facts you were given"],
      "confidence": 0.0
    }
  ]
}`;

export async function findMarketGaps(params: {
  agent: CrewAgent;
  cycleId: string | null;
  focus?: string;
  maxGaps?: number;
}): Promise<MarketGap[]> {
  const performance = await getCampaignPerformance();
  const maxGaps = params.maxGaps ?? 3;

  const performanceBlock =
    performance.length > 0
      ? performance
          .map(
            (row) =>
              `- "${row.campaign_name}" (variant ${row.variant}, ${row.channel}): ${row.messages_sent} sent, ` +
              `${row.replies} replies, ${row.sales_count} sales, $${(row.revenue_cents / 100).toFixed(2)} revenue`
          )
          .join('\n')
      : '- No campaigns have run yet. You have no outcome data; set confidence accordingly.';

  const proposals = await think<GapProposal[]>({
    agent: params.agent,
    cycleId: params.cycleId,
    kind: 'find-gaps',
    memoryQuery: `market gaps${params.focus ? ` in ${params.focus}` : ''}`,
    schema: GAP_SCHEMA,
    task: `Propose up to ${maxGaps} market gaps this crew could sell into${
      params.focus ? `, focused on: ${params.focus}` : ''
    }.

What the crew's campaigns have actually produced so far:
${performanceBlock}

Prefer a gap that the outcome data above supports over a more exciting one it doesn't.
If a segment has been messaged and bought nothing, that is evidence against it, not a
reason to try harder with the same framing.`,
    parse: (value) => {
      const gaps = asArray((value as { gaps?: unknown }).gaps, 'gaps');
      return gaps.slice(0, maxGaps).map((raw) => {
        const gap = raw as Record<string, unknown>;
        return {
          title: asString(gap.title, 'title'),
          segment: asString(gap.segment, 'segment'),
          description: asString(gap.description, 'description'),
          evidence: Array.isArray(gap.evidence) ? gap.evidence.map(String) : [],
          confidence: Math.min(1, Math.max(0, asNumber(gap.confidence, 'confidence', 0.4))),
        };
      });
    },
  });

  const stored: MarketGap[] = [];
  for (const proposal of proposals) {
    const gap = await storeMarketGap({ discoveredBy: params.agent.id, ...proposal });
    stored.push(gap);
    await rememberLearning({
      summary: `Market gap identified: ${gap.title} — ${gap.segment}. ${gap.description}`,
      category: 'market-gap',
      importance: gap.confidence >= 0.7 ? 4 : 3,
      metadata: { gapId: gap.id, segment: gap.segment, confidence: gap.confidence },
    });
  }
  return stored;
}

const OFFER_SCHEMA = `{
  "name": "the offer's name, as the buyer would see it",
  "pitch": "2-3 sentences the crew can actually deliver on",
  "price_cents": 0,
  "reasoning": "why this price for this segment"
}`;

/**
 * Design an offer against a gap and, if Stripe is configured, make it
 * immediately payable (product -> price -> payment link). An offer with no
 * Stripe objects stays `draft`, which the outreach path refuses to send --
 * the crew never pitches something a lead can't buy.
 */
export async function designOffer(params: {
  agent: CrewAgent;
  cycleId: string | null;
  gap: MarketGap;
}): Promise<Offer> {
  const design = await think<{ name: string; pitch: string; priceCents: number; reasoning: string }>({
    agent: params.agent,
    cycleId: params.cycleId,
    kind: 'design-offer',
    memoryQuery: `pricing and offers for ${params.gap.segment}`,
    schema: OFFER_SCHEMA,
    task: `Design one sellable offer for this gap.

Gap: ${params.gap.title}
Segment: ${params.gap.segment}
Need: ${params.gap.description}

Price it in cents, as a single up-front purchase. Only promise what a small crew can
actually deliver -- the pitch becomes the thing the buyer is owed.`,
    parse: (value) => {
      const offer = value as Record<string, unknown>;
      const priceCents = Math.round(asNumber(offer.price_cents, 'price_cents'));
      if (priceCents <= 0) throw new Error('price_cents must be positive');
      return {
        name: asString(offer.name, 'name'),
        pitch: asString(offer.pitch, 'pitch'),
        priceCents,
        reasoning: typeof offer.reasoning === 'string' ? offer.reasoning : '',
      };
    },
  });

  let offer = await storeOffer({
    gapId: params.gap.id,
    name: design.name,
    pitch: design.pitch,
    priceCents: design.priceCents,
  });

  if (isStripeConfigured()) {
    const stripeObjects = await createOfferProducts({
      name: design.name,
      description: design.pitch,
      priceCents: design.priceCents,
      metadata: { offer_id: offer.id, gap_id: params.gap.id, crew: 'BMDC' },
    });
    offer = await attachStripeToOffer({
      offerId: offer.id,
      productId: stripeObjects.productId,
      priceId: stripeObjects.priceId,
      paymentLinkUrl: stripeObjects.paymentLinkUrl,
    });
  } else {
    console.warn(
      `[crew] STRIPE_SECRET_KEY not set -- offer "${offer.name}" stays draft and will not be pitched.`
    );
  }

  return offer;
}
