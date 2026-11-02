import { describe, expect, it } from "vitest";
import type { FaultRow } from "../src/monitor.ts";
import { computeStats, unionLength } from "../src/stats.ts";

const H = 3600_000;
const DAY = 24 * H;
const NOW = Date.parse("2026-10-13T12:00:00Z");

function fault(overrides: Partial<FaultRow>): FaultRow {
	return {
		id: 1,
		line_id: "1",
		fault_key: "F",
		page_id: "p",
		text: "Störung",
		first_seen: NOW - H,
		last_seen: NOW,
		missing_since: null,
		resolved_at: null,
		...overrides,
	};
}

describe("unionLength", () => {
	it("merges overlapping and nested intervals", () => {
		const intervals = [
			{ start: 0, end: 10 },
			{ start: 5, end: 15 },
			{ start: 6, end: 7 },
			{ start: 20, end: 30 },
		];
		expect(unionLength(intervals, 0, 100)).toBe(25);
	});

	it("clips to the window", () => {
		expect(unionLength([{ start: 0, end: 100 }], 40, 60)).toBe(20);
		expect(unionLength([{ start: 0, end: 10 }], 20, 30)).toBe(0);
	});
});

describe("computeStats", () => {
	const line = { created_at: NOW - 10 * DAY, check_count: 100, error_count: 2 };

	it("counts overlapping outages once towards downtime and availability", () => {
		const stats = computeStats(
			[
				fault({ id: 1, first_seen: NOW - 5 * H, resolved_at: NOW - 3 * H }),
				fault({ id: 2, fault_key: "G", first_seen: NOW - 4 * H, resolved_at: NOW - 2 * H }),
			],
			line,
			NOW,
		);
		const week = stats.windows[0];
		expect(week.incidents).toBe(2);
		expect(week.incidentMs).toBe(3 * H);
		expect(week.observedMs).toBe(7 * DAY);
		expect(week.availability).toBeCloseTo(1 - 3 / (7 * 24));
		expect(week.mttrMs).toBe(2 * H);
		expect(week.longestMs).toBe(2 * H);
	});

	it("clamps windows to the monitoring start", () => {
		const stats = computeStats([], line, NOW);
		expect(stats.windows[1].from).toBe(line.created_at);
		expect(stats.windows[1].observedMs).toBe(10 * DAY);
		expect(stats.windows[1].availability).toBe(1);
	});

	it("ends an outage that went missing at missing_since, and an active one now", () => {
		const stats = computeStats(
			[fault({ id: 1, first_seen: NOW - 3 * H, missing_since: NOW - 2 * H }), fault({ id: 2, fault_key: "G", first_seen: NOW - H })],
			line,
			NOW,
		);
		expect(stats.windows[0].incidentMs).toBe(2 * H);
		expect(stats.windows[0].mttrMs).toBeNull();
	});

	it("splits daily minutes on Berlin midnight across DST", () => {
		// 2026-10-25 is the end of DST in Germany: that Berlin day lasts 25 hours.
		const now = Date.parse("2026-10-26T12:00:00Z");
		const stats = computeStats(
			// 23:30–00:30 Berlin (CET, UTC+1) across the night into Oct 26.
			[fault({ first_seen: Date.parse("2026-10-25T22:30:00Z"), resolved_at: Date.parse("2026-10-25T23:30:00Z") })],
			{ created_at: now - 30 * DAY, check_count: 0, error_count: 0 },
			now,
		);
		const byDate = Object.fromEntries(stats.daily.map((d) => [d.date, d.incidentMinutes]));
		expect(byDate["2026-10-25"]).toBe(30);
		expect(byDate["2026-10-26"]).toBe(30);
		expect(stats.daily.at(-1)!.date).toBe("2026-10-26");
		expect(new Set(stats.daily.map((d) => d.date)).size).toBe(stats.daily.length);
		// Started 23:30 Berlin on a Sunday.
		expect(stats.byHour[23]).toBe(1);
		expect(stats.byWeekday[6]).toBe(1);
	});
});
