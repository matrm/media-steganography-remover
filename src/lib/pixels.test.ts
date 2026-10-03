import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Bitmap, ProcessingOptions } from './types';
import {
	addLumaNoise,
	applyBlurEffect,
	applyColorShift,
	applyLsbEffect,
	applyTileShiftStage,
	applyWarpStage,
	bilateralFilter,
	boxBlur,
	boxFilter,
	clearLSBs,
	generateAffineParams,
	generateColorShift,
	generateTileShiftState,
	lanczos3Filter,
	RESAMPLE_BAND_ELEMENTS,
	lanczos3Kernel,
	randomizeLSBs,
	resampleSeparable,
	squeezeImageData,
} from './pixels';
import { combinedPsnr } from './metrics';

afterEach(() => {
	vi.restoreAllMocks();
});

function makeBitmap(width: number, height: number): Bitmap {
	return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

function solidBitmap(width: number, height: number, r: number, g: number, b: number, a = 255): Bitmap {
	const bmp = makeBitmap(width, height);
	for (let i = 0; i < bmp.data.length; i += 4) {
		bmp.data[i] = r;
		bmp.data[i + 1] = g;
		bmp.data[i + 2] = b;
		bmp.data[i + 3] = a;
	}
	return bmp;
}

// Returns a spy that replays the given values cyclically.
function mockRandomSeq(seq: number[]): ReturnType<typeof vi.spyOn> {
	let call = 0;
	return vi.spyOn(Math, 'random').mockImplementation(() => seq[call++ % seq.length]);
}

function baseOptions(overrides: Partial<ProcessingOptions> = {}): ProcessingOptions {
	return {
		clearLsb: false,
		randomizeLsb: false,
		applyBlur: false,
		blurRadius: 1,
		jpegRecompress: false,
		jpegQuality: 85,
		distort: {
			enabled: false,
			elasticAlpha: 0,
			elasticSigma: 50,
			rotationJitter: 0,
			squeezeFactor: 1,
			colorAmount: 0,
			lumaNoise: 0,
			lumaNoiseStep: 0.1,
			reencodeRounds: 0,
			reencodeQuality: 88,
			bilateral: false,
			psnrFloor: 24,
		},
		outputFormats: {},
		filenameMode: 'suffix',
		outputSuffix: '-clean',
		outputPrefix: 'file',
		prefixStartIndex: 0,
		hashLength: 32,
		...overrides,
	};
}

describe('clearLSBs', () => {
	it('forces every RGB low bit to zero and preserves the rest', () => {
		const bmp = makeBitmap(2, 1);
		bmp.data.set([255, 254, 1, 200]);
		clearLSBs(bmp);
		expect(Array.from(bmp.data.slice(0, 4))).toEqual([254, 254, 0, 200]);
	});
});

describe('randomizeLSBs', () => {
	it('keeps high bits and writes the mocked random bit', () => {
		mockRandomSeq([0.9, 0.1, 0.9]);
		const bmp = makeBitmap(1, 1);
		bmp.data.set([255, 255, 255, 255]);
		randomizeLSBs(bmp);
		expect(Array.from(bmp.data)).toEqual([255, 254, 255, 255]);
	});

	it('with an all-false sequence it behaves like clearing', () => {
		mockRandomSeq([0]);
		const bmp = makeBitmap(4, 4);
		for (let i = 0; i < bmp.data.length; i += 4) {
			bmp.data[i] = 123;
			bmp.data[i + 1] = 66;
			bmp.data[i + 2] = 191;
		}
		randomizeLSBs(bmp);
		for (let i = 0; i < bmp.data.length; i += 4) {
			expect([bmp.data[i], bmp.data[i + 1], bmp.data[i + 2]]).toEqual([122, 66, 190]);
		}
	});
});

describe('boxBlur and applyBlurEffect', () => {
	it('leaves a solid image untouched', () => {
		const bmp = solidBitmap(6, 5, 40, 90, 140);
		boxBlur(bmp, 1);
		for (let i = 0; i < bmp.data.length; i += 4) {
			expect([bmp.data[i], bmp.data[i + 1], bmp.data[i + 2]]).toEqual([40, 90, 140]);
		}
	});

	it('averages each clamped neighborhood on a small ramp', () => {
		const bmp = makeBitmap(3, 3);
		const values = [0, 30, 60, 90, 120, 150, 180, 210, 240];
		for (let p = 0; p < 9; p += 1) {
			bmp.data[p * 4] = values[p];
			bmp.data[p * 4 + 1] = 0;
			bmp.data[p * 4 + 3] = 255;
		}
		boxBlur(bmp, 1);
		// Border windows clip at the image edge, so corners average a 2x2
		// block, edges a 2x3 block, and the center the full 3x3 grid.
		const expected = [60, 75, 90, 105, 120, 135, 150, 165, 180];
		for (let p = 0; p < 9; p += 1) {
			expect(bmp.data[p * 4]).toBe(expected[p]);
			expect(bmp.data[p * 4 + 3]).toBe(255);
		}
	});

	it('applyBlurEffect respects the option flag and radius', () => {
		const options = baseOptions({ applyBlur: true, blurRadius: 0 });
		const bmp = solidBitmap(4, 4, 10, 20, 30);
		bmp.data[16] = 250; // One outlier pixel that only blur would move.
		applyBlurEffect(bmp, options);
		expect(bmp.data[16]).toBe(250);

		options.blurRadius = 1;
		applyBlurEffect(bmp, options);
		expect(bmp.data[16]).not.toBe(250);
	});
});

describe('applyLsbEffect', () => {
	it('routes to clearing or randomizing by option', () => {
		const clearOptions = baseOptions({ clearLsb: true });
		const bmp = makeBitmap(1, 1);
		bmp.data.set([3, 7, 15, 255]);
		applyLsbEffect(bmp, clearOptions);
		expect([bmp.data[0], bmp.data[1], bmp.data[2]]).toEqual([2, 6, 14]);

		const noneOptions = baseOptions();
		const bmp2 = makeBitmap(1, 1);
		bmp2.data.set([3, 7, 15, 255]);
		applyLsbEffect(bmp2, noneOptions);
		expect([bmp2.data[0], bmp2.data[1], bmp2.data[2]]).toEqual([3, 7, 15]);
	});
});

describe('lanczos3Kernel', () => {
	it('is 1 at the origin, 0 at integer offsets and outside support', () => {
		expect(lanczos3Kernel(0)).toBe(1);
		expect(lanczos3Kernel(1)).toBeCloseTo(0, 12);
		expect(lanczos3Kernel(-2)).toBeCloseTo(0, 12);
		expect(lanczos3Kernel(3)).toBe(0);
		expect(lanczos3Kernel(-3.5)).toBe(0);
	});

	it('decays symmetrically and stays bounded', () => {
		expect(lanczos3Kernel(0.5)).toBeCloseTo(lanczos3Kernel(-0.5), 12);
		for (const x of [0.25, 0.75, 1.5, 2.5]) {
			expect(Math.abs(lanczos3Kernel(x))).toBeLessThan(1);
		}
	});
});

describe('resampleSeparable', () => {
	it('reproduces the input at identical dimensions with Lanczos-3', () => {
		const src = new Uint8ClampedArray(8 * 8 * 4);
		for (let i = 0; i < src.length; i += 1) src[i] = (i * 37) % 256;
		const out = resampleSeparable(src, 8, 8, 8, 8, lanczos3Filter);
		for (let i = 0; i < src.length; i += 1) {
			expect(Math.abs(out[i] - src[i])).toBeLessThanOrEqual(1);
		}
	});

	it('downsamples 2x2 blocks to their exact channel means with the area filter', () => {
		const src = new Uint8ClampedArray([
			10, 20, 30, 255, 30, 40, 50, 255,
			110, 120, 130, 255, 130, 140, 150, 255,
		]);
		const out = resampleSeparable(src, 2, 2, 1, 1, boxFilter);
		expect(Array.from(out.slice(0, 4))).toEqual([70, 80, 90, 255]);
	});

	it('bounds the intermediate float plane for sources far larger than the output', () => {
		// The horizontal pass used to allocate a plane proportional to the
		// source height, so capping a very large frame could allocate hundreds
		// of megabytes. Track the intermediate allocations to prove it is now
		// split into bands.
		const OriginalFloat32Array = Float32Array;
		const allocations: number[] = [];
		class TrackingFloat32Array extends OriginalFloat32Array {
			constructor(length: number) {
				super(length);
				allocations.push(length);
			}
		}
		vi.stubGlobal('Float32Array', TrackingFloat32Array);
		try {
			const width = 1024;
			const height = 4096;
			const src = new Uint8ClampedArray(width * height * 4);
			for (let i = 0; i < src.length; i += 4) src[i] = i & 0xff;
			const out = resampleSeparable(src, width, height, width, height, boxFilter);
			expect(out.length).toBe(width * height * 4);
			const fullPlane = width * height * 4;
			expect(allocations.length).toBeGreaterThan(1);
			expect(Math.max(...allocations)).toBeLessThan(fullPlane / 2);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('squeezeImageData', () => {
	it('round trips a smooth gradient with negligible loss', () => {
		const width = 64;
		const height = 64;
		const bmp = makeBitmap(width, height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bmp.data[i] = x * 4;
				bmp.data[i + 1] = y * 4;
				bmp.data[i + 2] = (x + y) * 2;
				bmp.data[i + 3] = 255;
			}
		}
		const before = new Uint8ClampedArray(bmp.data);
		squeezeImageData(bmp, 0.9);
		const score = combinedPsnr(before, bmp.data);
		expect(score).toBeGreaterThan(35);
	});

	it('is a no-op when the factor rounds to no size change', () => {
		const bmp = solidBitmap(3, 3, 12, 34, 56);
		const before = new Uint8ClampedArray(bmp.data);
		squeezeImageData(bmp, 0.9999);
		expect(Array.from(bmp.data)).toEqual(Array.from(before));
	});
});

describe('generateTileShiftState', () => {
	it('draws integer offsets inside the strength budget', () => {
		mockRandomSeq([0.999999, 0, 0.3, 0.7]);
		const state = generateTileShiftState(200, 100, 2, 50);
		expect(state.tileSize).toBe(50);
		expect(state.cols).toBe(4);
		expect(state.rows).toBe(2);
		for (let i = 0; i < state.offsetsX.length; i += 1) {
			expect(Number.isInteger(state.offsetsX[i])).toBe(true);
			expect(Number.isInteger(state.offsetsY[i])).toBe(true);
			expect(Math.abs(state.offsetsX[i])).toBeLessThanOrEqual(2);
			expect(Math.abs(state.offsetsY[i])).toBeLessThanOrEqual(2);
		}
	});

	it('produces one offset per grid tile and varies them across tiles', () => {
		mockRandomSeq([0.999999, 0.5, 0, 0.5]);
		const state = generateTileShiftState(100, 100, 2, 50);
		expect(state.offsetsX.length).toBe(state.cols * state.rows);
		expect(state.offsetsY.length).toBe(state.cols * state.rows);
		expect(new Set(state.offsetsX).size).toBeGreaterThan(1);
	});

	it('clamps the drawn offsets below a quarter of the cell even for hand-set extremes', () => {
		// A budget of 4 at the API's minimum cell of 16 would otherwise draw
		// an offset of 4, putting the field's steepest gradient at exactly
		// one and folding it over itself. The clamp keeps the drawn offsets
		// at 3, so the gradient stays at 0.75.
		mockRandomSeq([0.999999, 0.5, 0.999999, 0.5]);
		const state = generateTileShiftState(32, 16, 4, 16);
		expect(Math.max(...state.offsetsX, ...state.offsetsY)).toBe(3);
		expect(4 * 3).toBeLessThan(state.tileSize);
	});

	it.each([
		[1.2, 55],
		[2, 50],
		[3, 46],
		[4, 20],
		[4, 80],
		[4, 16],
	] as const)('keeps the field fold-free for strength %f at cell size %i', (budget, size) => {
		// The bilinear offset field moves by its steepest gradient at the
		// corner where the four surrounding anchors' offsets differ most,
		// four times the whole-pixel budget per ramp. A gradient of one or
		// more folds the field over itself, mirroring content; the drawn
		// offsets must stay under a quarter of the cell.
		mockRandomSeq([0.999999, 0.5, 0.999999, 0.5]);
		const state = generateTileShiftState(256, 256, budget, size);
		const drawn = Math.max(...state.offsetsX, ...state.offsetsY);
		expect(4 * drawn).toBeLessThan(state.tileSize);
		expect(state.feather).toBe(state.tileSize);
	});
});

describe('applyTileShiftStage', () => {
	it('is a no-op without a shift plan', async () => {
		const bmp = makeBitmap(4, 4);
		bmp.data.fill(90);
		const before = new Uint8ClampedArray(bmp.data);
		await applyTileShiftStage(bmp, null);
		expect(Array.from(bmp.data)).toEqual(Array.from(before));
	});

	it('copies the whole image exactly when every tile draws the same shift', async () => {
		// Sequence forces every tile to the offset (+2, 0).
		mockRandomSeq([0.999999, 0.5]);
		const width = 100;
		const height = 60;
		const bmp = makeBitmap(width, height);
		for (let p = 0; p < width * height; p += 1) {
			bmp.data[p * 4] = (p * 7) % 256;
			bmp.data[p * 4 + 3] = 255;
		}
		await applyTileShiftStage(bmp, generateTileShiftState(width, height, 2, 50));
		// A uniform offset field is whole-pixel everywhere, so every pixel is
		// an exact copy of the source content two pixels to the right.
		for (const [x, y] of [[5, 5], [20, 30], [40, 45], [50, 10], [90, 55]] as const) {
			const i = (y * width + x) * 4;
			expect(bmp.data[i]).toBe(((y * width + x + 2) * 7) % 256);
			expect(bmp.data[i + 3]).toBe(255);
		}
	});

	it('keeps a feature single when it warps across a tile border', async () => {
		// Force tile (0,0) to (+2, 0) and tile (1,0) to (-2, 0), so the two
		// tiles' copies of the line sit four pixels apart. Cross-fading the
		// shifted copies would leave two separate bright runs; the continuous
		// offset field must keep the line a single unbroken feature.
		mockRandomSeq([0.999999, 0.5, 0, 0.5]);
		const width = 100;
		const height = 4;
		const bmp = makeBitmap(width, height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bmp.data[i] = x === 52 ? 255 : 0;
				bmp.data[i + 3] = 255;
			}
		}
		await applyTileShiftStage(bmp, generateTileShiftState(width, height, 2, 50));
		for (let y = 0; y < height; y += 1) {
			const bright: number[] = [];
			for (let x = 40; x < 60; x += 1) {
				if (bmp.data[(y * width + x) * 4] >= 100) bright.push(x);
			}
			expect(bright.length).toBeGreaterThan(0);
			for (let i = 1; i < bright.length; i += 1) {
				expect(bright[i]).toBe(bright[i - 1] + 1);
			}
		}
	});

	it('keeps a feature single across repeated borders at the strongest shift and smallest cell', async () => {
		// Strength 4 and cell 20 are the slider extremes: forced alternating
		// offsets of +4 and -4 make the field swing eight pixels across every
		// 20px cell, the steepest gradient the UI can produce. Every border
		// must still map the line to one unbroken run instead of folding it.
		mockRandomSeq([0.999999, 0.5, 0, 0.5]);
		const width = 200;
		const height = 2;
		const bmp = makeBitmap(width, height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bmp.data[i] = x === 101 ? 255 : 0;
				bmp.data[i + 3] = 255;
			}
		}
		await applyTileShiftStage(bmp, generateTileShiftState(width, height, 4, 20));
		for (let y = 0; y < height; y += 1) {
			const bright: number[] = [];
			for (let x = 0; x < width; x += 1) {
				if (bmp.data[(y * width + x) * 4] >= 100) bright.push(x);
			}
			expect(bright.length).toBeGreaterThan(0);
			for (let i = 1; i < bright.length; i += 1) {
				expect(bright[i]).toBe(bright[i - 1] + 1);
			}
		}
	});

	it('leaves a solid image untouched', async () => {
		mockRandomSeq([0.9, 0.1]);
		const bmp = solidBitmap(60, 40, 128, 64, 32);
		await applyTileShiftStage(bmp, generateTileShiftState(60, 40, 3, 20));
		for (let i = 0; i < bmp.data.length; i += 4) {
			expect([bmp.data[i], bmp.data[i + 1], bmp.data[i + 2]]).toEqual([128, 64, 32]);
		}
	});
});

describe('generateAffineParams and applyWarpStage', () => {
	it('generates unit sampling scale for zero jitter regardless of aspect', () => {
		mockRandomSeq([0.5]);
		for (const [w, h] of [[100, 100], [1920, 1080], [640, 1920]] as const) {
			const params = generateAffineParams(0, w, h);
			expect(params.rot).toBe(0);
			expect(params.sampleScale).toBeCloseTo(1, 12);
			expect(params.tx).toBeCloseTo(0, 12);
		}
	});

	it('scales translation with the rotation setting instead of always shifting full range', () => {
		// A draw of 0 maps to the negative extreme, so the magnitudes below
		// read the translation budget directly.
		mockRandomSeq([0.0]);
		expect(generateAffineParams(1.5, 100, 100).tx).toBeCloseTo(-2, 12);
		expect(generateAffineParams(0.15, 100, 100).tx).toBeCloseTo(-0.2, 12);
		mockRandomSeq([0.0]);
		expect(generateAffineParams(0.15, 100, 100).ty).toBeCloseTo(-0.2, 12);
	});

	it('caps translation at the maximum for large rotations and zeroes it at zero', () => {
		mockRandomSeq([0.0]);
		expect(generateAffineParams(4, 100, 100).tx).toBeCloseTo(-2, 12);
		mockRandomSeq([0.9999999]);
		const tiny = generateAffineParams(0.01, 100, 100);
		expect(Math.abs(tiny.tx)).toBeLessThan(0.02);
		expect(Math.abs(tiny.ty)).toBeLessThan(0.02);
	});

	it('quantizes sub-pixel tile strengths to zero everywhere', () => {
		// Integer offsets cannot express 0.5px: the draw range never reaches
		// the rounding threshold, so every tile stays put. Callers gate such
		// strengths as disabled rather than running a wasted exact copy.
		mockRandomSeq([0.0, 0.9999999, 0.37]);
		const state = generateTileShiftState(64, 64, 0.5, 50);
		expect(Array.from(state.offsetsX).every((o) => o === 0)).toBe(true);
		expect(Array.from(state.offsetsY).every((o) => o === 0)).toBe(true);
	});

	it('uses the smallest zoom that lets the rotated frame cover the canvas', () => {
		mockRandomSeq([0.999999]);
		const angle = ((0.999999 * 2) - 1) * 0.75 * (Math.PI / 180);
		// Zoom grows with aspect ratio extremity and stays below the old
		// square-frame factor plus margin for moderate aspects like 4:3.
		const squareParams = generateAffineParams(0.75, 1080, 1080);
		const wideParams = generateAffineParams(0.75, 1440, 1080);
		const widerParams = generateAffineParams(0.75, 1920, 1080);
		expect(1 / squareParams.sampleScale).toBeCloseTo(Math.cos(angle) + Math.sin(angle), 12);
		expect(1 / wideParams.sampleScale).toBeCloseTo(Math.cos(angle) + Math.sin(angle) * (4 / 3), 12);
		expect(wideParams.sampleScale).toBeGreaterThan(widerParams.sampleScale);
		// The square-frame factor with an arbitrary margin would over-zoom.
		expect(1 / wideParams.sampleScale).toBeLessThan(Math.cos(angle) + Math.sin(angle) + 0.01);
	});

	it('is a no-op when the affine params are null', async () => {
		const bmp = makeBitmap(4, 4);
		bmp.data.fill(77);
		const before = new Uint8ClampedArray(bmp.data);
		await applyWarpStage(bmp, null);
		expect(Array.from(bmp.data)).toEqual(Array.from(before));
	});

	it('preserves solid-color content regardless of warp', async () => {
		mockRandomSeq([0.15, 0.85, 0.4, 0.2, 0.95]);
		const bmp = solidBitmap(24, 18, 128, 64, 32);
		await applyTileShiftStage(bmp, generateTileShiftState(24, 18, 3, 6));
		await applyWarpStage(bmp, generateAffineParams(1.5, 24, 18));
		for (let i = 0; i < bmp.data.length; i += 4) {
			expect([bmp.data[i], bmp.data[i + 1], bmp.data[i + 2]]).toEqual([128, 64, 32]);
		}
	});

	it('converts horizontal stripes into homogeneous vertical columns under quarter rotation', async () => {
		const size = 40;
		const bmp = makeBitmap(size, size);
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				const i = (y * size + x) * 4;
				const topHalf = y < size / 2;
				bmp.data[i] = topHalf ? 220 : 30;
				bmp.data[i + 1] = topHalf ? 30 : 200;
				bmp.data[i + 2] = 90;
				bmp.data[i + 3] = 255;
			}
		}
		await applyWarpStage(bmp, { rot: Math.PI / 2, sampleScale: 1, tx: 0, ty: 0 });
		// The inverse map samples a source row determined solely by the output
		// x coordinate, and the source colors are constant along every row, so
		// each output column must be uniform.
		for (let x = 0; x < size; x += 1) {
			const base = x * 4;
			for (let y = 1; y < size; y += 1) {
				const idx = (y * size + x) * 4;
				expect(bmp.data[idx]).toBe(bmp.data[base]);
				expect(bmp.data[idx + 1]).toBe(bmp.data[base + 1]);
				expect(bmp.data[idx + 2]).toBe(bmp.data[base + 2]);
			}
		}
	});

	it('quantizes fractional sampling phases within a one-level bound', async () => {
		// Fractional samples take their kernel weights from a phase table, so
		// this pins the resulting per-channel error against an exact Lanczos-3
		// evaluation on a high-contrast pattern. Integer phases are grid-exact
		// and stay pinned by the quarter-rotation tests; a coarser band grid
		// would pass those while exceeding this bound.
		const width = 12;
		const height = 3;
		const tx = 0.32;
		const valueAt = (x: number) => (x % 2 === 0 ? 250 : 5);
		const bmp = makeBitmap(width, height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bmp.data[i] = valueAt(x);
				bmp.data[i + 3] = 255;
			}
		}
		await applyWarpStage(bmp, { rot: 0, sampleScale: 1, tx, ty: 0 });
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const sx = x - tx;
				const x0 = Math.floor(sx);
				const frac = sx - x0;
				let value = 0;
				let wsum = 0;
				for (let n = -2; n <= 3; n += 1) {
					const w = lanczos3Kernel(n - frac);
					value += w * valueAt(Math.min(width - 1, Math.max(0, x0 + n)));
					wsum += w;
				}
				const expected = new Uint8ClampedArray([value / wsum])[0];
				expect(Math.abs(bmp.data[(y * width + x) * 4] - expected)).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe('straight-alpha averaging', () => {
	it('carries premultiplied color through both resampling axes', () => {
		const src = new Uint8ClampedArray([
			255, 0, 0, 255, 0, 255, 0, 0,
			0, 0, 255, 85, 0, 0, 255, 85,
		]);
		expect(Array.from(resampleSeparable(src, 2, 2, 1, 1, boxFilter))).toEqual([153, 0, 102, 106]);
	});

	it('bilateralFilter scales partially transparent neighbors continuously', async () => {
		const bmp = makeBitmap(3, 1);
		bmp.data.set([200, 200, 200, 85, 100, 100, 100, 255, 250, 250, 250, 0]);
		await bilateralFilter(bmp, 1, 1e6);
		const neighborWeight = Math.exp(-2) * 85;
		const expected = new Uint8ClampedArray([(100 * 255 + 200 * neighborWeight) / (255 + neighborWeight)])[0];
		expect(Array.from(bmp.data.slice(4, 8))).toEqual([expected, expected, expected, 255]);
		expect([bmp.data[3], bmp.data[7], bmp.data[11]]).toEqual([85, 255, 0]);
	});

	it('uses nearest fallback in both axes when filter weights vanish', () => {
		const src = new Uint8ClampedArray([
			255, 0, 0, 255, 0, 255, 0, 0,
			0, 0, 255, 85, 40, 80, 120, 128,
		]);
		const filter = { support: () => 1, tapWeight: () => 0 };
		expect(Array.from(resampleSeparable(src, 2, 2, 1, 1, filter))).toEqual([40, 80, 120, 128]);
	});

	it('boxBlur weights RGB by alpha so transparent garbage never bleeds in', () => {
		const bmp = makeBitmap(3, 1);
		bmp.data.set([250, 250, 250, 0, 255, 0, 0, 255, 250, 250, 250, 0]);
		boxBlur(bmp, 1);
		expect([bmp.data[4], bmp.data[5], bmp.data[6], bmp.data[7]]).toEqual([255, 0, 0, 85]);
	});

	it('resampleSeparable weights RGB by alpha when downsampling', () => {
		const src = new Uint8ClampedArray([
			250, 250, 250, 0,
			255, 0, 0, 255,
		]);
		const out = resampleSeparable(src, 2, 1, 1, 1, boxFilter);
		expect([out[0], out[1], out[2], out[3]]).toEqual([255, 0, 0, 128]);
	});

	it('applyWarpStage weights RGB by alpha so transparent neighbors do not bleed', async () => {
		const bmp = makeBitmap(1, 3);
		bmp.data.set([250, 250, 250, 0, 255, 0, 0, 255, 250, 250, 250, 0]);
		await applyWarpStage(bmp, { rot: 0, sampleScale: 1, tx: 0, ty: 0.5 });
		expect(Array.from(bmp.data.slice(4, 7))).toEqual([255, 0, 0]);
		const weightSum = [-2, -1, 0, 1, 2, 3].reduce((sum, tap) => sum + lanczos3Kernel(tap - 0.5), 0);
		expect(bmp.data[7]).toBe(new Uint8ClampedArray([255 * lanczos3Kernel(0.5) / weightSum])[0]);
	});

	it.each(['blur', 'area', 'lanczos', 'warp', 'tile', 'bilateral'] as const)('%s is invariant to hidden transparent RGB', async (operation) => {
		const first = solidBitmap(32, 16, 120, 40, 80, 128);
		const second = solidBitmap(32, 16, 120, 40, 80, 128);
		for (let p = 0; p < 32 * 16; p += 3) {
			first.data.set([0, 0, 0, 0], p * 4);
			second.data.set([250, 180, 70, 0], p * 4);
		}
		const run = async (bmp: Bitmap): Promise<Uint8ClampedArray> => {
			if (operation === 'blur') boxBlur(bmp, 1);
			if (operation === 'area' || operation === 'lanczos') {
				return resampleSeparable(bmp.data, 32, 16, 23, 21, operation === 'area' ? boxFilter : lanczos3Filter);
			}
			if (operation === 'warp') await applyWarpStage(bmp, { rot: 0.04, sampleScale: 0.95, tx: 0.3, ty: -0.2 });
			if (operation === 'tile') await applyTileShiftStage(bmp, {
				tileSize: 16, feather: 6, cols: 2, rows: 1,
				offsetsX: new Int16Array([2, -2]), offsetsY: new Int16Array([0, 0]),
			});
			if (operation === 'bilateral') await bilateralFilter(bmp, 2, 80);
			return bmp.data;
		};
		expect(await run(first)).toEqual(await run(second));
	});

	it('applyTileShiftStage weights transparent pixels by alpha so hidden RGB stays out', async () => {
		mockRandomSeq([0.999999, 0.5, 0, 0.5]);
		const width = 100;
		const height = 50;
		const bmp = makeBitmap(width, height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bmp.data[i] = x % 256;
				bmp.data[i + 3] = 255;
			}
		}
		for (let y = 0; y < height; y += 1) bmp.data.set([250, 200, 150, 0], (y * width + 52) * 4);
		await applyTileShiftStage(bmp, generateTileShiftState(width, height, 2, 50));
		for (let y = 0; y < height; y += 1) {
			const i = (y * width + 50) * 4;
			// The transparent column's hidden green and blue must not bleed
			// into the warp, and the source only has red set elsewhere.
			expect(bmp.data[i + 1]).toBe(0);
			expect(bmp.data[i + 2]).toBe(0);
			expect(bmp.data[i + 3]).toBeGreaterThan(0);
		}
	});

	it('bilateralFilter weights neighbor RGB by alpha and preserves alpha', async () => {
		const bmp = makeBitmap(3, 1);
		bmp.data.set([250, 250, 250, 0, 255, 0, 0, 255, 250, 250, 250, 0]);
		await bilateralFilter(bmp, 1, 1e6);
		expect(Array.from(bmp.data.slice(4, 8))).toEqual([255, 0, 0, 255]);
		expect([bmp.data[3], bmp.data[7], bmp.data[11]]).toEqual([0, 255, 0]);
	});
});

describe('applyWarpStage exact quarter rotations', () => {
	it('rotates 90 degrees clockwise around the pixel-grid center exactly', async () => {
		const size = 8;
		const bmp = makeBitmap(size, size);
		for (let p = 0; p < size * size; p += 1) {
			bmp.data[p * 4] = p;
			bmp.data[p * 4 + 3] = 255;
		}
		await applyWarpStage(bmp, { rot: Math.PI / 2, sampleScale: 1, tx: 0, ty: 0 });
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				const srcX = y;
				const srcY = size - 1 - x;
				expect(bmp.data[(y * size + x) * 4]).toBe(srcY * size + srcX);
			}
		}
	});

	it('rotates 180 degrees around the pixel-grid center exactly', async () => {
		const size = 8;
		const bmp = makeBitmap(size, size);
		for (let p = 0; p < size * size; p += 1) {
			bmp.data[p * 4] = p;
			bmp.data[p * 4 + 3] = 255;
		}
		await applyWarpStage(bmp, { rot: Math.PI, sampleScale: 1, tx: 0, ty: 0 });
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				const srcP = (size - 1 - y) * size + (size - 1 - x);
				expect(bmp.data[(y * size + x) * 4]).toBe(srcP);
			}
		}
	});
});

