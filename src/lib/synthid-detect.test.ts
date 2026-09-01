import { describe, expect, it } from 'vitest';
import type { Bitmap } from './types';
import { rotate180, rotate90Clockwise } from './pixels';
import { SYNTHID_CODEBOOK, type SynthidCodebook, type SynthidCodebookProfile } from './synthid-codebook';
import { detectSynthid } from './synthid-detect';

// Builds a codebook profile whose carrier bins carry the given reference
// phases, packed in the same 7-byte record layout the generated artifact
// uses, so detection scores them like real carriers.
function makeCodebookFixture(
	width: number,
	height: number,
	binSpecs: { fy: number; fx: number; phase: number }[]
): SynthidCodebook {
	const channels: string[] = [];
	for (let channel = 0; channel < 3; channel += 1) {
		if (channel !== 1) {
			channels.push('');
			continue;
		}
		const records = new Uint8Array(binSpecs.length * 7);
		binSpecs.forEach((spec, i) => {
			const phaseMr = Math.round(spec.phase * 1000);
			records[i * 7] = spec.fy & 0xff;
			records[i * 7 + 1] = (spec.fy >> 8) & 0xff;
			records[i * 7 + 2] = spec.fx & 0xff;
			records[i * 7 + 3] = (spec.fx >> 8) & 0xff;
			records[i * 7 + 4] = 255;
			records[i * 7 + 5] = phaseMr & 0xff;
			records[i * 7 + 6] = (phaseMr >> 8) & 0xff;
		});
		let binary = '';
		for (const byte of records) binary += String.fromCharCode(byte);
		channels.push(btoa(binary));
	}
	const profile: SynthidCodebookProfile = {
		model: 'test-model',
		h: height,
		w: width,
		channels,
	};
	return { format: 'test', source: 'test', consensusFloor: 0.75, profiles: [profile] };
}

// Builds a test image carrying the given frequency plan as tones, so the
// synthesized phases match the fixture codebook's packed phases.
function toneBitmap(width: number, height: number, binSpecs: { fy: number; fx: number; phase: number }[]): Bitmap {
	const bitmap: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let value = 128;
			for (const spec of binSpecs) {
				value += 10 * Math.cos(2 * Math.PI * (spec.fy * y / height + spec.fx * x / width) + spec.phase);
			}
			const i = (y * width + x) * 4;
			bitmap.data[i] = value;
			bitmap.data[i + 1] = value;
			bitmap.data[i + 2] = value;
			bitmap.data[i + 3] = 255;
		}
	}
	return bitmap;
}

// Replicates every pixel into a factor-sized block. Unlike an interpolating
// upscale, this survives an area downsample exactly, so detection sees the
// original phases with no resample shift to account for.
function upscaleNearest(bitmap: Bitmap, factor: number): Bitmap {
	const width = bitmap.width * factor;
	const height = bitmap.height * factor;
	const out: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
	for (let y = 0; y < bitmap.height; y += 1) {
		for (let x = 0; x < bitmap.width; x += 1) {
			const src = (y * bitmap.width + x) * 4;
			for (let dy = 0; dy < factor; dy += 1) {
				for (let dx = 0; dx < factor; dx += 1) {
					const dst = ((y * factor + dy) * width + x * factor + dx) * 4;
					out.data[dst] = bitmap.data[src];
					out.data[dst + 1] = bitmap.data[src + 1];
					out.data[dst + 2] = bitmap.data[src + 2];
					out.data[dst + 3] = bitmap.data[src + 3];
				}
			}
		}
	}
	return out;
}

// Eight independent carriers, all inside the Nyquist bounds of a 32x64
// profile. Phases spread across the circle so a match cannot be an artifact
// of one alignment.
const NARROW_BINS = [5, 7, 11, 13, 3, 9, 15, 4].map((fx, i) => ({
	fy: 3 + i * 2,
	fx,
	phase: (i * 1.3) % (2 * Math.PI) - Math.PI,
}));

