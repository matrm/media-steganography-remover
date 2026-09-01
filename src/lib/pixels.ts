import type { AffineParams, Bitmap, ColorShift, ProcessingOptions, TileShiftState } from './types';
import { yieldToBrowser } from './util';

// Maximum random translation of the affine jitter stage, in pixels. Reached
// at AFFINE_FULL_TRANSLATION_AT_DEG; smaller rotation settings scale the
// shift proportionally so a tiny rotation does not pay the full cost.
const AFFINE_TRANSLATION_JITTER_PX = 2;
const AFFINE_FULL_TRANSLATION_AT_DEG = 1.5;
// Rows between cooperative yields in the heavy per-pixel stages. Keeps the
// tab responsive on multi-megapixel images without per-row timer overhead.
const YIELD_ROW_BAND = 64;

// ---------------------------------------------------------------------------
// Steganography basics
// ---------------------------------------------------------------------------

export function clearLSBs(imageData: Bitmap): void {
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		data[i] &= 0xfe; // R
		data[i + 1] &= 0xfe; // G
		data[i + 2] &= 0xfe; // B
	}
}

export function randomizeLSBs(imageData: Bitmap): void {
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		data[i] = (data[i] & 0xfe) | (Math.random() > 0.5 ? 1 : 0);
		data[i + 1] = (data[i + 1] & 0xfe) | (Math.random() > 0.5 ? 1 : 0);
		data[i + 2] = (data[i + 2] & 0xfe) | (Math.random() > 0.5 ? 1 : 0);
	}
}

export function boxBlur(imageData: Bitmap, radius: number): void {
	// Non-finite radii would hang the kernel loops (Infinity) or zero the
	// image (NaN via a 0/0 average); non-positive radii are a no-op.
	if (!Number.isFinite(radius) || radius <= 0) return;
	// Derive the half-width first so the kernel is always odd and centered;
	// rounding the full width could yield an even size whose floor-half loop
	// would then cover one tap more than the size claims.
	const half = Math.max(1, Math.round(radius));
	const src = imageData.data;
	const width = imageData.width;
	const height = imageData.height;
	const dst = new Uint8ClampedArray(src.length);

	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let wsum = 0;
			let count = 0;

			for (let ky = -half; ky <= half; ky += 1) {
				const py = y + ky;
				if (py < 0 || py >= height) continue;
				for (let kx = -half; kx <= half; kx += 1) {
					const px = x + kx;
					if (px < 0 || px >= width) continue;
					const idx = (py * width + px) * 4;
					const alpha = src[idx + 3];
					const w = alpha;
					r += w * src[idx];
					g += w * src[idx + 1];
					b += w * src[idx + 2];
					a += alpha;
					wsum += w;
					count += 1;
				}
			}

			const idx = (y * width + x) * 4;
			dst[idx + 3] = Math.round(a / count);
			dst[idx] = dst[idx + 3] > 0 ? Math.round(r / wsum) : 0;
			dst[idx + 1] = dst[idx + 3] > 0 ? Math.round(g / wsum) : 0;
			dst[idx + 2] = dst[idx + 3] > 0 ? Math.round(b / wsum) : 0;
		}
	}

	imageData.data.set(dst);
}

// Pre-pipeline pixel wash. Runs before the SynthID pipeline so it conditions
// the source pixels; LSB work happens separately after the pipeline.
export function applyBlurEffect(imageData: Bitmap, options: ProcessingOptions): void {
	if (options.applyBlur && options.blurRadius > 0) {
		boxBlur(imageData, options.blurRadius);
	}
}

// LSB pass for pixel-oriented output. Runs after the SynthID pipeline so the
// bits stay clean in the output; the pipeline's resampling and re-encode
// stages would otherwise re-derive and scramble them. Palette formats (GIF)
// serialize a palette rather than pixels, so they run applyPaletteLsb after
// quantization, where this pass would be overwritten by the palette mapping.
export function applyLsbEffect(imageData: Bitmap, options: ProcessingOptions): void {
	if (options.clearLsb) {
		clearLSBs(imageData);
	} else if (options.randomizeLsb) {
		randomizeLSBs(imageData);
	}
}

