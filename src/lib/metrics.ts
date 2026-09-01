// ---------------------------------------------------------------------------
// Quality metrics
// ---------------------------------------------------------------------------

// RGB comparison. By default it skips fully transparent pixels: their colors
// are invisible, and lossy formats may overwrite them arbitrarily during
// decode. With opaqueOnly it instead skips every pixel that is not fully
// opaque, which is the right basis for formats with no alpha channel (JPEG),
// where any semi-transparent source pixel is flattened onto a background and
// its RGB is intentionally lost.
export function computePsnr(a: Uint8ClampedArray, b: Uint8ClampedArray, opaqueOnly = false): number {
	if (a.length !== b.length) return 0;
	// Equal-length buffers that are not whole pixels would read undefined
	// channels below and silently produce NaN. Return NaN explicitly so floor
	// gates can treat malformed input as a failure instead of a pass.
	if (a.length % 4 !== 0) return NaN;
	let mse = 0;
	let samples = 0;
	for (let i = 0; i < a.length; i += 4) {
		const alpha = a[i + 3];
		if (opaqueOnly ? alpha !== 255 : alpha === 0) continue;
		mse += (a[i] - b[i]) ** 2;
		mse += (a[i + 1] - b[i + 1]) ** 2;
		mse += (a[i + 2] - b[i + 2]) ** 2;
		samples += 3;
	}
	if (samples === 0) return Infinity;
	mse /= samples;
	if (mse === 0) return Infinity;
	return 10 * Math.log10((255 * 255) / mse);
}

export function computeAlphaPsnr(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
	if (a.length !== b.length) return 0;
	if (a.length % 4 !== 0) return NaN;
	let mse = 0;
	let samples = 0;
	for (let i = 3; i < a.length; i += 4) {
		// Fully transparent pixels are invisible no matter what alpha the
		// decoder wrote back, mirroring computePsnr which skips their colors.
		if (a[i] === 0) continue;
		mse += (a[i] - b[i]) ** 2;
		samples += 1;
	}
	if (samples === 0) return Infinity;
	mse /= samples;
	if (mse === 0) return Infinity;
	return 10 * Math.log10((255 * 255) / mse);
}

// Overall quality score: the worse of the RGB and alpha channels.
export function combinedPsnr(reference: Uint8ClampedArray, data: Uint8ClampedArray): number {
	return Math.min(computePsnr(reference, data), computeAlphaPsnr(reference, data));
}

export function scanHasAlpha(data: Uint8ClampedArray): boolean {
	return anyAlphaMatch(data, (a) => a < 255);
}

// Whether at least one pixel has a non-zero alpha channel, i.e. any visible
// content at all. A frame with no visible pixels has no signal for PSNR to
// measure.
export function anyVisiblePixel(data: Uint8ClampedArray): boolean {
	return anyAlphaMatch(data, (a) => a !== 0);
}

/**
 * Reports whether the candidate image materializes visible pixels where the
 * reference had none. PSNR helpers skip fully transparent reference pixels by
 * design, so callers use this alongside the score to catch stages that bleed
 * opaque content into transparent regions.
 */
export function hasNewlyVisiblePixels(reference: Uint8ClampedArray, data: Uint8ClampedArray): boolean {
	for (let i = 3; i < reference.length && i < data.length; i += 4) {
		if (reference[i] === 0 && data[i] !== 0) return true;
	}
	return false;
}

function anyAlphaMatch(data: Uint8ClampedArray, matches: (alpha: number) => boolean): boolean {
	for (let i = 3; i < data.length; i += 4) {
		if (matches(data[i])) return true;
	}
	return false;
}