// Eight independent carriers inside the Nyquist bounds of a 32x32 square
// profile, with the same phase spread.
const SQUARE_BINS = [5, 7, 11, 13, 3, 9, 15, 1].map((fx, i) => ({
	fy: 3 + i,
	fx,
	phase: (i * 1.3) % (2 * Math.PI) - Math.PI,
}));

describe('synthid-codebook artifact', () => {
	it('carries the expected profiles with valid sorted carriers', () => {
		expect(SYNTHID_CODEBOOK.format).toBe('synthid-v4-compact-1');
		expect(SYNTHID_CODEBOOK.profiles.length).toBeGreaterThan(0);
		for (const profile of SYNTHID_CODEBOOK.profiles) {
			expect(profile.channels.length).toBe(3);
			for (const packed of profile.channels) {
				const bytes = atob(packed);
				expect(bytes.length % 7).toBe(0);
				let previousCons = 256;
				for (let offset = 0; offset < bytes.length; offset += 7) {
					const y = bytes.charCodeAt(offset) | (bytes.charCodeAt(offset + 1) << 8);
					const x = bytes.charCodeAt(offset + 2) | (bytes.charCodeAt(offset + 3) << 8);
					expect(y).toBeLessThan(profile.h);
					expect(x).toBeLessThan(profile.w);
					const cons = bytes.charCodeAt(offset + 4);
					expect(cons).toBeGreaterThanOrEqual(Math.round(0.75 * 255));
					expect(cons).toBeLessThanOrEqual(previousCons);
					previousCons = cons;
				}
			}
		}
	});
});

