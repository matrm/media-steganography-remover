import type {
	Bitmap,
	FrameSize,
	DistortOptions,
	DistortPreset,
	DistortRandomState,
} from './types';
import { canvasToBlob, createSeededRandom, yieldToBrowser } from './util';
import {
	addLumaNoise,
	applyColorShift,
	applyTileShiftStage,
	applyWarpStage,
	bilateralFilter,
	generateAffineParams,
	generateColorShift,
	generateTileShiftState,
	squeezeImageData,
} from './pixels';
import {
	computeAlphaPsnr,
	combinedPsnr,
	computePsnr,
	anyVisiblePixel,
	hasNewlyVisiblePixels,
	scanHasAlpha,
} from './metrics';

// ---------------------------------------------------------------------------
// Media distortion pipeline
//
// Signal-processing stages that disturb the pixel grid a steganographic
// watermark survives in. The stage set follows the attack documented by the
// reverse-SynthID project (https://github.com/aloshdenny/reverse-SynthID),
// which is aimed at the watermark described in the SynthID-Image paper
// (https://arxiv.org/abs/2510.09263).
//
// This is a best-effort distortion, not a verified removal. It was measured
// against Google's own SynthID checker on real Gemini output and did not
// defeat it at any setting, so it is presented as a generic distortion that
// may disturb some embedded watermarks rather than as SynthID removal.
// ---------------------------------------------------------------------------

export const MAX_DISTORT_PIXELS = 20_000_000;
export const MAX_GIF_PIXELS = 8_000_000;

// Strength presets, scaled down from the reverse-SynthID Round 06
// "final"/"nuke" settings (https://github.com/aloshdenny/reverse-SynthID) for a
// signal-processing-only pipeline.
export const DISTORT_PRESETS: Record<'gentle' | 'balanced' | 'aggressive', DistortPreset> = {
	gentle: {
		elasticAlpha: 1.2,
		elasticSigma: 55,
		rotationJitter: 0.4,
		squeezeFactor: 1,
		colorAmount: 0.7,
		lumaNoise: 1,
		reencodeRounds: 1,
		reencodeQuality: 95,
		bilateral: false,
		psnrFloor: 36,
	},
	balanced: {
		elasticAlpha: 2,
		elasticSigma: 50,
		rotationJitter: 0.75,
		squeezeFactor: 1,
		colorAmount: 1,
		lumaNoise: 1.5,
		reencodeRounds: 1,
		reencodeQuality: 92,
		bilateral: false,
		psnrFloor: 32,
	},
	aggressive: {
		elasticAlpha: 3,
		elasticSigma: 46,
		rotationJitter: 1.5,
		squeezeFactor: 0.9,
		colorAmount: 1.4,
		lumaNoise: 2.5,
		reencodeRounds: 2,
		reencodeQuality: 90,
		bilateral: true,
		psnrFloor: 28,
	},
};

const BILATERAL_RADIUS = 2;
const BILATERAL_SIGMA_COLOR = 25;
// Percentage points added to the encoder quality for the single retry when
// the final encoded output misses the quality floor.
const ENCODE_QUALITY_ESCALATION_STEP = 6;
// Share of a full-range RGB level that survives as limited-range luma (16 to
// 235); the reverse conversion expands by its reciprocal. Stages that move
// luma directly shrink their targets by this factor so the visible RGB delta
// matches the image path.
const LIMITED_RANGE_LUMA = 219 / 255;

// Outcome of a quality-floor gate: accepted, rejected by the PSNR floor, or
// rejected because it materialized visible pixels from a fully transparent
// reference.
type FloorOutcome = 'accepted' | 'floor' | 'visible';