// Shared quarter-turn rotation. `clockwise` selects where the source's top
// row lands in the output; either direction returns a new buffer and copies
// RGBA pixels verbatim, so no interpolation is involved.
function rotate90(bitmap: Bitmap, clockwise: boolean): Bitmap {
	const { width, height, data } = bitmap;
	const out = new Uint8ClampedArray(data.length);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const src = (y * width + x) * 4;
			const dst = clockwise
				? (x * height + (height - 1 - y)) * 4
				: ((width - 1 - x) * height + y) * 4;
			out[dst] = data[src];
			out[dst + 1] = data[src + 1];
			out[dst + 2] = data[src + 2];
			out[dst + 3] = data[src + 3];
		}
	}
	return { width: height, height: width, data: out };
}

// Rotates an RGBA bitmap 90 degrees clockwise. Watermark detection uses this
// to restore a profile's orientation before resampling when a delivered image
// arrives transposed.
export function rotate90Clockwise(bitmap: Bitmap): Bitmap {
	return rotate90(bitmap, true);
}

// Rotates an RGBA bitmap 90 degrees counterclockwise. A transposed delivery
// can come from either direction, so detection scores both quarter turns and
// needs both restorations.
export function rotate90Counterclockwise(bitmap: Bitmap): Bitmap {
	return rotate90(bitmap, false);
}

// Rotates an RGBA bitmap 180 degrees. Dimensions are unchanged, so this is
// the only non-identity orientation an image can hide without its size giving
// it away; like the quarter turns, it copies pixels verbatim.
export function rotate180(bitmap: Bitmap): Bitmap {
	const { width, height, data } = bitmap;
	const out = new Uint8ClampedArray(data.length);
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const src = (y * width + x) * 4;
			const dst = ((height - 1 - y) * width + (width - 1 - x)) * 4;
			out[dst] = data[src];
			out[dst + 1] = data[src + 1];
			out[dst + 2] = data[src + 2];
			out[dst + 3] = data[src + 3];
		}
	}
	return { width, height, data: out };
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

// Lanczos-3 resampling kernel.
export function lanczos3Kernel(x: number): number {
	if (x === 0) return 1;
	const ax = Math.abs(x);
	if (ax >= 3) return 0;
	const px = Math.PI * x;
	return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px);
}

interface ResampleFilter {
	// Weight for input tap i, given the output center in input index space and
	// the scale (input pixels per output pixel).
	tapWeight: (i: number, center: number, scale: number) => number;
	// Half-width of the kernel support in input pixels for a given scale.
	support: (scale: number) => number;
}

// Exact area filter: each input pixel contributes the overlap length between
// its extent [i - 0.5, i + 0.5] and the output pixel's input-space interval.
export const boxFilter: ResampleFilter = {
	tapWeight: (i, center, scale) => {
		const lo = center - scale / 2;
		const hi = center + scale / 2;
		const left = Math.max(i - 0.5, lo);
		const right = Math.min(i + 0.5, hi);
		return right > left ? right - left : 0;
	},
	support: (scale) => scale / 2 + 0.5,
};

export const lanczos3Filter: ResampleFilter = {
	tapWeight: (i, center, scale) => lanczos3Kernel((i - center) / Math.max(1, scale)),
	support: (scale) => 3 * Math.max(1, scale),
};

// Phase bands for the sampling kernel: one six-tap weight row per quantized
// sampling phase, so the per-pixel transcendental evaluations that dominate
// the sampler's cost become table reads. A band of 1/4096 pixel perturbs a
// weight by at most a few ten-thousandths, far below one 8-bit level, and the
// table stays small enough to sit in a CPU cache.
const KERNEL_PHASE_BANDS = 4096;
const KERNEL_PHASE_WEIGHTS = new Float32Array(KERNEL_PHASE_BANDS * 6);
for (let band = 0; band < KERNEL_PHASE_BANDS; band += 1) {
	const t = band / KERNEL_PHASE_BANDS;
	for (let tap = 0; tap < 6; tap += 1) {
		KERNEL_PHASE_WEIGHTS[band * 6 + tap] = lanczos3Kernel(tap - 2 - t);
	}
}

// Per-pixel tap scratch for sampleLanczos3. Calls never nest, so one shared
// set of buffers avoids a per-pixel allocation.
const SAMPLE_WEIGHT_X = new Float64Array(6);
const SAMPLE_WEIGHT_Y = new Float64Array(6);
const SAMPLE_INDEX_X = new Int32Array(6);
const SAMPLE_INDEX_Y = new Int32Array(6);

