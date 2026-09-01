// ---------------------------------------------------------------------------
// Discrete Fourier transforms
//
// Supports arbitrary transform lengths: powers of two run through an
// iterative radix-2 Cooley-Tukey; every other length goes through Bluestein's
// chirp-z algorithm backed by the same radix-2 core. Bin indices must line up
// exactly with the codebook profiles, which use Gemini's native non-power-of-
// two resolutions, hence no padding tricks.
// ---------------------------------------------------------------------------

interface ChirpTable {
	cosDown: Float64Array;
	sinDown: Float64Array;
	cosUp: Float64Array;
	sinUp: Float64Array;
}

// Bluestein kernel stored already transformed, so it is built and FFT'd once
// per length instead of once per row/column call.
interface BluesteinKernel {
	m: number;
	bRe: Float64Array;
	bIm: Float64Array;
}

const chirpCache = new Map<number, ChirpTable>();
const bluesteinKernelCache = new Map<number, BluesteinKernel>();

function isPowerOfTwo(n: number): boolean {
	// Bitwise & truncates to 32 bits and misclassifies n >= 2^31, so compare
	// against the exact logarithm instead.
	return Number.isInteger(n) && n > 0 && Math.log2(n) % 1 === 0;
}

function nextPowerOfTwo(n: number): number {
	let m = 1;
	while (m < n) m *= 2;
	return m;
}

// Forward (sign = -1) unnormalized DFT; inverse (sign = +1) callers divide by
// length themselves.
function fftRadix2(re: Float64Array, im: Float64Array, n: number, sign: number): void {
	// Bit-reversal permutation.
	for (let i = 1, j = 0; i < n; i += 1) {
		let bit = n >> 1;
		for (; j & bit; bit >>= 1) j ^= bit;
		j ^= bit;
		if (i < j) {
			const tr = re[i]; re[i] = re[j]; re[j] = tr;
			const ti = im[i]; im[i] = im[j]; im[j] = ti;
		}
	}
	for (let len = 2; len <= n; len *= 2) {
		const angle = (sign * 2 * Math.PI) / len;
		const wRe = Math.cos(angle);
		const wIm = Math.sin(angle);
		for (let start = 0; start < n; start += len) {
			let curRe = 1;
			let curIm = 0;
			for (let k = start; k < start + len / 2; k += 1) {
				const evenRe = re[k];
				const evenIm = im[k];
				const oddRe = re[k + len / 2] * curRe - im[k + len / 2] * curIm;
				const oddIm = re[k + len / 2] * curIm + im[k + len / 2] * curRe;
				re[k] = evenRe + oddRe;
				im[k] = evenIm + oddIm;
				re[k + len / 2] = evenRe - oddRe;
				im[k + len / 2] = evenIm - oddIm;
				const nextRe = curRe * wRe - curIm * wIm;
				curIm = curRe * wIm + curIm * wRe;
				curRe = nextRe;
			}
		}
	}
}

function getChirp(n: number): ChirpTable {
	const cached = chirpCache.get(n);
	if (cached) return cached;
	const cosDown = new Float64Array(n);
	const sinDown = new Float64Array(n);
	const cosUp = new Float64Array(n);
	const sinUp = new Float64Array(n);
	for (let k = 0; k < n; k += 1) {
		// exp(-i*pi*k^2/n) and its conjugate partner exp(+i*pi*k^2/n).
		const angle = (Math.PI * ((k * k) % (2 * n))) / n;
		cosDown[k] = Math.cos(angle);
		sinDown[k] = -Math.sin(angle);
		cosUp[k] = Math.cos(angle);
		sinUp[k] = Math.sin(angle);
	}
	const table = { cosDown, sinDown, cosUp, sinUp };
	chirpCache.set(n, table);
	return table;
}

// The Bluestein kernel b[k] = chirpUp[k] (wrapped) and its forward FFT depend
// only on n, so cache the transformed result.
function getBluesteinKernel(n: number): BluesteinKernel {
	const cached = bluesteinKernelCache.get(n);
	if (cached) return cached;
	const m = nextPowerOfTwo(2 * n - 1);
	const chirp = getChirp(n);
	const bRe = new Float64Array(m);
	const bIm = new Float64Array(m);
	for (let k = 0; k < n; k += 1) {
		bRe[k] = chirp.cosUp[k];
		bIm[k] = chirp.sinUp[k];
		// Wrap the kernel so the circular convolution reproduces the linear
		// one over the [-(n-1), n-1] difference range.
		if (k > 0) {
			bRe[m - k] = chirp.cosUp[k];
			bIm[m - k] = chirp.sinUp[k];
		}
	}
	fftRadix2(bRe, bIm, m, -1);
	const kernel = { m, bRe, bIm };
	bluesteinKernelCache.set(n, kernel);
	return kernel;
}

