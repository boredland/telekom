import { createECDH, createPublicKey, verify } from "node:crypto";
// @ts-expect-error http_ece ships no types
import ece from "http_ece";
import { afterEach, describe, expect, it, vi } from "vitest";
import { b64urlDecode, b64urlEncode, encryptPayload, isAllowedEndpoint, sendPush } from "../src/webpush.ts";

function browserSubscription() {
	const ua = createECDH("prime256v1");
	ua.generateKeys();
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return {
		ua,
		auth,
		sub: { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: b64urlEncode(ua.getPublicKey()), auth: b64urlEncode(auth) },
	};
}

describe("encryptPayload", () => {
	it("produces an aes128gcm body the reference implementation decrypts", async () => {
		const { ua, auth, sub } = browserSubscription();
		const payload = new TextEncoder().encode(JSON.stringify({ title: "Kabel-Störung", body: "ä ö ü ß" }));
		const body = await encryptPayload(sub, payload);
		const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: ua, authSecret: Buffer.from(auth) });
		expect(new Uint8Array(plain)).toEqual(payload);
	});

	it("rejects payloads that don't fit a single record", async () => {
		const { sub } = browserSubscription();
		await expect(encryptPayload(sub, new Uint8Array(4000))).rejects.toThrow("too large");
	});
});

describe("sendPush", () => {
	afterEach(() => vi.unstubAllGlobals());

	async function vapidKeys() {
		const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
		const raw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
		const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
		return { publicKey: b64urlEncode(raw), privateKey: jwk.d!, subject: "https://telekom.jonas-strassel.de" };
	}

	it("sends a VAPID JWT for the endpoint origin, signed by the configured key", async () => {
		const keys = await vapidKeys();
		const { sub } = browserSubscription();
		const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
		vi.stubGlobal("fetch", fetchMock);

		expect(await sendPush(sub, { title: "x" }, keys)).toBe("sent");

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(sub.endpoint);
		const headers = init.headers as Record<string, string>;
		expect(headers["Content-Encoding"]).toBe("aes128gcm");
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(headers.Authorization)!;
		expect(match[4]).toBe(keys.publicKey);
		const claims = JSON.parse(new TextDecoder().decode(b64urlDecode(match[2])));
		expect(claims.aud).toBe("https://fcm.googleapis.com");
		expect(claims.sub).toBe(keys.subject);
		expect(claims.exp * 1000).toBeGreaterThan(Date.now());

		const pub = b64urlDecode(keys.publicKey);
		const key = createPublicKey({
			key: { kty: "EC", crv: "P-256", x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) },
			format: "jwk",
		});
		const signed = Buffer.from(`${match[1]}.${match[2]}`);
		const signature = Buffer.from(b64urlDecode(match[3]));
		expect(verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
	});

	it.each([
		[404, "gone"],
		[410, "gone"],
		[429, "failed"],
		[500, "failed"],
	])("maps HTTP %i to %s", async (status, expected) => {
		vi.stubGlobal("fetch", async () => new Response("nope", { status }));
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await sendPush(browserSubscription().sub, {}, await vapidKeys())).toBe(expected);
	});
});

describe("isAllowedEndpoint", () => {
	it.each([
		["https://fcm.googleapis.com/fcm/send/x", true],
		["https://updates.push.services.mozilla.com/wpush/v2/x", true],
		["https://web.push.apple.com/QF8", true],
		["https://wns2-am3p.notify.windows.com/w/?token=x", true],
		["http://fcm.googleapis.com/fcm/send/x", false],
		["https://evilpush.apple.com.example/x", false],
		["https://fcm.googleapis.com.evil.de/x", false],
		["https://169.254.169.254/latest", false],
		["not a url", false],
	])("%s → %s", (endpoint, allowed) => {
		expect(isAllowedEndpoint(endpoint)).toBe(allowed);
	});
});