// Runs a pixel stage and rolls it back when it degrades the image below the
// configured PSNR floor. Quality is measured marginally: the stage result is
// compared against the image state immediately before the stage ran, so every
// stage is judged by its own contribution regardless of earlier stages.
async function applyWithPsnrFloor(
	imageData: Bitmap,
	stage: (data: Bitmap) => void | Promise<void>,
	floorDb: number
): Promise<FloorOutcome> {
	const before = new Uint8ClampedArray(imageData.data);
	await stage(imageData);
	// A fully transparent frame has no visible signal for PSNR to measure, so
	// combinedPsnr reports Infinity and the floor cannot judge the stage by
	// quality. Accept the stage unless it materialized visible pixels where
	// the reference had none.
	if (!anyVisiblePixel(before)) {
		const accepted = !anyVisiblePixel(imageData.data);
		if (!accepted) imageData.data.set(before);
		return accepted ? 'accepted' : 'visible';
	}
	// PSNR skips fully transparent reference pixels, so a stage that bleeds
	// opaque content into transparent regions can still score well. Reject
	// newly materialized pixels explicitly regardless of the score.
	if (hasNewlyVisiblePixels(before, imageData.data)) {
		imageData.data.set(before);
		return 'visible';
	}
	const score = combinedPsnr(before, imageData.data);
	// NaN is not >= the floor, so malformed scores roll back instead of
	// slipping through the < comparison (NaN < x is always false).
	if (!(score >= floorDb)) {
		imageData.data.set(before);
		return 'floor';
	}
	return 'accepted';
}

export function qualityFloorSkipWarning(stageName: string, floorDb: number): string {
	return `${stageName} was skipped: it would change the image more than your quality floor (${floorDb} dB) allows. Lower the quality floor or reduce that setting's strength to apply it.`;
}

// Warning for a video luma noise setting too small to survive the filter's
// whole-level quantization. The advised minimum is rounded up onto the
// caller's slider grid from the same factor isSubLevelVideoNoise uses, so the
// recommended value always lands on that grid and always applies noise;
// reaching it is up to the control's own range.
export function subLevelVideoNoiseWarning(sliderStep: number): string {
	// A non-finite or non-positive grid would poison the rounding; fall back
	// to tenths so the advice stays selectable on the default slider.
	const step = Number.isFinite(sliderStep) && sliderStep > 0 ? sliderStep : 0.1;
	const threshold = 0.5 / LIMITED_RANGE_LUMA;
	// toFixed strips the float dust of step * n so the advice reads 0.6 and
	// not 0.6000000000000001.
	const minSetting = Number((Math.ceil(threshold / step) * step).toFixed(10));
	return `Luma noise was skipped for this video because it rounds to zero whole noise levels. Raise it to at least ${minSetting} to apply video noise.`;
}

function visibilitySkipWarning(stageName: string): string {
	return `${stageName} was skipped: it would make fully transparent pixels visible.`;
}

function recordStageRollback(warnings: string[], stageName: string, outcome: FloorOutcome, floorDb: number): void {
	if (outcome === 'accepted') return;
	const warning = outcome === 'visible'
		? visibilitySkipWarning(stageName)
		: qualityFloorSkipWarning(stageName, floorDb);
	if (!warnings.includes(warning)) warnings.push(warning);
}

// Runs one pixel stage either directly or under the quality-floor gate,
// recording a skip warning when a gated run rolls back.
async function applyGatedStage(
	imageData: Bitmap,
	stageName: string,
	stage: (data: Bitmap) => void | Promise<void>,
	gated: boolean,
	floorDb: number,
	warnings: string[]
): Promise<void> {
	if (!gated) {
		await stage(imageData);
		return;
	}
	const outcome = await applyWithPsnrFloor(imageData, stage, floorDb);
	recordStageRollback(warnings, stageName, outcome, floorDb);
}

