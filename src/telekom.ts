// Client for the Flächenstörung check at https://www.telekom.de/hilfe/hilfe-bei-stoerungen/flaechenstoerung, a
// server-rendered Spring Web Flow: GET the form (session + flow execution + CSRF token), GET the captcha image bound
// to that session, POST the number with the solved captcha, read the result page.

import { decodeTemplates, solveCaptcha, type Template } from "./captcha.ts";
import { GLYPHS } from "./glyphs.ts";

const ORIGIN = "https://www.telekom.de";
const FLOW_PATH = "/hilfe/hilfe-bei-stoerungen/flaechenstoerung";
const CAPTCHA_PATH = "/tech/captcha";
const TIMEOUT_MS = 15_000;
// The flow passes through a silent-login check (www.telekom.de → accounts.login.idm.telekom.com → back), twice.
const MAX_REDIRECTS = 15;
// Unreadable captchas are skipped without submitting; wrong answers cost a POST and come back with a fresh image.
const MAX_CAPTCHA_FETCHES = 8;
const MAX_SUBMITS = 3;

export type AreaStatus = "none" | "outage";

export interface AreaCheck {
	status: AreaStatus;
	/** Telekom's tracking ID of the result page, e.g. `…flaechenstoerung.fehler.keine-stoerung`. */
	pageId: string;
	/** Visible result text. */
	text: string;
}

export class UpstreamError extends Error {}

/** The number was rejected by the form itself (malformed, unknown, not a Telekom line, …). */
export class InvalidNumberError extends Error {}

let templates: Template[] | undefined;
const glyphs = () => (templates ??= decodeTemplates(GLYPHS));

type Fetch = typeof fetch;

class Session {
	private cookies = new Map<string, string>();
	private readonly userAgent: string;
	private readonly fetcher: Fetch;

	constructor(userAgent: string, fetcher: Fetch) {
		this.userAgent = userAgent;
		this.fetcher = fetcher;
	}

	/** Follows redirects by hand: cookies set on intermediate responses (session, login check) must be kept. */
	async request(url: string, init: { method?: string; body?: URLSearchParams } = {}): Promise<{ url: string; res: Response }> {
		let method = init.method ?? "GET";
		let body = init.body;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			const headers: Record<string, string> = { "User-Agent": this.userAgent, "Accept-Language": "de-DE,de;q=0.9" };
			if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
			if (body) headers["Content-Type"] = "application/x-www-form-urlencoded";
			const res = await this.fetcher(url, { method, body, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
			for (const cookie of res.headers.getSetCookie()) {
				const pair = cookie.split(";", 1)[0];
				const eq = pair.indexOf("=");
				if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
			}
			if (res.headers.get("x-amzn-waf-action")) {
				throw new UpstreamError(`${new URL(url).pathname}: blocked by AWS WAF (${res.headers.get("x-amzn-waf-action")})`);
			}
			const location = res.headers.get("location");
			if (res.status >= 300 && res.status < 400 && location) {
				await res.body?.cancel();
				url = new URL(location, url).href;
				method = "GET";
				body = undefined;
				continue;
			}
			if (!res.ok) {
				const text = await res.text();
				throw new UpstreamError(`${new URL(url).pathname}: HTTP ${res.status} ${text.slice(0, 200)}`);
			}
			return { url, res };
		}
		throw new UpstreamError(`${new URL(url).pathname}: more than ${MAX_REDIRECTS} redirects`);
	}

	async captcha(): Promise<Uint8Array> {
		// Cache-buster as the page's reload button does; the image is generated per request either way.
		const { res } = await this.request(`${ORIGIN}${CAPTCHA_PATH}?${Date.now()}`);
		if (!res.headers.get("content-type")?.startsWith("image/png")) {
			throw new UpstreamError(`captcha: unexpected content type ${res.headers.get("content-type")}`);
		}
		return new Uint8Array(await res.arrayBuffer());
	}
}

export interface ResultPage {
	pageId: string;
	csrf?: string;
	action?: string;
	hasCaptchaField: boolean;
	/** Text of the result paragraph(s) and any form error messages. */
	text: string;
}

export const decodeEntities = (s: string) =>
	s
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
		.replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&");

export const stripTags = (html: string) =>
	decodeEntities(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();

export function parsePage(html: string): ResultPage {
	const pageId = /page_content_id\s*:\s*"([^"]*)"/.exec(html)?.[1].replace(/\\-/g, "-") ?? "";
	const form = /<form\b[^>]*\baction="([^"]*flaechenstoerung[^"]*)"[^>]*>([\s\S]*?)<\/form>/i.exec(html);
	const main = /<main\b[\s\S]*?<\/main>/i.exec(html)?.[0] ?? html;
	// The result is in the page's paragraphs; on the form page, field errors are the only paragraphs with text.
	const text = [...main.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
		.map((m) => stripTags(m[1]))
		.filter(Boolean)
		.join("\n");
	return {
		pageId,
		action: form ? decodeEntities(form[1]) : undefined,
		csrf: form ? /name="_csrf"\s+value="([^"]+)"/.exec(form[2])?.[1] : undefined,
		hasCaptchaField: !!form && /name="captchaCode"/.test(form[2]),
		text,
	};
}