describe('resampleSeparable allocation cap', () => {
	it.each([
		['area', 1, boxFilter],
		['lanczos', 1, lanczos3Filter],
		['lanczos halo', 513, lanczos3Filter],
	] as const)('streams %s downsampling to height %i within the total scratch budget', (_name, dstHeight, filter) => {
		const width = 1024;
		const height = 4096;
		const src = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				src[i] = y & 0xff;
				src[i + 1] = x & 0xff;
				src[i + 3] = y % 2 === 0 ? 255 : 85;
			}
		}
		const OriginalFloat32Array = Float32Array;
		const allocations: number[] = [];
		class TrackingFloat32Array extends OriginalFloat32Array {
			constructor(length: number) {
				super(length);
				allocations.push(length);
			}
		}
		const OriginalFloat64Array = Float64Array;
		class TrackingFloat64Array extends OriginalFloat64Array {
			constructor(length: number) {
				super(length);
				allocations.push(length * 2);
			}
		}
		vi.stubGlobal('Float32Array', TrackingFloat32Array);
		vi.stubGlobal('Float64Array', TrackingFloat64Array);
		try {
			const out = resampleSeparable(src, width, height, width, dstHeight, filter);
			expect(out.length).toBe(width * dstHeight * 4);
			expect(allocations.length).toBeGreaterThan(0);
			expect(allocations.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(RESAMPLE_BAND_ELEMENTS);
			const scale = height / dstHeight;
			for (let y = 0; y < dstHeight; y += 1) {
				const center = (y + 0.5) * scale - 0.5;
				let weights = 0;
				let alpha = 0;
				let red = 0;
				for (let sy = 0; sy < height; sy += 1) {
					const w = filter.tapWeight(sy, center, scale);
					const a = sy % 2 === 0 ? 255 : 85;
					weights += w;
					alpha += w * a;
					red += w * a * (sy & 0xff);
				}
				const expected = new Uint8ClampedArray([red / alpha, 0, 0, alpha / weights]);
				for (const x of [0, 1, 255, 511, width - 1]) {
					expected[1] = x & 0xff;
					expect(out.slice((y * width + x) * 4, (y * width + x + 1) * 4)).toEqual(expected);
				}
			}
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe('sharpness retention', () => {
	// Photo-like: smooth base plus a band of spatially correlated texture
	// (real photographs never contain independent per-pixel noise, and any
	// interpolation trivially shrinks the energy of uncorrelated noise).
	function photoLike(width: number, height: number): Bitmap {
		const bmp = makeBitmap(width, height);
		let seed = 12345;
		const rand = () => {
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			return seed / 0x7fffffff;
		};
		const raw = new Float32Array(width * height);
		for (let i = 0; i < raw.length; i += 1) raw[i] = rand();
		const smooth = new Float32Array(width * height);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				let sum = 0;
				let count = 0;
				for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
					const px = Math.min(width - 1, x + ox);
					const py = Math.min(height - 1, y + oy);
					sum += raw[py * width + px];
					count += 1;
				}
				smooth[y * width + x] = sum / count;
			}
		}
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				const base = 128 + 60 * Math.sin(x / 97) * Math.cos(y / 83);
				const detailBand = x > width * 0.3 && x < width * 0.7 && y > height * 0.3 && y < height * 0.7;
				const detail = detailBand ? (smooth[y * width + x] * 2 - 1) * 45 : (smooth[y * width + x] * 2 - 1) * 4;
				bmp.data[i] = base + detail;
				bmp.data[i + 1] = base + detail * 0.8;
				bmp.data[i + 2] = base - detail * 0.6;
				bmp.data[i + 3] = 255;
			}
		}
		return bmp;
	}

	function laplacianEnergy(data: Uint8ClampedArray, width: number, height: number): number {
		let energy = 0;
		for (let y = 1; y < height - 1; y += 1) {
			for (let x = 1; x < width - 1; x += 1) {
				const i = (y * width + x) * 4;
				const lap = 4 * data[i] - data[i - 4] - data[i + 4] - data[i - width * 4] - data[i + width * 4];
				energy += lap * lap;
			}
		}
		return energy;
	}

	it('keeps high-frequency energy through the default pixel attack', async () => {
		const width = 320;
		const height = 240;
		const original = photoLike(width, height);
		const before = laplacianEnergy(original.data, width, height);
		mockRandomSeq([0.85, 0.3, 0.6, 0.2, 0.75, 0.45, 0.1, 0.9]);
		await applyTileShiftStage(original, generateTileShiftState(width, height, 2, 50));
		await applyWarpStage(original, generateAffineParams(0.75, width, height));
		const after = laplacianEnergy(original.data, width, height);
		// Measured 0.83 with the Lanczos-3 rotation sampler; the guard keeps a
		// margin below that so kernel or feather regressions fail loudly.
		expect(after / before).toBeGreaterThan(0.75);
	});
});