// Individual distortion-stage runners, factored out so the animated-GIF
// pipeline and the static image pipeline share one implementation. Heavy
// stages yield cooperatively per row band, so callers only await.
async function applySqueezeStage(imageData: Bitmap, options: DistortOptions, gated: boolean, warnings: string[]): Promise<void> {
	// Treat invalid factors as disabled: 0/negative would collapse to a flat
	// field, non-finite would poison dimensions.
	if (!Number.isFinite(options.squeezeFactor) || options.squeezeFactor <= 0 || options.squeezeFactor >= 1) return;
	const squeezeFactor = options.squeezeFactor;
	await applyGatedStage(imageData, 'Resize squeeze', (data) => {
		squeezeImageData(data, squeezeFactor);
	}, gated, options.psnrFloor, warnings);
}

async function applyColorStage(imageData: Bitmap, state: DistortRandomState, options: DistortOptions, gated: boolean, warnings: string[]): Promise<void> {
	if (!state.color) return;
	const color = state.color;
	await applyGatedStage(imageData, 'Color shift', (data) => {
		applyColorShift(data, color);
	}, gated, options.psnrFloor, warnings);
}

async function applyNoiseStage(imageData: Bitmap, state: DistortRandomState, options: DistortOptions, gated: boolean, warnings: string[]): Promise<void> {
	if (options.lumaNoise <= 0) return;
	const lumaNoise = options.lumaNoise;
	const noiseSeed = state.noiseSeed;
	await applyGatedStage(imageData, 'Luma noise', (data) => {
		// A fresh generator from the per-file seed on every call keeps every
		// frame's pattern identical (no flicker) while files still differ.
		addLumaNoise(data, lumaNoise, createSeededRandom(noiseSeed));
	}, gated, options.psnrFloor, warnings);
}

// Applies the randomized distortion stages shared by the static image and
// animated GIF pipelines: tile shifts, affine jitter, resize squeeze, color
// micro-shift and luma noise. The random parameters come from the per-file
// state so repeats stay consistent. The tile shifts and the affine jitter
// always run regardless of gating: both relocate pixels by design, so
// per-pixel PSNR scores any detailed image as heavily degraded even though
// the content stays sharp, and a gate would silently disable the pipeline's
// main structural attacks on most real content while probing for a fitting
// strength costs more warps than the stage is worth. The floor therefore
// governs the genuinely lossy stages below.
export async function applyDistortStages(
	imageData: Bitmap,
	state: DistortRandomState,
	options: DistortOptions,
	gated: boolean,
	warnings: string[]
): Promise<void> {
	await applyTileShiftStage(imageData, state.tileShift);
	await applyWarpStage(imageData, state.affine);
	await applySqueezeStage(imageData, options, gated, warnings);
	await applyColorStage(imageData, state, options, gated, warnings);
	await applyNoiseStage(imageData, state, options, gated, warnings);
}

// Final edge-preserving smoothing pass shared by both pipelines; the only
// difference between media types is whether it runs under the quality floor.
export async function applyDistortSmoothingStage(
	imageData: Bitmap,
	options: DistortOptions,
	gated: boolean,
	warnings: string[]
): Promise<void> {
	if (!options.bilateral) return;
	await applyGatedStage(imageData, 'Edge-preserving smoothing', (data) => {
		return bilateralFilter(data, BILATERAL_RADIUS, BILATERAL_SIGMA_COLOR);
	}, gated, options.psnrFloor, warnings);
}

// Pre-generates the random tile shifts, affine and color parameters once per
// media file so every frame is distorted consistently and does not flicker.
// The shift sliders map onto the fragmentation attack: strength is the
// maximum integer offset in pixels, smoothness sets the tile cell size.
// Strengths below a whole pixel cannot survive integer quantization (they
// round to zero everywhere), so they are treated as disabled instead of
// running a wasted exact-copy stage.
export function buildDistortRandomState(width: number, height: number, options: DistortOptions): DistortRandomState {
	return {
		tileShift: options.elasticAlpha >= 1
			? generateTileShiftState(width, height, options.elasticAlpha, options.elasticSigma)
			: null,
		affine: options.rotationJitter > 0 ? generateAffineParams(options.rotationJitter, width, height) : null,
		color: options.colorAmount > 0 ? generateColorShift(options.colorAmount) : null,
		noiseSeed: Math.floor(Math.random() * 4294967296),
	};
}

