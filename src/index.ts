import { Hono, type Context } from "hono";
import { FRESH_MS, checkLine, lineId, runMonitor, type FaultRow, type LineRow } from "./monitor.ts";
import { notify, sendConfirmationEmail } from "./notify.ts";
import { nationalIncidents, publicNationalIncident } from "./national.ts";
import { computeStats } from "./stats.ts";
import { InvalidNumberError, UpstreamError, normalizeNumber } from "./telekom.ts";
import { b64urlEncode, isAllowedEndpoint, isValidSubscription } from "./webpush.ts";

const app = new Hono<{ Bindings: Env }>().basePath("/api");

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HISTORY_LIMIT = 100;

function clientIp(c: Context): string {
	return c.req.header("cf-connecting-ip") ?? "local";
}

async function limited(limiter: RateLimit, key: string): Promise<boolean> {
	return !(await limiter.limit({ key })).success;
}

function newToken(): string {
	return b64urlEncode(crypto.getRandomValues(new Uint8Array(24)));
}

app.onError((err, c) => {
	if (err instanceof UpstreamError || err.name === "TimeoutError") {
		console.warn("upstream:", err.message);
		return c.json({ error: "Die Telekom-Störungsauskunft ist gerade nicht erreichbar." }, 502);
	}
	console.error(err);
	return c.json({ error: "Interner Fehler" }, 500);
});

/** Registers a landline number. The ID is a hash, so links and push payloads don't contain the number itself. */
app.post("/lines", async (c) => {
	if (await limited(c.env.LOOKUP_LIMITER, clientIp(c))) return c.json({ error: "Zu viele Anfragen" }, 429);
	const body = await c.req.json<{ areaCode?: string; number?: string }>().catch(() => ({}) as { areaCode?: string; number?: string });
	let line: { areaCode: string; number: string };
	try {
		line = normalizeNumber(body.areaCode ?? "", body.number ?? "");
	} catch (err) {
		if (err instanceof InvalidNumberError) return c.json({ error: "Bitte Vorwahl (mit 0) und Rufnummer prüfen." }, 400);
		throw err;
	}
	const id = await lineId(line.areaCode, line.number);
	const now = Date.now();
	await c.env.DB.prepare(
		"INSERT OR IGNORE INTO lines (id, area_code, number, created_at, last_viewed_at) VALUES (?, ?, ?, ?, ?)",
	)
		.bind(id, line.areaCode, line.number, now, now)
		.run();
	return c.json({ id });
});

/** Current status. Checks Telekom unless the stored result is fresh. */
app.get("/lines/:id", async (c) => {
	const id = c.req.param("id");
	let line = await c.env.DB.prepare("SELECT * FROM lines WHERE id = ?").bind(id).first<LineRow>();
	if (!line) return c.json({ error: "Unbekannter Anschluss" }, 404);

	const now = Date.now();
	await c.env.DB.prepare("UPDATE lines SET last_viewed_at = ? WHERE id = ?").bind(now, id).run();
	let checkError: string | null = null;
	if (!line.last_checked_at || now - line.last_checked_at > FRESH_MS) {
		if (await limited(c.env.LOOKUP_LIMITER, clientIp(c))) {
			checkError = "Zu viele Anfragen; zeige gespeicherten Stand.";
		} else {
			try {
				const events = await checkLine(c.env, line);
				if (events.length) c.executionCtx.waitUntil(notify(c.env, events));
			} catch (err) {
				console.warn(`live check ${id} failed:`, err);
				checkError =
					err instanceof InvalidNumberError
						? `Die Telekom lehnt diese Rufnummer ab: ${err.message}`
						: "Die Telekom-Störungsauskunft ist gerade nicht erreichbar; zeige gespeicherten Stand.";
			}
			line = (await c.env.DB.prepare("SELECT * FROM lines WHERE id = ?").bind(id).first<LineRow>())!;
		}
	}

	const [{ results: active }, national] = await Promise.all([
		c.env.DB.prepare("SELECT * FROM faults WHERE line_id = ? AND resolved_at IS NULL ORDER BY first_seen DESC")
			.bind(id)
			.all<FaultRow>(),
		nationalIncidents(c.env.DB, { activeOnly: true }),
	]);
	return c.json({
		line: publicLine(line),
		checkedAt: line.last_checked_at,
		checkError,
		faults: active.map(publicFault),
		national: national.map(publicNationalIncident),
	});
});

/** Nationwide disruptions from Telekom's overview, kept apart from the per-line statistics. */
app.get("/national", async (c) => {
	return c.json({ incidents: (await nationalIncidents(c.env.DB, { limit: HISTORY_LIMIT })).map(publicNationalIncident) });
});