describe('detectSynthid', () => {
	it('flags an image whose carriers match the codebook phases', async () => {
		const width = 64;
		const height = 64;
		const binSpecs = [7, 11, 19, 23, 29, 13, 17, 5].map((step, i) => ({
			fy: 3 + i * 2,
			fx: step,
			phase: (i * 1.3) % (2 * Math.PI) - Math.PI,
		}));
		const codebook = makeCodebookFixture(width, height, binSpecs);
		// Synthesize the watermarked image from the fixture's frequency plan.
		// cos(theta + phi) puts phase +phi at the positive-frequency bin under
		// the forward DFT convention, matching the packed reference phases.
		const bitmap = toneBitmap(width, height, binSpecs);
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(true);
		expect(detection.confidence).toBeGreaterThan(0.9);
	});

	it('scores a profile whose channel list is shorter than three planes', async () => {
		const width = 64;
		const height = 64;
		const binSpecs = [7, 11, 19, 23, 29, 13, 17, 5].map((step, i) => ({
			fy: 3 + i * 2,
			fx: step,
			phase: (i * 1.3) % (2 * Math.PI) - Math.PI,
		}));
		const codebook = makeCodebookFixture(width, height, binSpecs);
		// The channel list is a plain list of per-plane carrier packs, so a
		// shorter one is well typed and simply means the missing planes carry
		// no carriers. The matching plane must still be scored.
		codebook.profiles[0].channels = codebook.profiles[0].channels.slice(0, 2);
		const detection = await detectSynthid(toneBitmap(width, height, binSpecs), { codebook });
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(true);
	});

	it('does not flag a single matching carrier in one channel', async () => {
		const bins = [{ fy: 5, fx: 9, phase: 1.1 }];
		const detection = await detectSynthid(toneBitmap(64, 64, bins), {
			codebook: makeCodebookFixture(64, 64, bins),
		});
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it.each(['duplicates', 'conjugates', 'all channels'])('does not inflate evidence from %s', async (variant) => {
		const bins = [{ fy: 5, fx: 9, phase: 1.1 }];
		const records = Array.from({ length: 128 }, (_, i) =>
			variant !== 'duplicates' && i % 2 === 1
				? { fy: 59, fx: 55, phase: -1.1 }
				: bins[0]);
		const codebook = makeCodebookFixture(64, 64, records);
		if (variant === 'all channels') {
			codebook.profiles[0].channels.fill(codebook.profiles[0].channels[1]);
		}
		const detection = await detectSynthid(toneBitmap(64, 64, bins), { codebook });
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it.each([1, 2, 3])('rejects a full codebook with only %i genuinely surviving carriers', async (count) => {
		const surviving = [
			{ fy: 0, fx: 16, phase: 0 },
			{ fy: 16, fx: 0, phase: 0 },
			{ fy: 16, fx: 16, phase: 0 },
		].slice(0, count);
		const absent = Array.from({ length: 32 }, (_, i) => ({ fy: i + 1, fx: 7, phase: 0 }));
		const codebook = makeCodebookFixture(64, 64, [...surviving, ...absent]);
		const bitmap = toneBitmap(64, 64, surviving);
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it.each([7, 8])('requires eight surviving independent carriers, with %i present', async (count) => {
		const surviving = Array.from({ length: count }, (_, i) => ({ fy: 8, fx: i * 8, phase: 0 }));
		const absent = Array.from({ length: 120 }, (_, i) => ({ fy: 1 + Math.trunc(i / 32), fx: i % 32, phase: 0 }));
		const codebook = makeCodebookFixture(64, 64, [...surviving, ...absent]);
		const bitmap = toneBitmap(64, 64, []);
		for (let y = 0; y < 64; y += 8) {
			for (let x = 0; x < 64; x += 8) {
				bitmap.data[(y * 64 + x) * 4 + 1] = 192;
			}
		}
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.isWatermarked).toBe(count === 8);
		if (count === 8) expect(detection.confidence).toBeGreaterThan(0.9);
		else expect(detection.confidence).toBeLessThan(0.5);
	});

	it('does not flag DC-only evidence', async () => {
		const bins = Array.from({ length: 32 }, () => ({ fy: 0, fx: 0, phase: 0 }));
		const detection = await detectSynthid(toneBitmap(64, 64, []), {
			codebook: makeCodebookFixture(64, 64, bins),
		});
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it('flags a non-square image whose carriers match the codebook phases', async () => {
		const width = 64;
		const height = 32;
		const binSpecs = [7, 11, 19, 23, 29, 13, 17, 5].map((step, i) => ({
			fy: 2 + i,
			fx: step,
			phase: (i * 1.3) % (2 * Math.PI) - Math.PI,
		}));
		const codebook = makeCodebookFixture(width, height, binSpecs);
		const detection = await detectSynthid(toneBitmap(width, height, binSpecs), { codebook });
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(true);
		expect(detection.confidence).toBeGreaterThan(0.9);
	});

	it('flags a clean scaled delivery of a watermarked profile image', async () => {
		const width = 32;
		const height = 64;
		const codebook = makeCodebookFixture(width, height, NARROW_BINS);
		const upscaled = upscaleNearest(toneBitmap(width, height, NARROW_BINS), 2);
		const detection = await detectSynthid(upscaled, { codebook });
		expect(detection.exactMatch).toBe(false);
		expect(detection.conclusive).toBe(true);
		expect(detection.profileKey).toContain(`${height}x${width}`);
		expect(detection.isWatermarked).toBe(true);
	});

	it('flags a clean transposed delivery of a watermarked profile image', async () => {
		const width = 32;
		const height = 64;
		const codebook = makeCodebookFixture(width, height, NARROW_BINS);
		// A transposed export is the upright image rotated a quarter turn
		// (counterclockwise here); detection must restore the profile
		// orientation before resampling.
		let delivered = upscaleNearest(toneBitmap(width, height, NARROW_BINS), 2);
		for (let i = 0; i < 3; i += 1) delivered = rotate90Clockwise(delivered);
		const detection = await detectSynthid(delivered, { codebook });
		expect(detection.exactMatch).toBe(false);
		expect(detection.conclusive).toBe(true);
		expect(detection.profileKey).toContain(`${height}x${width}`);
		expect(detection.isWatermarked).toBe(true);
	});

	it('flags a clean upside-down delivery of a watermarked profile image', async () => {
		const width = 32;
		const height = 64;
		const codebook = makeCodebookFixture(width, height, NARROW_BINS);
		// An upside-down export keeps the profile's aspect ratio and
		// dimensions, so only the half-turn restoration can reveal it.
		const delivered = rotate180(upscaleNearest(toneBitmap(width, height, NARROW_BINS), 2));
		const detection = await detectSynthid(delivered, { codebook });
		expect(detection.exactMatch).toBe(false);
		expect(detection.conclusive).toBe(true);
		expect(detection.profileKey).toContain(`${height}x${width}`);
		expect(detection.isWatermarked).toBe(true);
	});

	it.each([1, 3])('flags a native transposed delivery rotated %i quarter turn(s)', async (turns) => {
		const width = 32;
		const height = 64;
		const codebook = makeCodebookFixture(width, height, NARROW_BINS);
		// The delivery keeps the profile's native pixel count but arrives
		// transposed. The rotation direction is not recorded anywhere, so
		// both quarter turns must be scored; the wrong one scores as noise.
		let delivered = toneBitmap(width, height, NARROW_BINS);
		for (let i = 0; i < turns; i += 1) delivered = rotate90Clockwise(delivered);
		const detection = await detectSynthid(delivered, { codebook });
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.profileKey).toContain(`${height}x${width}`);
		expect(detection.isWatermarked).toBe(true);
	});

	it('flags an upside-down native delivery of a watermarked profile image', async () => {
		const width = 32;
		const height = 64;
		const codebook = makeCodebookFixture(width, height, NARROW_BINS);
		// A half turn keeps a non-square delivery's dimensions, so the size
		// cannot reveal it either.
		const delivered = rotate180(toneBitmap(width, height, NARROW_BINS));
		const detection = await detectSynthid(delivered, { codebook });
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.profileKey).toContain(`${height}x${width}`);
		expect(detection.isWatermarked).toBe(true);
	});

	it.each([1, 2, 3])('flags a native square delivery rotated %i quarter turn(s)', async (turns) => {
		const size = 32;
		const codebook = makeCodebookFixture(size, size, SQUARE_BINS);
		// A square delivery keeps its dimensions through any turn, so the
		// size cannot reveal the rotation; every orientation must be scored
		// or the watermark reads as upright noise.
		let delivered = toneBitmap(size, size, SQUARE_BINS);
		for (let i = 0; i < turns; i += 1) delivered = rotate90Clockwise(delivered);
		const detection = await detectSynthid(delivered, { codebook });
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(true);
	});

	it('marks a size too small to carry the profile carriers as inconclusive', async () => {
		const size = 32;
		const codebook = makeCodebookFixture(size, size, SQUARE_BINS);
		// A 16x16 input matches the profile's aspect ratio but its Nyquist
		// (8 cycles) leaves only three of the eight carriers; the verdict is
		// resample noise and must not be certified as a trusted match.
		const bitmap: Bitmap = { width: size / 2, height: size / 2, data: new Uint8ClampedArray((size / 2) * (size / 2) * 4) };
		for (let y = 0; y < bitmap.height; y += 1) {
			for (let x = 0; x < bitmap.width; x += 1) {
				const i = (y * bitmap.width + x) * 4;
				bitmap.data[i] = x * 8;
				bitmap.data[i + 1] = y * 8;
				bitmap.data[i + 2] = 128;
				bitmap.data[i + 3] = 255;
			}
		}
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.exactMatch).toBe(false);
		expect(detection.conclusive).toBe(false);
		expect(detection.profileKey).toContain(`${size}x${size}`);
	});

	it('marks a size whose only surviving carriers are conjugate duplicates as inconclusive', async () => {
		const size = 32;
		// Four physical carriers stored as four conjugate pairs. The scorer
		// counts a conjugate pair once, so only four independent carriers
		// survive a 16x16 source; no channel reaches the eight-carrier minimum
		// and the size must not be certified as a trusted clean check.
		const bins = [
			{ fy: 2, fx: 2, phase: 0.1 }, { fy: 30, fx: 30, phase: -0.1 },
			{ fy: 3, fx: 3, phase: 0.2 }, { fy: 29, fx: 29, phase: -0.2 },
			{ fy: 4, fx: 4, phase: 0.3 }, { fy: 28, fx: 28, phase: -0.3 },
			{ fy: 5, fx: 5, phase: 0.4 }, { fy: 27, fx: 27, phase: -0.4 },
		];
		const codebook = makeCodebookFixture(size, size, bins);
		const bitmap: Bitmap = { width: size / 2, height: size / 2, data: new Uint8ClampedArray((size / 2) * (size / 2) * 4) };
		for (let y = 0; y < bitmap.height; y += 1) {
			for (let x = 0; x < bitmap.width; x += 1) {
				const i = (y * bitmap.width + x) * 4;
				bitmap.data[i] = x * 8;
				bitmap.data[i + 1] = y * 8;
				bitmap.data[i + 2] = 128;
				bitmap.data[i + 3] = 255;
			}
		}
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.conclusive).toBe(false);
		expect(detection.isWatermarked).toBe(false);
	});

	it('reports clean for a square image whose phases do not match', async () => {
		const size = 32;
		const codebook = makeCodebookFixture(size, size, SQUARE_BINS);
		// The added quarter-turn hypotheses must not turn a plain gradient
		// into a detection.
		const bitmap: Bitmap = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) };
		for (let y = 0; y < size; y += 1) {
			for (let x = 0; x < size; x += 1) {
				const i = (y * size + x) * 4;
				bitmap.data[i] = x * 8;
				bitmap.data[i + 1] = y * 8;
				bitmap.data[i + 2] = 128;
				bitmap.data[i + 3] = 255;
			}
		}
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it('reports clean for a native transposed image whose phases do not match', async () => {
		const codebook = makeCodebookFixture(32, 64, NARROW_BINS);
		// A plain gradient carries none of the expected carrier phases; the
		// native transposed path must not invent a detection from the
		// rotation the image "needed" to land on a profile.
		const bitmap: Bitmap = { width: 64, height: 32, data: new Uint8ClampedArray(64 * 32 * 4) };
		for (let y = 0; y < 32; y += 1) {
			for (let x = 0; x < 64; x += 1) {
				const i = (y * 64 + x) * 4;
				bitmap.data[i] = x * 4;
				bitmap.data[i + 1] = y * 4;
				bitmap.data[i + 2] = 128;
				bitmap.data[i + 3] = 255;
			}
		}
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it('reports clean for a transposed image whose phases do not match', async () => {
		const width = 32;
		const height = 64;
		const codebook = makeCodebookFixture(width, height, NARROW_BINS);
		let bitmap: Bitmap = { width: width * 2, height: height * 2, data: new Uint8ClampedArray(width * height * 16) };
		for (let y = 0; y < bitmap.height; y += 1) {
			for (let x = 0; x < bitmap.width; x += 1) {
				const i = (y * bitmap.width + x) * 4;
				bitmap.data[i] = x * 4;
				bitmap.data[i + 1] = y * 4;
				bitmap.data[i + 2] = 128;
				bitmap.data[i + 3] = 255;
			}
		}
		for (let i = 0; i < 3; i += 1) bitmap = rotate90Clockwise(bitmap);
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it('reports clean for content whose phases do not match', async () => {
		const width = 64;
		const height = 64;
		const binSpecs = [7, 11, 19, 23, 29, 13, 17, 5].map((step, i) => ({
			fy: 3 + i * 2,
			fx: step,
			phase: (i * 1.3) % (2 * Math.PI) - Math.PI,
		}));
		const codebook = makeCodebookFixture(width, height, binSpecs);
		// A plain gradient carries none of the expected carrier phases.
		const bitmap: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bitmap.data[i] = x * 4;
				bitmap.data[i + 1] = y * 4;
				bitmap.data[i + 2] = 128;
				bitmap.data[i + 3] = 255;
			}
		}
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it('reports clean for a noise-level best-of-orientations match', async () => {
		const size = 32;
		// Five carriers agree and three sit far off, so the raw phase match
		// (0.7) clears the decision center. The spread of the per-bin scores
		// makes the match statistically indistinguishable from the best of the
		// four scored orientations, so the significance-adjusted verdict must
		// stay clean; taking an uncorrected best-of-K maximum would flag it.
		const reference = SQUARE_BINS.map((bin) => ({ ...bin, phase: 0 }));
		const tones = SQUARE_BINS.map((bin, i) => ({ ...bin, phase: i < 5 ? 0 : 0.8 * Math.PI }));
		const codebook = makeCodebookFixture(size, size, reference);
		const detection = await detectSynthid(toneBitmap(size, size, tones), { codebook });
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});

	it('trusts the fallback verdict at an uncovered size', async () => {
		const width = 64;
		const height = 32;
		const binSpecs = [{ fy: 3, fx: 9, phase: 1.0 }];
		const codebook = makeCodebookFixture(64, 64, binSpecs);
		// The 64x64 profile matches a 64x32 request only approximately, so the
		// verdict comes from the fallback, which takes the same significance
		// test as every other candidate and stays trusted when it clears it.
		const bitmap: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bitmap.data[i] = x * 4;
				bitmap.data[i + 1] = y * 4;
				bitmap.data[i + 2] = 128;
				bitmap.data[i + 3] = 255;
			}
		}
		const detection = await detectSynthid(bitmap, { codebook });
		expect(detection.exactMatch).toBe(false);
		expect(detection.conclusive).toBe(true);
		expect(detection.profileKey).toContain('64x64');
	});

	it('clears a marginal fallback match at an uncovered size', async () => {
		const bins = [
			{ fy: 2, fx: 1 }, { fy: 3, fx: 2 }, { fy: 4, fx: 3 }, { fy: 5, fx: 4 },
			{ fy: 6, fx: 5 }, { fy: 7, fx: 6 }, { fy: 8, fx: 7 }, { fy: 9, fx: 8 },
		].map((bin) => ({ ...bin, phase: 0 }));
		const codebook = makeCodebookFixture(64, 64, bins);
		// Two models sharing the resolution make the uncovered-size fallback a
		// best-of-K choice. Four agreeing carriers and four far-off ones put
		// the raw match just above the decision center with a wide per-bin
		// spread, the shape clean content takes, so the significance test must
		// clear it: the same pixels are indistinguishable from clean content.
		codebook.profiles.push({ ...codebook.profiles[0], model: 'other-model' });
		const tones = bins.map((bin, i) => ({ ...bin, phase: i < 4 ? 0 : 0.8 * Math.PI }));
		const detection = await detectSynthid(toneBitmap(64, 128, tones), { codebook });
		expect(detection.exactMatch).toBe(false);
		expect(detection.isWatermarked).toBe(false);
		expect(detection.conclusive).toBe(true);
	});

	it('reads a marginal fallback match when metadata corroborates it', async () => {
		const bins = [
			{ fy: 2, fx: 1 }, { fy: 3, fx: 2 }, { fy: 4, fx: 3 }, { fy: 5, fx: 4 },
			{ fy: 6, fx: 5 }, { fy: 7, fx: 6 }, { fy: 8, fx: 7 }, { fy: 9, fx: 8 },
		].map((bin) => ({ ...bin, phase: 0 }));
		const codebook = makeCodebookFixture(64, 64, bins);
		// The same marginal pixels the strict test clears read as watermarked
		// when the caller corroborated the watermark from file metadata, since
		// the prior supplies the confidence the per-bin spread cannot.
		codebook.profiles.push({ ...codebook.profiles[0], model: 'other-model' });
		const tones = bins.map((bin, i) => ({ ...bin, phase: i < 4 ? 0 : 0.8 * Math.PI }));
		const detection = await detectSynthid(toneBitmap(64, 128, tones), { codebook, sensitive: true });
		expect(detection.isWatermarked).toBe(true);
		expect(detection.conclusive).toBe(true);
	});

	it('flags an uncovered size when the fallback phases strongly match', async () => {
		const bins = [
			{ fy: 2, fx: 1 }, { fy: 3, fx: 2 }, { fy: 4, fx: 3 }, { fy: 5, fx: 4 },
			{ fy: 6, fx: 5 }, { fy: 7, fx: 6 }, { fy: 8, fx: 7 }, { fy: 9, fx: 8 },
		].map((bin) => ({ ...bin, phase: 0 }));
		const codebook = makeCodebookFixture(64, 64, bins);
		// All carriers agree, so the per-bin spread collapses and the
		// significance-adjusted verdict still detects the watermark at an
		// uncovered size that only the fallback can score.
		codebook.profiles.push({ ...codebook.profiles[0], model: 'other-model' });
		const detection = await detectSynthid(toneBitmap(64, 128, bins), { codebook });
		expect(detection.exactMatch).toBe(false);
		expect(detection.isWatermarked).toBe(true);
		expect(detection.conclusive).toBe(true);
	});

	it('runs the bundled artifact end to end on ordinary content', async () => {
		// Exercises the real base64 records (negative int16 phases, uint16 bin
		// coordinates) through the full decode path at the largest profile.
		const width = 1024;
		const height = 1024;
		const bitmap: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
		for (let y = 0; y < height; y += 1) {
			for (let x = 0; x < width; x += 1) {
				const i = (y * width + x) * 4;
				bitmap.data[i] = (x + y) & 0xff;
				bitmap.data[i + 1] = (x * 2 + y) & 0xff;
				bitmap.data[i + 2] = (x + y * 2) & 0xff;
				bitmap.data[i + 3] = 255;
			}
		}
		const detection = await detectSynthid(bitmap);
		expect(detection.exactMatch).toBe(true);
		expect(detection.conclusive).toBe(true);
		expect(detection.profileKey).toMatch(/\/1024x1024$/);
		expect(detection.phaseMatch).toBeGreaterThanOrEqual(0);
		expect(detection.phaseMatch).toBeLessThanOrEqual(1);
		expect(detection.confidence).toBeGreaterThanOrEqual(0);
		expect(detection.confidence).toBeLessThanOrEqual(1);
	});

	it('reports clean for flat content at profile resolutions', async () => {
		// Without the energy floor, deterministic round-off residue at
		// zero-energy carrier bins would masquerade as a watermark match and
		// flag solid-color images at native profile resolutions with high
		// confidence. Content carrying quantization noise (gradients, textures)
		// still rides the heuristic's inherent false-positive rate.
		const width = 1024;
		const height = 1024;
		const bitmap: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
		for (let i = 0; i < bitmap.data.length; i += 4) {
			bitmap.data[i] = 128;
			bitmap.data[i + 1] = 128;
			bitmap.data[i + 2] = 128;
			bitmap.data[i + 3] = 255;
		}
		const detection = await detectSynthid(bitmap);
		expect(detection.conclusive).toBe(true);
		expect(detection.isWatermarked).toBe(false);
		expect(detection.confidence).toBeLessThan(0.5);
	});
});

// Decodes the real bundled codebook records, so the synthetic image carries
// exactly the packed carrier phases the detector is expected to find.
function decodeRealChannel(packed: string): { y: number; x: number; phase: number }[] {
	const binary = atob(packed);
	const bins: { y: number; x: number; phase: number }[] = [];
	for (let offset = 0; offset + 7 <= binary.length; offset += 7) {
		const y = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
		const x = binary.charCodeAt(offset + 2) | (binary.charCodeAt(offset + 3) << 8);
		const phaseMr = ((binary.charCodeAt(offset + 5) | (binary.charCodeAt(offset + 6) << 8)) << 16) >> 16;
		bins.push({ y, x, phase: phaseMr / 1000 });
	}
	return bins;
}

function synthesizedProfileBitmap(profile: SynthidCodebookProfile): Bitmap {
	// Every green carrier the detector scores, not just the strongest few:
	// leaving the rest at the quantization floor would dilute the synthesized
	// match with noise-level bins the detector still counts. The amplitude is
	// scaled so the summed tones stay inside the byte range. Each 2D tone is
	// cos(a + b + phase) = cos(a + phase)cos(b) - sin(a + phase)sin(b), with
	// the row and column factors precomputed so the inner loop has no trig.
	const carriers = decodeRealChannel(profile.channels[1]).slice(0, 128);
	const width = profile.w;
	const height = profile.h;
	const amplitude = 3 * 32 / carriers.length;
	const rows = carriers.map((bin) => {
		const cos = new Float64Array(height);
		const sin = new Float64Array(height);
		for (let y = 0; y < height; y += 1) {
			const angle = 2 * Math.PI * bin.y * y / height + bin.phase;
			cos[y] = amplitude * Math.cos(angle);
			sin[y] = -amplitude * Math.sin(angle);
		}
		return { cos, sin };
	});
	const columns = carriers.map((bin) => {
		const cos = new Float64Array(width);
		const sin = new Float64Array(width);
		for (let x = 0; x < width; x += 1) {
			const angle = 2 * Math.PI * bin.x * x / width;
			cos[x] = Math.cos(angle);
			sin[x] = Math.sin(angle);
		}
		return { cos, sin };
	});
	const bitmap: Bitmap = { width, height, data: new Uint8ClampedArray(width * height * 4) };
	for (let y = 0; y < height; y += 1) {
		const row = new Float64Array(width);
		for (let k = 0; k < carriers.length; k += 1) {
			const rowFactor = rows[k];
			const columnFactor = columns[k];
			const cosY = rowFactor.cos[y];
			const sinY = rowFactor.sin[y];
			for (let x = 0; x < width; x += 1) {
				row[x] += cosY * columnFactor.cos[x] + sinY * columnFactor.sin[x];
			}
		}
		for (let x = 0; x < width; x += 1) {
			const value = 128 + row[x];
			const i = (y * width + x) * 4;
			bitmap.data[i] = value;
			bitmap.data[i + 1] = value;
			bitmap.data[i + 2] = value;
			bitmap.data[i + 3] = 255;
		}
	}
	return bitmap;
}

describe('real codebook detection', () => {
	// One representative profile per native aspect and model. Running the
	// sweep over every bundled profile costs over a minute because the
	// non-power-of-two Bluestein transforms dominate; fft.test.ts covers every
	// profile length and the artifact test covers every packed payload.
	const representatives: [model: string, height: number, width: number][] = [
		['gemini-3.1-flash-image-preview', 1440, 720],
		['gemini-3.1-flash-image-preview', 720, 1440],
		['nano-banana-pro-preview', 1024, 1024],
		['nano-banana-pro-preview', 768, 1365],
		['nano-banana-pro-preview', 843, 1264],
	];

	it('flags bundled profiles synthesized from their carriers', async () => {
		for (const [model, h, w] of representatives) {
			const profile = SYNTHID_CODEBOOK.profiles.find(
				(candidate) => candidate.model === model && candidate.h === h && candidate.w === w
			);
			expect(profile).toBeDefined();
			const detection = await detectSynthid(synthesizedProfileBitmap(profile!));
			expect(detection.exactMatch).toBe(true);
			expect(detection.conclusive).toBe(true);
			expect(detection.profileKey).toContain(`${h}x${w}`);
			expect(detection.isWatermarked).toBe(true);
			expect(detection.confidence).toBeGreaterThan(0.6);
		}
	}, 60000);

	it('flags rotated deliveries, including transposed and square profiles', async () => {
		const cases: [model: string, height: number, width: number][] = [
			// A transposed non-square delivery: the codebook holds the
			// transposed size as another model's profile, so a marginal
			// upright lookalike must not settle the verdict before the true
			// rotation is scored. A half turn keeps the upright dimensions.
			['gemini-3.1-flash-image-preview', 720, 1440],
			// A square delivery: any turn keeps the size, so the rotation
			// cannot be inferred from dimensions.
			['nano-banana-pro-preview', 1024, 1024],
		];
		for (const [model, h, w] of cases) {
			const profile = SYNTHID_CODEBOOK.profiles.find(
				(candidate) => candidate.model === model && candidate.h === h && candidate.w === w
			);
			expect(profile).toBeDefined();
			for (let turns = 1; turns <= 3; turns += 1) {
				let rotated = synthesizedProfileBitmap(profile!);
				for (let i = 0; i < turns; i += 1) rotated = rotate90Clockwise(rotated);
				const detection = await detectSynthid(rotated);
				expect(detection.isWatermarked).toBe(true);
				expect(detection.conclusive).toBe(true);
				expect(detection.profileKey).toContain(`${model}/${h}x${w}`);
			}
		}
	}, 60000);
});