describe('color shift', () => {
	it('produces identity parameters when randomness sits at neutral', () => {
		mockRandomSeq([0.5]);
		const shift = generateColorShift(1.5);
		for (let r = 0; r < 3; r += 1) {
			for (let c = 0; c < 3; c += 1) {
				expect(shift.m[r * 3 + c]).toBeCloseTo(r === c ? 1 : 0, 9);
			}
		}
		expect(shift.offset.every((o) => Math.abs(o) < 1e-9)).toBe(true);
	});

	it('applies a known matrix with per-channel offsets', () => {
		const bmp = makeBitmap(1, 1);
		bmp.data.set([100, 100, 100, 255]);
		applyColorShift(bmp, {
			m: [2, 0, 0, 0, 1, 0, 0, 0, 0.5],
			offset: [10, -5, 0],
		});
		expect([bmp.data[0], bmp.data[1], bmp.data[2]]).toEqual([210, 95, 50]);
	});

	it('clamps results into the byte range', () => {
		const bmp = makeBitmap(1, 1);
		bmp.data.set([250, 5, 5, 255]);
		applyColorShift(bmp, { m: [2, 0, 0, 0, 1, 0, 0, 0, 1], offset: [40, -40, 0] });
		expect(bmp.data[0]).toBe(255);
		expect(bmp.data[1]).toBe(0);
	});
});