app.get("/lines/:id/stats", async (c) => {
	const id = c.req.param("id");
	const line = await c.env.DB.prepare("SELECT * FROM lines WHERE id = ?").bind(id).first<LineRow>();
	if (!line) return c.json({ error: "Unbekannter Anschluss" }, 404);
	const { results: faults } = await c.env.DB.prepare("SELECT * FROM faults WHERE line_id = ? ORDER BY first_seen DESC")
		.bind(id)
		.all<FaultRow>();
	return c.json({
		stats: computeStats(faults, line, Date.now()),
		history: faults.slice(0, HISTORY_LIMIT).map(publicFault),
		historyTotal: faults.length,
	});
});

function publicLine(l: LineRow) {
	return { id: l.id, areaCode: l.area_code, number: l.number, monitoredSince: l.created_at };
}

function publicFault(f: FaultRow) {
	return { text: f.text, firstSeen: f.first_seen, lastSeen: f.last_seen, resolvedAt: f.resolved_at };
}

app.get("/vapid-public-key", (c) => c.json({ key: c.env.VAPID_PUBLIC_KEY }));

app.post("/lines/:id/subscriptions", async (c) => {
	const id = c.req.param("id");
	if (await limited(c.env.SUBSCRIBE_LIMITER, clientIp(c))) return c.json({ error: "Zu viele Anfragen" }, 429);
	const line = await c.env.DB.prepare("SELECT * FROM lines WHERE id = ?").bind(id).first<LineRow>();
	if (!line) return c.json({ error: "Unbekannter Anschluss" }, 404);

	type Body =
		| { kind: "push"; subscription: { endpoint: string; keys: { p256dh: string; auth: string } } }
		| { kind: "email"; email: string };
	const body = await c.req.json<Body>().catch(() => null);
	const now = Date.now();

	if (body?.kind === "push") {
		const endpoint = body.subscription?.endpoint;
		const p256dh = body.subscription?.keys?.p256dh;
		const auth = body.subscription?.keys?.auth;
		if (!endpoint || !p256dh || !auth || !isAllowedEndpoint(endpoint) || !isValidSubscription({ endpoint, p256dh, auth })) {
			return c.json({ error: "Ungültiges Push-Abonnement" }, 400);
		}
		// Push subscriptions are possessed only by the browser that created them, so they need no confirmation.
		const token = newToken();
		const row = await c.env.DB.prepare(
			`INSERT INTO subscriptions (line_id, kind, target, p256dh, auth, token, confirmed_at, created_at)
			VALUES (?, 'push', ?, ?, ?, ?, ?, ?)
			ON CONFLICT (line_id, kind, target) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
			RETURNING token`,
		)
			.bind(id, endpoint, p256dh, auth, token, now, now)
			.first<{ token: string }>();
		return c.json({ status: "subscribed", token: row!.token });
	}

	if (body?.kind === "email") {
		const email = body.email?.trim().toLowerCase();
		if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) return c.json({ error: "Ungültige E-Mail-Adresse" }, 400);
		if (await limited(c.env.SUBSCRIBE_LIMITER, `email:${email}`)) return c.json({ error: "Zu viele Anfragen" }, 429);
		const existing = await c.env.DB.prepare("SELECT token, confirmed_at FROM subscriptions WHERE line_id = ? AND kind = 'email' AND target = ?")
			.bind(id, email)
			.first<{ token: string; confirmed_at: number | null }>();
		// Same response whether or not the address is already subscribed, so the endpoint doesn't reveal subscribers.
		if (existing?.confirmed_at) return c.json({ status: "pending" });
		const token = existing?.token ?? newToken();
		if (!existing) {
			await c.env.DB.prepare("INSERT INTO subscriptions (line_id, kind, target, token, created_at) VALUES (?, 'email', ?, ?, ?)")
				.bind(id, email, token, now)
				.run();
		}
		await sendConfirmationEmail(c.env, email, line, token);
		return c.json({ status: "pending" });
	}

	return c.json({ error: "Unbekannte Abo-Art" }, 400);
});

app.post("/confirm", async (c) => {
	const { token } = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
	if (!token) return c.json({ error: "Token fehlt" }, 400);
	const row = await c.env.DB.prepare("UPDATE subscriptions SET confirmed_at = coalesce(confirmed_at, ?) WHERE token = ? RETURNING line_id")
		.bind(Date.now(), token)
		.first<{ line_id: string }>();
	if (!row) return c.json({ error: "Link ungültig oder abgelaufen" }, 404);
	return c.json({ lineId: row.line_id });
});

/** Called by the page (JSON body) and by mail clients for RFC 8058 one-click unsubscribe (token in query). */
app.post("/unsubscribe", async (c) => {
	const body = await c.req.json<{ token?: string }>().catch(() => ({ token: undefined }));
	const token = c.req.query("token") ?? body.token;
	if (!token) return c.json({ error: "Token fehlt" }, 400);
	const row = await c.env.DB.prepare("DELETE FROM subscriptions WHERE token = ? RETURNING line_id")
		.bind(token)
		.first<{ line_id: string }>();
	return c.json({ lineId: row?.line_id ?? null });
});

export default {
	fetch: app.fetch,
	async scheduled(_controller, env, ctx) {
		ctx.waitUntil(runMonitor(env));
	},
} satisfies ExportedHandler<Env>;
