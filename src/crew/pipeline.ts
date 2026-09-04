import { sendMessage, classifyInboundKeyword, type InboundMessage } from '../integrations/twilio.js';
import { createCheckoutSession, isStripeConfigured, type StripeEvent } from '../integrations/stripe.js';
import { rememberLearning } from './agent.js';
import { respondToLead } from './social.js';
import {
  getAgentByCodename,
  getConversation,
  getLastCampaignForLead,
  getLeadByPhone,
  getOffer,
  listCampaigns,
  listReachableLeads,
  recordAgentOutcome,
  recordOutreach,
  recordSale,
  setLeadConsent,
  setLeadStage,
  upsertLead,
} from './store.js';
import type { Campaign, Lead, Offer } from './types.js';

/**
 * The sales funnel: who gets contacted, what happens when they reply, and how
 * a reply becomes a paid checkout.
 *
 * This module is where consent is enforced. The Twilio wrapper will send to
 * anyone -- everything that sends *marketing* goes through here, and here a
 * lead that isn't `opted_in` is never messaged. Keep it that way: if a future
 * agent needs to send outbound, give it a function in this file rather than a
 * direct import of `sendMessage`.
 */

const HELP_REPLY =
  'BMDC (Byte Me Dev Crew) — automated messages about the offer you signed up for. ' +
  'Reply STOP to opt out. Message and data rates may apply.';

const STOP_CONFIRMATION =
  "You're opted out — you won't get any more messages from us. Thanks for your time.";

export interface OutreachRunResult {
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
}

/**
 * Send a campaign's message to reachable leads.
 *
 * `listReachableLeads` already filters to opted-in leads, but the per-lead
 * check below is deliberately redundant: this is the last gate before a real
 * message reaches a real person, and a query that silently changes shape one
 * day shouldn't be the only thing standing there.
 */
export async function runOutreach(params: {
  campaign: Campaign;
  offer: Offer;
  body: string;
  segment?: string;
  limit?: number;
}): Promise<OutreachRunResult> {
  const result: OutreachRunResult = { attempted: 0, sent: 0, skipped: 0, failed: 0 };

  if (params.offer.status !== 'live') {
    console.warn(
      `[crew] offer "${params.offer.name}" is ${params.offer.status}, not live -- refusing to pitch something nobody can buy.`
    );
    return result;
  }

  const leads = await listReachableLeads({ segment: params.segment, limit: params.limit ?? 25 });
  const channel = params.campaign.channel === 'whatsapp' ? 'whatsapp' : 'sms';

  for (const lead of leads) {
    result.attempted += 1;

    if (lead.consent_status !== 'opted_in' || !lead.phone) {
      result.skipped += 1;
      continue;
    }

    try {
      const sent = await sendMessage({ to: lead.phone, body: params.body, channel });
      await recordOutreach({
        campaignId: params.campaign.id,
        leadId: lead.id,
        direction: 'outbound',
        channel,
        body: params.body,
        providerSid: sent.sid,
        status: 'sent',
      });
      if (lead.stage === 'new') await setLeadStage(lead.id, 'contacted');
      result.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordOutreach({
        campaignId: params.campaign.id,
        leadId: lead.id,
        direction: 'outbound',
        channel,
        body: params.body,
        status: 'failed',
        error: message,
      });
      result.failed += 1;
      console.error(`[crew] outreach to lead ${lead.id} failed:`, message);
    }
  }

  return result;
}

export interface InboundResult {
  /** Reply to hand back in the TwiML response, if any. */
  reply: string | null;
  intent: string;
  leadId: string | null;
}

/**
 * Handle one inbound SMS/WhatsApp message.
 *
 * STOP is processed before anything else and never reaches the model: an
 * opt-out is not a conversation to be handled well, it's a state change to be
 * applied immediately and confirmed.
 */
export async function handleInboundMessage(message: InboundMessage): Promise<InboundResult> {
  const intent = classifyInboundKeyword(message.body);

  let lead: Lead | null = await getLeadByPhone(message.from);
  if (!lead) {
    // An inbound message from an unknown number is the strongest opt-in signal
    // there is -- they messaged us first -- but it's recorded as `unknown`
    // until they say something affirmative, not assumed.
    lead = await upsertLead({ phone: message.from, source: 'inbound_sms' });
  }

  await recordOutreach({
    campaignId: await getLastCampaignForLead(lead.id),
    leadId: lead.id,
    direction: 'inbound',
    channel: message.channel,
    body: message.body,
    providerSid: message.messageSid || null,
    status: 'received',
  });

  if (intent === 'stop') {
    await setLeadConsent({ leadId: lead.id, status: 'opted_out', source: 'sms_keyword' });
    await setLeadStage(lead.id, 'lost');
    return { reply: STOP_CONFIRMATION, intent, leadId: lead.id };
  }

  if (intent === 'help') {
    return { reply: HELP_REPLY, intent, leadId: lead.id };
  }

  if (intent === 'start') {
    // `setLeadConsent` refuses to walk back a prior opt-out; treat that refusal
    // as the correct outcome and stay silent rather than re-engaging.
    try {
      await setLeadConsent({ leadId: lead.id, status: 'opted_in', source: 'sms_keyword' });
      return {
        reply: "You're subscribed. Reply STOP any time to opt out.",
        intent,
        leadId: lead.id,
      };
    } catch {
      return { reply: null, intent: 'stop', leadId: lead.id };
    }
  }

  if (lead.consent_status === 'opted_out') {
    return { reply: null, intent: 'suppressed', leadId: lead.id };
  }

  return handleConversationalReply(lead, message);
}

