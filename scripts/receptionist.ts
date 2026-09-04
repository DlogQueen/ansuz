import 'dotenv/config';
import { timezoneOffsetMinutes } from '../src/receptionist/callFlow.js';
import { computeOpenSlots, describeSlot, spreadSlots } from '../src/receptionist/availability.js';
import {
  getBusinessBySlug,
  getReceptionistPerformance,
  getTakenRanges,
  listAvailabilityRules,
  listBusinesses,
  listUnhandledMessages,
  listUpcomingAppointments,
  setWeeklyHours,
  upsertBusiness,
} from '../src/receptionist/store.js';
import { canVerifyTwilioWebhooks, isTwilioConfigured } from '../src/integrations/twilio.js';

/**
 * Receptionist control surface (SKU 03).
 *
 *   npm run receptionist -- add <slug> <name> <+phone> [timezone]
 *   npm run receptionist -- hours <slug> <mon-fri|sat|sun|all> <09:00> <17:00>
 *   npm run receptionist -- slots <slug>
 *   npm run receptionist -- book-list <slug>
 *   npm run receptionist -- messages <slug>
 *   npm run receptionist -- status [slug]
 */

const WEEKDAY_SETS: Record<string, number[]> = {
  'mon-fri': [1, 2, 3, 4, 5],
  weekdays: [1, 2, 3, 4, 5],
  all: [0, 1, 2, 3, 4, 5, 6],
  sat: [6],
  sun: [0],
  mon: [1], tue: [2], wed: [3], thu: [4], fri: [5],
};

