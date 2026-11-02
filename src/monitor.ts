import { notifyNational, syncNational } from "./national.ts";
import { notify, type FaultEvent } from "./notify.ts";
import { checkAreaOutage, type AreaCheck } from "./telekom.ts";

/** Lines viewed within this window keep being polled so their statistics stay complete. */
export const WATCH_MS = 30 * 24 * 60 * 60 * 1000;
/** An outage must stay absent this long before it counts as resolved; absorbs flapping upstream results. */
export const RESOLVE_GRACE_MS = 9 * 60 * 1000;
/** Results younger than this are served from D1 instead of querying Telekom again. */
export const FRESH_MS = 2 * 60 * 1000;

// Each check is ~14 subrequests (login-check redirects, captcha, POST); Workers allow 1000 per invocation on the paid
// plan. 4 in parallel at ~1.5 s each fit the cron interval comfortably.
const MAX_LINES_PER_RUN = 60;
const CONCURRENCY = 4;
const UNCONFIRMED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface LineRow {
	id: string;
	area_code: string;
	number: string;
	created_at: number;
	last_viewed_at: number;
	last_checked_at: number | null;
	check_count: number;
	error_count: number;
	last_error: string | null;
}

export interface FaultRow {
	id: number;
	line_id: string;
	fault_key: string;
	page_id: string;
	text: string;
	first_seen: number;
	last_seen: number;
	missing_since: number | null;
	resolved_at: number | null;
}

export interface Fault {
	key: string;
	pageId: string;
	text: string;
}

const encoder = new TextEncoder();

async function sha256(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
	return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function lineId(areaCode: string, number: string): Promise<string> {
	return sha256(`${areaCode}/${number}`);
}

/** The outage reported by one check, or none. */
export async function faultsOf(check: AreaCheck): Promise<Fault[]> {
	if (check.status === "none") return [];
	return [{ key: (await sha256(`${check.pageId}\n${check.text}`)).slice(0, 16), pageId: check.pageId, text: check.text }];
}

/** Stores one observation of a line and returns the resulting outage transitions. */
export async function recordCheck(db: D1Database, line: LineRow, faults: Fault[], now: number): Promise<FaultEvent[]> {
	const { results: active } = await db
		.prepare("SELECT * FROM faults WHERE line_id = ? AND resolved_at IS NULL")
		.bind(line.id)
		.all<FaultRow>();
	const activeByKey = new Map(active.map((f) => [f.fault_key, f]));
	const statements: D1PreparedStatement[] = [];
	// Statements whose `changes` decide whether an event fires; concurrent checks (cron vs. page view)
	// race on the same rows, and only the one that actually changed a row notifies.
	const pending: { index: number; event: FaultEvent }[] = [];

	for (const fault of faults) {
		const existing = activeByKey.get(fault.key);
		if (existing) {
			statements.push(db.prepare("UPDATE faults SET last_seen = ?, missing_since = NULL WHERE id = ?").bind(now, existing.id));
			continue;
		}
		pending.push({
			index: statements.length,
			event: { type: "opened", line, fault: { key: fault.key, text: fault.text, firstSeen: now, resolvedAt: null } },
		});
		statements.push(
			db
				.prepare(
					`INSERT OR IGNORE INTO faults (line_id, fault_key, page_id, text, first_seen, last_seen)
					VALUES (?, ?, ?, ?, ?, ?)`,
				)
				.bind(line.id, fault.key, fault.pageId, fault.text, now, now),
		);
	}

	const seen = new Set(faults.map((f) => f.key));
	for (const row of active) {
		if (seen.has(row.fault_key)) continue;
		if (row.missing_since === null) {
			statements.push(db.prepare("UPDATE faults SET missing_since = ? WHERE id = ?").bind(now, row.id));
		} else if (now - row.missing_since >= RESOLVE_GRACE_MS) {
			pending.push({
				index: statements.length,
				event: {
					type: "resolved",
					line,
					fault: { key: row.fault_key, text: row.text, firstSeen: row.first_seen, resolvedAt: row.missing_since },
				},
			});
			statements.push(db.prepare("UPDATE faults SET resolved_at = missing_since WHERE id = ? AND resolved_at IS NULL").bind(row.id));
		}
	}

	statements.push(
		db
			.prepare("UPDATE lines SET last_checked_at = ?, check_count = check_count + 1, last_error = NULL WHERE id = ?")
			.bind(now, line.id),
	);

	const results = await db.batch(statements);
	return pending.filter((p) => results[p.index].meta.changes > 0).map((p) => p.event);
}

export async function recordError(db: D1Database, lineId: string, err: unknown, now: number): Promise<void> {
	await db
		.prepare("UPDATE lines SET last_checked_at = ?, error_count = error_count + 1, last_error = ? WHERE id = ?")
		.bind(now, String(err).slice(0, 500), lineId)
		.run();
}

export function userAgent(env: Pick<Env, "APP_URL">): string {
	return `telekom-stoerungen (+${env.APP_URL})`;
}

/** Queries Telekom for one line, records the result, and returns transitions to notify about. */
export async function checkLine(env: Env, line: LineRow): Promise<FaultEvent[]> {
	const now = Date.now();
	let check: AreaCheck;
	try {
		check = await checkAreaOutage(line.area_code, line.number, { userAgent: userAgent(env) });
	} catch (err) {
		await recordError(env.DB, line.id, err, now);
		throw err;
	}
	return recordCheck(env.DB, line, await faultsOf(check), now);
}

export async function runMonitor(env: Env, now = Date.now()): Promise<void> {
	await env.DB.prepare("DELETE FROM subscriptions WHERE confirmed_at IS NULL AND created_at < ?")
		.bind(now - UNCONFIRMED_TTL_MS)
		.run();
	await Promise.all([checkLines(env, now), syncNationalIncidents(env, now)]);
}

async function syncNationalIncidents(env: Env, now: number): Promise<void> {
	try {
		const events = await syncNational(env, now);
		if (events.length) await notifyNational(env, events);
	} catch (err) {
		console.error("national sync failed:", err);
	}
}

async function checkLines(env: Env, now: number): Promise<void> {
	// Oldest first, so lines beyond the per-run cap are picked up by the next run.
	const { results: lines } = await env.DB.prepare(
		`SELECT l.* FROM lines l
		WHERE l.last_viewed_at > ?1
			OR EXISTS (SELECT 1 FROM subscriptions s WHERE s.line_id = l.id AND s.confirmed_at IS NOT NULL)
		ORDER BY l.last_checked_at IS NOT NULL, l.last_checked_at
		LIMIT ?2`,
	)
		.bind(now - WATCH_MS, MAX_LINES_PER_RUN)
		.all<LineRow>();

	let next = 0;
	let failed = 0;
	const worker = async () => {
		while (next < lines.length) {
			const line = lines[next++];
			try {
				const events = await checkLine(env, line);
				if (events.length) await notify(env, events);
			} catch (err) {
				failed++;
				console.error(`check ${line.id} failed:`, err);
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	console.log(`monitor: checked ${lines.length} lines, ${failed} failed`);
}