async function handleConversationalReply(lead: Lead, message: InboundMessage): Promise<InboundResult> {
  const agent = await getAgentByCodename('BMDC-SIGNAL');
  if (!agent) {
    console.warn('[crew] BMDC-SIGNAL not on the roster -- run `npm run bmdc -- seed`.');
    return { reply: null, intent: 'unhandled', leadId: lead.id };
  }

  const campaignId = await getLastCampaignForLead(lead.id);
  const offer = await offerForCampaign(campaignId);
  const conversation = await getConversation(lead.id);

  const decision = await respondToLead({ agent, cycleId: null, lead, offer, conversation });

  const stageByIntent: Record<string, Lead['stage']> = {
    interested: 'qualified',
    question: 'engaged',
    objection: 'engaged',
    not_interested: 'lost',
    unclear: 'engaged',
  };
  await setLeadStage(lead.id, stageByIntent[decision.intent] ?? 'engaged');

  let reply = decision.reply;

  if (decision.sendCheckout && offer && isStripeConfigured()) {
    try {
      const checkout = await createCheckoutSession({
        priceId: offer.stripe_price_id ?? '',
        leadId: lead.id,
        campaignId,
        offerId: offer.id,
      });
      reply = `${reply}\n\n${checkout.url}`;
      await setLeadStage(lead.id, 'checkout_sent');
    } catch (error) {
      // The lead still gets the reply -- losing the link is better than losing
      // the conversation to a 500.
      console.error(
        '[crew] checkout session creation failed:',
        error instanceof Error ? error.message : error
      );
    }
  }

  await recordOutreach({
    campaignId,
    leadId: lead.id,
    direction: 'outbound',
    channel: message.channel,
    body: reply,
    status: 'sent',
  });

  return { reply, intent: decision.intent, leadId: lead.id };
}

async function offerForCampaign(campaignId: string | null): Promise<Offer | null> {
  if (!campaignId) return null;
  const campaigns = await listCampaigns(['running', 'paused', 'complete']);
  const campaign = campaigns.find((candidate) => candidate.id === campaignId);
  if (!campaign?.offer_id) return null;
  return getOffer(campaign.offer_id);
}

/**
 * Stripe webhook -> the `sales` table, which is the crew's ground truth. This
 * is the only place a sale is ever booked: an agent cannot mark its own
 * campaign successful, it has to wait for money to actually move.
 */
export async function handleStripeEvent(event: StripeEvent): Promise<{ handled: boolean }> {
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') {
    return { handled: false };
  }

  const session = event.data.object as {
    id: string;
    payment_intent?: string;
    amount_total?: number;
    currency?: string;
    payment_status?: string;
    metadata?: Record<string, string>;
  };

  const metadata = session.metadata ?? {};
  const leadId = metadata.lead_id || null;
  const campaignId = metadata.campaign_id || null;
  const offerId = metadata.offer_id || null;

  await recordSale({
    leadId,
    offerId,
    campaignId,
    stripeSessionId: session.id,
    stripePaymentIntent: session.payment_intent ?? null,
    amountCents: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    status: session.payment_status === 'paid' ? 'paid' : 'pending',
  });

  if (session.payment_status === 'paid') {
    if (leadId) await setLeadStage(leadId, 'won');

    // Credit the agents whose work produced the sale. This is the feedback that
    // makes the crew adaptive rather than merely busy.
    const signal = await getAgentByCodename('BMDC-SIGNAL');
    if (signal) await recordAgentOutcome(signal.id, 1);
    const prospect = await getAgentByCodename('BMDC-PROSPECT');
    if (prospect) await recordAgentOutcome(prospect.id, 1);

    await rememberLearning({
      summary:
        `Sale closed: $${((session.amount_total ?? 0) / 100).toFixed(2)} ${(session.currency ?? 'usd').toUpperCase()}` +
        `${campaignId ? ` attributed to campaign ${campaignId}` : ' with no campaign attribution'}.`,
      category: 'sales-outcome',
      importance: 5,
      metadata: { campaignId, offerId, leadId, sessionId: session.id },
    });
  }

  return { handled: true };
}
