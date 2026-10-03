import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bitmap, DistortOptions, DistortRandomState } from './types';
import { computePsnr } from './metrics';
import { addLumaNoise } from './pixels';
import { createSeededRandom } from './util';
import {
	DISTORT_PRESETS,
	applyDistortStages,
	applyDistortPipeline,
	buildDistortRandomState,
	buildDistortVideoFilters,
	encodeStaticImage,
	gifQualityToMaxColors,
	isSubLevelVideoNoise,
	qualityFloorSkipWarning,
	subLevelVideoNoiseWarning,
} from './distort';

afterEach(() => {
	vi.restoreAllMocks();
});

function disabledOptions(): DistortOptions {
	return {
		enabled: true,
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
	};
}

function solidGray(width: number, height: number): Bitmap {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let i = 0; i < data.length; i += 4) {
		data[i] = 128;
		data[i + 1] = 128;
		data[i + 2] = 128;
		data[i + 3] = 255;
	}
	return { width, height, data };
}

function stripyBitmap(width: number, height: number): Bitmap {
	// One-pixel vertical stripes: enough detail that any subpixel resample
	// scores low, so warp strengths separate cleanly by PSNR.
	const bmp = solidGray(width, height);
	for (let i = 0; i < bmp.data.length; i += 8) {
		bmp.data[i] = 255;
		bmp.data[i + 1] = 255;
		bmp.data[i + 2] = 255;
	}
	return bmp;
}

describe('DISTORT_PRESETS', () => {
	const keys: (keyof typeof DISTORT_PRESETS.gentle)[] = [
		'elasticAlpha',
		'elasticSigma',
		'rotationJitter',
		'squeezeFactor',
		'colorAmount',
		'lumaNoise',
		'reencodeRounds',
		'reencodeQuality',
		'bilateral',
		'psnrFloor',
	];

	it('defines complete parameter sets for every strength tier', () => {
		for (const preset of Object.values(DISTORT_PRESETS)) {
			for (const key of keys) {
				expect(preset[key]).toBeDefined();
			}
			expect(preset.psnrFloor).toBeGreaterThanOrEqual(10);
			expect(preset.psnrFloor).toBeLessThanOrEqual(40);
			// 1 means the squeeze stage is disabled; milder presets skip it so
			// the pipeline stays sharp.
			expect(preset.squeezeFactor).toBeLessThanOrEqual(1);
			expect(preset.squeezeFactor).toBeGreaterThan(0.5);
		}
	});

	it('keeps the tiers meaningfully distinct', () => {
		const values = Object.values(DISTORT_PRESETS).map((p) => p.elasticAlpha);
		expect(new Set(values).size).toBe(3);
	});
});

describe('gifQualityToMaxColors', () => {
	it('maps the slider range onto the palette depth window', () => {
		expect(gifQualityToMaxColors(60)).toBe(64);
		expect(gifQualityToMaxColors(100)).toBe(256);
		expect(gifQualityToMaxColors(88)).toBe(198);
	});

	it('clamps out-of-range qualities to the window ends', () => {
		expect(gifQualityToMaxColors(0)).toBe(64);
		expect(gifQualityToMaxColors(200)).toBe(256);
	});

	it('rises monotonically with quality', () => {
		let previous = 0;
		for (let q = 60; q <= 100; q += 5) {
			expect(gifQualityToMaxColors(q)).toBeGreaterThanOrEqual(previous);
			previous = gifQualityToMaxColors(q);
		}
	});
});

describe('buildDistortRandomState', () => {
	it('disables tile shifts below one whole pixel instead of shifting by zero', () => {
		const off = buildDistortRandomState(64, 64, { ...disabledOptions(), elasticAlpha: 0.5 });
		expect(off.tileShift).toBeNull();
		const on = buildDistortRandomState(64, 64, { ...disabledOptions(), elasticAlpha: 1.2 });
		expect(on.tileShift).not.toBeNull();
	});

	it('draws a finite per-file noise seed', () => {
		const state = buildDistortRandomState(64, 64, disabledOptions());
		expect(Number.isFinite(state.noiseSeed)).toBe(true);
	});

	it('omits video lens correction below one whole pixel like the image path', () => {
		const filters = buildDistortVideoFilters(
			{ ...disabledOptions(), elasticAlpha: 0.5 },
			{ width: 1920, height: 1080 }
		);
		expect(filters.some((f) => f.startsWith('lenscorrection='))).toBe(false);
	});

	it('applies identical noise to every frame sharing one state', async () => {
		const options = { ...disabledOptions(), lumaNoise: 3 };
		const state: DistortRandomState = { tileShift: null, affine: null, color: null, noiseSeed: 4242 };
		const first = solidGray(16, 16);
		const second = solidGray(16, 16);
		await applyDistortStages(first, state, options, false, []);
		await applyDistortStages(second, state, options, false, []);
		expect(Array.from(first.data)).toEqual(Array.from(second.data));
		expect(Array.from(first.data)).not.toEqual(Array.from(solidGray(16, 16).data));
	});
});

describe('isSubLevelVideoNoise', () => {
	it('flags positive settings that round to zero whole luma levels', () => {
		expect(isSubLevelVideoNoise(0)).toBe(false);
		expect(isSubLevelVideoNoise(0.4)).toBe(true);
		expect(isSubLevelVideoNoise(0.5)).toBe(true);
		expect(isSubLevelVideoNoise(1.4)).toBe(false);
		expect(isSubLevelVideoNoise(2)).toBe(false);
	});

	it('agrees with the image path at and below the sub-level cutoff', () => {
		// At and below the cutoff the compensated level rounds to zero and
		// the image path's sub-level perturbation is absorbed by integer
		// rounding, so both paths leave the pixels alone.
		expect(isSubLevelVideoNoise(0.4)).toBe(true);
		expect(isSubLevelVideoNoise(0.5)).toBe(true);
		const filters = buildDistortVideoFilters({ ...disabledOptions(), lumaNoise: 0.5 }, null);
		expect(filters.some((f) => f.startsWith('noise='))).toBe(false);
	});

	it('still moves the image inside the video skip band just above half a level', () => {
		// The video filter skips every setting whose compensated level
		// rounds to zero, nearly up to 0.58, but the image path only absorbs
		// perturbations at and below half a level: an extreme draw just above
		// it shifts pixels by one. The two paths part ways inside the skip
		// band, so the skip cannot claim to cover what the image path does.
		const level = 0.55;
		expect(isSubLevelVideoNoise(level)).toBe(true);
		const bmp: Bitmap = { width: 1, height: 1, data: new Uint8ClampedArray([99, 100, 101, 255]) };
		vi.spyOn(Math, 'random').mockReturnValue(0);
		addLumaNoise(bmp, level);
		expect(Array.from(bmp.data)).not.toEqual([99, 100, 101, 255]);
	});

	it('advises a video noise level on the slider grid that survives the whole-level rounding', () => {
		// The advice must land on the slider's grid so the recommended value
		// is selectable, and it must actually apply; parsing the text back
		// keeps the advice and the cutoff from drifting apart. One step below
		// the advice must stay skipped, so the advice is the smallest change
		// on that grid that works.
		for (const step of [0.1, 0.25]) {
			const warning = subLevelVideoNoiseWarning(step);
			const advised = Number.parseFloat(/at least ([0-9.]+)/.exec(warning)![1]);
			expect(isSubLevelVideoNoise(advised)).toBe(false);
			expect(advised / step).toBeCloseTo(Math.round(advised / step), 10);
			expect(isSubLevelVideoNoise(advised - step)).toBe(true);
		}
	});
});

