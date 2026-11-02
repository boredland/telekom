// Web Push with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291, RFC 8188) on WebCrypto.

export interface PushSubscription {
	endpoint: string;
	p256dh: string; // base64url, uncompressed P-256 point
	auth: string; // base64url, 16 bytes
}

export interface VapidKeys {
	publicKey: string; // base64url, uncompressed P-256 point
	privateKey: string; // base64url, 32-byte scalar
	subject: string; // mailto: or https: contact
}

export type PushResult = "sent" | "gone" | "failed";

const RECORD_SIZE = 4096;
const encoder = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let offset = 0;
	for (const p of parts) {
		out.set(p, offset);
		offset += p.length;
	}
	return out;
}

async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, length: number) {
	const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
	return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

export function isValidSubscription(sub: PushSubscription): boolean {
	try {
		const key = b64urlDecode(sub.p256dh);
		return key.length === 65 && key[0] === 0x04 && b64urlDecode(sub.auth).length === 16;
	} catch {
		return false;
	}
}

/** Encrypts `payload` for the subscription; returns the aes128gcm message body. */
export async function encryptPayload(sub: PushSubscription, payload: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
	const uaPublic = b64urlDecode(sub.p256dh);
	const authSecret = b64urlDecode(sub.auth);
	if (payload.length + 1 + 16 > RECORD_SIZE - 86) throw new Error("push payload too large");

	const asKeys = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", asKeys.publicKey)) as ArrayBuffer);
	const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	// workers-types names the ECDH peer key `$public`; the runtime expects `public` per WebCrypto.
	const ecdhParams = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, asKeys.privateKey, 256));

	const ikm = await hkdf(authSecret, ecdhSecret, concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic), 32);
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

	const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	// Single record: payload followed by the 0x02 last-record delimiter.
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, concat(payload, new Uint8Array([2])));

	const header = new Uint8Array(16 + 4 + 1);
	header.set(salt);
	new DataView(header.buffer).setUint32(16, RECORD_SIZE);
	header[20] = asPublic.length;
	return concat(header, asPublic, new Uint8Array(ciphertext));
}

async function vapidAuthorization(endpoint: string, keys: VapidKeys): Promise<string> {
	const publicKey = b64urlDecode(keys.publicKey);
	const signingKey = await crypto.subtle.importKey(
		"jwk",
		{
			kty: "EC",
			crv: "P-256",
			x: b64urlEncode(publicKey.slice(1, 33)),
			y: b64urlEncode(publicKey.slice(33, 65)),
			d: keys.privateKey,
		},
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const json = (value: object) => b64urlEncode(encoder.encode(JSON.stringify(value)));
	const unsigned = `${json({ typ: "JWT", alg: "ES256" })}.${json({
		aud: new URL(endpoint).origin,
		exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
		sub: keys.subject,
	})}`;
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, encoder.encode(unsigned));
	return `vapid t=${unsigned}.${b64urlEncode(new Uint8Array(signature))}, k=${keys.publicKey}`;
}

export async function sendPush(sub: PushSubscription, payload: unknown, keys: VapidKeys, ttlSeconds = 24 * 60 * 60): Promise<PushResult> {
	const res = await fetch(sub.endpoint, {
		method: "POST",
		headers: {
			Authorization: await vapidAuthorization(sub.endpoint, keys),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: String(ttlSeconds),
			Urgency: "high",
		},
		body: await encryptPayload(sub, encoder.encode(JSON.stringify(payload))),
		signal: AbortSignal.timeout(10_000),
	});
	if (res.ok) return "sent";
	if (res.status === 404 || res.status === 410) return "gone";
	console.warn(`push to ${new URL(sub.endpoint).host} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
	return "failed";
}

// Browser push services. Restricting endpoints keeps the Worker from POSTing to arbitrary hosts.
const PUSH_HOSTS = [
	"fcm.googleapis.com",
	"android.googleapis.com",
	"updates.push.services.mozilla.com",
	"push.apple.com",
	"notify.windows.com",
];

export function isAllowedEndpoint(endpoint: string): boolean {
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	return url.protocol === "https:" && PUSH_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));
}