// Sampling kernel shared by the rotation and tile-shift resamples. Lanczos-3's
// passband stays nearly flat to Nyquist, which matters here because both
// sampling grids sweep every phase of the kernel across the image; softer
// kernels (Catmull-Rom, Lanczos-2) measurably drain high-frequency energy.
// Each pixel snap-quantizes its sampling phase to the nearest band, reads the
// six horizontal weights once, and holds them for all six vertical taps, so a
// 36-tap sample costs twelve table reads and no kernel evaluations. Integer
// phases land exactly on the band grid, so whole-pixel sampling stays exact.
function sampleLanczos3(
	src: Uint8ClampedArray,
	width: number,
	height: number,
	sx: number,
	sy: number,
	dst: Uint8ClampedArray,
	o: number
): void {
	const x0 = Math.floor(sx);
	const y0 = Math.floor(sy);
	const tx = sx - x0;
	const ty = sy - y0;
	const rowX = Math.min(KERNEL_PHASE_BANDS - 1, (tx * KERNEL_PHASE_BANDS + 0.5) | 0) * 6;
	const rowY = Math.min(KERNEL_PHASE_BANDS - 1, (ty * KERNEL_PHASE_BANDS + 0.5) | 0) * 6;
	for (let i = 0; i < 6; i += 1) {
		const n = i - 2;
		SAMPLE_WEIGHT_X[i] = KERNEL_PHASE_WEIGHTS[rowX + i];
		SAMPLE_WEIGHT_Y[i] = KERNEL_PHASE_WEIGHTS[rowY + i];
		SAMPLE_INDEX_X[i] = Math.min(width - 1, Math.max(0, x0 + n)) * 4;
		SAMPLE_INDEX_Y[i] = Math.min(height - 1, Math.max(0, y0 + n)) * width * 4;
	}
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	let wsum = 0;
	for (let m = 0; m < 6; m += 1) {
		const wy = SAMPLE_WEIGHT_Y[m];
		if (wy === 0) continue;
		const rowStart = SAMPLE_INDEX_Y[m];
		for (let n = 0; n < 6; n += 1) {
			const wx = SAMPLE_WEIGHT_X[n];
			if (wx === 0) continue;
			const w = wx * wy;
			wsum += w;
			const idx = rowStart + SAMPLE_INDEX_X[n];
			const aw = w * src[idx + 3];
			r += aw * src[idx];
			g += aw * src[idx + 1];
			b += aw * src[idx + 2];
			a += aw;
		}
	}
	if (wsum === 0) {
		const cx = Math.min(width - 1, Math.max(0, Math.round(sx)));
		const cy = Math.min(height - 1, Math.max(0, Math.round(sy)));
		const idx = (cy * width + cx) * 4;
		dst[o] = src[idx + 3] > 0 ? src[idx] : 0;
		dst[o + 1] = src[idx + 3] > 0 ? src[idx + 1] : 0;
		dst[o + 2] = src[idx + 3] > 0 ? src[idx + 2] : 0;
		dst[o + 3] = src[idx + 3];
		return;
	}
	dst[o + 3] = a / wsum;
	dst[o] = dst[o + 3] > 0 && a > 0 ? r / a : 0;
	dst[o + 1] = dst[o + 3] > 0 && a > 0 ? g / a : 0;
	dst[o + 2] = dst[o + 3] > 0 && a > 0 ? b / a : 0;
}

// Cap on the banded intermediate plane, in 4-byte elements, so resampling a
// very large source cannot allocate a plane proportional to the source size.
export const RESAMPLE_BAND_ELEMENTS = 1 << 22;

