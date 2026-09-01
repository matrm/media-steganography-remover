import { describe, expect, it } from 'vitest';
import { fft2d, ifft2d } from './fft';

// Reference naive DFT for correctness comparison on small sizes.
function naiveDft1d(re: Float64Array, im: Float64Array): { re: Float64Array; im: Float64Array } {
	const n = re.length;
	const outRe = new Float64Array(n);
	const outIm = new Float64Array(n);
	for (let k = 0; k < n; k += 1) {
		let sr = 0;
		let si = 0;
		for (let t = 0; t < n; t += 1) {
			const angle = (-2 * Math.PI * k * t) / n;
			sr += re[t] * Math.cos(angle) - im[t] * Math.sin(angle);
			si += re[t] * Math.sin(angle) + im[t] * Math.cos(angle);
		}
		outRe[k] = sr;
		outIm[k] = si;
	}
	return { re: outRe, im: outIm };
}

function randomSignal(n: number, seed: number): { re: Float64Array; im: Float64Array } {
	let state = seed;
	const rand = () => {
		state = (state * 1103515245 + 12345) & 0x7fffffff;
		return state / 0x7fffffff;
	};
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	for (let i = 0; i < n; i += 1) {
		re[i] = rand() * 2 - 1;
		im[i] = rand() * 2 - 1;
	}
	return { re, im };
}

function expectClose(actual: Float64Array, expected: Float64Array, tolerance: number): void {
	for (let i = 0; i < actual.length; i += 1) {
		expect(Math.abs(actual[i] - expected[i])).toBeLessThan(tolerance);
	}
}

// Maximum absolute complex error, so a large transform needs one assertion
// instead of thousands.
function maxAbsDifference(actual: Float64Array, expected: Float64Array): number {
	let worst = 0;
	for (let i = 0; i < actual.length; i += 1) {
		worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
	}
	return worst;
}

describe('fft1dContiguous via fft2d row pass', () => {
	it('matches the naive DFT for a power-of-two length', () => {
		const { re, im } = randomSignal(8, 42);
		const expected = naiveDft1d(re, im);
		const workRe = Float64Array.from(re);
		const workIm = Float64Array.from(im);
		fft2d(workRe, workIm, 8, 1);
		expectClose(workRe, expected.re, 1e-9);
		expectClose(workIm, expected.im, 1e-9);
	});

	it('matches the naive DFT for a non-power-of-two length (Bluestein)', () => {
		const { re, im } = randomSignal(12, 7);
		const expected = naiveDft1d(re, im);
		const workRe = Float64Array.from(re);
		const workIm = Float64Array.from(im);
		fft2d(workRe, workIm, 12, 1);
		expectClose(workRe, expected.re, 1e-9);
		expectClose(workIm, expected.im, 1e-9);
	});

	it('matches the naive DFT for a composite non-power-of-two length', () => {
		const { re, im } = randomSignal(720, 99);
		const expected = naiveDft1d(re, im);
		const workRe = Float64Array.from(re);
		const workIm = Float64Array.from(im);
		fft2d(workRe, workIm, 720, 1);
		expectClose(workRe, expected.re, 1e-7);
		expectClose(workIm, expected.im, 1e-7);
	});
});

describe('fft2d at codebook profile lengths', () => {
	// Gemini's native profile resolutions are mostly not powers of two, so
	// both the row and column passes exercise the Bluestein path at full
	// scale.
	const lengths = [720, 768, 843, 896, 1024, 1195, 1264, 1365, 1440];

	it('matches the naive DFT along rows for every codebook size', () => {
		for (const n of lengths) {
			const { re, im } = randomSignal(n, n * 7 + 1);
			const expected = naiveDft1d(re, im);
			const gotRe = Float64Array.from(re);
			const gotIm = Float64Array.from(im);
			fft2d(gotRe, gotIm, n, 1);
			expect(maxAbsDifference(gotRe, expected.re)).toBeLessThan(1e-6);
			expect(maxAbsDifference(gotIm, expected.im)).toBeLessThan(1e-6);
		}
	});

	it('matches the naive DFT along columns for every codebook size', () => {
		for (const n of lengths) {
			const { re, im } = randomSignal(n, n * 13 + 3);
			const expected = naiveDft1d(re, im);
			const gotRe = Float64Array.from(re);
			const gotIm = Float64Array.from(im);
			fft2d(gotRe, gotIm, 1, n);
			expect(maxAbsDifference(gotRe, expected.re)).toBeLessThan(1e-6);
			expect(maxAbsDifference(gotIm, expected.im)).toBeLessThan(1e-6);
		}
	});
});