export function gifQualityToMaxColors(quality: number): number {
	const normalized = Math.max(0, Math.min(1, (quality - 60) / 40));
	return Math.round(64 + normalized * 192);
}

// Lossy re-encode round trips. JPEG for opaque images, WebP when transparency
// must survive. Stops early when the browser silently falls back to PNG.
async function runReencodeChain(
	canvas: HTMLCanvasElement,
	rounds: number,
	quality: number,
	floorDb: number,
	warnings: string[]
): Promise<void> {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return;
	const initial = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const mime = scanHasAlpha(initial.data) ? 'image/webp' : 'image/jpeg';

	for (let i = 0; i < rounds; i += 1) {
		// Round 0 starts from the identical pixels already read above for
		// mime detection, so reuse that snapshot instead of reading twice.
		const beforeRound = i === 0 ? initial : ctx.getImageData(0, 0, canvas.width, canvas.height);
		const q = quality / 100;
		const blob = await canvasToBlob(canvas, mime, q);
		if (blob.type !== mime) {
			warnings.push(`Re-encode rounds were skipped because ${mime} encoding is unavailable.`);
			break;
		}
		let bitmap: ImageBitmap;
		try {
			bitmap = await createImageBitmap(blob);
		} catch {
			warnings.push(`Re-encode round ${i + 1} was skipped because ${mime} decoding is unavailable.`);
			break;
		}
		try {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(bitmap, 0, 0);
		} catch {
			// The clear runs before the draw, so a failed draw leaves a blank
			// canvas behind; restore the pre-round pixels before leaving.
			ctx.putImageData(beforeRound, 0, 0);
			warnings.push(`Re-encode round ${i + 1} was skipped because the ${mime} image could not be drawn.`);
			break;
		} finally {
			bitmap.close();
		}

		const afterRound = ctx.getImageData(0, 0, canvas.width, canvas.height);
		// Fully transparent references report Infinity PSNR, so also roll back
		// when a round materializes visible pixels where there were none.
		if (!anyVisiblePixel(beforeRound.data)) {
			if (anyVisiblePixel(afterRound.data)) {
				ctx.putImageData(beforeRound, 0, 0);
				recordStageRollback(warnings, `Re-encode round ${i + 1}`, 'visible', floorDb);
				break;
			}
			continue;
		}
		// PSNR skips fully transparent reference pixels, so reject rounds that
		// bleed into transparent regions even when the score still clears.
		if (hasNewlyVisiblePixels(beforeRound.data, afterRound.data)) {
			ctx.putImageData(beforeRound, 0, 0);
			recordStageRollback(warnings, `Re-encode round ${i + 1}`, 'visible', floorDb);
			break;
		}
		const score = combinedPsnr(beforeRound.data, afterRound.data);
		if (!(score >= floorDb)) {
			ctx.putImageData(beforeRound, 0, 0);
			recordStageRollback(warnings, `Re-encode round ${i + 1}`, 'floor', floorDb);
			break;
		}
	}
}

export async function applyDistortPipeline(
	canvas: HTMLCanvasElement,
	options: DistortOptions,
	warnings: string[]
): Promise<void> {
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) return;
	const { width, height } = canvas;
	const state = buildDistortRandomState(width, height, options);

	// Heavy stages yield cooperatively per row band internally; the awaits
	// here sequence the groups while keeping the UI alive.
	await yieldToBrowser();
	const imageData = ctx.getImageData(0, 0, width, height);
	await applyDistortStages(imageData, state, options, true, warnings);
	ctx.putImageData(imageData, 0, 0);
	await yieldToBrowser();

	// Stage 6: lossy re-encode chain.
	if (options.reencodeRounds > 0) {
		await runReencodeChain(canvas, options.reencodeRounds, options.reencodeQuality, options.psnrFloor, warnings);
	}

	await yieldToBrowser();

	// Stage 7: edge-preserving smoothing.
	const smoothed = ctx.getImageData(0, 0, width, height);
	await applyDistortSmoothingStage(smoothed, options, true, warnings);
	ctx.putImageData(smoothed, 0, 0);
}

