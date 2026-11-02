// Nationwide disruptions from Telekom's own overview at https://www.telekom.com/de/newsroom/aktuelles/stoerungsuebersicht:
// one table row per service (MagentaTV, MagentaMobil, MagentaZuhause, Telekom Login, …) with a status symbol and text.
// The page has only ever been seen all-green, so anything but ✅ counts as a disruption and its text is shown verbatim.

import { notify, type FaultEvent } from "./notify.ts";
import type { LineRow } from "./monitor.ts";
import { UpstreamError, stripTags } from "./telekom.ts";

const OVERVIEW_URL = "https://www.telekom.com/de/newsroom/aktuelles/stoerungsuebersicht";
const TIMEOUT_MS = 15_000;
const OK_SYMBOL = "✅";
/** Services that affect a landline; a disruption of these alerts line subscribers. The others are only shown. */
const LANDLINE_SERVICES = new Set(["MagentaZuhause"]);

export interface ServiceStatus {
	service: string;
	symbol: string;
	description: string;
	ok: boolean;
}

export interface NationalIncidentRow {
	id: number;
	service: string;
	symbol: string;
	description: string;
	first_seen: number;
	last_seen: number;
	resolved_at: number | null;
}

export interface NationalEvent {
	type: "opened" | "resolved";
	incident: { service: string; description: string; firstSeen: number; resolvedAt: number | null };
}

/** Strips the leading pictograph the page puts before each service name ("📺 MagentaTV"). */
function serviceName(cell: string): string {
	return stripTags(cell).replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

export function parseOverview(html: string): ServiceStatus[] {
	const table = /<table\b[\s\S]*?<\/table>/i.exec(html)?.[0];
	if (!table) throw new UpstreamError("national overview: table not found");
	const services: ServiceStatus[] = [];
	for (const [, row] of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
		const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
		if (cells.length < 3) continue;
		const symbol = stripTags(cells[1]);
		services.push({ service: serviceName(cells[0]), symbol, description: stripTags(cells[2]), ok: symbol.includes(OK_SYMBOL) });
	}
	// The header row has <th> cells only; a table without any <td> row means the layout changed.
	if (!services.length) throw new UpstreamError("national overview: no service rows");
	return services;
}

export async function fetchOverview(env: Pick<Env, "APP_URL">): Promise<ServiceStatus[]> {
	const res = await fetch(OVERVIEW_URL, {
		headers: { "User-Agent": `telekom-stoerungen (+${env.APP_URL})`, "Accept-Language": "de-DE" },
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	if (!res.ok) throw new UpstreamError(`national overview: HTTP ${res.status}`);
	return parseOverview(await res.text());
}

/**
 * Stores one observation and returns open/resolve transitions. A service is in an episode while its symbol isn't ✅;
 * text changes during an episode update it in place. Only the cron writes here, so there's no concurrent writer.
 */
export async function recordOverview(db: D1Database, services: ServiceStatus[], now: number): Promise<NationalEvent[]> {
	const { results: active } = await db.prepare("SELECT * FROM national_incidents WHERE resolved_at IS NULL").all<NationalIncidentRow>();
	const activeByService = new Map(active.map((r) => [r.service, r]));
	const statements: D1PreparedStatement[] = [];
	const events: NationalEvent[] = [];

	for (const s of services) {
		const existing = activeByService.get(s.service);
		if (s.ok) {
			if (!existing) continue;
			statements.push(db.prepare("UPDATE national_incidents SET resolved_at = ? WHERE id = ?").bind(now, existing.id));
			events.push({
				type: "resolved",
				incident: { service: s.service, description: existing.description, firstSeen: existing.first_seen, resolvedAt: now },
			});
		} else if (existing) {
			statements.push(
				db.prepare("UPDATE national_incidents SET symbol = ?, description = ?, last_seen = ? WHERE id = ?").bind(s.symbol, s.description, now, existing.id),
			);
		} else {
			statements.push(
				db
					.prepare("INSERT INTO national_incidents (service, symbol, description, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)")
					.bind(s.service, s.symbol, s.description, now, now),
			);
			events.push({ type: "opened", incident: { service: s.service, description: s.description, firstSeen: now, resolvedAt: null } });
		}
	}
	// A service dropped from the table can't be judged either way; its episode stays open until it reappears as ✅.
	if (statements.length) await db.batch(statements);
	return events;
}

export async function syncNational(env: Env, now: number): Promise<NationalEvent[]> {
	const services = await fetchOverview(env);
	const events = await recordOverview(env.DB, services, now);
	console.log(`national: ${services.length} services, ${services.filter((s) => !s.ok).length} disrupted, ${events.length} transitions`);
	return events;
}

/** Disruptions of landline services go to every confirmed subscriber; the rest are only shown on the page. */
export async function notifyNational(env: Env, events: NationalEvent[]): Promise<void> {
	const relevant = events.filter((e) => LANDLINE_SERVICES.has(e.incident.service));
	if (!relevant.length) return;
	const { results: lines } = await env.DB.prepare(
		"SELECT DISTINCT l.* FROM lines l JOIN subscriptions s ON s.line_id = l.id AND s.confirmed_at IS NOT NULL",
	).all<LineRow>();
	await Promise.all(lines.map((line) => notify(env, relevant.map((e) => toFaultEvent(e, line)))));
}

function toFaultEvent({ type, incident }: NationalEvent, line: LineRow): FaultEvent {
	return {
		type,
		line,
		fault: {
			key: `national:${incident.service}:${incident.firstSeen}`,
			title: `bundesweite Störung ${incident.service}`,
			text: incident.description,
			firstSeen: incident.firstSeen,
			resolvedAt: incident.resolvedAt,
		},
	};
}

export async function nationalIncidents(db: D1Database, { activeOnly = false, limit = 100 } = {}): Promise<NationalIncidentRow[]> {
	const where = activeOnly ? "WHERE resolved_at IS NULL" : "";
	const { results } = await db.prepare(`SELECT * FROM national_incidents ${where} ORDER BY first_seen DESC LIMIT ?`).bind(limit).all<NationalIncidentRow>();
	return results;
}

export function publicNationalIncident(r: NationalIncidentRow) {
	return { service: r.service, symbol: r.symbol, description: r.description, firstSeen: r.first_seen, resolvedAt: r.resolved_at };
}
