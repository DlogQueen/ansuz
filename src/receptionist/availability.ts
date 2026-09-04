import type { AvailabilityRule, TimeRange } from './types.js';

/**
 * Slot computation.
 *
 * Slots are derived from recurring weekly rules minus whatever is already
 * taken, rather than stored as rows. A business changing its hours edits one
 * rule; it doesn't require regenerating a calendar, and there's no stored
 * state that can drift out of step with the rules.
 *
 * This module is deliberately pure -- no database, no clock of its own. Every
 * input is a parameter, which is what makes it testable without a Postgres
 * instance and a fake time library.
 */

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/**
 * Open slots for a business in [from, to), respecting weekly rules, existing
 * bookings, and a minimum lead time.
 *
 * `leadMinutes` exists because a caller at 1:58pm should not be offered the
 * 2:00pm slot -- they cannot get there, and offering it produces a no-show
 * that looks like the receptionist's fault.
 */
export function computeOpenSlots(params: {
  rules: AvailabilityRule[];
  taken: TimeRange[];
  from: Date;
  to: Date;
  slotMinutes: number;
  leadMinutes?: number;
  /** Minutes to shift UTC by to get the business's local wall clock. */
  timezoneOffsetMinutes?: number;
  limit?: number;
}): TimeRange[] {
  const {
    rules,
    taken,
    from,
    to,
    slotMinutes,
    leadMinutes = 60,
    timezoneOffsetMinutes = 0,
    limit = 50,
  } = params;

  if (slotMinutes <= 0) throw new Error('slotMinutes must be positive');
  if (to <= from) return [];

  const earliest = new Date(from.getTime() + leadMinutes * MINUTE_MS);
  const slots: TimeRange[] = [];

  // Walk day by day in the business's local frame. Start one day early so a
  // rule whose window began yesterday-local but is still open now isn't
  // skipped by an offset that pushes the local date backwards.
  const cursor = new Date(from.getTime() - DAY_MS);
  cursor.setUTCHours(0, 0, 0, 0);

  while (cursor.getTime() < to.getTime() + DAY_MS && slots.length < limit) {
    // `cursor` enumerates the business's local calendar days (as UTC midnights);
    // `localMidnight` is that same local midnight expressed as a real UTC
    // instant, which is what the slot arithmetic below needs.
    const localMidnight = cursor.getTime() - timezoneOffsetMinutes * MINUTE_MS;
    const weekday = cursor.getUTCDay();

    for (const rule of rules) {
      if (rule.weekday !== weekday) continue;

      for (
        let minute = rule.start_minute;
        minute + slotMinutes <= rule.end_minute;
        minute += slotMinutes
      ) {
        if (slots.length >= limit) break;

        const startsAt = new Date(localMidnight + minute * MINUTE_MS);
        const endsAt = new Date(startsAt.getTime() + slotMinutes * MINUTE_MS);

        if (startsAt < earliest) continue;
        if (startsAt < from || endsAt > to) continue;
        if (overlapsAny({ startsAt, endsAt }, taken)) continue;
        if (slots.some((existing) => existing.startsAt.getTime() === startsAt.getTime())) continue;

        slots.push({ startsAt, endsAt });
      }
    }

    cursor.setTime(cursor.getTime() + DAY_MS);
  }

  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, limit);
}

export function overlapsAny(candidate: TimeRange, ranges: TimeRange[]): boolean {
  return ranges.some(
    (range) => candidate.startsAt < range.endsAt && candidate.endsAt > range.startsAt
  );
}

/**
 * Render a slot the way a person says it out loud.
 *
 * This is spoken by a text-to-speech engine, so it avoids anything that reads
 * badly aloud: no 24-hour clock, no ISO timestamps, no "0" minutes ("two
 * o'clock", not "two zero zero").
 */
export function describeSlot(slot: TimeRange, timezoneOffsetMinutes = 0, now = new Date()): string {
  const local = new Date(slot.startsAt.getTime() + timezoneOffsetMinutes * MINUTE_MS);
  const localNow = new Date(now.getTime() + timezoneOffsetMinutes * MINUTE_MS);

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  const hours24 = local.getUTCHours();
  const minutes = local.getUTCMinutes();
  const period = hours24 >= 12 ? 'PM' : 'AM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const time = minutes === 0 ? `${hours12} ${period}` : `${hours12}:${String(minutes).padStart(2, '0')} ${period}`;

  const dayDiff = Math.floor(
    (Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) -
      Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate())) / DAY_MS
  );

  if (dayDiff === 0) return `today at ${time}`;
  if (dayDiff === 1) return `tomorrow at ${time}`;
  if (dayDiff > 1 && dayDiff < 7) return `${days[local.getUTCDay()]} at ${time}`;
  return `${days[local.getUTCDay()]}, ${months[local.getUTCMonth()]} ${local.getUTCDate()}, at ${time}`;
}

/**
 * Offer a handful of slots spread across different days rather than the next
 * three consecutive openings.
 *
 * "Two o'clock, two thirty, or three?" is a worse question than "this
 * afternoon, tomorrow morning, or Thursday?" -- the first three are nearly the
 * same choice, so a caller who can't do this afternoon has to be asked again.
 */
export function spreadSlots(slots: TimeRange[], count = 3, timezoneOffsetMinutes = 0): TimeRange[] {
  if (slots.length <= count) return slots;

  // Group by the business's LOCAL calendar day, not the UTC one. For a
  // business far from UTC these disagree: at UTC-8, a 9am and a 4pm slot on the
  // same local Monday fall on different UTC dates, so grouping by UTC would
  // "spread" them as if they were two different days -- and the caller gets
  // offered two Monday times believing they were offered Monday and Tuesday.
  const byDay = new Map<string, TimeRange[]>();
  for (const slot of slots) {
    const key = new Date(slot.startsAt.getTime() + timezoneOffsetMinutes * MINUTE_MS)
      .toISOString()
      .slice(0, 10);
    const group = byDay.get(key);
    if (group) group.push(slot);
    else byDay.set(key, [slot]);
  }

  const picked: TimeRange[] = [];
  const days = [...byDay.values()];
  // One per day first, then backfill from the earliest days if we still need more.
  for (const day of days) {
    if (picked.length >= count) break;
    picked.push(day[0]);
  }
  for (const day of days) {
    for (const slot of day.slice(1)) {
      if (picked.length >= count) break;
      picked.push(slot);
    }
  }

  return picked.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime()).slice(0, count);
}