describe('buildDistortVideoFilters', () => {
	it('returns an empty chain when every stage is off', () => {
		const filters = buildDistortVideoFilters(disabledOptions(), { width: 1920, height: 1080 });
		expect(filters).toEqual([]);
	});

	it('omits lens correction when frame size is unknown but keeps other stages', () => {
		const options = { ...disabledOptions(), lumaNoise: 2 };
		const filters = buildDistortVideoFilters(options, null);
		expect(filters.some((f) => f.startsWith('lenscorrection='))).toBe(false);
		expect(filters).toContain(`noise=c0s=5:allf=t+u`);
	});

	it('scales lens distortion k1 to the alpha-pixel budget for the frame size', () => {
		const options = { ...disabledOptions(), elasticAlpha: 2 };
		const width = 1920;
		const height = 1080;
		const expectedK1 = Math.min(0.25, (2 * 2) / Math.hypot(width, height));
		const filters = buildDistortVideoFilters(options, { width, height });
		const lens = filters.find((f) => f.startsWith('lenscorrection='))!;
		const match = /k1=(0\.\d+):i=bilinear/.exec(lens);
		expect(match).not.toBeNull();
		expect(Number.parseFloat(match![1])).toBeCloseTo(expectedK1, 6);
	});

	it('caps k1 at the filter limit for extreme budgets on tiny frames', () => {
		const options = { ...disabledOptions(), elasticAlpha: 900 };
		const filters = buildDistortVideoFilters(options, { width: 10, height: 10 });
		const lens = filters.find((f) => f.startsWith('lenscorrection='))!;
		expect(lens).toContain('k1=0.250000');
	});

	it('emits scale, rotate, then crop for the rotation stage inside the jitter bound', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.75);
		const jitterDeg = 1.4;
		const options = { ...disabledOptions(), rotationJitter: jitterDeg };
		const filters = buildDistortVideoFilters(options, { width: 1280, height: 720 });
		expect(filters).toHaveLength(3);
		expect(filters[0].startsWith('scale=')).toBe(true);
		const rotate = filters[1];
		expect(rotate.startsWith('rotate=')).toBe(true);
		// rotate=a= takes radians, so compare the parsed value against the
		// jitter bound converted to radians.
		const angleRad = Math.abs(parseFloat(/rotate=a=(-?[0-9.]+)/.exec(rotate)![1]));
		expect(angleRad).toBeLessThanOrEqual(jitterDeg * (Math.PI / 180) + 1e-9);
	});

	it('crops rather than scales after rotating so corner fill is discarded', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.75);
		const options = { ...disabledOptions(), rotationJitter: 0.75 };
		const filters = buildDistortVideoFilters(options, { width: 1920, height: 1080 });
		const afterRotate = filters.slice(filters.findIndex((f) => f.startsWith('rotate=')) + 1);
		expect(afterRotate.length).toBeGreaterThan(0);
		expect(afterRotate.some((f) => f.startsWith('scale='))).toBe(false);
		const crop = afterRotate.find((f) => f.startsWith('crop='))!;
		expect(crop).toContain('x=(iw-ow)/2');
		expect(crop).toContain('y=(ih-oh)/2');
	});

	it('adds squeeze down/up scale pairs only when squeezing is requested', () => {
		const active = { ...disabledOptions(), squeezeFactor: 0.9 };
		const squeezeFilters = buildDistortVideoFilters(active, { width: 640, height: 480 })
			.filter((f) => f.startsWith('scale='));
		expect(squeezeFilters).toHaveLength(2);

		const inactive = buildDistortVideoFilters({ ...disabledOptions(), squeezeFactor: 1 }, null);
		expect(inactive.length).toBe(0);
	});

	it('derives eq brightness from the limited-range level conversion', () => {
		// Sequence keeps brightness at maximum while neutralizing contrast
		// and saturation draws.
		mockFirstRandom([0.999999, 0.5, 0.5, 0.5]);
		const amount = 1.4;
		const options = { ...disabledOptions(), colorAmount: amount };
		const eq = buildDistortVideoFilters(options, null)
			.find((f) => f.startsWith('eq='))!;
		const brightness = parseFloat(/brightness=(-?[0-9.]+)/.exec(eq)![1]);
		const expected = ((2 / 255) * (219 / 255)) * amount;
		expect(brightness).toBeCloseTo(expected, 6);
		expect(/contrast=1\.00000/.test(eq)).toBe(true);
	});

	it('forces an odd uniform noise strength near twice the compensated level', () => {
		mockFirstRandom([0.5]);
		for (const [lumaNoise, expectedStrength] of [
			[1, 3],
			[1.4, 3],
			[1.6, 3],
			[5, 9],
			[90, 99],
		] as const) {
			const options = { ...disabledOptions(), lumaNoise };
			const filter = buildDistortVideoFilters(options, null).find((f) => f.startsWith('noise='))!;
			expect(filter).toBe(`noise=c0s=${expectedStrength}:allf=t+u`);
		}
	});

	it('skips sub-level noise that would emit a no-op filter', () => {
		const options = { ...disabledOptions(), lumaNoise: 0.4 };
		const filters = buildDistortVideoFilters(options, null);
		expect(filters.some((f) => f.startsWith('noise='))).toBe(false);
	});

	it('keeps video noise on the luma plane like the image path', () => {
		// The image path adds one shared delta to R, G and B, which leaves
		// chroma untouched. An all-planes strength noises U and V as well
		// and adds color speckle the still-image pipeline never produces.
		const options = { ...disabledOptions(), lumaNoise: 5 };
		const filter = buildDistortVideoFilters(options, null).find((f) => f.startsWith('noise='))!;
		expect(filter).not.toContain('alls=');
		expect(filter).toMatch(/c0s=/);
	});

	it('compensates the limited-range luma gain in the noise strength', () => {
		// Like the eq stage, the noise stage must undo the 255/219 expansion
		// limited-range luma applies in RGB. Without it the uniform integer
		// noise overshoots the image path's bounded +/-lumaNoise levels.
		const options = { ...disabledOptions(), lumaNoise: 5 };
		const filter = buildDistortVideoFilters(options, null).find((f) => f.startsWith('noise='))!;
		const strength = Number.parseInt(/noise=\w+=(\d+)/.exec(filter)![1], 10);
		const rgbAmplitude = Math.floor(strength / 2) * (255 / 219);
		expect(rgbAmplitude).toBeLessThanOrEqual(options.lumaNoise);
	});

	it('applies more noise than the setting at the smallest effective level', () => {
		// Whole luma levels cannot express a small setting exactly: 0.6 maps
		// to the nearest whole level and comes back as about 1.16 levels of
		// RGB noise, overshooting the setting itself. The bound test below
		// pins how far that overshoot may reach.
		const options = { ...disabledOptions(), lumaNoise: 0.6 };
		const filter = buildDistortVideoFilters(options, null).find((f) => f.startsWith('noise='))!;
		const strength = Number.parseInt(/noise=\w+=(\d+)/.exec(filter)![1], 10);
		const rgbAmplitude = Math.floor(strength / 2) * (255 / 219);
		expect(rgbAmplitude).toBeGreaterThan(options.lumaNoise);
	});

	it('keeps the noise amplitude within half a level of the setting', () => {
		// The compensated setting is rounded to the nearest whole luma level
		// and scaled back, so the amplitude may sit above or below the slider
		// value but never by more than half a level. Holds below the strength
		// cap, which clips the amplitude of settings past about 57.
		for (const lumaNoise of [0.6, 1, 1.4, 1.5, 2.5, 5, 20, 50]) {
			const options = { ...disabledOptions(), lumaNoise };
			const filter = buildDistortVideoFilters(options, null).find((f) => f.startsWith('noise='))!;
			const strength = Number.parseInt(/noise=\w+=(\d+)/.exec(filter)![1], 10);
			const rgbAmplitude = Math.floor(strength / 2) * (255 / 219);
			expect(Math.abs(rgbAmplitude - lumaNoise)).toBeLessThanOrEqual(0.5 * (255 / 219));
		}
	});

	it('emits a hue shift alongside eq for color amounts', () => {
		mockFirstRandom([0.5, 0.5, 0.5, 0.999999]);
		const options = { ...disabledOptions(), colorAmount: 1 };
		const filters = buildDistortVideoFilters(options, null);
		const hue = filters.find((f) => f.startsWith('hue='))!;
		expect(hue).toContain('h=');
		const deg = parseFloat(/h=(-?[0-9.]+)/.exec(hue)![1]);
		expect(Math.abs(deg)).toBeLessThanOrEqual(1.5 + 1e-9);
	});

	it('uses an injected random source instead of the global Math.random', () => {
		const options = { ...disabledOptions(), rotationJitter: 1.4, colorAmount: 1 };
		const globalDraw = vi.spyOn(Math, 'random').mockReturnValue(0.75);
		const fromGlobal = buildDistortVideoFilters(options, { width: 1280, height: 720 });
		globalDraw.mockClear();
		// A different injected value must yield a different chain, proving the
		// source is actually consumed rather than ignored for Math.random.
		const fromInjected = buildDistortVideoFilters(options, { width: 1280, height: 720 }, () => 0.25);
		expect(fromInjected).not.toEqual(fromGlobal);
		expect(globalDraw).not.toHaveBeenCalled();
	});
});

