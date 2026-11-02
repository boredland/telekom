// Solver for the image captcha at https://www.telekom.de/tech/captcha (300×100 PNG, 4–6 well-spaced Open Sans letters
// in regular/bold/italic, no noise). Letters are cut apart at blank columns and each one is matched against labelled
// glyphs extracted from real captchas (see scripts/build-glyphs.ts).
// No imports: scripts/build-glyphs.ts loads this file directly under Node's type stripping.

/** Binarised glyph, row-major, one byte per pixel (0/1), cropped to its ink. */
export interface Glyph {
	w: number;
	h: number;
	px: Uint8Array;
	ink: number;
}

export interface Template extends Glyph {
	char: string;
}

const INK_THRESHOLD = 128;

export interface Image {
	width: number;
	height: number;
	/** One byte per pixel, 0 = black. */
	gray: Uint8Array;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function inflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes 8-bit, non-interlaced grayscale/RGB/RGBA PNGs, which is what the captcha endpoint serves. */
export async function decodePng(png: Uint8Array): Promise<Image> {
	if (!PNG_SIGNATURE.every((b, i) => png[i] === b)) throw new Error("not a PNG");
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let width = 0;
	let height = 0;
	let channels = 0;
	const idat: Uint8Array[] = [];
	for (let pos = 8; pos + 8 <= png.length; ) {
		const length = view.getUint32(pos);
		const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
		const data = png.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(pos + 8);
			height = view.getUint32(pos + 12);
			const [depth, colorType, , , interlace] = data.subarray(8, 13);
			channels = ({ 0: 1, 2: 3, 6: 4 } as Record<number, number>)[colorType] ?? 0;
			if (depth !== 8 || !channels || interlace !== 0) {
				throw new Error(`unsupported PNG: depth ${depth}, color type ${colorType}, interlace ${interlace}`);
			}
		} else if (type === "IDAT") idat.push(data);
		else if (type === "IEND") break;
		pos += 12 + length;
	}
	if (!width || !idat.length) throw new Error("PNG without IHDR or IDAT");

	const raw = await inflate(new Uint8Array(await new Blob(idat).arrayBuffer()));
	const stride = width * channels;
	if (raw.length < height * (stride + 1)) throw new Error("truncated PNG data");
	const cur = new Uint8Array(stride);
	const prev = new Uint8Array(stride);
	const gray = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const filter = raw[y * (stride + 1)];
		const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
		for (let i = 0; i < stride; i++) {
			const a = i >= channels ? cur[i - channels] : 0;
			const b = prev[i];
			const c = i >= channels ? prev[i - channels] : 0;
			let predictor: number;
			switch (filter) {
				case 0:
					predictor = 0;
					break;
				case 1:
					predictor = a;
					break;
				case 2:
					predictor = b;
					break;
				case 3:
					predictor = (a + b) >> 1;
					break;
				case 4: {
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
					break;
				}
				default:
					throw new Error(`bad PNG filter ${filter}`);
			}
			cur[i] = (line[i] + predictor) & 0xff;
		}
		for (let x = 0; x < width; x++) {
			const o = x * channels;
			// Alpha is ignored: the captcha is opaque.
			gray[y * width + x] = channels === 1 ? cur[o] : Math.round(0.299 * cur[o] + 0.587 * cur[o + 1] + 0.114 * cur[o + 2]);
		}
		prev.set(cur);
	}
	return { width, height, gray };
}

/** Splits the image into letters at ink-free columns. An `i`/`j` dot shares its stem's columns, so it stays attached. */
export function segment(image: Image): Glyph[] {
	const { width, height, gray } = image;
	const ink = (x: number, y: number) => gray[y * width + x] < INK_THRESHOLD;
	const glyphs: Glyph[] = [];
	let start = -1;
	for (let x = 0; x <= width; x++) {
		let column = false;
		if (x < width) for (let y = 0; y < height && !column; y++) column = ink(x, y);
		if (column && start < 0) start = x;
		if (!column && start >= 0) {
			let top = height;
			let bottom = -1;
			for (let y = 0; y < height; y++) {
				for (let xx = start; xx < x; xx++) {
					if (ink(xx, y)) {
						top = Math.min(top, y);
						bottom = y;
						break;
					}
				}
			}
			const w = x - start;
			const h = bottom - top + 1;
			const px = new Uint8Array(w * h);
			let count = 0;
			for (let y = 0; y < h; y++) {
				for (let xx = 0; xx < w; xx++) if (ink(start + xx, top + y)) (px[y * w + xx] = 1), count++;
			}
			glyphs.push({ w, h, px, ink: count });
			start = -1;
		}
	}
	return glyphs;
}