export function resampleSeparable(
	src: Uint8ClampedArray,
	srcWidth: number,
	srcHeight: number,
	dstWidth: number,
	dstHeight: number,
	filter: ResampleFilter
): Uint8ClampedArray {
	const scaleX = srcWidth / dstWidth;
	const scaleY = srcHeight / dstHeight;
	const supportX = filter.support(scaleX);
	const supportY = filter.support(scaleY);
	const chunkWidth = Math.min(dstWidth, Math.floor((RESAMPLE_BAND_ELEMENTS - 2) / 16));
	const rowElements = chunkWidth * 4;
	const bandRows = Math.min(dstHeight, Math.max(1, Math.floor((RESAMPLE_BAND_ELEMENTS - rowElements * 2) / (rowElements * 2 + 2))));
	const rowBuf = new Float32Array(rowElements);
	const nearestRow = new Float32Array(rowElements);
	const acc = new Float64Array(bandRows * rowElements);
	const weightSums = new Float64Array(bandRows);
	const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);

	for (let chunkStart = 0; chunkStart < dstWidth; chunkStart += chunkWidth) {
		const columns = Math.min(chunkWidth, dstWidth - chunkStart);
		const horizontal = (y: number, row: Float32Array): void => {
			for (let x = 0; x < columns; x += 1) {
				const center = (chunkStart + x + 0.5) * scaleX - 0.5;
				const start = Math.max(0, Math.floor(center - supportX));
				const end = Math.min(srcWidth - 1, Math.ceil(center + supportX));
				let wsum = 0;
				let r = 0;
				let g = 0;
				let b = 0;
				let a = 0;
				for (let i = start; i <= end; i += 1) {
					const w = filter.tapWeight(i, center, scaleX);
					if (w === 0) continue;
					const idx = (y * srcWidth + i) * 4;
					const aw = w * src[idx + 3];
					r += aw * src[idx];
					g += aw * src[idx + 1];
					b += aw * src[idx + 2];
					a += aw;
					wsum += w;
				}
				const o = x * 4;
				if (wsum > 0) {
					row[o] = r / wsum;
					row[o + 1] = g / wsum;
					row[o + 2] = b / wsum;
					row[o + 3] = a / wsum;
				} else {
					const nearest = (y * srcWidth + Math.min(srcWidth - 1, Math.max(0, Math.round(center)))) * 4;
					const alpha = src[nearest + 3];
					row[o] = src[nearest] * alpha;
					row[o + 1] = src[nearest + 1] * alpha;
					row[o + 2] = src[nearest + 2] * alpha;
					row[o + 3] = alpha;
				}
			}
		};

		for (let bandStart = 0; bandStart < dstHeight; bandStart += bandRows) {
			const bandEnd = Math.min(dstHeight, bandStart + bandRows);
			acc.fill(0);
			weightSums.fill(0);
			const firstCenter = (bandStart + 0.5) * scaleY - 0.5;
			const lastCenter = (bandEnd - 0.5) * scaleY - 0.5;
			const srcStart = Math.max(0, Math.floor(firstCenter - supportY));
			const srcEnd = Math.min(srcHeight - 1, Math.ceil(lastCenter + supportY));
			for (let y = srcStart; y <= srcEnd; y += 1) {
				horizontal(y, rowBuf);
				const from = Math.max(bandStart, Math.ceil((y - supportY - 0.5) / scaleY - 0.5));
				const to = Math.min(bandEnd - 1, Math.floor((y + supportY + 1.5) / scaleY - 0.5));
				for (let y2 = from; y2 <= to; y2 += 1) {
					const center = (y2 + 0.5) * scaleY - 0.5;
					if (y < Math.floor(center - supportY) || y > Math.ceil(center + supportY)) continue;
					const w = filter.tapWeight(y, center, scaleY);
					if (w === 0) continue;
					const rowAcc = (y2 - bandStart) * rowElements;
					weightSums[y2 - bandStart] += w;
					for (let i = 0; i < columns * 4; i += 1) acc[rowAcc + i] += w * rowBuf[i];
				}
			}
			for (let y = bandStart; y < bandEnd; y += 1) {
				const wsum = weightSums[y - bandStart];
				if (wsum <= 0) {
					const center = (y + 0.5) * scaleY - 0.5;
					horizontal(Math.min(srcHeight - 1, Math.max(0, Math.round(center))), nearestRow);
				}
				for (let x = 0; x < columns; x += 1) {
					const i = (y - bandStart) * rowElements + x * 4;
					const o = (y * dstWidth + chunkStart + x) * 4;
					const values = wsum > 0 ? acc : nearestRow;
					const index = wsum > 0 ? i : x * 4;
					const alpha = values[index + 3];
					out[o + 3] = alpha / (wsum > 0 ? wsum : 1);
					if (out[o + 3] > 0 && alpha > 0) {
						out[o] = values[index] / alpha;
						out[o + 1] = values[index + 1] / alpha;
						out[o + 2] = values[index + 2] / alpha;
					}
				}
			}
		}
	}
	return out;
}