function fft1dContiguous(re: Float64Array, im: Float64Array, n: number): void {
	if (isPowerOfTwo(n)) {
		fftRadix2(re, im, n, -1);
		return;
	}
	// Bluestein: X[k] = chirpDown[k] * sum_m (x[m]*chirpDown[m]) * chirpUp[k-m],
	// i.e. a circular convolution of size m >= 2n-1 computed with radix-2 FFTs.
	const chirp = getChirp(n);
	const kernel = getBluesteinKernel(n);
	const m = kernel.m;
	const aRe = new Float64Array(m);
	const aIm = new Float64Array(m);
	for (let k = 0; k < n; k += 1) {
		aRe[k] = re[k] * chirp.cosDown[k] - im[k] * chirp.sinDown[k];
		aIm[k] = re[k] * chirp.sinDown[k] + im[k] * chirp.cosDown[k];
	}
	fftRadix2(aRe, aIm, m, -1);
	for (let k = 0; k < m; k += 1) {
		const r = aRe[k] * kernel.bRe[k] - aIm[k] * kernel.bIm[k];
		aIm[k] = aRe[k] * kernel.bIm[k] + aIm[k] * kernel.bRe[k];
		aRe[k] = r;
	}
	// Inverse transform of size m, normalized inline.
	fftRadix2(aRe, aIm, m, 1);
	const inv = 1 / m;
	for (let k = 0; k < n; k += 1) {
		const cRe = aRe[k] * inv;
		const cIm = aIm[k] * inv;
		re[k] = cRe * chirp.cosDown[k] - cIm * chirp.sinDown[k];
		im[k] = cRe * chirp.sinDown[k] + cIm * chirp.cosDown[k];
	}
}

// In-place forward 2D DFT (numpy fft2 convention) of a row-major H x W
// complex plane. Buffers hold at least width * height entries; oversized
// shared planes are allowed and only the leading region is transformed.
export function fft2d(re: Float64Array, im: Float64Array, width: number, height: number): void {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new RangeError(`fft2d requires positive integer dimensions (got ${width}x${height})`);
	}
	if (re.length < width * height || im.length < width * height) {
		throw new RangeError(`fft2d buffers too small for ${width}x${height}: ${re.length}, ${im.length}`);
	}
	const rowRe = new Float64Array(width);
	const rowIm = new Float64Array(width);
	for (let y = 0; y < height; y += 1) {
		const offset = y * width;
		rowRe.set(re.subarray(offset, offset + width));
		rowIm.set(im.subarray(offset, offset + width));
		fft1dContiguous(rowRe, rowIm, width);
		re.set(rowRe, offset);
		im.set(rowIm, offset);
	}
	const colRe = new Float64Array(height);
	const colIm = new Float64Array(height);
	for (let x = 0; x < width; x += 1) {
		for (let y = 0; y < height; y += 1) {
			colRe[y] = re[y * width + x];
			colIm[y] = im[y * width + x];
		}
		fft1dContiguous(colRe, colIm, height);
		for (let y = 0; y < height; y += 1) {
			re[y * width + x] = colRe[y];
			im[y * width + x] = colIm[y];
		}
	}
}

// In-place inverse 2D DFT (numpy ifft2 convention, normalized by 1/(W*H)).
// Follows fft2d's shared-plane convention: trailing entries of an oversized
// buffer are left untouched.
export function ifft2d(re: Float64Array, im: Float64Array, width: number, height: number): void {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new RangeError(`ifft2d requires positive integer dimensions (got ${width}x${height})`);
	}
	const count = width * height;
	if (re.length < count || im.length < count) {
		throw new RangeError(`ifft2d buffers too small for ${width}x${height}: ${re.length}, ${im.length}`);
	}
	// ifft(x) = conj(fft(conj(x))) / n.
	for (let i = 0; i < count; i += 1) im[i] = -im[i];
	fft2d(re, im, width, height);
	const norm = 1 / count;
	for (let i = 0; i < count; i += 1) {
		re[i] *= norm;
		im[i] *= -norm;
	}
}

// Phase angle of a complex value, wrapped to (-pi, pi].
export function phaseOf(re: number, im: number): number {
	return Math.atan2(im, re);
}
