import 'dotenv/config';
import { runCycle, seedCrew } from '../src/crew/orchestrator.js';
import { buildSituationReport } from '../src/crew/manager.js';
import {
  listAgents,
  listSocialPosts,
  setLeadConsent,
  upsertLead,
} from '../src/crew/store.js';
import { isStripeConfigured } from '../src/integrations/stripe.js';
import { isTwilioConfigured } from '../src/integrations/twilio.js';
import { getModelId, getProvider, isEmbeddingsAvailable } from '../src/llm/chat.js';

/**
 * BMDC control surface.
 *
 *   npm run bmdc -- seed              create the founding three agents
 *   npm run bmdc -- status            roster, gaps, campaigns, revenue
 *   npm run bmdc -- cycle [--dry-run] run one adapt cycle
 *   npm run bmdc -- lead <phone> [name] [segment]
 *                                     add a lead and record their opt-in
 *   npm run bmdc -- social            show drafted social posts
 *
 * `lead` records consent with source `cli_manual`, which is a claim that a
 * human actually collected that opt-in. Don't use it to bulk-load a list you
 * bought -- the whole outreach path is built on that flag meaning something.
 */

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'seed': {
      const agents = await seedCrew();
      console.log(`Seeded ${agents.length} founding agents:`);
      for (const agent of agents) console.log(`  ${agent.codename} (${agent.role})`);
      break;
    }

    case 'status': {
      const [report, agents] = await Promise.all([buildSituationReport(), listAgents()]);
      console.log(`\nBMDC — Byte Me Dev Crew`);
      console.log(`Revenue: $${(report.totals.revenueCents / 100).toFixed(2)} across ${report.totals.salesCount} sale(s)`);
      console.log(`Twilio: ${isTwilioConfigured() ? 'configured' : 'NOT configured'}   Stripe: ${isStripeConfigured() ? 'configured' : 'NOT configured'}`);
      console.log(
        `Model:  ${getProvider()} / ${getModelId()}` +
          (isEmbeddingsAvailable()
            ? '   (semantic memory retrieval)'
            : '   (no embeddings on this provider — memory falls back to recency+importance)')
      );

      console.log(`\nRoster (${agents.length}):`);
      for (const agent of agents) {
        console.log(
          `  ${agent.codename.padEnd(20)} ${agent.role.padEnd(11)} gen ${agent.generation}  ` +
            `fitness ${agent.fitness.toFixed(3)} over ${agent.runs} run(s)`
        );
      }

      console.log(`\nMarket gaps (${report.gaps.length}):`);
      for (const gap of report.gaps) {
        console.log(`  [${gap.status}] ${gap.title} — ${gap.segment} (confidence ${gap.confidence.toFixed(2)})`);
      }

      console.log(`\nCampaigns (${report.campaigns.length}):`);
      for (const campaign of report.campaigns) {
        console.log(
          `  ${campaign.name} [${campaign.variant}] — ${campaign.sent} sent, ${campaign.replies} replies, ` +
            `${campaign.sales} sales, $${(campaign.revenueCents / 100).toFixed(2)}`
        );
      }
      console.log('');
      break;
    }

    case 'cycle': {
      const result = await runCycle({ dryRun: args.includes('--dry-run') });
      console.log(`\nCycle ${result.cycleId}`);
      console.log(`Assessment: ${result.assessment}`);
      for (const decision of result.decisions) {
        console.log(`  → ${decision.agent}: ${decision.action}${decision.rationale ? ` (${decision.rationale})` : ''}`);
      }
      console.log(
        `\ngaps found: ${result.gapsFound}  campaigns: ${result.campaignsLaunched}  ` +
          `messages sent: ${result.messagesSent}  social drafts: ${result.socialDrafts}`
      );
      if (result.spawned) console.log(`spawned: ${result.spawned}`);
      if (result.retired.length > 0) console.log(`retired: ${result.retired.join(', ')}`);
      if (result.errors.length > 0) {
        console.error(`\nerrors:`);
        for (const error of result.errors) console.error(`  ${error}`);
        process.exitCode = 1;
      }
      break;
    }

    case 'lead': {
      const [phone, name, segment] = args;
      if (!phone) {
        console.error('Usage: npm run bmdc -- lead <e164-phone> [name] [segment]');
        process.exitCode = 1;
        return;
      }
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
        console.error(`"${phone}" is not E.164 (e.g. +15551234567).`);
        process.exitCode = 1;
        return;
      }
      const lead = await upsertLead({ phone, name, segment, source: 'cli_manual' });
      await setLeadConsent({ leadId: lead.id, status: 'opted_in', source: 'cli_manual' });
      console.log(`Lead ${phone} recorded and marked opted_in (source: cli_manual).`);
      break;
    }

    case 'social': {
      const posts = await listSocialPosts();
      if (posts.length === 0) {
        console.log('No drafted social posts.');
        break;
      }
      for (const post of posts) {
        console.log(`\n[${post.status}] ${post.platform}`);
        console.log(post.body);
        if (post.hashtags.length > 0) console.log(post.hashtags.map((tag) => `#${tag}`).join(' '));
      }
      console.log('');
      break;
    }

    default:
      console.log(
        'Usage: npm run bmdc -- <seed|status|cycle|lead|social>\n' +
          '  seed                     create the founding three agents\n' +
          '  status                   roster, gaps, campaigns, revenue\n' +
          '  cycle [--dry-run]        run one adapt cycle\n' +
          '  lead <phone> [name] [segment]   add an opted-in lead\n' +
          '  social                   show drafted social posts'
      );
      process.exitCode = command ? 1 : 0;
  }
}

main().catch((error) => {
  console.error('BMDC failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
