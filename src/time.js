// Turning "NA, Saturday, 21:00" into a moment in time, in the region's own time zone (DST included).

export const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** "21:00", "21", "9pm", "9:30 PM", "21.30" → { hour, minute }, or null. */
export function parseTime(text) {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(String(text ?? ""));
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const ampm = m[3]?.toLowerCase();
  if (minute > 59) return null;
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  } else if (hour > 23) return null;
  return { hour, minute };
}

/** The wall-clock date and time a moment shows in a time zone. */
function wallClock(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "long",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: DAYS.indexOf(get("weekday").toLowerCase()),
  };
}

/** The moment (ms) when the clock in `timeZone` shows that date and time. */
export function zonedToUtc({ year, month, day, hour, minute }, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  // Two rounds settle the zone's offset, also across a DST change.
  for (let i = 0; i < 2; i++) {
    const w = wallClock(guess, timeZone);
    const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
    guess += target - shown;
  }
  return guess;
}

/**
 * The next time it's `day` at `time` in the time zone, from `nowMs`. `day` is a weekday name,
 * "today" or "tomorrow". A weekday that's today but whose time has passed means next week.
 */
export function nextStart(day, time, timeZone, nowMs = Date.now()) {
  const today = wallClock(nowMs, timeZone);
  let ahead;
  if (day === "today") ahead = 0;
  else if (day === "tomorrow") ahead = 1;
  else {
    const target = DAYS.indexOf(day);
    if (target < 0) throw new Error(`Unknown day: ${day}`);
    ahead = (target - today.weekday + 7) % 7;
  }
  const at = (n) => {
    const d = new Date(Date.UTC(today.year, today.month - 1, today.day + n));
    return zonedToUtc(
      { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: time.hour, minute: time.minute },
      timeZone,
    );
  };
  let start = at(ahead);
  if (start <= nowMs && DAYS.includes(day)) start = at(ahead + 7);
  return start;
}

/** Discord shows <t:…> in each reader's own time zone. */
export const discordTime = (ms, style = "F") => `<t:${Math.floor(ms / 1000)}:${style}>`;
