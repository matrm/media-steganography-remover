import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { GifReader, GifWriter } from 'omggif';
import JSZip from 'jszip';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProcessingOptions {
	clearLsb: boolean;
	randomizeLsb: boolean;
	applyBlur: boolean;
	blurRadius: number;
	jpegRecompress: boolean;
	jpegQuality: number;
	outputFormats: Record<string, string>;
	filenameMode: 'suffix' | 'prefix' | 'hash';
	outputSuffix: string;
	outputPrefix: string;
	prefixStartIndex: number;
	hashLength: 16 | 32 | 'full';
}

type HashLength = ProcessingOptions['hashLength'];

interface QueuedFile {
	id: string;
	file: File;
	objectUrl: string;
}

interface ProcessedFile {
	id: string;
	originalName: string;
	cleanedName: string;
	originalSize: number;
	cleanedSize: number;
	inputHash: string;
	outputHash: string;
	blob: Blob;
	objectUrl: string;
	success: boolean;
	error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUPPORTED_IMAGE_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/jpg',
	'image/webp',
	'image/gif',
	'image/bmp',
	'image/x-windows-bmp',
]);

const SUPPORTED_VIDEO_TYPES = new Set([
	'video/mp4',
	'video/webm',
	'video/ogg',
	'video/quicktime',
	'video/x-msvideo',
	'video/x-matroska',
]);

const GIF_MIME = 'image/gif';
const VIDEO_MIME = 'video/mp4';
const GRID_COLUMNS = 4;
const PAGE_ROWS = 4;
const PAGE_SIZE = GRID_COLUMNS * PAGE_ROWS;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const dropZone = document.getElementById('drop-zone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const fileListSection = document.getElementById('file-list-section') as HTMLElement;
const fileList = document.getElementById('file-list') as HTMLElement;
const fileCount = document.getElementById('file-count') as HTMLElement;
const optionsSection = document.getElementById('options-section') as HTMLElement;
const clearLsbInput = document.getElementById('clear-lsb') as HTMLInputElement;
const randomizeLsbInput = document.getElementById('randomize-lsb') as HTMLInputElement;
const applyBlurInput = document.getElementById('apply-blur') as HTMLInputElement;
const jpegRecompressInput = document.getElementById('jpeg-recompress') as HTMLInputElement;
const blurRadiusInput = document.getElementById('blur-radius') as HTMLInputElement;
const blurRadiusValue = document.getElementById('blur-radius-value') as HTMLElement;
const jpegQualityInput = document.getElementById('jpeg-quality') as HTMLInputElement;
const jpegQualityValue = document.getElementById('jpeg-quality-value') as HTMLElement;
const outputFormatRows = document.getElementById('output-format-rows') as HTMLElement;
const outputFormatsGroup = document.getElementById('output-formats-group') as HTMLElement;
const filenameModeGroup = document.getElementById('filename-mode-group') as HTMLElement;
const outputSuffixInput = document.getElementById('output-suffix') as HTMLInputElement;
const outputPrefixInput = document.getElementById('output-prefix') as HTMLInputElement;
const prefixStartIndexInput = document.getElementById('prefix-start-index') as HTMLInputElement;
const suffixPanel = document.getElementById('suffix-panel') as HTMLElement;
const prefixPanel = document.getElementById('prefix-panel') as HTMLElement;
const hashPanel = document.getElementById('hash-panel') as HTMLElement;
const processAllBtn = document.getElementById('process-all') as HTMLButtonElement;
const downloadAllBtn = document.getElementById('download-all') as HTMLButtonElement;
const clearAllBtn = document.getElementById('clear-all') as HTMLButtonElement;
const progressSection = document.getElementById('progress-section') as HTMLElement;
const progressFill = document.getElementById('progress-fill') as HTMLElement;
const progressText = document.getElementById('progress-text') as HTMLElement;
const resultsSection = document.getElementById('results-section') as HTMLElement;
const resultsList = document.getElementById('results-list') as HTMLElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let queuedFiles: QueuedFile[] = [];
let processedFiles: ProcessedFile[] = [];
let fileListPage = 0;
let resultsPage = 0;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function generateId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB'];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function getExtensionFromMime(mime: string): string {
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

function getMimeFromExtension(ext: string): string {
	switch (ext.toLowerCase()) {
		case 'png':
			return 'image/png';
		case 'jpg':
		case 'jpeg':
			return 'image/jpeg';
		case 'webp':
			return 'image/webp';
		case 'gif':
			return 'image/gif';
		case 'bmp':
			return 'image/bmp';
		case 'mp4':
			return 'video/mp4';
		case 'webm':
			return 'video/webm';
		case 'mov':
			return 'video/quicktime';
		case 'avi':
			return 'video/x-msvideo';
		case 'mkv':
			return 'video/x-matroska';
		case 'ogg':
			return 'video/ogg';
		default:
			return 'image/png';
	}
}

function isVideoFile(file: File): boolean {
	return file.type.startsWith('video/') || SUPPORTED_VIDEO_TYPES.has(file.type);
}

function detectInputMime(file: File): string {
	if (file.type.startsWith('video/')) {
		return file.type;
	}
	if (SUPPORTED_IMAGE_TYPES.has(file.type)) {
		return file.type === 'image/jpg' ? 'image/jpeg' : file.type;
	}
	const ext = file.name.split('.').pop() ?? '';
	return getMimeFromExtension(ext);
}

function getOutputMime(inputMime: string, options: ProcessingOptions): string {
	if (inputMime.startsWith('video/')) {
		return getVideoOutputProfile(inputMime).mime;
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
	if (['image/png', 'image/jpeg', 'image/webp'].includes(inputMime)) {
		return inputMime;
	}
	return 'image/png';
}

function formatHash(hash: string, length: HashLength): string {
	return length === 'full' ? hash : hash.slice(0, length);
}

function cleanedFileName(
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
	const base = originalName.replace(/\.[^.]+$/, '');
	return `${base}${suffix}.${ext}`;
}

function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(file);
	});
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error(`Failed to load image: ${file.name}`));
		img.src = URL.createObjectURL(file);
	});
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
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