// Evaluates the subset of FFmpeg filter expressions the video filter builder
// emits, so tests can check the geometry a chain will apply.
function evalFilterExpression(expression: string, iw: number, ih: number): number {
	const fn = new Function(
		'iw', 'ih', 'trunc', 'ceil', 'max', 'min', 'abs', 'round',
		`return (${expression.replace(/\\,/g, ',')});`
	) as (
		iw: number, ih: number,
		trunc: typeof Math.trunc, ceil: typeof Math.ceil,
		max: typeof Math.max, min: typeof Math.min,
		abs: typeof Math.abs, round: typeof Math.round
	) => number;
	return fn(iw, ih, Math.trunc, Math.ceil, Math.max, Math.min, Math.abs, Math.round);
}

describe('video squeeze geometry', () => {
	it.each([
		[1024, 1024, 0.9],
		[1920, 1080, 0.9],
		[1365, 843, 0.73],
		[1, 1, 0.9],
		[1024, 768, 0.00001],
		[1024, 768, Number.MIN_VALUE],
	])('restores original even dimensions for %i x %i at factor %s', (width, height, squeezeFactor) => {
		const filters = buildDistortVideoFilters({ ...disabledOptions(), squeezeFactor }, { width, height });
		expect(filters).toHaveLength(2);
		let currentWidth = width;
		let currentHeight = height;
		for (const filter of filters) {
			const [w, h] = filter.slice('scale='.length).split(':');
			const nextWidth = evalFilterExpression(w, currentWidth, currentHeight);
			const nextHeight = evalFilterExpression(h, currentWidth, currentHeight);
			expect(Number.isFinite(nextWidth)).toBe(true);
			expect(Number.isFinite(nextHeight)).toBe(true);
			expect(nextWidth).toBeGreaterThanOrEqual(2);
			expect(nextHeight).toBeGreaterThanOrEqual(2);
			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}
		expect(currentWidth).toBe(Math.max(2, Math.trunc(width / 2) * 2));
		expect(currentHeight).toBe(Math.max(2, Math.trunc(height / 2) * 2));
	});

	it('skips squeeze with a warning when original dimensions are unavailable', () => {
		const warnings: string[] = [];
		const filters = buildDistortVideoFilters(
			{ ...disabledOptions(), squeezeFactor: 0.9, lumaNoise: 2 }, null, () => 0.5, warnings
		);
		expect(filters).toEqual(['noise=c0s=5:allf=t+u']);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('Resize squeeze');
		expect(warnings[0]).toContain('dimensions');
	});

	it.each([0, -1, 1, 2, NaN, Infinity])('ignores inactive or invalid factor %s', (squeezeFactor) => {
		const warnings: string[] = [];
		expect(buildDistortVideoFilters({ ...disabledOptions(), squeezeFactor }, null, () => 0.5, warnings)).toEqual([]);
		expect(warnings).toEqual([]);
	});
});