describe('addLumaNoise', () => {
	it('shifts channels together and stays within the level bound', () => {
		mockRandomSeq([0.999999, 0, 0.5]);
		const levels = 2.5;
		const bmp = makeBitmap(3, 1);
		for (let i = 0; i < bmp.data.length; i += 4) {
			bmp.data[i] = 100;
			bmp.data[i + 1] = 100;
			bmp.data[i + 2] = 100;
			bmp.data[i + 3] = 255;
		}
		addLumaNoise(bmp, levels);
		for (let p = 0; p < 3; p += 1) {
			const i = p * 4;
			expect(bmp.data[i]).toBe(bmp.data[i + 1]);
			expect(Math.abs(bmp.data[i] - 100)).toBeLessThanOrEqual(Math.ceil(levels));
		}
	});

	it('rounds sub-level noise away entirely at and below half a level', () => {
		// The image path rounds any perturbation of half a level or less back
		// to the starting value for every draw in [0, 1), so these settings
		// are a no-op here. The video path skips an even wider band (its
		// compensated cutoff sits near 0.58), so both media types leave these
		// settings alone; the video boundary itself is pinned in the
		// isSubLevelVideoNoise tests. Just above half a level the two part
		// ways: extreme draws can move the image by one level while the video
		// filter stays quiet.
		for (const levels of [0.4, 0.5]) {
			const bmp = solidBitmap(2, 1, 99, 100, 101);
			const before = new Uint8ClampedArray(bmp.data);
			// Extremes of the [0, 1) range; the exact 0 draw, the one that
			// lands on the -0.5 tie, is covered by the test below.
			mockRandomSeq([0.9999999, 0.5, 0.25]);
			addLumaNoise(bmp, levels);
			expect(Array.from(bmp.data)).toEqual(Array.from(before));
		}
	});

	it('rounds the zero draw away at the sub-level cutoff like every other draw', () => {
		// Math.random and the seeded generator both allow an exact 0 draw,
		// which lands the perturbation on the -0.5 tie rather than strictly
		// inside the round-away band. The claim that sub-level noise rounds
		// away entirely must hold for that draw too.
		const bmp = solidBitmap(2, 1, 99, 100, 101);
		const before = new Uint8ClampedArray(bmp.data);
		mockRandomSeq([0]);
		addLumaNoise(bmp, 0.5);
		expect(Array.from(bmp.data)).toEqual(Array.from(before));
	});
});