function copyImageData(source: ImageData): ImageData {
	const copy = new ImageData(source.width, source.height);
	copy.data.set(source.data);
	return copy;
}

// ---------------------------------------------------------------------------
// FFmpeg / video processing
// ---------------------------------------------------------------------------

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoading = false;

function getFFmpegBaseUrl(): string {
	// Use the current page URL as the base so worker/module URLs resolve
	// correctly even when the bundled script runs from a blob/data URL.
	return new URL('.', location.href).href;
}

async function fetchWithProgress(url: string, onProgress: (percent: number) => void): Promise<Blob> {
	const response = await fetch(url);
	const contentLength = Number(response.headers.get('Content-Length')) || 0;
	const reader = response.body!.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;

	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		received += value.length;
		if (contentLength) {
			onProgress(Math.round((received / contentLength) * 100));
		}
	}

	return new Blob(chunks as BlobPart[]);
}

async function getFFmpeg(onProgress?: (percent: number) => void): Promise<FFmpeg> {
	if (ffmpegInstance) return ffmpegInstance;
	if (ffmpegLoading) {
		while (ffmpegLoading) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		if (ffmpegInstance) return ffmpegInstance;
	}

	ffmpegLoading = true;
	try {
		const base = getFFmpegBaseUrl();
		const ffmpeg = new FFmpeg();

		const wasmUrl = `${base}ffmpeg/ffmpeg-core.wasm`;
		const wasmBlobUrl = onProgress
			? URL.createObjectURL(await fetchWithProgress(wasmUrl, onProgress))
			: wasmUrl;

		await ffmpeg.load({
			coreURL: `${base}ffmpeg/ffmpeg-core.js`,
			wasmURL: wasmBlobUrl,
			classWorkerURL: `${base}ffmpeg/worker.js`,
		});
		ffmpegInstance = ffmpeg;
		return ffmpeg;
	} finally {
		ffmpegLoading = false;
	}
}

interface VideoOutputProfile {
	mime: string;
	videoCodec: string;
	audioCodec: string;
	videoArgs: string[];
}

function getVideoOutputProfile(_inputMime: string): VideoOutputProfile {
	// libx264 + AAC is the most memory-efficient and compatible combo in this
	// FFmpeg.wasm build. VP8/VP9 encoding exhausts WASM memory at 1080p.
	return {
		mime: 'video/mp4',
		videoCodec: 'libx264',
		audioCodec: 'aac',
		videoArgs: ['-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p'],
	};
}

async function processVideo(file: File, options: ProcessingOptions, onStatus?: (phase: string, percent: number) => void): Promise<Blob> {
	const ffmpeg = await getFFmpeg((pct) => onStatus?.('download', pct));
	onStatus?.('convert', 0);
	const ext = file.name.split('.').pop() ?? 'mp4';
	const inputName = `input.${ext}`;

	const inputMime = detectInputMime(file);
	const profile = getVideoOutputProfile(inputMime);
	const outputExt = getExtensionFromMime(profile.mime);
	const outputName = `output.${outputExt}`;

	const inputData = new Uint8Array(await file.arrayBuffer());
	await ffmpeg.writeFile(inputName, inputData);

	const logLines: string[] = [];
	const onLog = ({ message }: { message: string }) => {
		logLines.push(message);
	};
	ffmpeg.on('log', onLog);

	try {
		const args: string[] = [
			'-i', inputName,
			'-map_metadata', '-1',
			'-threads', '1',
			'-c:v', profile.videoCodec,
			...profile.videoArgs,
			'-c:a', profile.audioCodec,
			'-b:a', '128k',
			'-y',
			outputName,
		];

		const exitCode = await ffmpeg.exec(args, 300000);
		if (exitCode !== 0) {
			const tail = logLines.slice(-20).join('\n');
			throw new Error(`FFmpeg exited with code ${exitCode}.\n${tail}`);
		}

		const outputData = await ffmpeg.readFile(outputName);
		await ffmpeg.deleteFile(inputName);
		await ffmpeg.deleteFile(outputName);

		const bytes = outputData instanceof Uint8Array
			? new Uint8Array(outputData)
			: new TextEncoder().encode(outputData as string);
		return new Blob([bytes], { type: profile.mime });
	} catch (err) {
		// Terminate the instance on failure so the next video gets a fresh load.
		try { ffmpeg.terminate(); } catch { /* ignore */ }
		ffmpegInstance = null;
		const tail = logLines.slice(-40).join('\n');
		throw new Error(`${err instanceof Error ? err.message : String(err)}\nFFmpeg log:\n${tail}`);
	} finally {
		ffmpeg.off('log', onLog);
	}
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	return Array.from(bytes)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function computeSha256(blob: Blob): Promise<string> {
	const buffer = await blob.arrayBuffer();
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return arrayBufferToHex(digest);
}

// ---------------------------------------------------------------------------
// Pixel processing
// ---------------------------------------------------------------------------

function clearLSBs(imageData: ImageData): void {
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		data[i] &= 0xfe; // R
		data[i + 1] &= 0xfe; // G
		data[i + 2] &= 0xfe; // B
	}
}