const CAPTCHA_ERROR = /Code wurde nicht oder nicht korrekt eingegeben/;
const NO_OUTAGE_PAGE = /\.keine-stoerung$/;
const FORM_PAGE = /\.l3light$/;

/** Area codes start with 0; numbers are digits only. Both are sent as the form's two separate fields. */
export function normalizeNumber(areaCode: string, number: string): { areaCode: string; number: string } {
	const a = areaCode.replace(/[\s/()-]/g, "");
	const n = number.replace(/[\s/()-]/g, "");
	if (!/^0[1-9]\d{1,4}$/.test(a)) throw new InvalidNumberError(`invalid area code: ${areaCode}`);
	if (!/^\d{3,9}$/.test(n)) throw new InvalidNumberError(`invalid number: ${number}`);
	return { areaCode: a, number: n };
}

export interface CheckOptions {
	userAgent: string;
	/** Injected for tests; defaults to global fetch. */
	fetcher?: Fetch;
}

export async function checkAreaOutage(areaCode: string, number: string, options: CheckOptions): Promise<AreaCheck> {
	const line = normalizeNumber(areaCode, number);
	// Wrapped: Workers throw "Illegal invocation" when fetch is called as a method of another object.
	const session = new Session(options.userAgent, options.fetcher ?? ((input, init) => fetch(input, init)));
	const first = await session.request(`${ORIGIN}${FLOW_PATH}`);
	let page = parsePage(await first.res.text());
	let fetches = 0;
	for (let submits = 0; submits < MAX_SUBMITS; ) {
		if (!page.action || !page.csrf || !page.hasCaptchaField) {
			throw new UpstreamError(`flaechenstoerung: form not found on page ${page.pageId || "(no page id)"}`);
		}
		let answer: string | undefined;
		while (!answer) {
			if (++fetches > MAX_CAPTCHA_FETCHES) throw new UpstreamError(`captcha: no readable image in ${MAX_CAPTCHA_FETCHES} attempts`);
			answer = await solveCaptcha(await session.captcha(), glyphs());
		}
		submits++;
		const posted = await session.request(new URL(page.action, ORIGIN).href, {
			method: "POST",
			body: new URLSearchParams({
				_csrf: page.csrf,
				"credentials.connection.areaCode": line.areaCode,
				"credentials.connection.callNumber": line.number,
				captchaCode: answer,
				_eventId_submit: "Submit",
			}),
		});
		page = parsePage(await posted.res.text());
		if (FORM_PAGE.test(page.pageId)) {
			// Back on the form: either the captcha was wrong (fresh image, retry) or a field was rejected.
			if (CAPTCHA_ERROR.test(page.text)) continue;
			throw new InvalidNumberError(page.text || `rejected ${line.areaCode}/${line.number}`);
		}
		return { status: NO_OUTAGE_PAGE.test(page.pageId) ? "none" : "outage", pageId: page.pageId, text: page.text };
	}
	throw new UpstreamError(`captcha: ${MAX_SUBMITS} answers rejected`);
}