describe('bilateralFilter', () => {
	it('pulls isolated speckles toward flat surroundings', async () => {
		const bmp = makeBitmap(9, 9);
		bmp.data.fill(0);
		for (let i = 0; i < bmp.data.length; i += 4) {
			bmp.data[i] = 100;
			bmp.data[i + 3] = 255;
		}
		const speck = (4 * 9 + 4) * 4;
		bmp.data[speck] = 230;
		await bilateralFilter(bmp, 2, 25);
		const before = 230;
		expect(bmp.data[speck]).toBeLessThan(before);
		expect(bmp.data[speck]).toBeGreaterThan(100);
	});

	it('does not smear a constant image', async () => {
		const bmp = solidBitmap(7, 7, 90, 160, 200);
		await bilateralFilter(bmp, 2, 25);
		for (let i = 0; i < bmp.data.length; i += 4) {
			expect([bmp.data[i], bmp.data[i + 1], bmp.data[i + 2]]).toEqual([90, 160, 200]);
		}
	});
});

describe('invalid pixel parameters', () => {
	it('boxBlur treats non-finite and non-positive radii as a no-op', () => {
		for (const radius of [NaN, Infinity, -Infinity, 0, -1, -2.5]) {
			const bmp = solidBitmap(4, 4, 55, 65, 75);
			const before = Array.from(bmp.data);
			boxBlur(bmp, radius);
			expect(Array.from(bmp.data)).toEqual(before);
		}
	});

	it('addLumaNoise treats non-finite and non-positive levels as a no-op', () => {
		for (const levels of [NaN, Infinity, -Infinity, 0, -2]) {
			const bmp = solidBitmap(2, 2, 100, 100, 100);
			const before = Array.from(bmp.data);
			addLumaNoise(bmp, levels);
			expect(Array.from(bmp.data)).toEqual(before);
		}
	});

	it('addLumaNoise is deterministic for an injected generator', () => {
		const first = solidBitmap(3, 1, 100, 100, 100);
		const second = solidBitmap(3, 1, 100, 100, 100);
		const seq = [0.1, 0.9, 0.5];
		let call = 0;
		const rng = () => seq[call++ % seq.length];
		addLumaNoise(first, 4, rng);
		call = 0;
		addLumaNoise(second, 4, rng);
		expect(Array.from(first.data)).toEqual(Array.from(second.data));
	});

	it('bilateralFilter rejects non-finite, negative, and zero parameters', async () => {
		const bmp = solidBitmap(3, 3, 90, 160, 200);
		await expect(bilateralFilter(bmp, 2, 0)).rejects.toThrow(RangeError);
		await expect(bilateralFilter(bmp, -1, 25)).rejects.toThrow(RangeError);
		await expect(bilateralFilter(bmp, NaN, 25)).rejects.toThrow(RangeError);
		await expect(bilateralFilter(bmp, 2, NaN)).rejects.toThrow(RangeError);
		await expect(bilateralFilter(bmp, Infinity, 25)).rejects.toThrow(RangeError);
	});

	it('generateTileShiftState clamps huge offsets to the Int16 range', () => {
		// A cell this large puts the fold limit past the Int16 range, so only
		// the Int16 clamp bounds the draw. Without it the near-maximal random
		// draw lands at 34999 and stores as -30537, reversing direction.
		mockRandomSeq([0.999999, 0.999999]);
		const state = generateTileShiftState(64, 64, 100000, 140000);
		expect(state.offsetsX[0]).toBe(32767);
		expect(state.offsetsY[0]).toBe(32767);
	});
});
