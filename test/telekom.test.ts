import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkAreaOutage, InvalidNumberError, normalizeNumber, parsePage, UpstreamError } from "../src/telekom.ts";

// Real captchas with known answers, served by the fake in order.
const testDir = new URL("../captcha/test/", import.meta.url);
const captchas = readdirSync(testDir)
	.filter((f) => f.endsWith(".png"))
	.sort()
	.map((f) => ({ png: readFileSync(new URL(f, testDir)), text: f.slice(0, -4).split("-")[1] }));

const formPage = (step: string, error = "") => `<html><script>utag_data = {
page_content_id : "www.telekom.de.privatkunden.magenta\\-service.flaechenstoerung.l3light"
}</script><main>
<form method="POST" action="https://www.telekom.de/hilfe/hilfe-bei-stoerungen/flaechenstoerung?execution1=${step}" id="flowModel">
<input type="hidden" name="_csrf" value="csrf-${step}"/>
<input name="credentials.connection.areaCode"/><input name="credentials.connection.callNumber"/>
${error ? `<p class="error">${error}</p>` : ""}
<input type="text" name="captchaCode"/><button type="submit" name="_eventId_submit" value="Submit">Weiter</button>
</form></main></html>`;

const resultPage = (id: string, text: string) => `<html><script>utag_data = {
page_content_id : "www.telekom.de.privatkunden.magenta\\-service.flaechenstoerung.${id}"
}</script><main><h1>Informationsservice Flächenstörung</h1><p class="u-devider">${text}</p>
<form method="POST" action="https://www.telekom.de/hilfe/hilfe-bei-stoerungen/flaechenstoerung?execution1=e1s3">
<input type="hidden" name="_csrf" value="x"/><button name="_eventId_end">Diagnose starten</button></form></main></html>`;

const CAPTCHA_ERROR = "Der Code wurde nicht oder nicht korrekt eingegeben.";

/**
 * Minimal stand-in for www.telekom.de: one session cookie, the silent-login redirect hop, the form, a captcha bound to
 * the session, and `verdict`'s page once a POST carries the right captcha and CSRF token.
 */
function fakeTelekom(verdict: (form: URLSearchParams) => string, opts: { waf?: boolean } = {}) {
	let served = 0;
	let current: string | undefined;
	let result = "";
	const posts: URLSearchParams[] = [];
	const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const cookie = new Headers(init?.headers).get("cookie") ?? "";
		const html = (body: string) => new Response(body, { headers: { "content-type": "text/html" } });
		if (opts.waf) return new Response("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
		if (url.pathname === "/hilfe/hilfe-bei-stoerungen/flaechenstoerung" && !url.search) {
			return new Response(null, {
				status: 302,
				headers: { location: "/tech/sam/ess/check", "set-cookie": "VPJSESSIONID=s1; Path=/; HttpOnly" },
			});
		}
		if (url.pathname === "/tech/sam/ess/check") {
			return new Response(null, { status: 302, headers: { location: "/hilfe/hilfe-bei-stoerungen/flaechenstoerung?execution1=e1s2" } });
		}
		if (!cookie.includes("VPJSESSIONID=s1")) return new Response("no session", { status: 403 });
		if (url.pathname === "/tech/captcha") {
			const c = captchas[served++ % captchas.length];
			current = c.text;
			return new Response(c.png, { headers: { "content-type": "image/png;charset=UTF-8" } });
		}
		if (init?.method === "POST") {
			const form = new URLSearchParams(String(init.body));
			posts.push(form);
			const ok = current !== undefined && form.get("captchaCode") === current && form.get("_csrf") === `csrf-${url.searchParams.get("execution1")}`;
			current = undefined;
			if (ok) result = verdict(form);
			return new Response(null, { status: 302, headers: { location: `/hilfe/hilfe-bei-stoerungen/flaechenstoerung?execution1=${ok ? "e1s3" : "e1s2"}` } });
		}
		const step = url.searchParams.get("execution1");
		if (step === "e1s2") return html(formPage("e1s2", posts.length ? CAPTCHA_ERROR : ""));
		if (step === "e1s3") return html(result);
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetcher, posts, captchasServed: () => served };
}

const options = (fetcher: typeof fetch) => ({ userAgent: "test", fetcher });