function randomizeLSBs(imageData: ImageData): void {
	const data = imageData.data;
	for (let i = 0; i < data.length; i += 4) {
		data[i] = (data[i] & 0xfe) | (Math.random() > 0.5 ? 1 : 0);
		data[i + 1] = (data[i + 1] & 0xfe) | (Math.random() > 0.5 ? 1 : 0);
		data[i + 2] = (data[i + 2] & 0xfe) | (Math.random() > 0.5 ? 1 : 0);
	}
}

function boxBlur(imageData: ImageData, radius: number): void {
	const kernelSize = Math.max(2, Math.round(radius * 2 + 1));
	const half = Math.floor(kernelSize / 2);
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
			let count = 0;

			for (let ky = -half; ky <= half; ky += 1) {
				const py = y + ky;
				if (py < 0 || py >= height) continue;
				for (let kx = -half; kx <= half; kx += 1) {
					const px = x + kx;
					if (px < 0 || px >= width) continue;
					const idx = (py * width + px) * 4;
					r += src[idx];
					g += src[idx + 1];
					b += src[idx + 2];
					a += src[idx + 3];
					count += 1;
				}
			}

			const idx = (y * width + x) * 4;
			dst[idx] = Math.round(r / count);
			dst[idx + 1] = Math.round(g / count);
			dst[idx + 2] = Math.round(b / count);
			dst[idx + 3] = Math.round(a / count);
		}
	}

	imageData.data.set(dst);
}

function applyPixelEffects(imageData: ImageData, options: ProcessingOptions): void {
	if (options.applyBlur && options.blurRadius > 0) {
		boxBlur(imageData, options.blurRadius);
	}
	if (options.clearLsb) {
		clearLSBs(imageData);
	} else if (options.randomizeLsb) {
		randomizeLSBs(imageData);
	}
}

// ---------------------------------------------------------------------------
// Static image processing
// ---------------------------------------------------------------------------

async function processStaticImage(file: File, options: ProcessingOptions): Promise<Blob> {
	const img = await loadImageFromFile(file);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('Could not create canvas context');

		ctx.drawImage(img, 0, 0);

		if (options.applyBlur || options.clearLsb || options.randomizeLsb) {
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
			applyPixelEffects(imageData, options);
			ctx.putImageData(imageData, 0, 0);
		}

		const inputMime = detectInputMime(file);
		const outputMime = getOutputMime(inputMime, options);
		const quality = outputMime === 'image/jpeg' ? options.jpegQuality / 100 : undefined;
		return await canvasToBlob(canvas, outputMime, quality);
	} finally {
		URL.revokeObjectURL(img.src);
	}
}

// ---------------------------------------------------------------------------
// GIF quantization
// ---------------------------------------------------------------------------

interface ColorBin {
	r: number;
	g: number;
	b: number;
	count: number;
}

class ColorBox {
	colors: ColorBin[];
	rMin: number;
	rMax: number;
	gMin: number;
	gMax: number;
	bMin: number;
	bMax: number;

	constructor(colors: ColorBin[]) {
		this.colors = colors;
		this.rMin = 255;
		this.rMax = 0;
		this.gMin = 255;
		this.gMax = 0;
		this.bMin = 255;
		this.bMax = 0;
		for (const c of colors) {
			if (c.r < this.rMin) this.rMin = c.r;
			if (c.r > this.rMax) this.rMax = c.r;
			if (c.g < this.gMin) this.gMin = c.g;
			if (c.g > this.gMax) this.gMax = c.g;
			if (c.b < this.bMin) this.bMin = c.b;
			if (c.b > this.bMax) this.bMax = c.b;
		}
	}

	longestRange(): number {
		return Math.max(this.rMax - this.rMin, this.gMax - this.gMin, this.bMax - this.bMin);
	}

	split(): [ColorBox, ColorBox] {
		const rRange = this.rMax - this.rMin;
		const gRange = this.gMax - this.gMin;
		const bRange = this.bMax - this.bMin;
		let axis: 'r' | 'g' | 'b' = 'r';
		if (gRange >= rRange && gRange >= bRange) axis = 'g';
		else if (bRange >= rRange && bRange >= gRange) axis = 'b';

		const sorted = [...this.colors].sort((a, b) => a[axis] - b[axis]);
		const mid = Math.floor(sorted.length / 2);
		return [new ColorBox(sorted.slice(0, mid)), new ColorBox(sorted.slice(mid))];
	}

	average(): ColorBin {
		let r = 0;
		let g = 0;
		let b = 0;
		let total = 0;
		for (const c of this.colors) {
			r += c.r * c.count;
			g += c.g * c.count;
			b += c.b * c.count;
			total += c.count;
		}
		if (total === 0) return { r: 0, g: 0, b: 0, count: 0 };
		return { r: Math.round(r / total), g: Math.round(g / total), b: Math.round(b / total), count: total };
	}
}

