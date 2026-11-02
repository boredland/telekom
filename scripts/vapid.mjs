// Generates a VAPID key pair in the base64url formats expected by the Worker secrets.
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey));
const publicKey = Buffer.from(raw).toString("base64url");
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${jwk.d}`);
