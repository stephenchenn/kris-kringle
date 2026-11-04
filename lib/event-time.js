const DEFAULT_ZONE = 'Australia/Adelaide';

function dateParts(timestamp, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
}

function midnight(date, zone) {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let value = target;
  for (let i = 0; i < 4; i++) {
    const local = dateParts(value, zone);
    const shift = target - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    value += shift;
    if (!shift) break;
  }
  return value;
}

function eventSchedule(event, now = Date.now()) {
  const zone = event.event_timezone || DEFAULT_ZONE;
  try {
    if (!event.event_date) return { phase: 'unavailable', timezone: zone, locks_at: null, reveals_at: null };
    const onlyDate = /^\d{4}-\d{2}-\d{2}$/.test(event.event_date);
    if (!onlyDate && !/(Z|[+-]\d{2}:\d{2})$/i.test(event.event_date)) throw new Error('Event time needs an offset');
    const instant = Date.parse(event.event_date);
    if (!Number.isFinite(instant)) throw new Error('Invalid event date');
    const local = onlyDate
      ? Object.fromEntries(['year', 'month', 'day'].map((key, index) => [key, Number(event.event_date.split('-')[index])]))
      : dateParts(instant, zone);
    const calendar = new Date(Date.UTC(local.year,local.month-1,local.day));
    if (calendar.getUTCFullYear()!==local.year || calendar.getUTCMonth()+1!==local.month || calendar.getUTCDate()!==local.day) throw new Error('Invalid calendar date');
    const lock = midnight(local, zone);
    const next = new Date(Date.UTC(local.year, local.month - 1, local.day + 1));
    const end = midnight({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, zone);
    const reveal = onlyDate ? end : instant;
    if (reveal < lock) throw new Error('Invalid schedule');
    return { phase: now >= reveal ? 'results' : now >= lock ? 'locked' : 'open', timezone: zone,
      locks_at: new Date(lock).toISOString(), reveals_at: new Date(reveal).toISOString() };
  } catch {
    return { phase: 'unavailable', timezone: zone, locks_at: null, reveals_at: null };
  }
}

module.exports = { eventSchedule, DEFAULT_ZONE };