async function encodedImagePassesPsnr(
	blob: Blob,
	width: number,
	height: number,
	reference: Uint8ClampedArray,
	floorDb: number,
	checkAlpha: boolean
): Promise<boolean> {
	const bitmap = await createImageBitmap(blob);
	try {
		if (bitmap.width !== width || bitmap.height !== height) return false;
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return false;
		ctx.drawImage(bitmap, 0, 0);
		const data = ctx.getImageData(0, 0, width, height).data;
		// A fully transparent reference has no visible content for the score
		// to measure. Alpha-preserving encodes must keep it invisible; formats
		// that flatten alpha (JPEG) necessarily materialize the reference when
		// decoded, which is not a quality failure because no visible content
		// was lost.
		if (!anyVisiblePixel(reference)) return !checkAlpha || !anyVisiblePixel(data);
		// PSNR skips fully transparent reference pixels, so reject encodes
		// that bleed into transparent regions even when the score clears.
		// JPEG flattening intentionally materializes pixels, so this only
		// applies to alpha-preserving encodes.
		if (checkAlpha && hasNewlyVisiblePixels(reference, data)) return false;
		return computePsnr(reference, data, !checkAlpha) >= floorDb
			&& (!checkAlpha || computeAlphaPsnr(reference, data) >= floorDb);
	} finally {
		bitmap.close();
	}
}

export async function encodeStaticImage(
	canvas: HTMLCanvasElement,
	mime: string,
	quality: number | undefined,
	options: DistortOptions,
	preEncode: Uint8ClampedArray | null,
	warnings: string[]
): Promise<Blob> {
	let blob = await canvasToBlob(canvas, mime, quality);
	if (blob.type !== mime) {
		throw new Error(`Canvas does not support ${mime} output. It returned ${blob.type || 'an unknown format'}.`);
	}
	if (!options.enabled) return blob;
	// Reaching here means the caller ran the distortion pipeline with enabled,
	// and the sole caller builds preEncode exactly when enabled, so it is
	// non-null. The check narrows the type and guards any future caller that
	// violates that invariant; this path is otherwise unreachable.
	if (preEncode === null) {
		throw new Error('Quality floor validation requires the pre-encode snapshot.');
	}

	// Formats with a quality knob get one retry at slightly higher quality
	// when the encoded result misses the floor. Lossless formats get one
	// check. Like every other stage, quality is measured marginally against
	// the canvas state immediately before this encode, so cumulative drift
	// from earlier pipeline stages is not blamed on serialization. The bump
	// is capped just above the user's chosen quality so the floor's quality
	// promise cannot turn the output into a maximum-quality encode the user
	// never asked for.
	try {
		if (await encodedImagePassesPsnr(blob, canvas.width, canvas.height, preEncode, options.psnrFloor, mime !== 'image/jpeg')) {
			return blob;
		}
		let bumped = false;
		if (quality !== undefined) {
			const chosenQuality = Math.round(quality * 100);
			const attemptQuality = Math.min(100, chosenQuality + ENCODE_QUALITY_ESCALATION_STEP);
			if (attemptQuality > chosenQuality) {
				const attempt = await canvasToBlob(canvas, mime, attemptQuality / 100);
				if (attempt.type === mime) {
					blob = attempt;
					bumped = true;
					if (await encodedImagePassesPsnr(attempt, canvas.width, canvas.height, preEncode, options.psnrFloor, mime !== 'image/jpeg')) {
						return blob;
					}
				}
			}
		}
		warnings.push(bumped
			? `The final ${mime} encode fell below the ${options.psnrFloor} dB quality floor even after a small encoder quality bump, so the delivered pixels differ from the ones the pipeline produced by more than the floor allows.`
			: `The final ${mime} encode fell below the ${options.psnrFloor} dB quality floor, so the delivered pixels differ from the ones the pipeline produced by more than the floor allows.`);
	} catch {
		warnings.push(`Could not validate the ${mime} output against the quality floor, but the result was kept.`);
	}
	return blob;
}

