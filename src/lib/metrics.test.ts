import { describe, expect, it } from 'vitest';
import {
	anyVisiblePixel,
	combinedPsnr,
	computeAlphaPsnr,
	computePsnr,
	hasNewlyVisiblePixels,
	scanHasAlpha,
} from './metrics';

describe('computePsnr', () => {
	it('returns Infinity for identical buffers', () => {
		const a = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]);
		expect(computePsnr(a, new Uint8ClampedArray(a))).toBe(Infinity);
	});

	it('returns 0 for mismatched buffer lengths', () => {
		expect(computePsnr(new Uint8ClampedArray(4), new Uint8ClampedArray(8))).toBe(0);
	});

	it('matches the hand-computed value for a known difference', () => {
		// One opaque pixel where only R differs by 10: MSE = 100/3.
		const a = new Uint8ClampedArray([100, 100, 100, 255]);
		const b = new Uint8ClampedArray([110, 100, 100, 255]);
		const expected = 10 * Math.log10((255 * 255) / (100 / 3));
		expect(computePsnr(a, b)).toBeCloseTo(expected, 10);
	});

	it('skips fully transparent reference pixels entirely', () => {
		const a = new Uint8ClampedArray([0, 0, 0, 0, 50, 50, 50, 255]);
		// Transparent slot carries wildly different RGB that must not count.
		const b = new Uint8ClampedArray([255, 255, 255, 200, 50, 50, 50, 255]);
		expect(computePsnr(a, b)).toBe(Infinity);
	});

	it('returns Infinity when every reference pixel is transparent', () => {
		const a = new Uint8ClampedArray([1, 2, 3, 0]);
		const b = new Uint8ClampedArray([4, 5, 6, 250]);
		expect(computePsnr(a, b)).toBe(Infinity);
	});

	it('with opaqueOnly scores only fully opaque reference pixels', () => {
		// The semi-transparent pixel is intentionally flattened in a format
		// with no alpha, so its large RGB delta must not count; the opaque
		// pixel matches exactly and keeps the score at Infinity.
		const reference = new Uint8ClampedArray([200, 200, 200, 128, 10, 20, 30, 255]);
		const decoded = new Uint8ClampedArray([0, 0, 0, 255, 10, 20, 30, 255]);
		expect(computePsnr(reference, decoded)).toBeLessThan(Infinity);
		expect(computePsnr(reference, decoded, true)).toBe(Infinity);
	});

	it('with opaqueOnly skips fully transparent and semi-transparent pixels', () => {
		const reference = new Uint8ClampedArray([9, 9, 9, 0, 8, 8, 8, 128]);
		const decoded = new Uint8ClampedArray([1, 1, 1, 255, 1, 1, 1, 255]);
		expect(computePsnr(reference, decoded, true)).toBe(Infinity);
	});
});

describe('computeAlphaPsnr', () => {
	it('measures only alpha differences on visible pixels', () => {
		const a = new Uint8ClampedArray([10, 10, 10, 255]);
		const b = new Uint8ClampedArray([250, 250, 250, 200]);
		const expected = 10 * Math.log10((255 * 255) / (55 * 55));
		expect(computeAlphaPsnr(a, b)).toBeCloseTo(expected, 10);
	});

	it('ignores alpha churn on fully transparent pixels', () => {
		const a = new Uint8ClampedArray([10, 10, 10, 0]);
		const b = new Uint8ClampedArray([10, 10, 10, 240]);
		expect(computeAlphaPsnr(a, b)).toBe(Infinity);
	});

	it('shares the length-mismatch and identical-buffer behavior of computePsnr', () => {
		expect(computeAlphaPsnr(new Uint8ClampedArray(8), new Uint8ClampedArray(4))).toBe(0);
		expect(computeAlphaPsnr(new Uint8ClampedArray([9, 9, 9, 128]), new Uint8ClampedArray([3, 7, 11, 128]))).toBe(Infinity);
	});
});

describe('combinedPsnr', () => {
	it('takes the worse of the two channel scores', () => {
		const rgb = new Uint8ClampedArray([0, 0, 0, 255]);
		const shifted = new Uint8ClampedArray([90, 0, 0, 200]);
		const expected = Math.min(
			computePsnr(rgb, shifted),
			computeAlphaPsnr(rgb, shifted)
		);
		expect(combinedPsnr(rgb, shifted)).toBe(expected);
	});
});

describe('scanHasAlpha', () => {
	it('detects any transparency including semi-transparent pixels', () => {
		expect(scanHasAlpha(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 254]))).toBe(true);
		expect(scanHasAlpha(new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]))).toBe(false);
	});
});

describe('anyVisiblePixel', () => {
	it('reports true when at least one pixel has a non-zero alpha', () => {
		expect(anyVisiblePixel(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 255]))).toBe(true);
		expect(anyVisiblePixel(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 1]))).toBe(true);
	});

	it('reports false only when every pixel is fully transparent', () => {
		expect(anyVisiblePixel(new Uint8ClampedArray([0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
		expect(anyVisiblePixel(new Uint8ClampedArray([]))).toBe(false);
	});
});

describe('hasNewlyVisiblePixels', () => {
	it('reports true when a fully transparent pixel gains any alpha', () => {
		const before = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0]);
		const after = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 1]);
		expect(hasNewlyVisiblePixels(before, after)).toBe(true);
	});

	it('reports false when alpha only disappears or stays the same', () => {
		const opaque = new Uint8ClampedArray([10, 20, 30, 255]);
		const transparent = new Uint8ClampedArray([10, 20, 30, 0]);
		expect(hasNewlyVisiblePixels(opaque, transparent)).toBe(false);
		expect(hasNewlyVisiblePixels(opaque, new Uint8ClampedArray(opaque))).toBe(false);
		expect(hasNewlyVisiblePixels(transparent, new Uint8ClampedArray(transparent))).toBe(false);
	});
});

describe('malformed buffers', () => {
	it('returns NaN for equal-length buffers that are not whole pixels', () => {
		const a = new Uint8ClampedArray(5);
		const b = new Uint8ClampedArray(5);
		expect(computePsnr(a, b)).toBeNaN();
		expect(computeAlphaPsnr(a, b)).toBeNaN();
		expect(combinedPsnr(a, b)).toBeNaN();
	});

	it('treats NaN scores as a floor failure, not a pass', () => {
		expect(NaN >= 32).toBe(false);
		expect(!(NaN >= 32)).toBe(true);
	});
});
