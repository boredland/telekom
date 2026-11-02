import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { RESOLVE_GRACE_MS, faultsOf, recordCheck, type Fault, type FaultRow, type LineRow } from "../src/monitor.ts";

const MIN = 60_000;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
let db: D1Database;
let line: LineRow;

beforeAll(async () => {
	proxy = await getPlatformProxy<Env>({ persist: false });
	db = proxy.env.DB;
	const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8").replace(/--.*$/gm, "");
	for (const statement of schema.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
});

afterAll(() => proxy?.dispose());

beforeEach(async () => {
	await db.batch([db.prepare("DELETE FROM faults"), db.prepare("DELETE FROM lines")]);
	await db.prepare("INSERT INTO lines (id, area_code, number, created_at, last_viewed_at) VALUES ('1', '069', '53440275', 0, 0)").run();
	line = (await db.prepare("SELECT * FROM lines").first<LineRow>())!;
});

const outage: Fault = { key: "K1", pageId: "…flaechenstoerung.stoerung", text: "Störung im Gebiet" };

const faults = async () => (await db.prepare("SELECT * FROM faults ORDER BY id").all<FaultRow>()).results;

describe("faultsOf", () => {
	it("maps a no-outage result to nothing and an outage to a key that changes with the message", async () => {
		expect(await faultsOf({ status: "none", pageId: "x.keine-stoerung", text: "keine" })).toEqual([]);
		const [a] = await faultsOf({ status: "outage", pageId: "x.stoerung", text: "Behebung bis 12:00" });
		const [same] = await faultsOf({ status: "outage", pageId: "x.stoerung", text: "Behebung bis 12:00" });
		const [later] = await faultsOf({ status: "outage", pageId: "x.stoerung", text: "Behebung bis 18:00" });
		expect(a.key).toBe(same.key);
		expect(a.key).not.toBe(later.key);
	});
});

describe("recordCheck", () => {
	it("opens an outage once and keeps it while it is reported", async () => {
		expect((await recordCheck(db, line, [outage], 0)).map((e) => e.type)).toEqual(["opened"]);
		expect(await recordCheck(db, line, [outage], 5 * MIN)).toEqual([]);
		const [row] = await faults();
		expect(row).toMatchObject({ first_seen: 0, last_seen: 5 * MIN, resolved_at: null, text: "Störung im Gebiet" });
		const updated = (await db.prepare("SELECT check_count FROM lines").first<{ check_count: number }>())!;
		expect(updated.check_count).toBe(2);
	});

	it("resolves only after the grace period, at the time it first went missing", async () => {
		await recordCheck(db, line, [outage], 0);
		expect(await recordCheck(db, line, [], 5 * MIN)).toEqual([]);
		expect(await recordCheck(db, line, [], 5 * MIN + RESOLVE_GRACE_MS - 1)).toEqual([]);
		const events = await recordCheck(db, line, [], 5 * MIN + RESOLVE_GRACE_MS);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "resolved", fault: { key: "K1", firstSeen: 0, resolvedAt: 5 * MIN } });
		expect((await faults())[0].resolved_at).toBe(5 * MIN);
	});

	it("treats a brief disappearance as the same episode", async () => {
		await recordCheck(db, line, [outage], 0);
		await recordCheck(db, line, [], 5 * MIN);
		expect(await recordCheck(db, line, [outage], 10 * MIN)).toEqual([]);
		const rows = await faults();
		expect(rows).toHaveLength(1);
		expect(rows[0].missing_since).toBeNull();
	});

	it("notifies only once when two checks race on the same transition", async () => {
		const [a, b] = await Promise.all([recordCheck(db, line, [outage], 0), recordCheck(db, line, [outage], 0)]);
		expect(a.length + b.length).toBe(1);
		await recordCheck(db, line, [], MIN);
		const [c, d] = await Promise.all([recordCheck(db, line, [], MIN + RESOLVE_GRACE_MS), recordCheck(db, line, [], MIN + RESOLVE_GRACE_MS)]);
		expect(c.length + d.length).toBe(1);
	});
});