/** True if a fully blank row separates parts of the glyph, i.e. it has an `i`/`j` dot. */
export function hasDot(g: Glyph): boolean {
	for (let y = 1; y < g.h - 1; y++) {
		let blank = true;
		for (let x = 0; x < g.w && blank; x++) blank = !g.px[y * g.w + x];
		if (blank) return true;
	}
	return false;
}

const MAX_SIZE_DIFF = 4;

/** Cosine similarity of two centred bitmaps, maximised over ±1 px offsets to absorb rounding in the centring. */
export function similarity(a: Glyph, b: Glyph): number {
	let best = 0;
	const baseY = (a.h >> 1) - (b.h >> 1);
	const baseX = (a.w >> 1) - (b.w >> 1);
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			// b's pixel (y, x) lands on a's pixel (y + oy, x + ox).
			const oy = baseY + dy;
			const ox = baseX + dx;
			const y0 = Math.max(0, -oy);
			const y1 = Math.min(b.h, a.h - oy);
			const x0 = Math.max(0, -ox);
			const x1 = Math.min(b.w, a.w - ox);
			let overlap = 0;
			for (let y = y0; y < y1; y++) {
				const rowA = (y + oy) * a.w + ox;
				const rowB = y * b.w;
				for (let x = x0; x < x1; x++) overlap += a.px[rowA + x] & b.px[rowB + x];
			}
			if (overlap > best) best = overlap;
		}
	}
	return best / Math.sqrt(a.ink * b.ink);
}

export interface Match {
	char: string;
	score: number;
	/** Gap to the best-scoring different character. */
	margin: number;
}

export function classify(glyph: Glyph, templates: readonly Template[]): Match | undefined {
	// Dots are reliable and decide what the shapes alone confuse, notably italic `j` vs `J`.
	const dotted = hasDot(glyph);
	const best = new Map<string, number>();
	for (const t of templates) {
		if (Math.abs(t.w - glyph.w) > MAX_SIZE_DIFF || Math.abs(t.h - glyph.h) > MAX_SIZE_DIFF) continue;
		if ((t.char === "i" || t.char === "j") !== dotted) continue;
		const s = similarity(glyph, t);
		if (s > (best.get(t.char) ?? -1)) best.set(t.char, s);
	}
	const ranked = [...best].sort((x, y) => y[1] - x[1]);
	if (!ranked.length) return undefined;
	return { char: ranked[0][0], score: ranked[0][1], margin: ranked[0][1] - (ranked[1]?.[1] ?? 0) };
}

export const MIN_LETTERS = 4;
export const MAX_LETTERS = 6;
// Below these, a fresh captcha is cheaper than a likely-wrong answer. Correct reads on the held-out set all clear them.
const MIN_SCORE = 0.8;
const MIN_MARGIN = 0.01;

/** Returns the captcha text, or undefined when the image doesn't segment cleanly or a letter is ambiguous. */
export async function solveCaptcha(png: Uint8Array, templates: readonly Template[]): Promise<string | undefined> {
	const glyphs = segment(await decodePng(png));
	if (glyphs.length < MIN_LETTERS || glyphs.length > MAX_LETTERS) return undefined;
	let text = "";
	for (const g of glyphs) {
		const m = classify(g, templates);
		if (!m || m.score < MIN_SCORE || m.margin < MIN_MARGIN) return undefined;
		text += m.char;
	}
	return text;
}

// Template serialisation: per glyph one char code byte, width, height, then the bitmap packed MSB-first, base64-encoded.

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	// Chunked: spreading ~100 KB into String.fromCharCode overflows the call stack.
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

export function encodeTemplates(templates: readonly Template[]): string {
	const bytes: number[] = [];
	for (const t of templates) {
		bytes.push(t.char.charCodeAt(0), t.w, t.h);
		for (let i = 0; i < t.px.length; i += 8) {
			let b = 0;
			for (let j = 0; j < 8; j++) b |= (t.px[i + j] ?? 0) << (7 - j);
			bytes.push(b);
		}
	}
	return toBase64(Uint8Array.from(bytes));
}

export function decodeTemplates(encoded: string): Template[] {
	const bytes = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
	const templates: Template[] = [];
	for (let pos = 0; pos < bytes.length; ) {
		const char = String.fromCharCode(bytes[pos]);
		const w = bytes[pos + 1];
		const h = bytes[pos + 2];
		pos += 3;
		const px = new Uint8Array(w * h);
		let ink = 0;
		for (let i = 0; i < px.length; i++) ink += px[i] = (bytes[pos + (i >> 3)] >> (7 - (i & 7))) & 1;
		pos += (px.length + 7) >> 3;
		templates.push({ char, w, h, px, ink });
	}
	return templates;
}
