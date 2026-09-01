// ---------------------------------------------------------------------------
// Shared types
//
// Structural image buffers (Bitmap) exist so the pixel pipelines can be
// exercised outside a browser: every function here only touches width,
// height and data, and real canvas ImageData values satisfy the shape.
// ---------------------------------------------------------------------------

export interface Bitmap {
	width: number;
	height: number;
	data: Uint8ClampedArray;
}

export interface SynthidPreset {
	elasticAlpha: number;
	elasticSigma: number;
	rotationJitter: number;
	squeezeFactor: number;
	colorAmount: number;
	lumaNoise: number;
	reencodeRounds: number;
	reencodeQuality: number;
	bilateral: boolean;
	psnrFloor: number;
}

export interface SynthidOptions extends SynthidPreset {
	enabled: boolean;
}

// Per-tile displacement plan. The integer offsets are the control values of
// one continuous field: each tile's interpolation weight peaks at the tile's
// center, so its offset dominates the cell center and blends across the
// feather band into its neighbours' offsets. The image bends like an elastic
// sheet instead of stepping at tile borders.
export interface TileShiftState {
	// Square tile edge length in pixels.
	tileSize: number;
	// Width of the offset blend ramp straddling tile borders.
	feather: number;
	// Tile grid dimensions.
	cols: number;
	rows: number;
	// Per-tile integer offsets, row-major, length cols * rows.
	offsetsX: Int16Array;
	offsetsY: Int16Array;
}

export interface AffineParams {
	rot: number;
	// Sampling multiplier for the rotation inverse map: the content is
	// magnified by its reciprocal, the smallest zoom under which the rotated
	// frame still covers the canvas (edges crop, no corner gaps).
	sampleScale: number;
	tx: number;
	ty: number;
}

export interface ColorShift {
	m: number[];
	offset: number[];
}

// Random attack parameters generated once per media file so distortion is
// consistent across every frame of an animated GIF, and shared by the static
// image pipeline for the same purpose.
export interface SynthidRandomState {
	tileShift: TileShiftState | null;
	affine: AffineParams | null;
	color: ColorShift | null;
	// Seed for the per-pixel luma noise generator. Noise draws from a generator
	// built from this seed on every use, so every frame of one file gets the
	// identical pattern (no flicker) while files still differ from each other.
	noiseSeed: number;
}

// Controls which inputs get the SynthID attack:
// 'detected-no-video' runs it only on still images the detector flags;
// 'detected' adds all videos (the detector does not cover video); 'all'
// runs it on every input regardless of detection.
export type SynthidScope = 'detected-no-video' | 'detected' | 'all';

export interface ProcessingOptions {
	clearLsb: boolean;
	randomizeLsb: boolean;
	applyBlur: boolean;
	blurRadius: number;
	jpegRecompress: boolean;
	jpegQuality: number;
	synthid: SynthidOptions;
	synthidScope: SynthidScope;
	outputFormats: Record<string, string>;
	filenameMode: 'suffix' | 'prefix' | 'hash';
	outputSuffix: string;
	outputPrefix: string;
	prefixStartIndex: number;
	hashLength: 16 | 32 | 'full';
}

export type HashLength = ProcessingOptions['hashLength'];

export interface FrameSize {
	width: number;
	height: number;
}

export interface VideoOutputProfile {
	mime: string;
	videoCodec: string;
	audioCodec: string;
	videoArgs: string[];
}

export interface ProcessingOutput {
	blob: Blob;
	warnings: string[];
	synthidCheck?: SynthidCheckResult;
	// Hash of the output blob when the processing path computed one for its
	// own checks, so the caller can reuse it instead of hashing again.
	outputHash?: string;
}

// Input and output SynthID verdicts for one processed file, when the media
// type supports the statistical detector (still images and animated GIFs).
export interface SynthidCheckResult {
	input: SynthidDetection;
	output: SynthidDetection | null;
}

export interface SynthidDetection {
	isWatermarked: boolean;
	confidence: number;
	phaseMatch: number;
	profileKey: string;
	exactMatch: boolean;
	// True when the verdict is trustworthy enough for callers to act on.
	// Native matches and the loose closest-profile fallback are trusted; a
	// clean scaled match is trusted while the input still carries the
	// profile's carriers. Only a clean match too small to carry them cannot be
	// vouched for, and callers must report it as inconclusive rather than
	// detected or clean.
	conclusive: boolean;
}