// Downsamples with the exact area filter, then upsamples with Lanczos-3 back
// to the original size, erasing sub-pixel watermark information.
export function squeezeImageData(imageData: Bitmap, factor: number): void {
	// Invalid factors are treated as disabled rather than destructive: 0 or
	// negative would collapse to 1x1 and wipe content, and non-finite would
	// poison dimensions.
	if (!Number.isFinite(factor) || factor <= 0 || factor >= 1) return;
	const dw = Math.max(1, Math.round(imageData.width * factor));
	const dh = Math.max(1, Math.round(imageData.height * factor));
	if (dw === imageData.width && dh === imageData.height) return;
	const down = resampleSeparable(imageData.data, imageData.width, imageData.height, dw, dh, boxFilter);
	const up = resampleSeparable(down, dw, dh, imageData.width, imageData.height, lanczos3Filter);
	imageData.data.set(up);
}

// ---------------------------------------------------------------------------
// SynthID attack pipeline pixel stages
//
// Signal-processing stages of the attack documented by the reverse-SynthID
// project (https://github.com/aloshdenny/reverse-SynthID) against the
// watermark described in the SynthID-Image paper
// (https://arxiv.org/abs/2510.09263).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spatial fragmentation: per-tile integer shifts
// ---------------------------------------------------------------------------

// Draws one random integer offset per tile. The offsets are applied as a
// continuous displacement field (see applyTileShiftStage): each tile's
// offset anchors at its center and interpolates across the whole cell into
// its neighbours' offsets, so the field bends content gradually (roughly
// twice the budget divided by the cell size per pixel) instead of jogging
// at cell borders, which would read as jagged straight lines. Every tile's
// independent offset still rotates the phase of watermark carrier
// frequencies (a 1-3 px shift spans tens to hundreds of degrees across the
// 4-20 px carrier band). The interpolation band spans a full cell because
// that is the gentlest gradient the tile grid can express. The field's
// steepest displacement gradient is four times the whole-pixel budget over
// the cell size, so the budget is clamped below a quarter of the cell size
// to keep the field from folding over itself; that clamp never engages for
// the strength and cell sliders, whose extremes keep four times the
// rounded budget at sixteen against a minimum cell of twenty.
export function generateTileShiftState(width: number, height: number, maxOffset: number, tileSize: number): TileShiftState {
	// Non-finite cell sizes fall back to the balanced default instead of
	// poisoning grid dimensions.
	const size = Number.isFinite(tileSize) ? Math.max(16, Math.round(tileSize)) : 50;
	// Comfortably away from the fold-over boundary, where the field's
	// steepest gradient would reach one.
	const foldLimit = Math.max(1, Math.floor((size - 1) / 4));
	// Clamp the offset budget to the Int16 plane range so huge strengths wrap
	// modulo 2^16 and silently reverse direction, and to the fold limit so a
	// hand-set cell size below the sliders' minimum cannot fold the field
	// over itself. Non-finite or negative budgets disable shifting instead
	// of poisoning the draw. The budget keeps its fractional part so
	// sub-pixel strengths still quantize to zero; the clamp precedes the
	// per-tile rounding so it bounds the rounded whole-pixel budget too.
	const budget = Number.isFinite(maxOffset) ? Math.max(0, Math.min(32767, foldLimit, maxOffset)) : 0;
	const cols = Math.max(1, Math.ceil(width / size));
	const rows = Math.max(1, Math.ceil(height / size));
	const offsetsX = new Int16Array(cols * rows);
	const offsetsY = new Int16Array(cols * rows);
	for (let i = 0; i < offsetsX.length; i += 1) {
		offsetsX[i] = Math.round(((Math.random() * 2) - 1) * budget);
		offsetsY[i] = Math.round(((Math.random() * 2) - 1) * budget);
	}
	return {
		tileSize: size,
		feather: size,
		cols,
		rows,
		offsetsX,
		offsetsY,
	};
}

// 1D weight for the tile whose borders are left and right: 1 across the tile
// core and ramping linearly to 0 at the feather band edges, half a feather
// on either side of every border. A feather as wide as the tile leaves no
// core, so the weight peaks at the cell center; a narrower feather leaves a
// flat 1-weight core between the ramps. Adjacent ramps are complementary,
// so the weights sum to exactly 1 everywhere and the blended offset stays a
// convex combination of the tiles' offsets.
function tileAxisWeight(x: number, left: number, right: number, feather: number, total: number): number {
	// A zero or non-finite feather would divide by zero below (0/0 is NaN at
	// exact borders); treat it as no feathering instead of poisoning weights.
	if (!Number.isFinite(feather) || feather <= 0) return 1;
	let w = 1;
	if (left > 0) {
		w = Math.min(w, Math.max(0, Math.min(1, (x - (left - feather / 2)) / feather)));
	}
	if (right < total) {
		w = Math.min(w, Math.max(0, Math.min(1, ((right + feather / 2) - x) / feather)));
	}
	return w;
}

