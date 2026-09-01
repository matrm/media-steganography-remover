import type { HashLength, ProcessingOptions, VideoOutputProfile } from './types';

// Single source of truth for filename-extension handling. A Map (rather than
// a plain object) avoids prototype-chain surprises for odd names like
// "file.__proto__" or "file.constructor".
const EXTENSION_TO_MIME = new Map<string, string>([
	['png', 'image/png'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['webp', 'image/webp'],
	['gif', 'image/gif'],
	['bmp', 'image/bmp'],
	['mp4', 'video/mp4'],
	['webm', 'video/webm'],
	['mov', 'video/quicktime'],
	['avi', 'video/x-msvideo'],
	['mkv', 'video/x-matroska'],
	['ogg', 'video/ogg'],
]);

const SUPPORTED_IMAGE_TYPES = new Set([
	...[...EXTENSION_TO_MIME.values()].filter((mime) => mime.startsWith('image/')),
	'image/jpg',
	'image/x-windows-bmp',
]);

const SUPPORTED_VIDEO_TYPES = new Set(
	[...EXTENSION_TO_MIME.values()].filter((mime) => mime.startsWith('video/'))
);

export function generateId(): string {
	// Math.random() === 0 stringifies to "0" with no fractional digits, so
	// pad the short half instead of emitting a trailing dash that fails the
	// id pattern.
	const randomHalf = Math.random().toString(36).slice(2, 11).padEnd(9, '0').slice(0, 9);
	return `${Date.now().toString(36)}-${randomHalf}`;
}

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	// Clamp to 0 as well: bytes below 1 would otherwise index units[-1].
	const i = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export function getExtensionFromMime(mime: string): string {
	switch (mime) {
		case 'image/png':
			return 'png';
		case 'image/jpeg':
		case 'image/jpg':
			return 'jpg';
		case 'image/webp':
			return 'webp';
		case 'image/gif':
			return 'gif';
		case 'image/bmp':
		case 'image/x-windows-bmp':
			return 'bmp';
		case 'video/webm':
			return 'webm';
		case 'video/mp4':
			return 'mp4';
		default:
			return mime.startsWith('video/') ? 'mp4' : 'png';
	}
}

export function getMimeFromExtension(ext: string): string {
	return EXTENSION_TO_MIME.get(ext.toLowerCase()) ?? 'image/png';
}

// MIME mapped from a file name's extension, or undefined when unlisted.
function getFilenameMime(fileName: string): string | undefined {
	return EXTENSION_TO_MIME.get(getFileExtension(fileName));
}

// Extension without the dot, lowercased, or '' when the name has none. Shared
// by every filename parser so dotless, trailing-dot, or uppercase names behave
// identically.
export function getFileExtension(fileName: string): string {
	const dotIndex = fileName.lastIndexOf('.');
	if (dotIndex <= 0 || dotIndex === fileName.length - 1) return '';
	return fileName.slice(dotIndex + 1).toLowerCase();
}

export function isVideoFile(file: File): boolean {
	const type = file.type ?? '';
	if (type.startsWith('video/') || SUPPORTED_VIDEO_TYPES.has(type)) {
		return true;
	}
	// Some platforms report an empty type for containers like .mkv; fall back
	// to the extension only when the type says nothing at all.
	if (type === '') {
		return (getFilenameMime(file.name) ?? '').startsWith('video/');
	}
	return false;
}

// Whether the file can enter the processing queue: allowlisted image/video
// MIME types, plus extension-allowlisted files whose type is empty. Generic
// image/* or video/* types outside the allowlist (e.g. HEIC, SVG) are rejected
// here so they fail fast with guidance instead of a generic decode error.
export function isSupportedFile(file: File): boolean {
	const type = file.type ?? '';
	if (SUPPORTED_IMAGE_TYPES.has(type) || SUPPORTED_VIDEO_TYPES.has(type)) {
		return true;
	}
	if (type !== '') return false;
	return getFilenameMime(file.name) !== undefined;
}

export function detectInputMime(file: File): string {
	const type = file.type ?? '';
	if (type.startsWith('video/')) {
		return type;
	}
	if (SUPPORTED_IMAGE_TYPES.has(type)) {
		return type === 'image/jpg' ? 'image/jpeg' : type;
	}
	return getMimeFromExtension(getFileExtension(file.name));
}

// libx264 + AAC is the most memory-efficient and compatible combo in this
// FFmpeg.wasm build. VP8/VP9 encoding exhausts WASM memory at 1080p.
export const VIDEO_OUTPUT_PROFILE: VideoOutputProfile = {
	mime: 'video/mp4',
	videoCodec: 'libx264',
	audioCodec: 'aac',
	videoArgs: ['-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p'],
};
Object.freeze(VIDEO_OUTPUT_PROFILE.videoArgs);
Object.freeze(VIDEO_OUTPUT_PROFILE);

export function getOutputMime(inputMime: string, options: ProcessingOptions): string {
	if (inputMime.startsWith('video/')) {
		return VIDEO_OUTPUT_PROFILE.mime;
	}
	if (options.jpegRecompress && inputMime !== 'image/gif') {
		return 'image/jpeg';
	}
	const ext = getExtensionFromMime(inputMime);
	const extFormat = options.outputFormats[ext];
	if (extFormat !== undefined && extFormat !== 'auto') {
		return extFormat;
	}
	if (inputMime === 'image/gif') {
		return 'image/gif';
	}
	if (['image/png', 'image/jpeg', 'image/jpg', 'image/webp'].includes(inputMime)) {
		return inputMime === 'image/jpg' ? 'image/jpeg' : inputMime;
	}
	return 'image/png';
}

// Whether an input/output MIME pair routes through the FFmpeg video path.
// Lives here (rather than beside its callers) so the batch progress label
// and the per-file router cannot drift apart again.
export function routesToVideo(inputMime: string, outputMime: string): boolean {
	return inputMime.startsWith('video/')
		|| (inputMime === 'image/gif' && outputMime.startsWith('video/'));
}

export function formatHash(hash: string, length: HashLength): string {
	return length === 'full' ? hash : hash.slice(0, length);
}

export function getHashLength(value: string): HashLength {
	if (value === 'full') return 'full';
	if (value === '16') return 16;
	if (value === '32') return 32;
	return 32;
}

export function cleanedFileName(
	originalName: string,
	outputMime: string,
	options: ProcessingOptions,
	index: number,
	outputHash: string
): string {
	const ext = getExtensionFromMime(outputMime);
	const mode = options.filenameMode;

	if (mode === 'hash') {
		return `${formatHash(outputHash, options.hashLength)}.${ext}`;
	}

	if (mode === 'prefix') {
		const prefix = options.outputPrefix.trim() || 'file';
		const num = options.prefixStartIndex + index;
		return `${prefix}${num}.${ext}`;
	}

	const suffix = options.outputSuffix.trim() || '-clean';
	const stripped = originalName.replace(/\.+$/, '').replace(/\.[^.]+$/, '');
	const base = stripped === '' ? 'file' : stripped;
	return `${base}${suffix}.${ext}`;
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

// Numeric inputs fall back to safe defaults when the value cannot be parsed,
// so a malformed field never reaches the pixel pipelines as NaN. Parsing is
// strict: trailing garbage ("123abc") is rejected instead of inheriting
// parseFloat/parseInt prefix semantics.
export function parseNumber(value: string, fallback: number): number {
	if (value.trim() === '') return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseInteger(value: string, fallback: number): number {
	if (value.trim() === '') return fallback;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.trunc(parsed);
}

// Bounds a parsed option into [min, max], falling back when the value is not
// finite. Used for tampered or programmatic inputs that bypass the range
// sliders in the UI.
export function clampNumber(value: number, min: number, max: number, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

export function yieldToBrowser(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

// Deterministic per-file generator (mulberry32) so stages that need randomness
// stay consistent across frames of one file instead of flickering, while still
// varying between files through the seed drawn at state build time.
export function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
	return new Promise((resolve, reject) => {
		canvas.toBlob(
			(blob) => {
				if (blob) resolve(blob);
				else reject(new Error(`Canvas export failed for ${mime}`));
			},
			mime,
			quality
		);
	});
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// Prefix marking the non-crypto fingerprint returned when crypto.subtle is
// unavailable, so it is never mistaken for a real SHA-256 digest.
const FALLBACK_HASH_PREFIX = 'fnv1a-';

// Whether a digest came from the fallback rather than SHA-256. The fingerprint
// is not cryptographic, so callers that key correctness-critical state by hash
// (e.g. the SynthID verdict cache) must not treat these digests as unique.
export function isFallbackHash(hash: string): boolean {
	return hash.startsWith(FALLBACK_HASH_PREFIX);
}

export async function computeSha256(blob: Blob): Promise<string> {
	const buffer = await blob.arrayBuffer();
	// crypto.subtle is unavailable outside secure contexts (plain HTTP, some
	// embedded webviews). Fall back to a local FNV-1a fingerprint. Both sides
	// of the identical-output check use this same function, so the comparison
	// still works under the fallback.
	if (typeof crypto === 'undefined' || !crypto.subtle) {
		return `${FALLBACK_HASH_PREFIX}${fingerprintHex(new Uint8Array(buffer))}`;
	}
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return arrayBufferToHex(digest);
}

// 64-bit local fingerprint built from two 32-bit passes (FNV-1a plus FNV-1
// with a different basis), because the identical-output check compares hashes:
// a single 32-bit digest's collision odds are small but the consequence is a
// false "no change" verdict. Still not a substitute for SHA-256.
function fingerprintHex(bytes: Uint8Array): string {
	let forward = 0x811c9dc5;
	let reverse = 0x9e3779b9;
	for (const byte of bytes) {
		forward ^= byte;
		forward = Math.imul(forward, 0x01000193);
		reverse = Math.imul(reverse, 0x01000193);
		reverse ^= byte;
	}
	const high = (forward >>> 0).toString(16).padStart(8, '0');
	const low = (reverse >>> 0).toString(16).padStart(8, '0');
	return `${high}${low}`;
}