describe('video rotation geometry', () => {
	it('magnifies uniformly and crops back to the original frame size', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0.75);
		const width = 1920;
		const height = 1080;
		const jitterDeg = 3;
		const options = { ...disabledOptions(), rotationJitter: jitterDeg };
		const filters = buildDistortVideoFilters(options, { width, height });
		const scaleFilter = filters.find((f) => f.startsWith('scale='));
		const cropFilter = filters.find((f) => f.startsWith('crop='));
		expect(scaleFilter).toBeDefined();
		expect(cropFilter).toBeDefined();

		const [scaleWExpr, scaleHExpr] = scaleFilter!.slice('scale='.length).split(':');
		const scaledW = evalFilterExpression(scaleWExpr, width, height);
		const scaledH = evalFilterExpression(scaleHExpr, width, height);
		const angle = Math.abs((0.75 * 2 - 1) * jitterDeg) * (Math.PI / 180);
		const cover = Math.cos(angle) + Math.sin(angle) * Math.max(width / height, height / width);
		// Both axes must use the same covering factor: scaling each axis to
		// the rotated bounding box stretches the frame anamorphically and
		// changes its aspect ratio.
		expect(scaledW / width).toBeGreaterThanOrEqual(cover - 0.001);
		expect(scaledH / height).toBeGreaterThanOrEqual(cover - 0.001);
		expect(Math.abs(scaledW / width - scaledH / height)).toBeLessThan(0.005);

		// The crop restores the original size, so rotation never changes the
		// output dimensions.
		const [cropWExpr, cropHExpr] = cropFilter!.slice('crop='.length).split(':');
		expect(evalFilterExpression(cropWExpr, scaledW, scaledH)).toBe(width);
		expect(evalFilterExpression(cropHExpr, scaledW, scaledH)).toBe(height);
	});

	it('skips rotation with a warning when original dimensions are unavailable', () => {
		const warnings: string[] = [];
		const filters = buildDistortVideoFilters(
			{ ...disabledOptions(), rotationJitter: 3, lumaNoise: 2 }, null, () => 0.75, warnings
		);
		expect(filters).toEqual(['noise=c0s=5:allf=t+u']);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('Rotation jitter');
		expect(warnings[0]).toContain('dimensions');
	});
});

describe('video lens distortion edge handling', () => {
	it('crops away the black band that outward radial sampling leaves at the edges', () => {
		const width = 1920;
		const height = 1080;
		const options = { ...disabledOptions(), elasticAlpha: 2 };
		const filters = buildDistortVideoFilters(options, { width, height });
		const lensIndex = filters.findIndex((f) => f.startsWith('lenscorrection='));
		expect(lensIndex).toBeGreaterThan(-1);
		const match = /k1=([0-9.]+):i=bilinear/.exec(filters[lensIndex]);
		expect(match).not.toBeNull();
		const k1 = Number.parseFloat(match![1]);
		expect(k1).toBeGreaterThan(0);

		// Positive k1 samples beyond the frame edge, and lenscorrection fills
		// those unmapped pixels with black unless the chain crops the band off.
		const scaleFilter = filters[lensIndex - 1];
		const cropFilter = filters[lensIndex + 1];
		expect(scaleFilter?.startsWith('scale=')).toBe(true);
		expect(cropFilter?.startsWith('crop=')).toBe(true);

		const [scaleWExpr, scaleHExpr] = scaleFilter.slice('scale='.length).split(':');
		const scaledW = evalFilterExpression(scaleWExpr, width, height);
		const scaledH = evalFilterExpression(scaleHExpr, width, height);
		const [cropWExpr, cropHExpr] = cropFilter.slice('crop='.length).split(':');
		const cropW = evalFilterExpression(cropWExpr, scaledW, scaledH);
		const cropH = evalFilterExpression(cropHExpr, scaledW, scaledH);
		// The unmapped band reaches k1 * scaledSize / 2 at the corners.
		expect((scaledW - cropW) / 2).toBeGreaterThanOrEqual((k1 * scaledW) / 2);
		expect((scaledH - cropH) / 2).toBeGreaterThanOrEqual((k1 * scaledH) / 2);
	});
});

function mockFirstRandom(seq: number[]): void {
	let call = 0;
	vi.spyOn(Math, 'random').mockImplementation(() => seq[call++ % seq.length]);
}