function medianCutQuantize(rgba: Uint8ClampedArray, maxColors: number): { palette: number[]; indices: Uint8Array; transparentIndex: number } {
	const colorMap = new Map<string, ColorBin>();
	let hasTransparent = false;

	for (let i = 0; i < rgba.length; i += 4) {
		const a = rgba[i + 3];
		if (a < 128) {
			hasTransparent = true;
			continue;
		}
		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];
		const key = `${r},${g},${b}`;
		const existing = colorMap.get(key);
		if (existing) {
			existing.count += 1;
		} else {
			colorMap.set(key, { r, g, b, count: 1 });
		}
	}

	const colors = Array.from(colorMap.values());
	const availableSlots = hasTransparent ? maxColors - 1 : maxColors;
	let paletteBins: ColorBin[];

	if (colors.length <= availableSlots) {
		paletteBins = colors;
	} else {
		let boxes = [new ColorBox(colors)];
		while (boxes.length < availableSlots && boxes.some((b) => b.longestRange() > 0)) {
			const boxToSplit = boxes.reduce((largest, box) =>
				box.longestRange() > largest.longestRange() ? box : largest
			);
			if (boxToSplit.longestRange() === 0) break;
			const [a, b] = boxToSplit.split();
			const idx = boxes.indexOf(boxToSplit);
			boxes.splice(idx, 1, a, b);
		}
		paletteBins = boxes.map((box) => box.average());
	}

	const transparentIndex = hasTransparent ? 0 : -1;
	const palette: number[] = [];
	if (hasTransparent) {
		palette.push(0);
	}
	for (const c of paletteBins) {
		palette.push((c.r << 16) | (c.g << 8) | c.b);
	}

	// Pad palette to a power of 2 (required by GIF format: 2, 4, 8, 16, 32, 64, 128, 256).
	let paletteSize = palette.length;
	const validSizes = [2, 4, 8, 16, 32, 64, 128, 256];
	const nextSize = validSizes.find((s) => s >= paletteSize) ?? 256;
	const fillColor = paletteSize > (hasTransparent ? 1 : 0) ? palette[hasTransparent ? 1 : 0] : 0;
	while (palette.length < nextSize) {
		palette.push(fillColor);
	}

	const indices = new Uint8Array(rgba.length / 4);
	for (let i = 0; i < rgba.length; i += 4) {
		const idx = i / 4;
		if (rgba[i + 3] < 128) {
			indices[idx] = 0;
			continue;
		}

		let bestIndex = hasTransparent ? 1 : 0;
		let bestDist = Infinity;
		const r = rgba[i];
		const g = rgba[i + 1];
		const b = rgba[i + 2];

		const start = hasTransparent ? 1 : 0;
		for (let p = start; p < palette.length; p += 1) {
			const pr = (palette[p] >> 16) & 0xff;
			const pg = (palette[p] >> 8) & 0xff;
			const pb = palette[p] & 0xff;
			const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
			if (dist < bestDist) {
				bestDist = dist;
				bestIndex = p;
			}
		}
		indices[idx] = bestIndex;
	}

	return { palette, indices, transparentIndex };
}

// ---------------------------------------------------------------------------
// Animated GIF processing
// ---------------------------------------------------------------------------

async function processAnimatedGif(file: File, options: ProcessingOptions): Promise<Blob> {
	const buffer = new Uint8Array(await readFileAsArrayBuffer(file));
	const reader = new GifReader(buffer);
	const width = reader.width;
	const height = reader.height;
	const frameCount = reader.numFrames();

	const frames: { indices: Uint8Array; palette: number[]; delay: number; transparentIndex: number }[] = [];

	// Canvas for compositing frames according to disposal.
	let canvas = new Uint8ClampedArray(width * height * 4);
	const background = new Uint8ClampedArray(width * height * 4).fill(0);

	for (let i = 0; i < frameCount; i += 1) {
		const info = reader.frameInfo(i);

		// Save state before drawing for disposal type 3.
		const beforeState = new Uint8ClampedArray(canvas);

		// Decode frame on top of current canvas.
		reader.decodeAndBlitFrameRGBA(i, canvas);

		// Process the composed full canvas.
		const imageData = new ImageData(new Uint8ClampedArray(canvas), width, height);
		applyPixelEffects(imageData, options);

		// Quantize the processed frame.
		const { palette, indices, transparentIndex } = medianCutQuantize(imageData.data, 256);
		frames.push({
			indices,
			palette,
			delay: info.delay,
			transparentIndex,
		});

		// Apply disposal for next frame.
		if (info.disposal === 2) {
			canvas = new Uint8ClampedArray(background);
		} else if (info.disposal === 3) {
			canvas = beforeState;
		}
		// disposal 0/1: leave canvas as-is
	}

	// Estimate buffer size and write GIF. Over-allocate to avoid overflow.
	const estimatedSize = width * height * frameCount * 4 + 1024 * frameCount + 1024;
	let gifBuffer = new Uint8Array(estimatedSize);
	const writer = new GifWriter(gifBuffer, width, height, { loop: reader.loopCount() ?? 0 });

	for (const frame of frames) {
		const opts: { palette: number[]; delay: number; transparent?: number } = {
			palette: frame.palette,
			delay: frame.delay,
		};
		if (frame.transparentIndex >= 0) {
			opts.transparent = frame.transparentIndex;
		}
		writer.addFrame(0, 0, width, height, frame.indices, opts);
	}

	writer.end();
	const endPos = writer.getOutputBufferPosition();
	const output = gifBuffer.slice(0, endPos);
	return new Blob([output], { type: GIF_MIME });
}