export function buildDistortVideoFilters(
	options: DistortOptions,
	frameSize: FrameSize | null,
	random: () => number = Math.random,
	warnings: string[] = []
): string[] {
	const filters: string[] = [];

	// Sub-pixel strengths cannot survive integer quantization on the image
	// path (they round to zero everywhere and are treated as disabled), so
	// the video approximation uses the same cutoff instead of distorting
	// videos that images would leave untouched.
	if (options.elasticAlpha >= 1 && frameSize) {
		// FFmpeg does not provide the same random displacement field as the
		// image path, so use radial lens distortion as a deterministic
		// spatially-varying approximation. Displacement grows with normalized
		// radius and peaks at the corners (where the radius reaches 1) at
		// k1 * hypot(width, height) / 2 pixels; solving for the image path's
		// alpha-pixel budget gives k1 below. Bilinear sampling avoids visible
		// nearest-neighbour stepping at these small displacements.
		const k1 = Math.min(0.25, (2 * options.elasticAlpha) / Math.hypot(frameSize.width, frameSize.height));
		// Positive k1 samples past the frame edge, and lenscorrection fills
		// those unmapped pixels with black. Magnify first, then crop the
		// margin back off, so the black band falls outside the output. The
		// scale 1 / (1 - k1) covers the k1 * scaled / 2 corner band.
		const marginScale = (1 / (1 - k1)).toFixed(6);
		const marginWidth = Math.max(2, Math.trunc(frameSize.width / 2) * 2);
		const marginHeight = Math.max(2, Math.trunc(frameSize.height / 2) * 2);
		filters.push(`scale=max(2\\,ceil(iw*${marginScale}/2)*2):max(2\\,ceil(ih*${marginScale}/2)*2):flags=lanczos`);
		filters.push(`lenscorrection=k1=${k1.toFixed(6)}:i=bilinear`);
		filters.push(`crop=${marginWidth}:${marginHeight}:x=(iw-ow)/2:y=(ih-oh)/2`);
	}

	if (options.rotationJitter > 0) {
		// Magnify uniformly, rotate, then center-crop back to the original
		// size. The magnification is the smallest uniform factor under which
		// the rotated frame still covers the canvas, the same covering factor
		// the image path applies; scaling each axis to the rotated bounding
		// box would stretch the frame anamorphically and change the output
		// dimensions. The crop discards the rotate filter's black corner
		// fill: rotate keeps the frame size and fills uncovered corners with
		// black by default. max(2, ...) keeps 1px frames valid instead of
		// truncating to 0, and the even quantization keeps yuv420p encoders
		// happy.
		const angle = ((random() * 2) - 1) * options.rotationJitter * (Math.PI / 180);
		const absAngle = Math.abs(angle);
		const sinA = Math.sin(absAngle);
		const cosA = Math.cos(absAngle);
		if (frameSize) {
			const cover = (cosA + sinA * Math.max(frameSize.width / frameSize.height, frameSize.height / frameSize.width)).toFixed(6);
			const cropWidth = Math.max(2, Math.trunc(frameSize.width / 2) * 2);
			const cropHeight = Math.max(2, Math.trunc(frameSize.height / 2) * 2);
			filters.push(`scale=max(2\\,ceil(iw*${cover}/2)*2):max(2\\,ceil(ih*${cover}/2)*2):flags=lanczos`);
			filters.push(`rotate=a=${angle.toFixed(6)}:bilinear=1`);
			filters.push(`crop=${cropWidth}:${cropHeight}:x=(iw-ow)/2:y=(ih-oh)/2`);
		} else {
			warnings.push('Rotation jitter was skipped: original frame dimensions are unavailable.');
		}
	}

	if (Number.isFinite(options.squeezeFactor) && options.squeezeFactor > 0 && options.squeezeFactor < 1) {
		if (frameSize) {
			const width = Math.max(2, Math.trunc(frameSize.width / 2) * 2);
			const height = Math.max(2, Math.trunc(frameSize.height / 2) * 2);
			const squeezedWidth = Math.max(2, Math.trunc(width * options.squeezeFactor / 2) * 2);
			const squeezedHeight = Math.max(2, Math.trunc(height * options.squeezeFactor / 2) * 2);
			filters.push(`scale=${squeezedWidth}:${squeezedHeight}:flags=lanczos`);
			filters.push(`scale=${width}:${height}:flags=lanczos`);
		} else {
			warnings.push('Resize squeeze was skipped: original frame dimensions are unavailable.');
		}
	}

	if (options.colorAmount > 0) {
		// The image path shifts brightness by up to 2 * amount RGB levels; eq
		// normalizes over [0, 1] but writes limited-range luma (16 to 235),
		// which expands back into full-range RGB by 255/219, so the divisor
		// compensates for that gain.
		const levelsToBrightness = (2 / 255) * LIMITED_RANGE_LUMA;
		const brightness = ((random() * 2) - 1) * levelsToBrightness * options.colorAmount;
		const contrast = 1 + ((random() * 2) - 1) * 0.02 * options.colorAmount;
		const saturation = 1 + ((random() * 2) - 1) * 0.03 * options.colorAmount;
		filters.push(`eq=brightness=${brightness.toFixed(5)}:contrast=${contrast.toFixed(5)}:saturation=${saturation.toFixed(5)}`);
		// The image path also applies a hue micro-rotation of up to 1.5 degrees
		// per amount; approximate it with FFmpeg's hue filter (degrees).
		const hueDeg = ((random() * 2) - 1) * 1.5 * options.colorAmount;
		if (hueDeg !== 0) filters.push(`hue=h=${hueDeg.toFixed(4)}`);
	}

	if (options.lumaNoise > 0 && !isSubLevelVideoNoise(options.lumaNoise)) {
		// An odd strength S with the uniform flag produces exactly uniform
		// integer noise in [-floor(S/2), +floor(S/2)]; without the uniform
		// flag the filter emits Gaussian noise with roughly twice that RMS.
		// Only the luma plane moves, matching the image path's shared R/G/B
		// delta, which leaves chroma untouched; the per-plane strengths
		// default to zero so the unset planes stay clean. The level is the
		// image path's +/-lumaNoise bound scaled by LIMITED_RANGE_LUMA so
		// the visible RGB delta lands on that bound within half a level once
		// limited-range luma expands back into full-range RGB, rounded to
		// the nearest whole level (the filter cannot express sub-level
		// noise) so S always lands odd (an even S would skew the distribution
		// asymmetrically). The cap keeps
		// S odd: 100 is even and would skew the distribution, so the largest
		// odd strength at or below the filter limit is 99.
		const level = Math.round(options.lumaNoise * LIMITED_RANGE_LUMA);
		const strength = Math.min(99, 2 * level + 1);
		filters.push(`noise=c0s=${strength}:allf=t+u`);
	}
	// Sub-level settings are skipped by the check above instead of emitting
	// strength 1, which is a no-op ([-0, +0]). The skip only omits this
	// filter so later stages still run.

	return filters;
}

// Whether a luma noise setting rounds to zero whole luma levels for the FFmpeg
// uniform filter after the limited-range gain compensation, so it produces no
// video noise. The filter cannot express sub-level noise, so callers disclose
// the skip instead of emitting a no-op filter silently. The image path absorbs
// perturbations only at and below half a level; just above it extreme draws
// can still move pixels by one while this filter stays quiet.
export function isSubLevelVideoNoise(value: number): boolean {
	return value > 0 && Math.round(value * LIMITED_RANGE_LUMA) === 0;
}