function parseClock(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`"${value}" is not HH:MM (e.g. 09:00)`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`"${value}" is not a valid time`);
  return hours * 60 + minutes;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'add': {
      const [slug, name, phone, timezone] = args;
      if (!slug || !name) {
        console.error('Usage: npm run receptionist -- add <slug> <name> [+phone] [timezone]');
        process.exitCode = 1;
        return;
      }
      if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) {
        console.error(`"${phone}" is not E.164 (e.g. +15551234567).`);
        process.exitCode = 1;
        return;
      }
      const business = await upsertBusiness({
        slug,
        name,
        phoneNumber: phone,
        timezone: timezone ?? 'America/New_York',
      });
      console.log(`Business "${business.name}" (${business.slug}) saved.`);
      console.log(`  phone:    ${business.phone_number ?? '(none — set one before taking calls)'}`);
      console.log(`  timezone: ${business.timezone} (currently UTC${formatOffset(timezoneOffsetMinutes(business.timezone))})`);
      console.log(`  slots:    ${business.appointment_minutes} min`);
      console.log(`\nNext: npm run receptionist -- hours ${slug} mon-fri 09:00 17:00`);
      break;
    }

    case 'hours': {
      const [slug, dayset, start, end] = args;
      if (!slug || !dayset || !start || !end) {
        console.error('Usage: npm run receptionist -- hours <slug> <mon-fri|all|sat|sun|mon..fri> <HH:MM> <HH:MM>');
        process.exitCode = 1;
        return;
      }
      const business = await requireBusiness(slug);
      if (!business) return;

      const weekdays = WEEKDAY_SETS[dayset.toLowerCase()];
      if (!weekdays) {
        console.error(`Unknown day set "${dayset}". Try: ${Object.keys(WEEKDAY_SETS).join(', ')}`);
        process.exitCode = 1;
        return;
      }
      await setWeeklyHours({
        businessId: business.id,
        weekdays,
        startMinute: parseClock(start),
        endMinute: parseClock(end),
        replace: true,
      });
      console.log(`Hours set for ${business.name}: ${dayset} ${start}–${end} (${business.timezone}).`);
      break;
    }

    case 'slots': {
      const [slug] = args;
      const business = await requireBusiness(slug);
      if (!business) return;

      const now = new Date();
      const to = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      const offset = timezoneOffsetMinutes(business.timezone);
      const [rules, taken] = await Promise.all([
        listAvailabilityRules(business.id),
        getTakenRanges({ businessId: business.id, from: now, to }),
      ]);

      if (rules.length === 0) {
        console.log(`No hours set. Run: npm run receptionist -- hours ${business.slug} mon-fri 09:00 17:00`);
        break;
      }

      const slots = computeOpenSlots({
        rules, taken, from: now, to,
        slotMinutes: business.appointment_minutes,
        timezoneOffsetMinutes: offset,
        limit: 20,
      });

      console.log(`\nNext open slots for ${business.name} (${slots.length} shown, ${taken.length} range(s) already taken):`);
      for (const slot of slots) console.log(`  ${describeSlot(slot, offset, now)}`);
      console.log(`\nWhat a caller would be offered: ${spreadSlots(slots, 3).map((s) => describeSlot(s, offset, now)).join(' / ') || '(none)'}\n`);
      break;
    }

    case 'book-list': {
      const business = await requireBusiness(args[0]);
      if (!business) return;
      const appointments = await listUpcomingAppointments({ businessId: business.id });
      if (appointments.length === 0) {
        console.log('No upcoming appointments.');
        break;
      }
      const offset = timezoneOffsetMinutes(business.timezone);
      console.log(`\nUpcoming for ${business.name}:`);
      for (const appointment of appointments) {
        console.log(
          `  ${describeSlot({ startsAt: new Date(appointment.starts_at), endsAt: new Date(appointment.ends_at) }, offset)}` +
            ` — ${appointment.caller_name ?? 'unnamed'} (${appointment.caller_phone ?? 'no number'})` +
            `${appointment.purpose ? ` · ${appointment.purpose}` : ''} [${appointment.status}]`
        );
      }
      console.log('');
      break;
    }

    case 'messages': {
      const business = await requireBusiness(args[0]);
      if (!business) return;
      const messages = await listUnhandledMessages(business.id);
      if (messages.length === 0) {
        console.log('No unhandled messages.');
        break;
      }
      console.log(`\n${messages.length} unhandled message(s) for ${business.name}:`);
      for (const message of messages) {
        console.log(
          `\n  [${message.urgency}] ${message.caller_name ?? 'unnamed'} (${message.caller_phone ?? 'no number'}) — ${new Date(message.created_at).toLocaleString()}`
        );
        console.log(`  ${message.message}`);
      }
      console.log('');
      break;
    }

    case 'status': {
      const [slug] = args;
      console.log(`\nBMDC Receptionist`);
      console.log(
        `Twilio: ${isTwilioConfigured() ? 'configured' : 'NOT configured'}` +
          `   Voice webhooks verifiable: ${canVerifyTwilioWebhooks() ? 'yes' : 'NO — set TWILIO_AUTH_TOKEN'}`
      );
      if (!canVerifyTwilioWebhooks()) {
        console.log('  ⚠ Without TWILIO_AUTH_TOKEN every inbound call webhook is rejected.\n    The line will not answer.');
      }
      if (!process.env.BMDC_PUBLIC_URL) {
        console.log('  ⚠ BMDC_PUBLIC_URL is not set — signature verification cannot construct the called URL.');
      }

      const businesses = slug ? [await requireBusiness(slug)] : await listBusinesses();
      for (const business of businesses) {
        if (!business) continue;
        const performance = await getReceptionistPerformance(business.id);
        console.log(`\n  ${business.name} (${business.slug}) — ${business.phone_number ?? 'no number'}`);
        console.log(`    ${business.timezone}, ${business.appointment_minutes}-min slots, transfers to ${business.transfer_number ?? 'nobody (takes messages)'}`);
        console.log(
          `    calls ${performance.calls} · booked ${performance.booked} · messages ${performance.messages_taken}` +
            ` · escalated ${performance.escalated} · abandoned ${performance.abandoned}`
        );
      }
      console.log('');
      break;
    }

    default:
      console.log(
        'Usage: npm run receptionist -- <add|hours|slots|book-list|messages|status>\n' +
          '  add <slug> <name> [+phone] [timezone]     register a business\n' +
          '  hours <slug> <mon-fri|all|sat> <HH:MM> <HH:MM>   set weekly hours\n' +
          '  slots <slug>                              preview open slots\n' +
          '  book-list <slug>                          upcoming appointments\n' +
          '  messages <slug>                           unhandled callbacks\n' +
          '  status [slug]                             config + call outcomes'
      );
      process.exitCode = command ? 1 : 0;
  }
}

async function requireBusiness(slug: string | undefined) {
  if (!slug) {
    console.error('A business slug is required.');
    process.exitCode = 1;
    return null;
  }
  const business = await getBusinessBySlug(slug);
  if (!business) {
    console.error(`No business with slug "${slug}". Run: npm run receptionist -- add ${slug} "<name>"`);
    process.exitCode = 1;
    return null;
  }
  return business;
}

function formatOffset(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

main().catch((error) => {
  console.error('Receptionist command failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
