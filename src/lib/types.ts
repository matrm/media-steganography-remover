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

export interface DistortPreset {
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

export interface DistortOptions extends DistortPreset {
	enabled: boolean;
	// Grid the luma-noise control steps on. Carried in the snapshot rather than
	// read from the control at use time so processing stays independent of the
	// DOM and advice about the setting cannot drift from the value applied.
	lumaNoiseStep: number;
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
export interface DistortRandomState {
	tileShift: TileShiftState | null;
	affine: AffineParams | null;
	color: ColorShift | null;
	// Seed for the per-pixel luma noise generator. Noise draws from a generator
	// built from this seed on every use, so every frame of one file gets the
	// identical pattern (no flicker) while files still differ from each other.
	noiseSeed: number;
}

export interface ProcessingOptions {
	clearLsb: boolean;
	randomizeLsb: boolean;
	applyBlur: boolean;
	blurRadius: number;
	jpegRecompress: boolean;
	jpegQuality: number;
	distort: DistortOptions;
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
	// Hash of the output blob when the processing path computed one for its
	// own checks, so the caller can reuse it instead of hashing again.
	outputHash?: string;
}