describe('quality gating', () => {
	it('rolls back a destructive gated stage and records one deduped warning', async () => {
		const bmp = solidGray(16, 16);
		const before = new Uint8ClampedArray(bmp.data);
		// All-negative extreme noise on flat gray collapses PSNR far below any floor.
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const state = buildDistortRandomState(bmp.width, bmp.height, disabledOptions());
		const warnings: string[] = [];
		await applyDistortStages(
			bmp,
			state,
			{ ...disabledOptions(), lumaNoise: 80 },
			true,
			warnings
		);
		expect(Array.from(bmp.data)).toEqual(Array.from(before));
		expect(warnings).toEqual([qualityFloorSkipWarning('Luma noise', 24)]);
	});

	it('runs the affine warp ungated like the tile shifts', async () => {
		// Per-pixel PSNR scores any subpixel resample on detailed content as
		// heavily degraded, so gating the warp would roll it back on most real
		// images and probing for a fitting strength costs more warps than the
		// stage is worth. The geometric stages therefore run regardless of
		// gating, and the floor governs the genuinely lossy stages instead.
		const bmp = stripyBitmap(32, 32);
		const before = new Uint8ClampedArray(bmp.data);
		vi.spyOn(Math, 'random').mockReturnValue(0.75);
		const options = { ...disabledOptions(), rotationJitter: 3, psnrFloor: 40 };
		const state = buildDistortRandomState(bmp.width, bmp.height, options);
		const warnings: string[] = [];
		await applyDistortStages(bmp, state, options, true, warnings);
		expect(Array.from(bmp.data)).not.toEqual(Array.from(before));
		expect(warnings).toEqual([]);
	});

	it('applies the same stage ungated without warnings', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const bmp = solidGray(16, 16);
		const before = new Uint8ClampedArray(bmp.data);
		const state = buildDistortRandomState(bmp.width, bmp.height, disabledOptions());
		const warnings: string[] = [];
		await applyDistortStages(
			bmp,
			state,
			{ ...disabledOptions(), lumaNoise: 80 },
			false,
			warnings
		);
		expect(Array.from(bmp.data)).not.toEqual(Array.from(before));
		expect(warnings).toEqual([]);
	});

	it('keeps marginal changes that clear the floor', async () => {
		const bmp = solidGray(32, 32);
		const before = new Uint8ClampedArray(bmp.data);
		vi.spyOn(Math, 'random').mockReturnValue(0.999999);
		const state = buildDistortRandomState(bmp.width, bmp.height, disabledOptions());
		const warnings: string[] = [];
		await applyDistortStages(
			bmp,
			state,
			{ ...disabledOptions(), lumaNoise: 0.9, psnrFloor: 20 },
			true,
			warnings
		);
		expect(warnings).toEqual([]);
		expect(Array.from(bmp.data)).not.toEqual(Array.from(before));
	});

	it('skips stages whose state or options leave them empty', async () => {
		const bmp = solidGray(4, 4);
		const before = new Uint8ClampedArray(bmp.data);
		const state = buildDistortRandomState(bmp.width, bmp.height, disabledOptions());
		const warnings: string[] = [];
		await applyDistortStages(bmp, state, disabledOptions(), true, warnings);
		expect(Array.from(bmp.data)).toEqual(Array.from(before));
		expect(warnings).toEqual([]);
	});

	it('keeps a gated stage on a fully transparent frame that stays invisible', async () => {
		// A fully transparent frame has no visible signal for PSNR to measure,
		// so the gate accepts a stage that perturbs the invisible RGB channels
		// as long as it does not materialize visible pixels.
		const data = new Uint8ClampedArray(16 * 16 * 4);
		for (let i = 0; i < data.length; i += 4) {
			data[i] = 128;
			data[i + 1] = 128;
			data[i + 2] = 128;
			data[i + 3] = 0;
		}
		const bmp = { width: 16, height: 16, data };
		const before = new Uint8ClampedArray(bmp.data);
		vi.spyOn(Math, 'random').mockReturnValue(0);
		const state = buildDistortRandomState(bmp.width, bmp.height, disabledOptions());
		const warnings: string[] = [];
		await applyDistortStages(
			bmp,
			state,
			{ ...disabledOptions(), lumaNoise: 80 },
			true,
			warnings
		);
		expect(Array.from(bmp.data)).not.toEqual(Array.from(before));
		expect(warnings).toEqual([]);
	});

	it('rolls back a gated stage that materializes visible pixels on a partially transparent image', async () => {
		// Squeeze resampling blends alpha across the opaque/transparent
		// boundary, so the stage gains visible pixels where the reference had
		// none. combinedPsnr skips those pixels, so without an explicit
		// newly-visible check the floor would accept the stage silently.
		const width = 32;
		const height = 32;
		const data = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				if (x < width / 2) {
					data[i] = 120;
					data[i + 1] = 130;
					data[i + 2] = 140;
					data[i + 3] = 255;
				} else {
					data[i] = 0;
					data[i + 1] = 0;
					data[i + 2] = 0;
					data[i + 3] = 0;
				}
			}
		}
		const bmp: Bitmap = { width, height, data };
		const before = new Uint8ClampedArray(bmp.data);
		const state: DistortRandomState = { tileShift: null, affine: null, color: null, noiseSeed: 0 };
		const warnings: string[] = [];
		await applyDistortStages(
			bmp,
			state,
			{ ...disabledOptions(), squeezeFactor: 0.9, psnrFloor: 10 },
			true,
			warnings
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('Resize squeeze');
		expect(warnings[0]).toContain('visible');
		expect(Array.from(bmp.data)).toEqual(Array.from(before));
	});
});

// ---------------------------------------------------------------------------
// Canvas-backed pipeline tests
//
// applyDistortPipeline and encodeStaticImage drive a canvas 2D context,
// canvas.toBlob and createImageBitmap, so they need a DOM. The fakes below
// back a canvas with a plain RGBA buffer and route every encode and decode
// through an injectable pixel transform, letting the tests simulate lossless
// and quality-dependent lossy codecs without a browser.
// ---------------------------------------------------------------------------

type EncodeTransform = (
	data: Uint8ClampedArray,
	width: number,
	height: number,
	mime: string,
	quality: number | undefined
) => Uint8ClampedArray;

interface DecodedBitmap {
	width: number;
	height: number;
	data: Uint8ClampedArray;
	close: () => void;
}

const ENCODED_MAGIC = [0x46, 0x42, 0x4d, 0x50];

let encodeTransform: EncodeTransform = (data) => data;
let forcedMime: string | null = null;
let encodedHeader: { width: number; height: number } | null = null;
let decodeFails = false;
let drawFails = false;
let decodeCloseCount = 0;

function encodePixelsToBlob(pixels: Uint8ClampedArray, width: number, height: number, mime: string): Blob {
	const header = new Uint8Array(12);
	header.set(ENCODED_MAGIC);
	const view = new DataView(header.buffer);
	view.setUint32(4, encodedHeader?.width ?? width, true);
	view.setUint32(8, encodedHeader?.height ?? height, true);
	return new Blob([header, new Uint8Array(pixels)], { type: mime });
}