// Applies the per-tile shifts as one continuous displacement field. Each
// output pixel samples the source at its own position plus the offset field,
// the weight-blended average of the neighbouring tiles' integer offsets.
// The tile offsets anchor at the cell centers and the ramps interpolate them
// across the whole cell, so content crossing a border bends gradually.
// Cross-fading the two tiles' shifted samples would double every edge that
// crosses a border and read as tearing, and narrow ramps would make straight
// lines jog at every border and read as jagged. Each output pixel gathers
// the offsets covering it rather than scattering every tile into
// accumulator and weight planes, so peak memory is one source copy.
export async function applyTileShiftStage(imageData: Bitmap, tileShift: TileShiftState | null): Promise<void> {
	if (!tileShift) return;
	const { width, height, data } = imageData;
	const { tileSize, feather, cols, rows, offsetsX, offsetsY } = tileShift;
	const src = new Uint8ClampedArray(data);

	for (let y = 0; y < height; y += 1) {
		if ((y & (YIELD_ROW_BAND - 1)) === 0) await yieldToBrowser();
		// The interpolation band spans at most one tile, so only the owning
		// tile and its immediate neighbours can contribute to this pixel.
		const ty = Math.min(rows - 1, Math.floor(y / tileSize));
		const yFrom = Math.max(0, ty - 1);
		const yTo = Math.min(rows - 1, ty + 1);
		for (let x = 0; x < width; x += 1) {
			const tx = Math.min(cols - 1, Math.floor(x / tileSize));
			const xFrom = Math.max(0, tx - 1);
			const xTo = Math.min(cols - 1, tx + 1);
			let ox = 0;
			let oy = 0;
			let wsum = 0;
			for (let ny = yFrom; ny <= yTo; ny += 1) {
				const top = ny * tileSize;
				const bottom = Math.min(height, top + tileSize);
				if (y < Math.ceil(top - feather / 2) || y > Math.floor(bottom + feather / 2 - 1)) continue;
				const wy = tileAxisWeight(y + 0.5, top, bottom, feather, height);
				if (wy === 0) continue;
				for (let nx = xFrom; nx <= xTo; nx += 1) {
					const left = nx * tileSize;
					const right = Math.min(width, left + tileSize);
					if (x < Math.ceil(left - feather / 2) || x > Math.floor(right + feather / 2 - 1)) continue;
					const wx = tileAxisWeight(x + 0.5, left, right, feather, width);
					if (wx === 0) continue;
					const w = wx * wy;
					if (w === 0) continue;
					const i = ny * cols + nx;
					ox += w * offsetsX[i];
					oy += w * offsetsY[i];
					wsum += w;
				}
			}
			if (wsum === 0) continue;
			ox /= wsum;
			oy /= wsum;
			const o = (y * width + x) * 4;
			// An integer total offset is a whole-pixel relocation; copying it
			// directly stays bit-exact and skips the sampling kernel the
			// source would only round back to the same pixel.
			if (Number.isInteger(ox) && Number.isInteger(oy)) {
				const sx = Math.min(width - 1, Math.max(0, x + ox));
				const sy = Math.min(height - 1, Math.max(0, y + oy));
				const s = (sy * width + sx) * 4;
				data[o + 3] = src[s + 3];
				data[o] = src[s + 3] > 0 ? src[s] : 0;
				data[o + 1] = src[s + 3] > 0 ? src[s + 1] : 0;
				data[o + 2] = src[s + 3] > 0 ? src[s + 2] : 0;
			} else {
				sampleLanczos3(src, width, height, x + ox, y + oy, data, o);
			}
		}
	}
}

