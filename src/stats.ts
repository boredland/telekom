import type { FaultRow } from "./monitor.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOWS = [7, 30, 90, 365] as const;

export interface Interval {
	start: number;
	end: number;
}

export interface WindowStats {
	days: number;
	/** Start of the window, clamped to when monitoring began. */
	from: number;
	/** Monitored time covered by the window. */
	observedMs: number;
	incidents: number;
	/** Time with at least one active outage (overlaps merged). */
	incidentMs: number;
	/** Share of observed time without an active outage. */
	availability: number | null;
	mttrMs: number | null;
	longestMs: number | null;
}

export interface Stats {
	monitoredSince: number;
	checks: number;
	errors: number;
	windows: WindowStats[];
	/** Per Berlin calendar day: minutes with an active outage, last 90 days. */
	daily: { date: string; incidentMinutes: number }[];
	/** Episodes started per hour of day (Berlin), all time. */
	byHour: number[];
	/** Episodes started per weekday (Mon=0, Berlin), all time. */
	byWeekday: number[];
}

/** An active outage ends "now"; one absent but within the grace period ends when it was last seen missing. */
export function faultInterval(f: Pick<FaultRow, "first_seen" | "missing_since" | "resolved_at">, now: number): Interval {
	return { start: f.first_seen, end: f.resolved_at ?? f.missing_since ?? now };
}

/** Total length of the union of `intervals` clipped to [from, to]. */
export function unionLength(intervals: Interval[], from: number, to: number): number {
	const clipped = intervals
		.map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
		.filter((i) => i.end > i.start)
		.sort((a, b) => a.start - b.start);
	let total = 0;
	let cursor = -Infinity;
	for (const i of clipped) {
		const start = Math.max(i.start, cursor);
		if (i.end > start) {
			total += i.end - start;
			cursor = i.end;
		}
	}
	return total;
}

const berlinParts = new Intl.DateTimeFormat("en-CA", {
	timeZone: "Europe/Berlin",
	year: "numeric",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	weekday: "short",
	hourCycle: "h23",
});
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function berlin(ts: number): { date: string; hour: number; weekday: number } {
	const parts = Object.fromEntries(berlinParts.formatToParts(ts).map((p) => [p.type, p.value]));
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		hour: Number(parts.hour),
		weekday: WEEKDAYS.indexOf(parts.weekday),
	};
}

/** Berlin calendar days as [start, end) epoch ranges, oldest first, ending with the day containing `now`. */
function berlinDays(now: number, count: number): { date: string; start: number; end: number }[] {
	const days: { date: string; start: number; end: number }[] = [];
	let end = now;
	let start = dayStart(now);
	for (let i = 0; i < count; i++) {
		days.push({ date: berlin(start).date, start, end });
		end = start;
		start = dayStart(start - 1);
	}
	return days.reverse();
}

/** Epoch ms of Berlin midnight starting the day that contains `ts`. */
function dayStart(ts: number): number {
	const { date } = berlin(ts);
	// Berlin is UTC+1 or UTC+2; midnight lies in [date 00:00 UTC − 2h, date 00:00 UTC − 1h].
	const utcMidnight = Date.parse(`${date}T00:00:00Z`);
	for (const offsetH of [2, 1]) {
		const candidate = utcMidnight - offsetH * 3600_000;
		if (berlin(candidate).date === date && berlin(candidate - 1).date !== date) return candidate;
	}
	return utcMidnight - 3600_000;
}

export function computeStats(
	faults: FaultRow[],
	line: { created_at: number; check_count: number; error_count: number },
	now: number,
): Stats {
	const monitoredSince = Math.min(line.created_at, ...faults.map((f) => f.first_seen));
	const intervals = faults.map((f) => faultInterval(f, now));

	const windows = WINDOWS.map((days): WindowStats => {
		const from = Math.max(now - days * DAY_MS, monitoredSince);
		const observedMs = Math.max(0, now - from);
		const resolved = faults.filter((f) => f.resolved_at !== null && f.resolved_at > from);
		const durations = resolved.map((f) => f.resolved_at! - f.first_seen);
		const incidentMs = unionLength(intervals, from, now);
		return {
			days,
			from,
			observedMs,
			incidents: faults.filter((f) => faultInterval(f, now).end > from).length,
			incidentMs,
			availability: observedMs > 0 ? 1 - incidentMs / observedMs : null,
			mttrMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
			longestMs: durations.length ? Math.max(...durations) : null,
		};
	});

	const daily = berlinDays(now, 90)
		.filter((d) => d.end > monitoredSince)
		.map((d) => ({ date: d.date, incidentMinutes: Math.round(unionLength(intervals, d.start, d.end) / 60_000) }));

	const byHour = new Array<number>(24).fill(0);
	const byWeekday = new Array<number>(7).fill(0);
	for (const f of faults) {
		const { hour, weekday } = berlin(f.first_seen);
		byHour[hour]++;
		byWeekday[weekday]++;
	}

	return { monitoredSince, checks: line.check_count, errors: line.error_count, windows, daily, byHour, byWeekday };
}
