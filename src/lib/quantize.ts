import type { Bitmap, ProcessingOptions } from './types';
import { GifReader } from 'omggif';

// Full color depth for GIF frames; smaller values trigger palette reduction.
export const GIF_DEFAULT_MAX_COLORS = 256;

// ---------------------------------------------------------------------------
// GIF quantization
// ---------------------------------------------------------------------------

interface ColorBin {
	r: number;
	g: number;
	b: number;
	count: number;
}

export class ColorBox {
	colors: ColorBin[];
	rMin: number;
	rMax: number;
	gMin: number;
	gMax: number;
	bMin: number;
	bMax: number;

	constructor(colors: ColorBin[]) {
		this.colors = colors;
		this.rMin = 255;
		this.rMax = 0;
		this.gMin = 255;
		this.gMax = 0;
		this.bMin = 255;
		this.bMax = 0;
		for (const c of colors) {
			if (c.r < this.rMin) this.rMin = c.r;
			if (c.r > this.rMax) this.rMax = c.r;
			if (c.g < this.gMin) this.gMin = c.g;
			if (c.g > this.gMax) this.gMax = c.g;
			if (c.b < this.bMin) this.bMin = c.b;
			if (c.b > this.bMax) this.bMax = c.b;
		}
	}

	longestRange(): number {
		return Math.max(this.rMax - this.rMin, this.gMax - this.gMin, this.bMax - this.bMin);
	}

	split(): [ColorBox, ColorBox] {
		if (this.colors.length < 2) {
			return [new ColorBox([]), new ColorBox([...this.colors])];
		}
		const rRange = this.rMax - this.rMin;
		const gRange = this.gMax - this.gMin;
		const bRange = this.bMax - this.bMin;
		let axis: 'r' | 'g' | 'b' = 'r';
		if (gRange >= rRange && gRange >= bRange) axis = 'g';
		else if (bRange >= rRange && bRange >= gRange) axis = 'b';

		const sorted = [...this.colors].sort((a, b) => a[axis] - b[axis]);
		// Split at the count-weighted median so a dominant color does not drag
		// the cut into a sparse tail. Clamped to keep both halves non-empty.
		let total = 0;
		for (const c of sorted) total += c.count;
		let cumulative = 0;
		let mid = sorted.length - 1;
		for (let i = 0; i < sorted.length; i += 1) {
			cumulative += sorted[i].count;
			if (cumulative * 2 >= total) {
				mid = i + 1;
				break;
			}
		}
		mid = Math.min(Math.max(mid, 1), sorted.length - 1);
		return [new ColorBox(sorted.slice(0, mid)), new ColorBox(sorted.slice(mid))];
	}

	average(): ColorBin {
		let r = 0;
		let g = 0;
		let b = 0;
		let total = 0;
		for (const c of this.colors) {
			r += c.r * c.count;
			g += c.g * c.count;
			b += c.b * c.count;
			total += c.count;
		}
		if (total === 0) return { r: 0, g: 0, b: 0, count: 0 };
		return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total), count: total };
	}
}

export function medianCutQuantize(
	rgba: Uint8ClampedArray,
	maxColors: number
): { palette: number[]; indices: Uint8Array; transparentIndex: number } {
	const colorMap = new Map<number, ColorBin>();
	let hasTransparent = false;

	for (let i = 0; i < rgba.length; i += 4) {
		const a = rgba[i + 3];
		if (a < 128) {
			hasTransparent = true;
			continue;
		}
		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];
		const key = (r << 16) | (g << 8) | b;
		const existing = colorMap.get(key);
		if (existing) {
			existing.count += 1;
		} else {
			colorMap.set(key, { r, g, b, count: 1 });
		}
	}

	const colors = Array.from(colorMap.values());
	// GIF caps palettes at 256 entries; clamp attacker-controlled depths so an
	// oversized request cannot overflow the Uint8 index plane. Non-finite
	// input falls back to the full depth. The format needs at least 2 slots,
	// so requests below that are raised instead of producing a 1-entry
	// palette that must be padded back up anyway.
	const safeMaxColors = Number.isFinite(maxColors) ? Math.max(2, Math.min(256, Math.floor(maxColors))) : GIF_DEFAULT_MAX_COLORS;
	const availableSlots = Math.max(1, hasTransparent ? safeMaxColors - 1 : safeMaxColors);
	let paletteBins: ColorBin[];

	if (colors.length <= availableSlots) {
		paletteBins = colors;
	} else {
		let boxes = [new ColorBox(colors)];
		while (boxes.length < availableSlots && boxes.some((b) => b.longestRange() > 0)) {
			const boxToSplit = boxes.reduce((largest, box) =>
				box.longestRange() > largest.longestRange() ? box : largest
			);
			if (boxToSplit.longestRange() === 0) break;
			const [a, b] = boxToSplit.split();
			const idx = boxes.indexOf(boxToSplit);
			boxes.splice(idx, 1, a, b);
		}
		paletteBins = boxes.map((box) => box.average());
	}

	const transparentIndex = hasTransparent ? 0 : -1;
	const palette: number[] = [];
	if (hasTransparent) {
		palette.push(0);
	}
	for (const c of paletteBins) {
		palette.push((c.r << 16) | (c.g << 8) | c.b);
	}

	// Pad palette to a power of 2 (required by GIF format: 2, 4, 8, 16, 32, 64, 128, 256).
	// The fill entries duplicate an existing color, so the nearest-color
	// search below only scans the real entries; ties already resolve to the
	// first occurrence, making the duplicates pure wasted distance checks.
	const realPaletteSize = palette.length;
	const validSizes = [2, 4, 8, 16, 32, 64, 128, 256];
	const nextSize = validSizes.find((s) => s >= realPaletteSize) ?? 256;
	const fillColor = realPaletteSize > (hasTransparent ? 1 : 0) ? palette[hasTransparent ? 1 : 0] : 0;
	while (palette.length < nextSize) {
		palette.push(fillColor);
	}

	const indices = new Uint8Array(rgba.length / 4);
	for (let i = 0; i < rgba.length; i += 4) {
		const idx = i / 4;
		if (rgba[i + 3] < 128) {
			indices[idx] = 0;
			continue;
		}

		let bestIndex = hasTransparent ? 1 : 0;
		let bestDist = Infinity;

		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];
		const start = hasTransparent ? 1 : 0;
		for (let p = start; p < realPaletteSize; p += 1) {
			const pr = (palette[p] >> 16) & 0xff;
			const pg = (palette[p] >> 8) & 0xff;
			const pb = palette[p] & 0xff;
			const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
			if (dist < bestDist) {
				bestDist = dist;
				bestIndex = p;
			}
		}
		indices[idx] = bestIndex;
	}

	return { palette, indices, transparentIndex };
}