export function generateAffineParams(rotationJitterDeg: number, width: number, height: number): AffineParams {
	const rot = ((Math.random() * 2) - 1) * rotationJitterDeg * (Math.PI / 180);
	// Smallest uniform zoom under which the rotated frame still covers the
	// canvas, so the rotation crops edges instead of leaving corner gaps. The
	// rotated bounding box of a W x H rectangle is
	// (W*cos + H*sin) x (W*sin + H*cos), which yields the expression below.
	// The translation below is not covered by this guarantee, so it can sample
	// up to a couple of pixels past the frame, which the sampler clamps to the
	// edge. At zero rotation and translation the zoom is exactly 1.
	const sampleScale = 1 / (Math.cos(Math.abs(rot)) + Math.sin(Math.abs(rot)) * Math.max(width / height, height / width));
	// The shift shares the rotation knob: it grows with the slider and caps
	// at the maximum above, so minimal rotations are not dragged by a full
	// translation and rotation never applies without a matching shift budget.
	const translationMax = AFFINE_TRANSLATION_JITTER_PX
		* Math.max(0, Math.min(1, rotationJitterDeg / AFFINE_FULL_TRANSLATION_AT_DEG));
	return {
		rot,
		sampleScale,
		tx: ((Math.random() * 2) - 1) * translationMax,
		ty: ((Math.random() * 2) - 1) * translationMax,
	};
}

// Applies the affine jitter (small rotation + fit zoom + translation) in a
// single Lanczos-3 resampling pass. The spatially varying tile shifts handle
// phase fragmentation; this stage adds the global component that CNN
// detectors are most sensitive to (small rotations).
export async function applyWarpStage(imageData: Bitmap, affine: AffineParams | null): Promise<void> {
	if (!affine) return;
	const { width, height, data } = imageData;
	const src = new Uint8ClampedArray(data);
	const cx = (width - 1) / 2;
	const cy = (height - 1) / 2;
	const cos = Math.cos(affine.rot);
	const sin = Math.sin(affine.rot);
	const sampleScale = affine.sampleScale;
	const atx = affine.tx;
	const aty = affine.ty;

	for (let y = 0; y < height; y += 1) {
		if ((y & (YIELD_ROW_BAND - 1)) === 0) await yieldToBrowser();
		for (let x = 0; x < width; x += 1) {
			const idx = y * width + x;
			const u = x - cx - atx;
			const v = y - cy - aty;
			const sx = cx + sampleScale * (u * cos + v * sin);
			const sy = cy + sampleScale * (-u * sin + v * cos);
			sampleLanczos3(src, width, height, sx, sy, data, idx * 4);
		}
	}
}

// Builds one combined matrix for random brightness, contrast, saturation and
// hue micro-shifts.
export function generateColorShift(amount: number): ColorShift {
	const brightness = ((Math.random() * 2) - 1) * 2 * amount;
	const contrast = 1 + ((Math.random() * 2) - 1) * 0.02 * amount;
	const saturation = 1 + ((Math.random() * 2) - 1) * 0.03 * amount;
	const hue = ((Math.random() * 2) - 1) * 1.5 * amount * (Math.PI / 180);

	// Hue rotation matrix (SVG feColorMatrix hueRotate formulation).
	const cosA = Math.cos(hue);
	const sinA = Math.sin(hue);
	const hueM = [
		0.213 + cosA * 0.787 - sinA * 0.213, 0.715 - cosA * 0.715 - sinA * 0.715, 0.072 - cosA * 0.072 + sinA * 0.928,
		0.213 - cosA * 0.213 + sinA * 0.143, 0.715 + cosA * 0.285 + sinA * 0.140, 0.072 - cosA * 0.072 - sinA * 0.283,
		0.213 - cosA * 0.213 - sinA * 0.787, 0.715 - cosA * 0.715 + sinA * 0.715, 0.072 + cosA * 0.928 + sinA * 0.072,
	];

	// Luma-based saturation matrix.
	const lr = 0.2126;
	const lg = 0.7152;
	const lb = 0.0722;
	const satM = [
		saturation + (1 - saturation) * lr, (1 - saturation) * lg, (1 - saturation) * lb,
		(1 - saturation) * lr, saturation + (1 - saturation) * lg, (1 - saturation) * lb,
		(1 - saturation) * lr, (1 - saturation) * lg, saturation + (1 - saturation) * lb,
	];

	// Combined transform: hue, then saturation, then contrast, then brightness.
	const m: number[] = new Array(9);
	for (let r = 0; r < 3; r += 1) {
		for (let c = 0; c < 3; c += 1) {
			m[r * 3 + c] = contrast * (
				satM[r * 3] * hueM[c] +
				satM[r * 3 + 1] * hueM[3 + c] +
				satM[r * 3 + 2] * hueM[6 + c]
			);
		}
	}
	const offsetValue = 127.5 * (1 - contrast) + brightness;
	return { m, offset: [offsetValue, offsetValue, offsetValue] };
}

