import { describe, expect, it } from 'vitest';
import { GifWriter } from 'omggif';
import {
	ColorBox,
	applyPaletteLsb,
	getGifBackground,
	gifHasTransparency,
	medianCutQuantize,
	quantizeImageToPalette,
} from './quantize';
import type { Bitmap } from './types';

function opaquePixelBuffer(rgbTuples: number[][]): Uint8ClampedArray {
	const data = new Uint8ClampedArray(rgbTuples.length * 4);
	rgbTuples.forEach(([r, g, b], p) => {
		data[p * 4] = r;
		data[p * 4 + 1] = g;
		data[p * 4 + 2] = b;
		data[p * 4 + 3] = 255;
	});
	return data;
}

describe('medianCutQuantize', () => {
	it('reproduces input exactly when unique colors fit the palette', () => {
		const rgba = opaquePixelBuffer([
			[10, 20, 30],
			[200, 100, 50],
			[10, 20, 30],
		]);
		const { palette, indices, transparentIndex } = medianCutQuantize(rgba, 256);
		expect(transparentIndex).toBe(-1);
		for (let p = 0; p < indices.length; p += 1) {
			const color = palette[indices[p]];
			const i = p * 4;
			expect([(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff])
				.toEqual([rgba[i], rgba[i + 1], rgba[i + 2]]);
		}
	});

	it('pads the palette to a valid power-of-two size', () => {
		const tuples: number[][] = [];
		for (let c = 0; c < 300; c += 1) tuples.push([c % 256, Math.floor(c / 256), c]);
		const { palette } = medianCutQuantize(opaquePixelBuffer(tuples), 256);
		const sizes = [2, 4, 8, 16, 32, 64, 128, 256];
		expect(sizes).toContain(palette.length);
		expect(new Set(palette).size).toBeLessThanOrEqual(256);
	});

	it('never exceeds maxColors distinct representatives', () => {
		const tuples: number[][] = [];
		for (let c = 0; c < 400; c += 1) tuples.push([c % 256, Math.floor(c / 128), Math.floor(c / 64)]);
		const { palette } = medianCutQuantize(opaquePixelBuffer(tuples), 8);
		const distinctColors = new Set(
			palette.map((color) => `${(color >> 16) & 0xff},${(color >> 8) & 0xff},${color & 0xff}`)
		);
		expect(distinctColors.size).toBeLessThanOrEqual(8);
	});

	it('raises a maxColors of 1 to the 2-entry GIF minimum', () => {
		const rgba = new Uint8ClampedArray([
			255, 0, 0, 255,
			0, 0, 255, 255,
			0, 0, 0, 0,
		]);
		const { palette } = medianCutQuantize(rgba, 1);
		expect(palette.length).toBeLessThanOrEqual(256);
		expect(new Set(palette).size).toBeLessThanOrEqual(2);
	});

	it('clamps oversized maxColors to the 256-entry GIF limit', () => {
		const tuples: number[][] = [];
		for (let c = 0; c < 400; c += 1) tuples.push([c % 256, Math.floor(c / 128), Math.floor(c / 64)]);
		const { palette, indices } = medianCutQuantize(opaquePixelBuffer(tuples), 300);
		expect(palette.length).toBeLessThanOrEqual(256);
		for (const idx of indices) expect(idx).toBeLessThan(256);
	});

	it('never returns an empty half from a singleton split', () => {
		const box = new ColorBox([{ r: 10, g: 20, b: 30, count: 1 }]);
		const [a, b] = box.split();
		expect(a.colors.length + b.colors.length).toBe(1);
	});

	it('treats alpha below 128 as transparent and everything above as opaque', () => {
		const rgba = new Uint8ClampedArray([
			1, 2, 3, 127,
			9, 9, 9, 128,
		]);
		const { palette, indices, transparentIndex } = medianCutQuantize(rgba, 256);
		expect(transparentIndex).toBe(0);
		expect(indices[0]).toBe(0);
		expect(indices[1]).not.toBe(0);
		// Slot 0 belongs to transparency, so real colors start at index 1.
		expect(palette[0]).toBe(0);
	});

	it('handles an image made entirely of transparent pixels', () => {
		const rgba = new Uint8ClampedArray(2 * 4);
		const { palette, indices, transparentIndex } = medianCutQuantize(rgba, 256);
		expect(transparentIndex).toBe(0);
		expect(Array.from(indices)).toEqual([0, 0]);
		expect(palette[0]).toBe(0);
	});
});

describe('ColorBox', () => {
	it('tracks component ranges and averages weighted by counts', () => {
		const box = new ColorBox([
			{ r: 10, g: 0, b: 0, count: 3 },
			{ r: 20, g: 200, b: 40, count: 1 },
		]);
		expect(box.longestRange()).toBe(200);
		const avg = box.average();
		expect(avg.r).toBe(Math.round((10 * 3 + 20) / 4));
	});

	it('splits at the count-weighted median rather than the bin midpoint', () => {
		// An unweighted midpoint would cut after the second bin; the dominant
		// first color holds more than half the pixels, so the cut goes right
		// after it.
		const box = new ColorBox([
			{ r: 0, g: 0, b: 0, count: 6 },
			{ r: 10, g: 0, b: 0, count: 1 },
			{ r: 20, g: 0, b: 0, count: 1 },
			{ r: 200, g: 0, b: 0, count: 1 },
			{ r: 210, g: 0, b: 0, count: 1 },
		]);
		const [left, right] = box.split();
		expect(left.colors.map((c) => c.r)).toEqual([0]);
		expect(right.colors.map((c) => c.r)).toEqual([10, 20, 200, 210]);
	});
});

describe('quantizeImageToPalette', () => {
	it('writes palette colors back into the buffer and flags mapped transparent pixels', () => {
		const bmp: Bitmap = { width: 2, height: 1, data: new Uint8ClampedArray([
			12, 34, 56, 255,
			99, 99, 99, 60,
		]) };
		const result = quantizeImageToPalette(bmp, 256);
		expect(bmp.data[0]).toBe(12);
		expect(bmp.data[1]).toBe(34);
		expect(bmp.data[4]).toBe(99);
		expect(result.transparentIndex).toBe(0);
		expect(bmp.data[7]).toBe(0);
	});

	it('reproduces the medianCutQuantize mapping while writing colors back', () => {
		const data = new Uint8ClampedArray(8 * 8 * 4);
		for (let p = 0; p < 64; p += 1) {
			data[p * 4] = (p * 5) % 256;
			data[p * 4 + 1] = (p * 7) % 256;
			data[p * 4 + 2] = (p * 11) % 256;
			data[p * 4 + 3] = p % 3 === 0 ? 40 : 255;
		}
		const direct = medianCutQuantize(new Uint8ClampedArray(data), 16);
		const inPlace = quantizeImageToPalette({ width: 8, height: 8, data }, 16);
		expect(inPlace.indices).toEqual(direct.indices);
		expect(inPlace.palette).toEqual(direct.palette);
		expect(inPlace.transparentIndex).toBe(direct.transparentIndex);
	});
});

describe('applyPaletteLsb', () => {
	it('returns the palette unchanged when both passes are off', () => {
		const palette = [0x123455, 0xabcdef];
		expect(applyPaletteLsb(palette, -1, { clearLsb: false, randomizeLsb: false })).toBe(palette);
	});

	it('clears every RGB low bit and leaves the transparent slot untouched', () => {
		const palette = [0x111111, 0x222223, 0xabcdee];
		const result = applyPaletteLsb(palette, 0, { clearLsb: true, randomizeLsb: false });
		expect(result[0]).toBe(0x111111);
		expect(result[1]).toBe(0x222222);
		expect(result[2]).toBe(0xaaccee);
	});

	it('randomizes only the low bits from the injected source', () => {
		const palette = [0x000000, 0xffffff];
		const options = { clearLsb: false, randomizeLsb: true };
		expect(applyPaletteLsb(palette, -1, options, () => 0.999)).toEqual([0x010101, 0xffffff]);
		expect(applyPaletteLsb(palette, -1, options, () => 0.499)).toEqual([0x000000, 0xfefefe]);
	});

	it('draws one random value per RGB channel', () => {
		let calls = 0;
		applyPaletteLsb([0x808080], -1, { clearLsb: false, randomizeLsb: true }, () => {
			calls += 1;
			return 0.999;
		});
		expect(calls).toBe(3);
	});
});

describe('getGifBackground', () => {
	function gifHeader(flags: number, bgColorIndex: number, palette: number[]): Uint8Array {
		// Header (6) + logical screen descriptor (7) + global color table.
		return new Uint8Array([
			71, 73, 70, 56, 57, 97, // GIF89a
			4, 0, // width
			4, 0, // height
			flags,
			bgColorIndex,
			0, // aspect ratio
			...palette,
		]);
	}

	it('reads the declared background color but leaves the compositing canvas transparent', () => {
		// Flags: global table present (0x80), color resolution bits, sort bit, size bits = 0 -> 2 entries.
		const buffer = gifHeader(0x80, 1, [
			255, 0, 0,
			17, 34, 51,
		]);
		const result = getGifBackground(buffer, 2, 2);
		expect(result.color).toBe((17 << 16) | (34 << 8) | 51);
		// Browsers restore disposal-2 regions (and the pre-first-frame screen)
		// to transparency, never to the declared color, so the canvas handed
		// to frame compositing must stay cleared even when a color is parsed.
		expect(Array.from(result.pixels)).toEqual(new Array(16).fill(0));
	});

	it('returns transparent black without a global color table', () => {
		const buffer = gifHeader(0x00, 0, []);
		const result = getGifBackground(buffer, 2, 2);
		expect(result.color).toBe(null);
		expect(Array.from(result.pixels)).toEqual(new Array(16).fill(0));
	});

	it('rejects background indexes outside the table', () => {
		const buffer = gifHeader(0x80, 5, [1, 2, 3, 4, 5, 6]);
		expect(getGifBackground(buffer, 2, 2).color).toBe(null);
	});

	it('survives truncated buffers', () => {
		expect(getGifBackground(new Uint8Array([71, 73]), 2, 2).color).toBe(null);
	});
});

describe('gifHasTransparency', () => {
	function encodeGif(transparent: boolean): Uint8Array {
		const buffer = new Uint8Array(1024);
		const writer = new GifWriter(buffer, 2, 2, { loop: 0 });
		writer.addFrame(0, 0, 2, 2, new Uint8Array([0, 1, 1, 0]), {
			palette: [0x000000, 0xffffff],
			delay: 0,
			disposal: 2,
			...(transparent ? { transparent: 0 } : {}),
		});
		writer.end();
		return buffer.slice(0, writer.getOutputBufferPosition());
	}

	it('flags GIFs with a transparent palette index', () => {
		expect(gifHasTransparency(encodeGif(true))).toBe(true);
	});

	it('clears GIFs without one so opaque animations skip the warning', () => {
		expect(gifHasTransparency(encodeGif(false))).toBe(false);
	});

	it('returns false for unparseable buffers instead of throwing', () => {
		expect(gifHasTransparency(new Uint8Array([1, 2, 3]))).toBe(false);
	});
});