async function decodeEncodedBlob(blob: Blob): Promise<DecodedBitmap> {
	if (decodeFails) throw new Error('decode failed');
	const bytes = new Uint8Array(await blob.arrayBuffer());
	if (bytes.length < 12 || ENCODED_MAGIC.some((byte, index) => bytes[index] !== byte)) {
		throw new Error('unrecognized encoded data');
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return {
		width: view.getUint32(4, true),
		height: view.getUint32(8, true),
		data: new Uint8ClampedArray(bytes.subarray(12)),
		close: () => { decodeCloseCount += 1; },
	};
}

// Quantizes RGB to the given step, the way a lossy codec's error shrinks as
// quality rises; alpha is left untouched.
function quantizePixels(data: Uint8ClampedArray, step: number): Uint8ClampedArray {
	const out = new Uint8ClampedArray(data);
	if (step <= 1) return out;
	for (let i = 0; i < out.length; i += 4) {
		out[i] = Math.round(out[i] / step) * step;
		out[i + 1] = Math.round(out[i + 1] / step) * step;
		out[i + 2] = Math.round(out[i + 2] / step) * step;
	}
	return out;
}

function qualityQuantizer(data: Uint8ClampedArray, quality: number | undefined): Uint8ClampedArray {
	return quantizePixels(data, Math.max(1, Math.round((1 - (quality ?? 0.8)) * 128)));
}

class FakeContext {
	constructor(private readonly canvas: FakeCanvas) {}

	getImageData(x: number, y: number, width: number, height: number): DecodedBitmap {
		const data = new Uint8ClampedArray(width * height * 4);
		for (let row = 0; row < height; row += 1) {
			const start = ((y + row) * this.canvas.width + x) * 4;
			data.set(this.canvas.data.subarray(start, start + width * 4), row * width * 4);
		}
		return { width, height, data, close: () => {} };
	}

	putImageData(image: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number): void {
		for (let row = 0; row < image.height; row += 1) {
			const start = ((y + row) * this.canvas.width + x) * 4;
			this.canvas.data.set(image.data.subarray(row * image.width * 4, (row + 1) * image.width * 4), start);
		}
	}

	clearRect(x: number, y: number, width: number, height: number): void {
		for (let row = 0; row < height; row += 1) {
			const start = ((y + row) * this.canvas.width + x) * 4;
			this.canvas.data.fill(0, start, start + width * 4);
		}
	}

	drawImage(source: { width: number; height: number; data: Uint8ClampedArray }, x: number, y: number): void {
		if (drawFails) throw new Error('draw failed');
		for (let row = 0; row < source.height; row += 1) {
			const start = ((y + row) * this.canvas.width + x) * 4;
			this.canvas.data.set(source.data.subarray(row * source.width * 4, (row + 1) * source.width * 4), start);
		}
	}
}

class FakeCanvas {
	toBlobCalls: { mime: string; quality: number | undefined }[] = [];
	contextAvailable = true;
	private pixelWidth = 0;
	private pixelHeight = 0;
	private pixels = new Uint8ClampedArray(0);
	private context: FakeContext | null = null;

	constructor(width = 0, height = 0) {
		this.width = width;
		this.height = height;
	}

	get width(): number { return this.pixelWidth; }
	set width(value: number) { this.pixelWidth = value; this.resize(); }
	get height(): number { return this.pixelHeight; }
	set height(value: number) { this.pixelHeight = value; this.resize(); }
	get data(): Uint8ClampedArray { return this.pixels; }

	private resize(): void {
		this.pixels = new Uint8ClampedArray(this.pixelWidth * this.pixelHeight * 4);
	}

	getContext(_type: string, _options?: unknown): FakeContext | null {
		if (!this.contextAvailable) return null;
		this.context ??= new FakeContext(this);
		return this.context;
	}

	toBlob(callback: (blob: Blob | null) => void, mime: string, quality?: number): void {
		this.toBlobCalls.push({ mime, quality });
		const pixels = encodeTransform(new Uint8ClampedArray(this.pixels), this.pixelWidth, this.pixelHeight, mime, quality);
		callback(encodePixelsToBlob(pixels, this.pixelWidth, this.pixelHeight, forcedMime ?? mime));
	}
}

const asCanvas = (canvas: FakeCanvas): HTMLCanvasElement => canvas as unknown as HTMLCanvasElement;

// A gradient with a little high-frequency texture, so gated stages have
// something measurable to change.
function texturedCanvas(width: number, height: number): FakeCanvas {
	const canvas = new FakeCanvas(width, height);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const i = (y * width + x) * 4;
			const texture = ((x + y) % 2) * 12;
			canvas.data[i] = (x * 9 + texture) & 0xff;
			canvas.data[i + 1] = (y * 13 + texture) & 0xff;
			canvas.data[i + 2] = ((x + y) * 7 + texture) & 0xff;
			canvas.data[i + 3] = 255;
		}
	}
	return canvas;
}