// Quantizes the frame to a reduced palette in place, the way GIF
// serialization will. Returns the palette mapping so callers can serialize
// directly without re-running median-cut.
export function quantizeImageToPalette(
	imageData: Bitmap,
	maxColors: number
): { palette: number[]; indices: Uint8Array; transparentIndex: number } {
	const { palette, indices, transparentIndex } = medianCutQuantize(imageData.data, maxColors);
	for (let i = 0; i < indices.length; i += 1) {
		const dataIndex = i * 4;
		const paletteIndex = indices[i];
		if (paletteIndex === transparentIndex) {
			imageData.data[dataIndex + 3] = 0;
			continue;
		}
		const color = palette[paletteIndex] ?? 0;
		imageData.data[dataIndex] = (color >> 16) & 0xff;
		imageData.data[dataIndex + 1] = (color >> 8) & 0xff;
		imageData.data[dataIndex + 2] = color & 0xff;
		imageData.data[dataIndex + 3] = 255;
	}
	return { palette, indices, transparentIndex };
}

// Palette-level equivalent of the pixel LSB pass. A palette format has one
// RGB value per palette entry, so clearing or randomizing the entries is what
// reaches the rendered pixels; there is no per-pixel RGB left to touch after
// quantization. The transparent slot is skipped because its color never
// renders. Returns a new palette; a disabled pass returns the input as-is.
export function applyPaletteLsb(
	palette: number[],
	transparentIndex: number,
	options: Pick<ProcessingOptions, 'clearLsb' | 'randomizeLsb'>,
	random: () => number = Math.random
): number[] {
	if (!options.clearLsb && !options.randomizeLsb) return palette;
	const passChannel = (channel: number): number => options.clearLsb
		? channel & 0xfe
		: (channel & 0xfe) | (random() > 0.5 ? 1 : 0);
	return palette.map((color, index) => index === transparentIndex
		? color
		: (passChannel((color >> 16) & 0xff) << 16)
			| (passChannel((color >> 8) & 0xff) << 8)
			| passChannel(color & 0xff));
}

// Whether any frame of a raw GIF declares a transparent palette index.
// Used to warn when a GIF is flattened into a format without alpha (MP4).
// Returns false for unparseable buffers so the warning stays additive and
// never fails the file it describes.
export function gifHasTransparency(buffer: Uint8Array): boolean {
	try {
		const reader = new GifReader(buffer);
		for (let i = 0; i < reader.numFrames(); i += 1) {
			if (reader.frameInfo(i).transparent_index !== null) return true;
		}
		return false;
	} catch {
		return false;
	}
}

// Reads the logical screen background color from a raw GIF header. Returns a
// fully transparent compositing canvas, because browsers restore disposal-2
// regions and the pre-first-frame screen to transparency rather than to the
// declared color, plus the packed declared color for the writer, or null when
// the file carries no usable global palette.
export function getGifBackground(buffer: Uint8Array, width: number, height: number): { pixels: Uint8ClampedArray; color: number | null } {
	const pixels = new Uint8ClampedArray(width * height * 4);
	if (buffer.length < 13 || (buffer[10] & 0x80) === 0) return { pixels, color: null };

	const paletteSize = 1 << ((buffer[10] & 0x07) + 1);
	const backgroundIndex = buffer[11];
	const paletteOffset = 13;
	const colorOffset = paletteOffset + backgroundIndex * 3;
	if (backgroundIndex >= paletteSize || colorOffset + 2 >= buffer.length) return { pixels, color: null };

	const color = (buffer[colorOffset] << 16) | (buffer[colorOffset + 1] << 8) | buffer[colorOffset + 2];
	return { pixels, color };
}