export function applyColorShift(imageData: Bitmap, shift: ColorShift): void {
	const { m, offset } = shift;
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		data[i] = m[0] * r + m[1] * g + m[2] * b + offset[0];
		data[i + 1] = m[3] * r + m[4] * g + m[5] * b + offset[1];
		data[i + 2] = m[6] * r + m[7] * g + m[8] * b + offset[2];
	}
}

export function addLumaNoise(imageData: Bitmap, levels: number, random: () => number = Math.random): void {
	// Non-finite levels would poison every channel (NaN blackens, Infinity
	// posterizes); non-positive levels are a no-op. The injectable source
	// lets file pipelines pass a per-file seeded generator so frames stay
	// consistent instead of flickering.
	if (!Number.isFinite(levels) || levels <= 0) return;
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		// Round the perturbation before storing it so sub-level noise always
		// vanishes: a raw -0.5 step (an exact 0 draw at 0.5 levels) would
		// land on the clamped array's half-to-even tie and move odd channel
		// values instead of rounding away.
		const n = Math.round((random() * 2 - 1) * levels);
		data[i] += n;
		data[i + 1] += n;
		data[i + 2] += n;
	}
}

// Edge-preserving smoothing: flattens residual high-frequency watermark
// energy in flat regions while keeping edges intact.
export async function bilateralFilter(imageData: Bitmap, radius: number, sigmaColor: number): Promise<void> {
	// A zero color sigma divides by zero in the range table (NaN weights
	// blacken the image); negative or non-finite parameters are programmer
	// errors, so fail fast instead of producing silent garbage.
	if (!Number.isFinite(radius) || !Number.isFinite(sigmaColor) || radius < 0 || sigmaColor <= 0) {
		throw new RangeError(`bilateralFilter requires a finite radius >= 0 and sigmaColor > 0 (got ${radius}, ${sigmaColor})`);
	}
	const roundedRadius = Math.round(radius);
	const { width, height, data } = imageData;
	const src = new Uint8ClampedArray(data);
	const size = roundedRadius * 2 + 1;
	const sigmaSpace = Math.max(0.5, roundedRadius / 2);
	const spatial = new Float32Array(size * size);
	for (let ky = -roundedRadius; ky <= roundedRadius; ky += 1) {
		for (let kx = -roundedRadius; kx <= roundedRadius; kx += 1) {
			spatial[(ky + roundedRadius) * size + (kx + roundedRadius)] = Math.exp(-(kx * kx + ky * ky) / (2 * sigmaSpace * sigmaSpace));
		}
	}
	const colorLut = new Float32Array(256);
	for (let d = 0; d < 256; d += 1) {
		colorLut[d] = Math.exp(-(d * d) / (2 * sigmaColor * sigmaColor));
	}

	for (let y = 0; y < height; y += 1) {
		if ((y & (YIELD_ROW_BAND - 1)) === 0) await yieldToBrowser();
		for (let x = 0; x < width; x += 1) {
			const idx = (y * width + x) * 4;
			if (src[idx + 3] === 0) {
				data[idx] = 0;
				data[idx + 1] = 0;
				data[idx + 2] = 0;
				continue;
			}
			const cr = src[idx];
			const cg = src[idx + 1];
			const cb = src[idx + 2];
			let wsum = 0;
			let r = 0;
			let g = 0;
			let b = 0;
			for (let ky = -roundedRadius; ky <= roundedRadius; ky += 1) {
				const py = Math.min(height - 1, Math.max(0, y + ky));
				for (let kx = -roundedRadius; kx <= roundedRadius; kx += 1) {
					const px = Math.min(width - 1, Math.max(0, x + kx));
					const pidx = (py * width + px) * 4;
					// Luma-weighted color distance.
					const d = Math.abs(
						0.2126 * (src[pidx] - cr) +
						0.7152 * (src[pidx + 1] - cg) +
						0.0722 * (src[pidx + 2] - cb)
					);
					const w = spatial[(ky + roundedRadius) * size + (kx + roundedRadius)] * colorLut[Math.round(d)] * src[pidx + 3];
					wsum += w;
					r += w * src[pidx];
					g += w * src[pidx + 1];
					b += w * src[pidx + 2];
				}
			}
			data[idx] = r / wsum;
			data[idx + 1] = g / wsum;
			data[idx + 2] = b / wsum;
		}
	}
}