// ---------------------------------------------------------------------------
// File processing orchestration
// ---------------------------------------------------------------------------

async function processSingleFile(
	file: File,
	options: ProcessingOptions,
	index: number,
	onVideoStatus?: (phase: string, percent: number) => void
): Promise<ProcessedFile> {
	const id = generateId();
	const inputMime = detectInputMime(file);
	const outputMime = getOutputMime(inputMime, options);

	try {
		const inputHash = await computeSha256(file);

		let blob: Blob;
		if (inputMime.startsWith('video/')) {
			blob = await processVideo(file, options, onVideoStatus);
		} else if (inputMime === 'image/gif') {
			if (outputMime.startsWith('video/')) {
				blob = await processVideo(file, options, onVideoStatus);
			} else {
				blob = await processAnimatedGif(file, options);
			}
		} else {
			blob = await processStaticImage(file, options);
		}

		const outputHash = await computeSha256(blob);

		if (inputHash === outputHash) {
			return {
				id,
				originalName: file.name,
				cleanedName: cleanedFileName(file.name, outputMime, options, index, outputHash),
				originalSize: file.size,
				cleanedSize: blob.size,
				inputHash,
				outputHash,
				blob: new Blob(),
				objectUrl: '',
				success: false,
				error: 'Output is identical to input. No steganography was removed. Enable LSB clearing, blur, or JPEG re-compression.',
			};
		}

		return {
			id,
			originalName: file.name,
			cleanedName: cleanedFileName(file.name, outputMime, options, index, outputHash),
			originalSize: file.size,
			cleanedSize: blob.size,
			inputHash,
			outputHash,
			blob,
			objectUrl: URL.createObjectURL(blob),
			success: true,
		};
	} catch (err) {
		return {
			id,
			originalName: file.name,
			cleanedName: file.name,
			originalSize: file.size,
			cleanedSize: 0,
			inputHash: '',
			outputHash: '',
			blob: new Blob(),
			objectUrl: '',
			success: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function buildPagination(
	container: HTMLElement,
	currentPage: number,
	totalPages: number,
	onPageChange: (page: number) => void
): void {
	if (totalPages <= 1) return;

	const row = document.createElement('div');
	row.className = 'pagination';

	const makeBtn = (label: string, disabled: boolean, onClick: () => void) => {
		const btn = document.createElement('button');
		btn.className = 'pagination__btn';
		btn.type = 'button';
		btn.textContent = label;
		btn.disabled = disabled;
		btn.addEventListener('click', onClick);
		return btn;
	};

	row.append(
		makeBtn('First', currentPage === 0, () => onPageChange(0)),
		makeBtn('Prev', currentPage === 0, () => onPageChange(currentPage - 1))
	);

	const indicator = document.createElement('span');
	indicator.className = 'pagination__indicator';
	indicator.textContent = `Page ${currentPage + 1} of ${totalPages}`;
	row.append(indicator);

	row.append(
		makeBtn('Next', currentPage >= totalPages - 1, () => onPageChange(currentPage + 1)),
		makeBtn('Last', currentPage >= totalPages - 1, () => onPageChange(totalPages - 1))
	);

	container.append(row);
}

function getSelectedRadioValue(group: HTMLElement): string {
	const radio = group.querySelector('input[type="radio"]:checked') as HTMLInputElement | null;
	return radio?.value ?? '';
}

function getHashLength(value: string): HashLength {
	if (value === 'full' || value === '16' || value === '32') {
		return value as HashLength;
	}
	return 32;
}

function getOutputFormatsFromRows(): Record<string, string> {
	const map: Record<string, string> = {};
	const selects = outputFormatRows.querySelectorAll('select');
	for (const select of selects) {
		const ext = (select as HTMLSelectElement).dataset.ext;
		if (ext) map[ext] = (select as HTMLSelectElement).value;
	}
	return map;
}

function getProcessingOptions(): ProcessingOptions {
	const mode = getSelectedRadioValue(filenameModeGroup) as ProcessingOptions['filenameMode'];
	return {
		clearLsb: clearLsbInput.checked,
		randomizeLsb: randomizeLsbInput.checked,
		applyBlur: applyBlurInput.checked,
		blurRadius: parseFloat(blurRadiusInput.value),
		jpegRecompress: jpegRecompressInput.checked,
		jpegQuality: parseInt(jpegQualityInput.value, 10),
		outputFormats: getOutputFormatsFromRows(),
		filenameMode: mode || 'suffix',
		outputSuffix: outputSuffixInput.value.trim() || '-clean',
		outputPrefix: outputPrefixInput.value.trim() || 'file',
		prefixStartIndex: Math.max(0, parseInt(prefixStartIndexInput.value, 10) || 0),
		hashLength: getHashLength(getSelectedRadioValue(hashPanel)),
	};
}

function setProgress(percent: number, text: string): void {
	progressFill.style.width = `${percent}%`;
	progressFill.setAttribute('aria-valuenow', String(percent));
	progressText.textContent = text;
	progressSection.hidden = false;
}

function updateOutputFormatRows(): void {
	const uniqueExtensions = new Set<string>();
	for (const queued of queuedFiles) {
		const mime = detectInputMime(queued.file);
		const ext = getExtensionFromMime(mime);
		uniqueExtensions.add(ext);
	}

	outputFormatsGroup.hidden = uniqueExtensions.size === 0;
	outputFormatRows.innerHTML = '';

	const sortedExtensions = Array.from(uniqueExtensions).sort();
	const imageFormats = [
		{ value: 'auto', label: 'Auto (keep input format)' },
		{ value: 'image/png', label: 'PNG' },
		{ value: 'image/jpeg', label: 'JPEG' },
		{ value: 'image/webp', label: 'WebP' },
	];

	for (const ext of sortedExtensions) {
		const isGif = ext === 'gif';
		const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(ext);

		const control = document.createElement('div');
		control.className = 'control';

		const label = document.createElement('label');
		label.className = 'control__label';
		label.textContent = `.${ext} output format${isVideo ? ' (always MP4)' : ''}`;

		const select = document.createElement('select');
		select.dataset.ext = ext;

		if (isVideo) {
			const opt = document.createElement('option');
			opt.value = 'auto';
			opt.textContent = 'MP4 (default)';
			select.append(opt);
			select.disabled = true;
		} else {
			const formats = isGif
				? [...imageFormats, { value: 'image/gif', label: 'GIF' }, { value: 'video/mp4', label: 'MP4' }]
				: imageFormats;
			for (const fmt of formats) {
				const opt = document.createElement('option');
				opt.value = fmt.value;
				opt.textContent = fmt.label;
				select.append(opt);
			}
		}

		control.append(label, select);
		outputFormatRows.append(control);
	}

	updateJpegControls();
}

function updateFileList(): void {
	fileList.innerHTML = '';
	fileCount.textContent = String(queuedFiles.length);
	fileListSection.hidden = queuedFiles.length === 0;

	const oldPagination = fileListSection.querySelector('.pagination');
	if (oldPagination) oldPagination.remove();

	const totalPages = Math.max(1, Math.ceil(queuedFiles.length / PAGE_SIZE));
	fileListPage = Math.min(fileListPage, totalPages - 1);
	const startIndex = fileListPage * PAGE_SIZE;
	const displayFiles = queuedFiles.slice(startIndex, startIndex + PAGE_SIZE);

	for (const queued of displayFiles) {
		const li = document.createElement('li');
		li.className = 'file-item';

		const thumb = isVideoFile(queued.file)
			? document.createElement('video')
			: document.createElement('img');
		thumb.className = 'file-item__thumb';
		if (thumb instanceof HTMLVideoElement) {
			thumb.src = queued.objectUrl;
			thumb.muted = true;
			thumb.playsInline = true;
			thumb.preload = 'metadata';
		} else {
			thumb.src = queued.objectUrl;
			thumb.alt = '';
		}

		const info = document.createElement('div');
		info.className = 'file-item__info';

		const name = document.createElement('p');
		name.className = 'file-item__name';
		name.textContent = queued.file.name;

		const meta = document.createElement('p');
		meta.className = 'file-item__meta';
		meta.textContent = formatBytes(queued.file.size);

		info.append(name, meta);

		const remove = document.createElement('button');
		remove.className = 'file-item__remove';
		remove.type = 'button';
		remove.setAttribute('aria-label', `Remove ${queued.file.name}`);
		remove.textContent = '×';
		remove.addEventListener('click', () => removeFileFromQueue(queued.id));

		li.append(remove, thumb, info);
		fileList.append(li);
	}

	buildPagination(fileListSection, fileListPage, totalPages, (page) => {
		fileListPage = page;
		updateFileList();
	});

	processAllBtn.disabled = queuedFiles.length === 0;
	updateOutputFormatRows();
}

function removeFileFromQueue(id: string): void {
	const queued = queuedFiles.find((q) => q.id === id);
	if (queued) URL.revokeObjectURL(queued.objectUrl);
	queuedFiles = queuedFiles.filter((q) => q.id !== id);
	updateFileList();
}

function addFilesToQueue(files: FileList | null): void {
	if (!files) return;
	for (const file of files) {
		if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) continue;
		queuedFiles.push({
			id: generateId(),
			file,
			objectUrl: URL.createObjectURL(file),
		});
	}
	updateFileList();
}

function updateResults(): void {
	resultsList.innerHTML = '';
	resultsSection.hidden = processedFiles.length === 0;

	const oldPagination = resultsSection.querySelector('.pagination');
	if (oldPagination) oldPagination.remove();

	const totalPages = Math.max(1, Math.ceil(processedFiles.length / PAGE_SIZE));
	resultsPage = Math.min(resultsPage, totalPages - 1);
	const startIndex = resultsPage * PAGE_SIZE;
	const displayResults = processedFiles.slice(startIndex, startIndex + PAGE_SIZE);

	for (const result of displayResults) {
		const li = document.createElement('li');
		li.className = 'result-item';

		if (result.success) {
			const isVideo = result.cleanedName.endsWith('.webm') || result.cleanedName.endsWith('.mp4');
			const thumb = isVideo
				? document.createElement('video')
				: document.createElement('img');
			thumb.className = 'result-item__thumb';
			if (thumb instanceof HTMLVideoElement) {
				thumb.src = result.objectUrl;
				thumb.muted = true;
				thumb.playsInline = true;
				thumb.preload = 'metadata';
			} else {
				thumb.src = result.objectUrl;
				thumb.alt = '';
			}

			const info = document.createElement('div');
			info.className = 'result-item__info';

			const name = document.createElement('p');
			name.className = 'result-item__name';
			name.textContent = result.cleanedName;

			const meta = document.createElement('p');
			meta.className = 'result-item__meta';
			meta.textContent = `${formatBytes(result.originalSize)} → ${formatBytes(result.cleanedSize)}`;

			const hash = document.createElement('p');
			hash.className = 'result-item__hash';
			hash.textContent = `SHA-256: ${result.outputHash.slice(0, 16)}…`;
			hash.title = `Input: ${result.inputHash}\nOutput: ${result.outputHash}`;

			info.append(name, meta, hash);

			const download = document.createElement('button');
			download.className = 'result-item__download';
			download.type = 'button';
			download.textContent = 'Download';
			download.addEventListener('click', () => downloadBlob(result.blob, result.cleanedName));

			li.append(thumb, info, download);
		} else {
			const marker = document.createElement('div');
			marker.className = 'result-item__marker';
			marker.setAttribute('aria-hidden', 'true');
			marker.textContent = '!';

			const info = document.createElement('div');
			info.className = 'result-item__info';

			const name = document.createElement('p');
			name.className = 'result-item__name';
			name.textContent = result.cleanedName || result.originalName;

			const meta = document.createElement('p');
			meta.className = 'result-item__meta';
			meta.textContent = `Error: ${result.error ?? 'Unknown error'}`;

			if (result.inputHash && result.outputHash) {
				const hash = document.createElement('p');
				hash.className = 'result-item__hash';
				hash.textContent = `Hashes match. Input and output are identical.`;
				info.append(name, meta, hash);
			} else {
				info.append(name, meta);
			}

			const status = document.createElement('span');
			status.className = 'result-item__status result-item__status--error';
			status.textContent = 'Failed';

			li.append(marker, info, status);
		}

		resultsList.append(li);
	}

	buildPagination(resultsSection, resultsPage, totalPages, (page) => {
		resultsPage = page;
		updateResults();
	});

	downloadAllBtn.disabled = processedFiles.some((r) => r.success) === false;
}

function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
}

async function downloadAllAsZip(): Promise<void> {
	const zip = new JSZip();
	for (const result of processedFiles) {
		if (!result.success) continue;
		zip.file(result.cleanedName, result.blob);
	}
	const blob = await zip.generateAsync({ type: 'blob' });
	downloadBlob(blob, 'steganography-removed.zip');
}

async function processAllFiles(): Promise<void> {
	if (queuedFiles.length === 0) return;

	processAllBtn.disabled = true;
	processedFiles = [];
	resultsPage = 0;
	updateResults();

	const options = getProcessingOptions();
	const total = queuedFiles.length;

	for (let i = 0; i < total; i += 1) {
		const queued = queuedFiles[i];
		const isVideo = isVideoFile(queued.file);
		const base = (i / total) * 100;
		const range = 100 / total;

		setProgress(
			base,
			isVideo
				? `Loading FFmpeg.wasm for ${queued.file.name} (${i + 1}/${total})…`
				: `Processing ${queued.file.name} (${i + 1}/${total})…`
		);

		// Yield to the event loop to keep the UI responsive.
		await new Promise((resolve) => requestAnimationFrame(resolve));

		const result = await processSingleFile(queued.file, options, i, (phase, pct) => {
			if (phase === 'download') {
				setProgress(base + (range * pct / 100), `Downloading FFmpeg.wasm ${pct}% (${i + 1}/${total})…`);
			} else {
				setProgress(base + range * 0.9, `Converting with FFmpeg.wasm… (${i + 1}/${total})…`);
			}
		});
		processedFiles.push(result);
		setProgress(base + range, `Processed ${queued.file.name} (${i + 1}/${total})…`);
		updateResults();
	}

	setProgress(100, `Finished processing ${total} file${total === 1 ? '' : 's'}.`);
	processAllBtn.disabled = false;
}

function clearAll(): void {
	for (const queued of queuedFiles) {
		URL.revokeObjectURL(queued.objectUrl);
	}
	for (const result of processedFiles) {
		if (result.objectUrl) URL.revokeObjectURL(result.objectUrl);
	}
	queuedFiles = [];
	processedFiles = [];
	fileListPage = 0;
	resultsPage = 0;
	updateFileList();
	updateResults();
	progressSection.hidden = true;
	setProgress(0, 'Ready');
	fileInput.value = '';
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

['dragenter', 'dragover'].forEach((event) => {
	dropZone.addEventListener(event, (e) => {
		e.preventDefault();
		dropZone.classList.add('drop-zone--dragover');
	});
});

['dragleave', 'drop'].forEach((event) => {
	dropZone.addEventListener(event, (e) => {
		e.preventDefault();
		dropZone.classList.remove('drop-zone--dragover');
	});
});

dropZone.addEventListener('drop', (e) => {
	addFilesToQueue(e.dataTransfer?.files ?? null);
});

fileInput.addEventListener('change', () => {
	addFilesToQueue(fileInput.files);
	fileInput.value = '';
});

clearLsbInput.addEventListener('change', () => {
	if (clearLsbInput.checked) randomizeLsbInput.checked = false;
});

randomizeLsbInput.addEventListener('change', () => {
	if (randomizeLsbInput.checked) clearLsbInput.checked = false;
});

applyBlurInput.addEventListener('change', () => {
	blurRadiusInput.disabled = !applyBlurInput.checked;
});

blurRadiusInput.addEventListener('input', () => {
	blurRadiusValue.textContent = `${blurRadiusInput.value}px`;
});

jpegQualityInput.addEventListener('input', () => {
	jpegQualityValue.textContent = `${jpegQualityInput.value}%`;
});

function updateJpegControls(): void {
	const active = jpegRecompressInput.checked;
	const selects = outputFormatRows.querySelectorAll('select');
	for (const select of selects) {
		const s = select as HTMLSelectElement;
		if (s.dataset.ext === 'gif') continue;
		const isVideo = ['mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg'].includes(s.dataset.ext ?? '');
		if (isVideo) continue;
		if (active) {
			s.dataset.prevValue = s.value;
			s.value = 'image/jpeg';
			s.disabled = true;
		} else {
			s.disabled = false;
			if (s.dataset.prevValue) {
				s.value = s.dataset.prevValue;
				delete s.dataset.prevValue;
			}
		}
	}
	updateJpegQualityEnabled();
}

function updateJpegQualityEnabled(): void {
	const selects = outputFormatRows.querySelectorAll('select');
	const anyJpeg = Array.from(selects).some(
		(s) => (s as HTMLSelectElement).value === 'image/jpeg'
	);
	jpegQualityInput.disabled = !anyJpeg;
}

jpegRecompressInput.addEventListener('change', updateJpegControls);
outputFormatRows.addEventListener('change', updateJpegQualityEnabled);

function updateFilenamePanels(): void {
	const mode = getSelectedRadioValue(filenameModeGroup) as ProcessingOptions['filenameMode'];
	suffixPanel.hidden = mode !== 'suffix';
	prefixPanel.hidden = mode !== 'prefix';
	hashPanel.hidden = mode !== 'hash';
}

filenameModeGroup.addEventListener('change', updateFilenamePanels);

processAllBtn.addEventListener('click', () => processAllFiles());
downloadAllBtn.addEventListener('click', () => downloadAllAsZip());
clearAllBtn.addEventListener('click', () => clearAll());

// ---------------------------------------------------------------------------
// Preview generators
// ---------------------------------------------------------------------------

function createPreviewCanvas(size: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('Could not create preview context');
	return { canvas, ctx };
}

function drawSampleGradient(ctx: CanvasRenderingContext2D, size: number): void {
	const gradient = ctx.createLinearGradient(0, 0, size, size);
	gradient.addColorStop(0, '#ff5f6d');
	gradient.addColorStop(0.5, '#ffc371');
	gradient.addColorStop(1, '#2c3e50');
	ctx.fillStyle = gradient;
	ctx.fillRect(0, 0, size, size);
}

function buildPreviewPair(original: HTMLCanvasElement, processed: HTMLCanvasElement, labels: [string, string]): DocumentFragment {
	const frag = document.createDocumentFragment();

	const makeColumn = (canvas: HTMLCanvasElement, label: string) => {
		const col = document.createElement('div');
		col.style.display = 'flex';
		col.style.flexDirection = 'column';
		col.style.alignItems = 'center';
		col.style.gap = '0.25rem';

		const lbl = document.createElement('span');
		lbl.className = 'option__preview-label';
		lbl.textContent = label;
		col.append(canvas, lbl);
		return col;
	};

	frag.append(makeColumn(original, labels[0]), makeColumn(processed, labels[1]));
	return frag;
}

function renderOptionPreviews(): void {
	const size = 64;

	// Randomize LSBs preview.
	const lsbPreview = document.getElementById('randomize-lsb-preview');
	if (lsbPreview) {
		const { canvas: original, ctx: origCtx } = createPreviewCanvas(size);
		drawSampleGradient(origCtx, size);

		const { canvas: processed, ctx: procCtx } = createPreviewCanvas(size);
		procCtx.drawImage(original, 0, 0);
		const imageData = procCtx.getImageData(0, 0, size, size);
		randomizeLSBs(imageData);
		procCtx.putImageData(imageData, 0, 0);

		lsbPreview.append(buildPreviewPair(original, processed, ['Original', 'After']));
	}

	// Expand palette preview.
	const palettePreview = document.getElementById('expand-palette-preview');
	if (palettePreview) {
		const { canvas: original, ctx: origCtx } = createPreviewCanvas(size);
		// Draw a deliberately limited-palette image.
		origCtx.fillStyle = '#e74c3c';
		origCtx.fillRect(0, 0, size / 2, size / 2);
		origCtx.fillStyle = '#f1c40f';
		origCtx.fillRect(size / 2, 0, size / 2, size / 2);
		origCtx.fillStyle = '#2ecc71';
		origCtx.fillRect(0, size / 2, size / 2, size / 2);
		origCtx.fillStyle = '#3498db';
		origCtx.fillRect(size / 2, size / 2, size / 2, size / 2);

		const { canvas: processed, ctx: procCtx } = createPreviewCanvas(size);
		procCtx.drawImage(original, 0, 0);

		palettePreview.append(buildPreviewPair(original, processed, ['Indexed', 'Truecolor']));
	}
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

blurRadiusInput.disabled = !applyBlurInput.checked;
updateJpegControls();
updateFilenamePanels();
renderOptionPreviews();
setProgress(0, 'Ready');