describe("checkAreaOutage", () => {
	it("solves the captcha, posts the split number and reports no outage", async () => {
		const fake = fakeTelekom(() => resultPage("fehler.keine\\-stoerung", "Zu der eingegebenen Rufnummer können wir keine Beeinträchtigung feststellen."));
		const result = await checkAreaOutage("069", "5344 0275", options(fake.fetcher));
		expect(result.status).toBe("none");
		expect(result.pageId).toBe("www.telekom.de.privatkunden.magenta-service.flaechenstoerung.fehler.keine-stoerung");
		expect(fake.posts).toHaveLength(1);
		expect(fake.posts[0].get("credentials.connection.areaCode")).toBe("069");
		expect(fake.posts[0].get("credentials.connection.callNumber")).toBe("53440275");
	});

	it("reports any other result page as an outage, with its text", async () => {
		const fake = fakeTelekom(() => resultPage("stoerung", "In Ihrer Region liegt eine Störung vor. Voraussichtliche Behebung: 03.11.2026 &amp; später"));
		const result = await checkAreaOutage("069", "53440275", options(fake.fetcher));
		expect(result.status).toBe("outage");
		expect(result.text).toBe("In Ihrer Region liegt eine Störung vor. Voraussichtliche Behebung: 03.11.2026 & später");
	});

	it("retries with a fresh captcha when the answer is rejected", async () => {
		const fake = fakeTelekom(() => resultPage("fehler.keine\\-stoerung", "keine"));
		// Corrupt the first answer by intercepting the first POST.
		let first = true;
		const sabotaged = (async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST" && first) {
				first = false;
				const body = new URLSearchParams(String(init.body));
				body.set("captchaCode", "wrong");
				init = { ...init, body };
			}
			return fake.fetcher(input, init);
		}) as typeof fetch;
		const result = await checkAreaOutage("069", "53440275", options(sabotaged));
		expect(result.status).toBe("none");
		expect(fake.posts).toHaveLength(2);
		expect(fake.captchasServed()).toBe(2);
	});

	it("gives up after three rejected answers instead of looping", async () => {
		const fake = fakeTelekom(() => resultPage("fehler.keine\\-stoerung", "keine"));
		const alwaysWrong = (async (input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === "POST") init = { ...init, body: new URLSearchParams({ ...Object.fromEntries(new URLSearchParams(String(init.body))), captchaCode: "x" }) };
			return fake.fetcher(input, init);
		}) as typeof fetch;
		await expect(checkAreaOutage("069", "53440275", options(alwaysWrong))).rejects.toThrow(UpstreamError);
		expect(fake.posts).toHaveLength(3);
	});

	it("surfaces a form error other than the captcha as an invalid number", async () => {
		const fake = fakeTelekom(() => formPage("e1s2", "Bitte geben Sie eine gültige Rufnummer ein."));
		await expect(checkAreaOutage("069", "53440275", options(fake.fetcher))).rejects.toThrow(
			new InvalidNumberError("Bitte geben Sie eine gültige Rufnummer ein."),
		);
	});

	it("fails clearly when AWS WAF challenges the request", async () => {
		const fake = fakeTelekom(() => "", { waf: true });
		await expect(checkAreaOutage("069", "53440275", options(fake.fetcher))).rejects.toThrow(/AWS WAF/);
	});
});

describe("normalizeNumber", () => {
	it("strips separators and rejects what can't be a German landline", () => {
		expect(normalizeNumber(" 069 ", "534/402-75")).toEqual({ areaCode: "069", number: "53440275" });
		expect(() => normalizeNumber("69", "53440275")).toThrow(InvalidNumberError);
		expect(() => normalizeNumber("0049", "53440275")).toThrow(InvalidNumberError);
		expect(() => normalizeNumber("069", "12")).toThrow(InvalidNumberError);
		expect(() => normalizeNumber("069", "5344027a")).toThrow(InvalidNumberError);
	});
});

describe("parsePage", () => {
	it("reads the real no-outage page", () => {
		const html = readFileSync(new URL("fixtures/keine-stoerung.html", import.meta.url), "utf8");
		const page = parsePage(html);
		expect(page.pageId).toBe("www.telekom.de.privatkunden.magenta-service.flaechenstoerung.fehler.keine-stoerung");
		expect(page.hasCaptchaField).toBe(false);
		expect(page.text).toMatch(/^Zu der eingegebenen Rufnummer können wir keine Beeinträchtigung aufgrund einer Flächenstörung feststellen\./);
	});
});