describe('fft2d', () => {
	it('matches the naive row-column DFT on a small plane', () => {
		const width = 5;
		const height = 3;
		const re = new Float64Array(width * height);
		const im = new Float64Array(width * height);
		let state = 5;
		const rand = () => {
			state = (state * 1103515245 + 12345) & 0x7fffffff;
			return state / 0x7fffffff;
		};
		for (let i = 0; i < re.length; i += 1) {
			re[i] = rand();
			im[i] = rand();
		}
		// Naive 2D DFT.
		const outRe = new Float64Array(re.length);
		const outIm = new Float64Array(im.length);
		for (let ky = 0; ky < height; ky += 1) {
			for (let kx = 0; kx < width; kx += 1) {
				let sr = 0;
				let si = 0;
				for (let y = 0; y < height; y += 1) {
					for (let x = 0; x < width; x += 1) {
						const angle = (-2 * Math.PI * (ky * y / height + kx * x / width));
						sr += re[y * width + x] * Math.cos(angle) - im[y * width + x] * Math.sin(angle);
						si += re[y * width + x] * Math.sin(angle) + im[y * width + x] * Math.cos(angle);
					}
				}
				outRe[ky * width + kx] = sr;
				outIm[ky * width + kx] = si;
			}
		}
		fft2d(re, im, width, height);
		expectClose(re, outRe, 1e-9);
		expectClose(im, outIm, 1e-9);
	});

	it('round trips through the inverse transform', () => {
		const { re, im } = randomSignal(12 * 10, 3);
		const origRe = Float64Array.from(re);
		const origIm = Float64Array.from(im);
		fft2d(re, im, 12, 10);
		ifft2d(re, im, 12, 10);
		expectClose(re, origRe, 1e-9);
		expectClose(im, origIm, 1e-9);
	});

	it('recovers pure tone phase and amplitude', () => {
		const width = 64;
		const height = 32;
		const re = new Float64Array(width * height);
		const im = new Float64Array(width * height);
		const fy = 5;
		const fx = 13;
		const amplitude = 3;
		const phase = Math.PI / 4;
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const angle = (2 * Math.PI * (fy * y / height + fx * x / width)) - phase;
				re[y * width + x] = amplitude * Math.cos(angle);
				im[y * width + x] = amplitude * Math.sin(angle);
			}
		}
		fft2d(re, im, width, height);
		const idx = fy * width + fx;
		const magnitude = Math.hypot(re[idx], im[idx]);
		expect(magnitude).toBeCloseTo(amplitude * width * height, 6);
		// A cosine with a negative phase offset puts +phi at the positive
		// frequency bin under the forward DFT convention.
		expect(Math.atan2(im[idx], re[idx])).toBeCloseTo(-phase, 6);
	});

	it('rejects non-positive, fractional, and undersized dimensions', () => {
		const re = new Float64Array(16);
		const im = new Float64Array(16);
		expect(() => fft2d(re, im, 0, 4)).toThrow(RangeError);
		expect(() => fft2d(re, im, 4.5, 2)).toThrow(RangeError);
		expect(() => fft2d(new Float64Array(3), new Float64Array(3), 2, 2)).toThrow(RangeError);
	});

	it('accepts oversized shared planes and transforms the leading region', () => {
		const re = new Float64Array(32);
		const im = new Float64Array(32);
		re[0] = 1;
		expect(() => fft2d(re, im, 4, 4)).not.toThrow();
	});
});

describe('ifft2d', () => {
	it('rejects non-positive, fractional, and undersized dimensions', () => {
		const re = new Float64Array(16);
		const im = new Float64Array(16);
		expect(() => ifft2d(re, im, 0, 4)).toThrow(RangeError);
		expect(() => ifft2d(re, im, 4.5, 2)).toThrow(RangeError);
		expect(() => ifft2d(new Float64Array(3), new Float64Array(3), 2, 2)).toThrow(RangeError);
	});

	it('accepts oversized shared planes and leaves trailing entries untouched', () => {
		const { re, im } = randomSignal(4 * 4, 11);
		const oversizedRe = new Float64Array(32);
		const oversizedIm = new Float64Array(32);
		oversizedRe.set(re);
		oversizedIm.set(im);
		oversizedRe[16] = 7;
		oversizedIm[16] = 9;

		fft2d(oversizedRe, oversizedIm, 4, 4);
		ifft2d(oversizedRe, oversizedIm, 4, 4);

		expectClose(oversizedRe.subarray(0, 16), re, 1e-9);
		expectClose(oversizedIm.subarray(0, 16), im, 1e-9);
		expect(oversizedRe[16]).toBe(7);
		expect(oversizedIm[16]).toBe(9);
	});
});
