import { readdirSync, readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, decodeTemplates, encodeTemplates, segment, solveCaptcha } from "../src/captcha.ts";
import { GLYPHS } from "../src/glyphs.ts";

const testDir = new URL("../captcha/test/", import.meta.url);
const templates = decodeTemplates(GLYPHS);

function crc32(bytes: Uint8Array): number {
	let c = ~0;
	for (const b of bytes) {
		c ^= b;
		for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
	}
	return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + data.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, data.length);
	out.set(new TextEncoder().encode(type), 4);
	out.set(data, 8);
	view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
	return out;
}

/** Grayscale PNG; row y is encoded with scanline filter `filters[y]` (default 0, None), which the decoder must undo. */
function png(width: number, height: number, pixel: (x: number, y: number) => number, filters: number[] = []): Uint8Array {
	const value = (x: number, y: number) => (x < 0 || y < 0 ? 0 : pixel(x, y));
	const raw = new Uint8Array(height * (width + 1));
	for (let y = 0; y < height; y++) {
		const filter = filters[y] ?? 0;
		raw[y * (width + 1)] = filter;
		for (let x = 0; x < width; x++) {
			const [a, b, c] = [value(x - 1, y), value(x, y - 1), value(x - 1, y - 1)];
			const p = a + b - c;
			const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
			const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			const predictor = [0, a, b, (a + b) >> 1, paeth][filter];
			raw[y * (width + 1) + 1 + x] = (value(x, y) - predictor) & 0xff;
		}
	}
	const ihdr = new Uint8Array(13);
	new DataView(ihdr.buffer).setUint32(0, width);
	new DataView(ihdr.buffer).setUint32(4, height);
	ihdr.set([8, 0, 0, 0, 0], 8);
	return new Uint8Array([
		...[137, 80, 78, 71, 13, 10, 26, 10],
		...chunk("IHDR", ihdr),
		...chunk("IDAT", deflateSync(raw)),
		...chunk("IEND", new Uint8Array()),
	]);
}

describe("solveCaptcha", () => {
	// Held out from captcha/train, which the templates are built from.
	it("reads every held-out captcha exactly, case included", async () => {
		const files = readdirSync(testDir).filter((f) => f.endsWith(".png"));
		expect(files.length).toBeGreaterThanOrEqual(50);
		for (const f of files) {
			const expected = f.slice(0, -4).split("-")[1];
			expect(await solveCaptcha(readFileSync(new URL(f, testDir)), templates), f).toBe(expected);
		}
	});

	it("refuses an image whose ink doesn't separate into 4-6 glyphs", async () => {
		const bar = png(300, 100, (x, y) => (x >= 20 && x < 280 && y >= 40 && y < 60 ? 0 : 255));
		expect(await solveCaptcha(bar, templates)).toBeUndefined();
	});

	it("refuses shapes that match no letter well enough", async () => {
		// Five filled squares: plausible count, nothing letter-like.
		const blocks = png(300, 100, (x, y) => (y >= 30 && y < 64 && x < 250 && x % 50 >= 10 && x % 50 < 40 ? 0 : 255));
		expect(segment(await decodePng(blocks))).toHaveLength(5);
		expect(await solveCaptcha(blocks, templates)).toBeUndefined();
	});
});

describe("decodePng", () => {
	it("undoes all five scanline filters", async () => {
		const gradient = (x: number, y: number) => (x * 37 + y * 53) & 0xff;
		const image = await decodePng(png(6, 5, gradient, [0, 1, 2, 3, 4]));
		for (let y = 0; y < 5; y++) for (let x = 0; x < 6; x++) expect(image.gray[y * 6 + x], `${x},${y}`).toBe(gradient(x, y));
	});
});

describe("template encoding", () => {
	it("round-trips bitmaps whose size isn't a multiple of 8 bits", () => {
		const px = Uint8Array.from({ length: 5 * 3 }, (_, i) => ((i * 7) % 3 === 0 ? 1 : 0));
		const original = [
			{ char: "Q", w: 5, h: 3, px, ink: px.reduce((a, b) => a + b, 0) },
			{ char: "j", w: 1, h: 1, px: new Uint8Array([1]), ink: 1 },
		];
		expect(decodeTemplates(encodeTemplates(original))).toEqual(original);
	});
});
