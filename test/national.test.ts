import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getPlatformProxy } from "wrangler";
import { parseOverview, recordOverview, type NationalIncidentRow, type ServiceStatus } from "../src/national.ts";
import { UpstreamError } from "../src/telekom.ts";

const real = readFileSync(new URL("fixtures/stoerungsuebersicht-table.html", import.meta.url), "utf8");

describe("parseOverview", () => {
	it("reads every service of the real all-green table, without the leading pictographs", () => {
		const services = parseOverview(real);
		expect(services.map((s) => s.service)).toEqual([
			"MagentaTV",
			"MagentaMobil",
			"MagentaZuhause",
			"Telekom Login",
			"Telekom Mail",
			"Kundenservice",
			"Sicherheit",
		]);
		expect(services.every((s) => s.ok && s.description === "Keine bekannten größeren Einschränkungen")).toBe(true);
	});

	it("treats any symbol other than ✅ as a disruption and keeps its text", () => {
		const disrupted = real.replace(
			/(MagentaZuhause<\/td>\s*<td[^>]*>)✅(<\/td>\s*<td>)[^<]*/,
			"$1⚠️$2Störung bei DSL und Glasfaser in &amp; um Köln",
		);
		const zuhause = parseOverview(disrupted).find((s) => s.service === "MagentaZuhause")!;
		expect(zuhause).toEqual({ service: "MagentaZuhause", symbol: "⚠️", description: "Störung bei DSL und Glasfaser in & um Köln", ok: false });
	});

	it("fails loudly when the layout changes instead of reporting everything as fine", () => {
		expect(() => parseOverview("<main><p>Alles gut</p></main>")).toThrow(UpstreamError);
		expect(() => parseOverview("<table><tr><th>Dienste</th></tr></table>")).toThrow(UpstreamError);
	});
});

describe("recordOverview", () => {
	let proxy: Awaited<ReturnType<typeof getPlatformProxy<Env>>>;
	let db: D1Database;

	beforeAll(async () => {
		proxy = await getPlatformProxy<Env>({ persist: false });
		db = proxy.env.DB;
		for (const file of ["0001_init.sql", "0002_national_incidents.sql"]) {
			const schema = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8").replace(/--.*$/gm, "");
			for (const statement of schema.split(";").filter((s) => s.trim())) await db.prepare(statement).run();
		}
	});

	afterAll(() => proxy?.dispose());
	beforeEach(() => db.prepare("DELETE FROM national_incidents").run());

	const status = (service: string, ok: boolean, description = ok ? "Keine bekannten größeren Einschränkungen" : "Störung"): ServiceStatus => ({
		service,
		symbol: ok ? "✅" : "⚠️",
		description,
		ok,
	});
	const rows = async () => (await db.prepare("SELECT * FROM national_incidents ORDER BY id").all<NationalIncidentRow>()).results;

	it("opens an episode once, updates its text in place, and resolves it when the service is green again", async () => {
		expect(await recordOverview(db, [status("MagentaTV", true)], 0)).toEqual([]);
		expect((await recordOverview(db, [status("MagentaZuhause", false, "DSL gestört")], 1)).map((e) => e.type)).toEqual(["opened"]);
		expect(await recordOverview(db, [status("MagentaZuhause", false, "DSL gestört, Behebung bis 18 Uhr")], 2)).toEqual([]);
		const [open] = await rows();
		expect(open).toMatchObject({ service: "MagentaZuhause", description: "DSL gestört, Behebung bis 18 Uhr", first_seen: 1, last_seen: 2 });

		const [resolved] = await recordOverview(db, [status("MagentaZuhause", true)], 3);
		expect(resolved).toMatchObject({ type: "resolved", incident: { service: "MagentaZuhause", firstSeen: 1, resolvedAt: 3 } });
		expect((await rows())[0].resolved_at).toBe(3);
	});

	it("keeps an episode open while its service is missing from the table", async () => {
		await recordOverview(db, [status("MagentaMobil", false)], 0);
		expect(await recordOverview(db, [status("MagentaTV", true)], 1)).toEqual([]);
		expect((await rows())[0].resolved_at).toBeNull();
	});

	it("starts a new episode when a resolved service is disrupted again", async () => {
		await recordOverview(db, [status("Telekom Login", false)], 0);
		await recordOverview(db, [status("Telekom Login", true)], 1);
		expect((await recordOverview(db, [status("Telekom Login", false)], 2)).map((e) => e.type)).toEqual(["opened"]);
		expect((await rows()).map((r) => r.resolved_at)).toEqual([1, null]);
	});
});