describe('canvas pipeline', () => {
	beforeEach(() => {
		encodeTransform = (data) => data;
		forcedMime = null;
		encodedHeader = null;
		decodeFails = false;
		drawFails = false;
		decodeCloseCount = 0;
		vi.stubGlobal('document', { createElement: () => new FakeCanvas() });
		vi.stubGlobal('createImageBitmap', (blob: Blob) => decodeEncodedBlob(blob));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe('applyDistortPipeline', () => {
		it('applies the gated distortion stages to the canvas in place', async () => {
			const canvas = texturedCanvas(48, 32);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), { ...disabledOptions(), lumaNoise: 2 }, warnings);
			expect(Array.from(canvas.data)).not.toEqual(Array.from(before));
			expect(canvas.toBlobCalls).toHaveLength(0);
			expect(warnings).toEqual([]);
		});

		it('returns without touching the canvas when no 2D context is available', async () => {
			const canvas = texturedCanvas(8, 8);
			canvas.contextAvailable = false;
			const before = new Uint8ClampedArray(canvas.data);
			await applyDistortPipeline(asCanvas(canvas), disabledOptions(), []);
			expect(Array.from(canvas.data)).toEqual(Array.from(before));
			expect(canvas.toBlobCalls).toHaveLength(0);
		});

		it('rolls back a re-encode round that misses the quality floor and stops', async () => {
			encodeTransform = (data) => quantizePixels(data, 19);
			const canvas = texturedCanvas(32, 32);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), {
				...disabledOptions(),
				reencodeRounds: 3,
				reencodeQuality: 90,
				psnrFloor: 40,
			}, warnings);
			expect(canvas.toBlobCalls).toEqual([{ mime: 'image/jpeg', quality: 0.9 }]);
			expect(warnings).toEqual([qualityFloorSkipWarning('Re-encode round 1', 40)]);
			expect(Array.from(canvas.data)).toEqual(Array.from(before));
		});

		it('applies every re-encode round that clears the floor', async () => {
			encodeTransform = (data) => quantizePixels(data, 19);
			const canvas = texturedCanvas(32, 32);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), {
				...disabledOptions(),
				reencodeRounds: 2,
				reencodeQuality: 90,
				psnrFloor: 20,
			}, warnings);
			expect(canvas.toBlobCalls).toHaveLength(2);
			expect(warnings).toEqual([]);
			expect(Array.from(canvas.data)).toEqual(Array.from(quantizePixels(before, 19)));
		});

		it('picks the alpha-preserving encoder only for transparent canvases', async () => {
			const transparent = texturedCanvas(8, 8);
			transparent.data[3] = 0;
			await applyDistortPipeline(asCanvas(transparent), {
				...disabledOptions(),
				reencodeRounds: 1,
				reencodeQuality: 90,
				psnrFloor: 10,
			}, []);
			expect(transparent.toBlobCalls[0].mime).toBe('image/webp');

			const opaque = texturedCanvas(8, 8);
			await applyDistortPipeline(asCanvas(opaque), {
				...disabledOptions(),
				reencodeRounds: 1,
				reencodeQuality: 90,
				psnrFloor: 10,
			}, []);
			expect(opaque.toBlobCalls[0].mime).toBe('image/jpeg');
		});

		it('rolls back a re-encode round that materializes visible pixels', async () => {
			encodeTransform = (data) => {
				const out = new Uint8ClampedArray(data);
				for (let i = 3; i < out.length; i += 4) out[i] = 255;
				return out;
			};
			const canvas = texturedCanvas(16, 16);
			for (let i = 0; i < canvas.data.length / 2; i += 4) canvas.data[i + 3] = 0;
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), {
				...disabledOptions(),
				reencodeRounds: 2,
				reencodeQuality: 90,
				psnrFloor: 10,
			}, warnings);
			expect(canvas.toBlobCalls).toHaveLength(1);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('Re-encode round 1');
			expect(warnings[0]).toContain('visible');
			expect(Array.from(canvas.data)).toEqual(Array.from(before));
		});

		it('skips re-encode rounds when the canvas substitutes another format', async () => {
			forcedMime = 'image/png';
			const canvas = texturedCanvas(8, 8);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), {
				...disabledOptions(),
				reencodeRounds: 1,
				reencodeQuality: 90,
				psnrFloor: 10,
			}, warnings);
			expect(warnings).toEqual(['Re-encode rounds were skipped because image/jpeg encoding is unavailable.']);
			expect(Array.from(canvas.data)).toEqual(Array.from(before));
		});

		it('skips remaining re-encode rounds when decoding is unavailable', async () => {
			decodeFails = true;
			const canvas = texturedCanvas(8, 8);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), {
				...disabledOptions(),
				reencodeRounds: 2,
				reencodeQuality: 90,
				psnrFloor: 10,
			}, warnings);
			expect(canvas.toBlobCalls).toHaveLength(1);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('decoding is unavailable');
			expect(Array.from(canvas.data)).toEqual(Array.from(before));
			expect(decodeCloseCount).toBe(0);
		});

		it('restores the pre-round pixels when the decoded round cannot be drawn', async () => {
			drawFails = true;
			const canvas = texturedCanvas(8, 8);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), {
				...disabledOptions(),
				reencodeRounds: 2,
				reencodeQuality: 90,
				psnrFloor: 10,
			}, warnings);
			expect(canvas.toBlobCalls).toHaveLength(1);
			expect(warnings).toEqual(['Re-encode round 1 was skipped because the image/jpeg image could not be drawn.']);
			expect(Array.from(canvas.data)).toEqual(Array.from(before));
			expect(decodeCloseCount).toBe(1);
		});

		it('closes each decoded round on the success path', async () => {
			const canvas = texturedCanvas(8, 8);
			await applyDistortPipeline(asCanvas(canvas), {
				...disabledOptions(),
				reencodeRounds: 2,
				reencodeQuality: 90,
				psnrFloor: 10,
			}, []);
			expect(decodeCloseCount).toBe(2);
		});

		it('applies edge-preserving smoothing when enabled', async () => {
			const canvas = texturedCanvas(32, 32);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), { ...disabledOptions(), bilateral: true, psnrFloor: 10 }, warnings);
			expect(Array.from(canvas.data)).not.toEqual(Array.from(before));
			expect(warnings).toEqual([]);
		});

		it('rolls back smoothing that falls below the quality floor', async () => {
			const canvas = texturedCanvas(32, 32);
			const before = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(canvas), { ...disabledOptions(), bilateral: true, psnrFloor: 60 }, warnings);
			expect(Array.from(canvas.data)).toEqual(Array.from(before));
			expect(warnings).toEqual([qualityFloorSkipWarning('Edge-preserving smoothing', 60)]);
		});

		it('rolls back the gated stages a strict quality floor rejects', async () => {
			// At a floor nothing can clear, every gated stage must be rolled back
			// and each must say so in a warning, since nothing else reports it.
			// Squeeze and smoothing are the two gated stages the balanced preset leaves
			// off, so turn both on before asserting that the floor rejects them.
const strict: DistortOptions = {
			...DISTORT_PRESETS.balanced,
			enabled: true,
			lumaNoiseStep: 0.1,
			squeezeFactor: 0.9,
			bilateral: true,
			psnrFloor: 60,
		};
			const warnings: string[] = [];
			await applyDistortPipeline(asCanvas(texturedCanvas(64, 64)), strict, warnings);
			expect(warnings).toContain(qualityFloorSkipWarning('Resize squeeze', 60));
			expect(warnings).toContain(qualityFloorSkipWarning('Edge-preserving smoothing', 60));
			// The relocation stages are exempt from the floor by design, so they
			// must not be claimed as skipped.
			expect(warnings.some((warning) => warning.includes('Local shift'))).toBe(false);
			expect(warnings.some((warning) => warning.includes('Rotation jitter'))).toBe(false);
		});

		it('changes the image further than a bare re-encode does', async () => {
			// The comparison a user actually makes: does the distortion do
			// anything the re-encode that saving a JPEG forces anyway would not?
			// Both runs share a seeded draw and the same codec, so the
			// distortion stages are the only difference between them. Measured
			// as the fidelity cost against the source, which is the only thing
			// measurable here.
			const options: DistortOptions = { enabled: true, lumaNoiseStep: 0.1, ...DISTORT_PRESETS.balanced };
			// A gentle fixed quantization step stands in for the encoder, so the
			// comparison is about what the distortion adds on top of it.
			encodeTransform = (data) => quantizePixels(data, 2);

			const run = async (settings: DistortOptions) => {
				vi.spyOn(Math, 'random').mockImplementation(createSeededRandom(12345));
				const canvas = texturedCanvas(256, 256);
				const source = new Uint8ClampedArray(canvas.data);
				await applyDistortPipeline(asCanvas(canvas), settings, []);
				return computePsnr(source, canvas.data, false);
			};

			// Every distortion stage disabled: only the re-encode chain runs.
			const reencodeOnly = await run({
				...options,
				elasticAlpha: 0,
				rotationJitter: 0,
				squeezeFactor: 1,
				colorAmount: 0,
				lumaNoise: 0,
				bilateral: false,
			});
			const distorted = await run(options);

			// The distortion has to cost more fidelity than the encoder alone.
			// If the two ever matched, the stage set would be doing nothing the
			// re-encode was not already doing, which is the ambiguity this
			// exists to rule out.
			expect(reencodeOnly).toBeLessThan(Infinity);
			expect(distorted).toBeLessThan(reencodeOnly);
		});
	});

	describe('encodeStaticImage', () => {
		it('returns the raw encode without validation when the pipeline is disabled', async () => {
			const canvas = texturedCanvas(8, 8);
			const warnings: string[] = [];
			const blob = await encodeStaticImage(
				asCanvas(canvas), 'image/png', undefined, { ...disabledOptions(), enabled: false }, null, warnings
			);
			expect(blob.type).toBe('image/png');
			expect(canvas.toBlobCalls).toEqual([{ mime: 'image/png', quality: undefined }]);
			expect(warnings).toEqual([]);
		});

		it('throws when the canvas silently substitutes another format', async () => {
			forcedMime = 'image/png';
			const canvas = texturedCanvas(8, 8);
			await expect(encodeStaticImage(
				asCanvas(canvas), 'image/jpeg', 0.85, { ...disabledOptions(), enabled: false }, null, []
			)).rejects.toThrow('Canvas does not support image/jpeg output');
		});

		it('requires the pre-encode snapshot when the pipeline is enabled', async () => {
			const canvas = texturedCanvas(8, 8);
			await expect(encodeStaticImage(
				asCanvas(canvas), 'image/png', undefined, { ...disabledOptions(), enabled: true }, null, []
			)).rejects.toThrow('pre-encode snapshot');
		});

		it('keeps a lossless encode that matches the snapshot', async () => {
			const canvas = texturedCanvas(8, 8);
			const warnings: string[] = [];
			const blob = await encodeStaticImage(
				asCanvas(canvas), 'image/png', undefined,
				{ ...disabledOptions(), enabled: true }, new Uint8ClampedArray(canvas.data), warnings
			);
			expect(canvas.toBlobCalls).toHaveLength(1);
			expect(warnings).toEqual([]);
			const decoded = await decodeEncodedBlob(blob);
			expect(Array.from(decoded.data)).toEqual(Array.from(canvas.data));
		});

		it('bumps encoder quality once when the first encode misses the floor', async () => {
			encodeTransform = (data, _width, _height, _mime, quality) => qualityQuantizer(data, quality);
			const canvas = texturedCanvas(32, 32);
			const snapshot = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			const blob = await encodeStaticImage(
				asCanvas(canvas), 'image/jpeg', 0.85,
				{ ...disabledOptions(), enabled: true, psnrFloor: 35 }, snapshot, warnings
			);
			expect(canvas.toBlobCalls.map((call) => call.quality)).toEqual([0.85, 0.91]);
			expect(warnings).toEqual([]);
			const decoded = await decodeEncodedBlob(blob);
			expect(Array.from(decoded.data)).toEqual(Array.from(quantizePixels(snapshot, 12)));
			expect(computePsnr(snapshot, decoded.data)).toBeGreaterThanOrEqual(35);
		});

		it('warns and keeps the bumped encode when even the bump misses the floor', async () => {
			encodeTransform = (data, _width, _height, _mime, quality) => qualityQuantizer(data, quality);
			const canvas = texturedCanvas(32, 32);
			const snapshot = new Uint8ClampedArray(canvas.data);
			const warnings: string[] = [];
			const blob = await encodeStaticImage(
				asCanvas(canvas), 'image/jpeg', 0.85,
				{ ...disabledOptions(), enabled: true, psnrFloor: 50 }, snapshot, warnings
			);
			expect(canvas.toBlobCalls.map((call) => call.quality)).toEqual([0.85, 0.91]);
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain('even after a small encoder quality bump');
			const decoded = await decodeEncodedBlob(blob);
			expect(Array.from(decoded.data)).toEqual(Array.from(quantizePixels(snapshot, 12)));
		});

		it('warns without a bump when the format has no quality knob', async () => {
			encodeTransform = (data) => quantizePixels(data, 19);
			const canvas = texturedCanvas(32, 32);
			const warnings: string[] = [];
			await encodeStaticImage(
				asCanvas(canvas), 'image/png', undefined,
				{ ...disabledOptions(), enabled: true, psnrFloor: 35 }, new Uint8ClampedArray(canvas.data), warnings
			);
			expect(canvas.toBlobCalls).toHaveLength(1);
			expect(warnings).toEqual(['The final image/png encode fell below the 35 dB quality floor, so the delivered pixels differ from the ones the pipeline produced by more than the floor allows.']);
		});

		it('does not bump past the maximum encoder quality', async () => {
			encodeTransform = (data) => quantizePixels(data, 19);
			const canvas = texturedCanvas(32, 32);
			const warnings: string[] = [];
			await encodeStaticImage(
				asCanvas(canvas), 'image/jpeg', 1,
				{ ...disabledOptions(), enabled: true, psnrFloor: 35 }, new Uint8ClampedArray(canvas.data), warnings
			);
			expect(canvas.toBlobCalls).toEqual([{ mime: 'image/jpeg', quality: 1 }]);
			expect(warnings[0]).toContain('fell below the 35 dB quality floor,');
		});

		it('keeps the result with a warning when the encode cannot be validated', async () => {
			decodeFails = true;
			const canvas = texturedCanvas(8, 8);
			const warnings: string[] = [];
			const blob = await encodeStaticImage(
				asCanvas(canvas), 'image/png', undefined,
				{ ...disabledOptions(), enabled: true }, new Uint8ClampedArray(canvas.data), warnings
			);
			expect(blob.type).toBe('image/png');
			expect(warnings).toEqual(['Could not validate the image/png output against the quality floor, but the result was kept.']);
		});

		it('rejects an encode whose decoded dimensions do not match the canvas', async () => {
			encodedHeader = { width: 4, height: 4 };
			const canvas = texturedCanvas(8, 8);
			const warnings: string[] = [];
			await encodeStaticImage(
				asCanvas(canvas), 'image/png', undefined,
				{ ...disabledOptions(), enabled: true, psnrFloor: 30 }, new Uint8ClampedArray(canvas.data), warnings
			);
			expect(warnings).toEqual(['The final image/png encode fell below the 30 dB quality floor, so the delivered pixels differ from the ones the pipeline produced by more than the floor allows.']);
		});

		it('accepts a JPEG encode that flattens a fully transparent canvas', async () => {
			encodeTransform = (data) => {
				const out = new Uint8ClampedArray(data);
				for (let i = 3; i < out.length; i += 4) out[i] = 255;
				return out;
			};
			const canvas = texturedCanvas(8, 8);
			for (let i = 3; i < canvas.data.length; i += 4) canvas.data[i] = 0;
			const warnings: string[] = [];
			await encodeStaticImage(
				asCanvas(canvas), 'image/jpeg', 0.85,
				{ ...disabledOptions(), enabled: true, psnrFloor: 30 }, new Uint8ClampedArray(canvas.data), warnings
			);
			expect(canvas.toBlobCalls).toHaveLength(1);
			expect(warnings).toEqual([]);
		});

		it('rejects an alpha-preserving encode that materializes visible pixels', async () => {
			encodeTransform = (data) => {
				const out = new Uint8ClampedArray(data);
				for (let i = 3; i < out.length; i += 4) out[i] = 255;
				return out;
			};
			const canvas = texturedCanvas(8, 8);
			for (let i = 3; i < canvas.data.length; i += 4) canvas.data[i] = 0;
			const warnings: string[] = [];
			await encodeStaticImage(
				asCanvas(canvas), 'image/webp', undefined,
				{ ...disabledOptions(), enabled: true, psnrFloor: 30 }, new Uint8ClampedArray(canvas.data), warnings
			);
			expect(canvas.toBlobCalls).toHaveLength(1);
			expect(warnings).toEqual(['The final image/webp encode fell below the 30 dB quality floor, so the delivered pixels differ from the ones the pipeline produced by more than the floor allows.']);
		});
	});
});
