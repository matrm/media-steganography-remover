import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { GifReader, GifWriter } from 'omggif';
import JSZip from 'jszip';
import type {
	DistortPreset,
	FrameSize,
	ProcessingOptions,
	ProcessingOutput,
} from './lib/types';
import {
	cleanedFileName,
	clampNumber,
	detectInputMime,
	formatBytes,
	generateId,
	getExtensionFromMime,
	getFileExtension,
	getHashLength,
	getOutputMime,
	routesToVideo,
	VIDEO_OUTPUT_PROFILE,
	isContentDigest,
	isFallbackHash,
	isSupportedFile,
	isVideoFile,
	LARGE_INPUT_BYTES,
	parseInteger,
	parseNumber,
	readFileAsArrayBuffer,
	sha256HexFromBuffer,
	yieldToBrowser,
	computeSha256,
	createSeededRandom,
} from './lib/util';
import { applyBlurEffect, applyLsbEffect } from './lib/pixels';
import {
	GIF_DEFAULT_MAX_COLORS,
	applyPaletteLsb,
	getGifBackground,
	gifHasTransparency,
	medianCutQuantize,
	quantizeImageToPalette,
} from './lib/quantize';
import { applyGifFrameDisposal } from './lib/gif';
import {
	MAX_GIF_PIXELS,
	MAX_DISTORT_PIXELS,
	DISTORT_PRESETS,
	applyDistortStages,
	applyDistortPipeline,
	applyDistortSmoothingStage,
	buildDistortRandomState,
	buildDistortVideoFilters,
	encodeStaticImage,
	gifQualityToMaxColors,
	isSubLevelVideoNoise,
	subLevelVideoNoiseWarning,
} from './lib/distort';
import { hasSynthidDeclarationInBytes, hasSynthidManifest } from './lib/synthid-metadata';
import { createDeclarationCache } from './lib/declaration-cache';
import { scanHasAlpha } from './lib/metrics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueuedFile {
	id: string;
	file: File;
	objectUrl: string;
	// Content hash, computed once by the pre-flight pass (or by processing when
	// the pre-flight was skipped) and reused for the identical-output check.
	// Left unset for inputs too large to hash eagerly, since the pre-flight
	// does not need a digest and hashing one would read the whole file.
	inputHash?: string;
	// Pre-flight SynthID declaration for the file, read from its own metadata,
	// so the UI can offer the distortion option before the user processes it.
	// This is Google's declaration rather than a carrier measurement, so it is
	// named as such wherever it is shown.
	synthidDeclared?: boolean;
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
	warnings?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GIF_MIME = 'image/gif';
// Output extensions that always encode to MP4. Rows are keyed by
// getExtensionFromMime, which maps every video input onto mp4/webm, so no
// other video extension can appear here.
const VIDEO_FORMAT_EXTENSIONS: readonly string[] = Object.freeze(['mp4', 'webm']);
// Cap on the upfront GIF writer reservation so a huge animation fails cleanly
// instead of crashing the tab with a single massive allocation.
const MAX_GIF_OUTPUT_BYTES = 256 * 1024 * 1024;
const GRID_COLUMNS = 4;
const PAGE_ROWS = 4;
const PAGE_SIZE = GRID_COLUMNS * PAGE_ROWS;
// Upper bound on waiting for video metadata before giving up on dimension
// lookups that feed the distortion filter builder.
const VIDEO_METADATA_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const dropZone = document.getElementById('drop-zone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const fileListSection = document.getElementById('file-list-section') as HTMLElement;
// Every control in the options panel, so a batch can lock the whole set at once
// rather than each control deciding for itself. A disabled fieldset makes its
// descendants inert without overwriting the per-control disabled states the
// option logic maintains (blur radius, JPEG quality, forced output formats),
// which a blanket enable/disable pass would clobber.
const optionsLock = document.getElementById('options-lock') as HTMLFieldSetElement;
const fileList = document.getElementById('file-list') as HTMLElement;
const fileCount = document.getElementById('file-count') as HTMLElement;
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
const progressBar = document.getElementById('progress-bar') as HTMLElement;
const progressFill = document.getElementById('progress-fill') as HTMLElement;
const progressText = document.getElementById('progress-text') as HTMLElement;
const resultsSection = document.getElementById('results-section') as HTMLElement;
const resultsList = document.getElementById('results-list') as HTMLElement;
const distortAttackInput = document.getElementById('distort-attack') as HTMLInputElement;
const distortAdvancedToggle = document.getElementById('distort-advanced-toggle') as HTMLButtonElement;
const distortSettingsGroup = document.getElementById('distort-settings') as HTMLElement;
const distortPresetGroup = document.getElementById('distort-preset-group') as HTMLElement;
const distortElasticInput = document.getElementById('distort-elastic') as HTMLInputElement;
const distortElasticValue = document.getElementById('distort-elastic-value') as HTMLElement;
const distortSigmaInput = document.getElementById('distort-sigma') as HTMLInputElement;
const distortSigmaValue = document.getElementById('distort-sigma-value') as HTMLElement;
const distortRotationInput = document.getElementById('distort-rotation') as HTMLInputElement;
const distortRotationValue = document.getElementById('distort-rotation-value') as HTMLElement;
const distortSqueezeInput = document.getElementById('distort-squeeze') as HTMLInputElement;
const distortSqueezeValue = document.getElementById('distort-squeeze-value') as HTMLElement;
const distortColorInput = document.getElementById('distort-color') as HTMLInputElement;
const distortColorValue = document.getElementById('distort-color-value') as HTMLElement;
const distortNoiseInput = document.getElementById('distort-noise') as HTMLInputElement;
const distortNoiseValue = document.getElementById('distort-noise-value') as HTMLElement;
const distortRoundsInput = document.getElementById('distort-rounds') as HTMLInputElement;
const distortRoundsValue = document.getElementById('distort-rounds-value') as HTMLElement;
const distortQualityInput = document.getElementById('distort-quality') as HTMLInputElement;
const distortQualityValue = document.getElementById('distort-quality-value') as HTMLElement;
const distortPsnrFloorInput = document.getElementById('distort-psnr-floor') as HTMLInputElement;
const distortPsnrFloorValue = document.getElementById('distort-psnr-floor-value') as HTMLElement;
const distortBilateralInput = document.getElementById('distort-bilateral') as HTMLInputElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let queuedFiles: QueuedFile[] = [];
let processedFiles: ProcessedFile[] = [];
let fileListPage = 0;
let resultsPage = 0;
let distortAdvancedExpanded = false;
// Guards against queue mutation and re-entrant runs while batch processing is
// active, and against concurrent ZIP generations.
let isProcessing = false;
let isZipping = false;

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => {
			URL.revokeObjectURL(url);
			reject(new Error(`Unsupported or undecodable image: ${file.name} (${file.type || 'unknown type'}). Use PNG, JPEG, WebP, BMP, or GIF.`));
		};
		img.src = url;
	});
}

// ---------------------------------------------------------------------------
// FFmpeg / video processing
// ---------------------------------------------------------------------------

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadingPromise: Promise<FFmpeg> | null = null;

function getFFmpegBaseUrl(): string {
	// Use the current page URL as the base so worker/module URLs resolve
	// correctly even when the bundled script runs from a blob/data URL.
	return new URL('.', location.href).href;
}

async function fetchWithProgress(url: string, onProgress: (percent: number) => void): Promise<Blob> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
	}
	if (!response.body) {
		throw new Error(`Failed to download ${url}: the response has no body to read.`);
	}
	const contentLength = Number(response.headers.get('Content-Length')) || 0;
	const reader = response.body.getReader();
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

	return new Blob(chunks as BlobPart[], { type: 'application/wasm' });
}

async function getFFmpeg(onProgress?: (percent: number) => void): Promise<FFmpeg> {
	if (ffmpegInstance) return ffmpegInstance;
	if (ffmpegLoadingPromise) return ffmpegLoadingPromise;
	// Share the in-flight load so concurrent callers await one promise instead
	// of polling. Cleared after settling so a failure does not stick and the
	// next caller retries; success sticks via ffmpegInstance.
	ffmpegLoadingPromise = (async () => {
		const base = getFFmpegBaseUrl();
		const ffmpeg = new FFmpeg();

		const wasmUrl = `${base}ffmpeg/ffmpeg-core.wasm`;
		let wasmBlobUrl: string | null = null;

		try {
			if (onProgress !== undefined) {
				wasmBlobUrl = URL.createObjectURL(await fetchWithProgress(wasmUrl, onProgress));
			}
			await ffmpeg.load({
				coreURL: `${base}ffmpeg/ffmpeg-core.js`,
				wasmURL: wasmBlobUrl ?? wasmUrl,
				classWorkerURL: `${base}ffmpeg/worker.js`,
			});
		} catch (err) {
			try { ffmpeg.terminate(); } catch {}
			throw err;
		} finally {
			if (wasmBlobUrl !== null) URL.revokeObjectURL(wasmBlobUrl);
		}
		ffmpegInstance = ffmpeg;
		return ffmpeg;
	})();
	try {
		return await ffmpegLoadingPromise;
	} finally {
		ffmpegLoadingPromise = null;
	}
}

// Reads frame dimensions from video metadata so dimension-dependent filter
// parameters can be computed before encoding starts. Returns null when the
// browser cannot decode enough of the container to report a size.
async function getVideoFrameSize(file: File): Promise<FrameSize | null> {
	const url = URL.createObjectURL(file);
	const video = document.createElement('video');
	video.muted = true;
	video.preload = 'metadata';
	try {
		return await new Promise<FrameSize | null>((resolve) => {
			let settled = false;
			const timer = setTimeout(() => done(null), VIDEO_METADATA_TIMEOUT_MS);
			function done(value: FrameSize | null) {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				video.removeEventListener('loadedmetadata', onMeta);
				video.removeEventListener('error', onError);
				resolve(value);
			}
			const onMeta = () =>
				done(video.videoWidth > 0 && video.videoHeight > 0 ? { width: video.videoWidth, height: video.videoHeight } : null);
			const onError = () => done(null);
			video.addEventListener('loadedmetadata', onMeta);
			video.addEventListener('error', onError);
			video.src = url;
		});
	} finally {
		URL.revokeObjectURL(url);
	}
}

async function processVideo(
	file: File,
	options: ProcessingOptions,
	onStatus?: (phase: string, percent: number) => void,
	warnings: string[] = []
): Promise<ProcessingOutput> {
	const ffmpeg = await getFFmpeg((pct) => onStatus?.('download', pct));
	onStatus?.('convert', 0);
	// Extension hint for FFmpeg's demuxer. Already lowercased by getFileExtension.
	const rawExt = getFileExtension(file.name);
	const ext = /^[a-z0-9]+$/.test(rawExt) ? rawExt : 'mp4';
	const inputName = `input.${ext}`;

	const profile = VIDEO_OUTPUT_PROFILE;
	const outputExt = getExtensionFromMime(profile.mime);
	const outputName = `output.${outputExt}`;

	const inputMime = detectInputMime(file);

	const logLines: string[] = [];
	const onLog = ({ message }: { message: string }) => {
		logLines.push(message);
	};
	ffmpeg.on('log', onLog);
	const onProgress = ({ progress }: { progress: number; time: number }) => {
		const pct = progress <= 1 ? progress * 100 : progress;
		onStatus?.('convert', Math.max(0, Math.min(100, pct)));
	};
	ffmpeg.on('progress', onProgress);

	try {
		const inputData = new Uint8Array(await file.arrayBuffer());
		if (inputMime === GIF_MIME && gifHasTransparency(inputData)) {
			warnings.push('MP4 output discards transparency from the input image.');
		}
		// The video route never runs the still-image stages, so say which
		// checked options it cannot honor instead of leaving the checkboxes
		// to imply they applied. The static "images only" tags are ambiguous
		// for an image routed here as well.
		const skippedImageOptions = [
			options.clearLsb ? 'Clear LSBs' : '',
			options.randomizeLsb ? 'Randomize LSBs' : '',
			options.applyBlur && options.blurRadius > 0 ? 'Apply blur' : '',
			options.jpegRecompress ? 'JPEG re-compress' : '',
		].filter((name) => name !== '');
		if (skippedImageOptions.length > 0) {
			warnings.push(`Skipped for this video output (still images only): ${skippedImageOptions.join(', ')}.`);
		}
		await ffmpeg.writeFile(inputName, inputData);
		let distortFilters: string[] = [];
		// The FFmpeg approximations run on every input the distortion option is
		// enabled for. Nothing here measures the result, so there is no gate to
		// consult and nothing to report afterwards.
		const videoDistort = options.distort;
		if (videoDistort.enabled) {
			const frameSize = await getVideoFrameSize(file);
			if (frameSize === null && videoDistort.elasticAlpha >= 1) {
				warnings.push('The warp approximation was skipped because the video frame size could not be determined.');
			}
			distortFilters = buildDistortVideoFilters(videoDistort, frameSize, Math.random, warnings);
			if (isSubLevelVideoNoise(videoDistort.lumaNoise)) {
				warnings.push(subLevelVideoNoiseWarning(videoDistort.lumaNoiseStep));
			}
		}

		const buildArgs = (filters: string[]): string[] => {
			const args: string[] = [
				'-i', inputName,
				'-map_metadata', '-1',
				'-threads', '1',
				'-map', '0:v:0',
				'-map', '0:a?',
				'-sn',
				'-dn',
			];
			if (filters.length > 0) args.push('-vf', filters.join(','));
			args.push(
				'-c:v', profile.videoCodec,
				...profile.videoArgs,
				'-c:a', profile.audioCodec,
				'-b:a', '128k',
				'-y',
				outputName,
			);
			return args;
		};

		let exitCode = await ffmpeg.exec(buildArgs(distortFilters), 300000);
		if (exitCode !== 0 && distortFilters.length > 0) {
			// The distortion filter chain can fail on unusual inputs; retry with
			// metadata stripping only instead of failing the whole file.
			logLines.push('--- retrying without distortion filters ---');
			exitCode = await ffmpeg.exec(buildArgs([]), 300000);
			// A retry that fails as well throws below, so only a retry with
			// output may claim metadata stripping was applied.
			if (exitCode === 0) {
				warnings.push('The video distortion filter chain failed for this file. Metadata stripping was applied without the distortion stages.');
			}
		} else if (distortFilters.length > 0) {
			// Only describe the approximations when the chain actually ran, so
			// a chain that failed into the metadata-only fallback does not
			// also carry a note implying the distortion stages were applied.
			warnings.push('This video uses a simplified distortion filter chain. The re-encode rounds, re-encode quality, quality floor, and smoothing settings were skipped because they apply to still images only.');
		}
		if (exitCode !== 0) {
			const tail = logLines.slice(-20).join('\n');
			throw new Error(`FFmpeg exited with code ${exitCode}.\n${tail}`);
		}

		const outputData = await ffmpeg.readFile(outputName);
		await ffmpeg.deleteFile(inputName);
		await ffmpeg.deleteFile(outputName);

		if (!(outputData instanceof Uint8Array)) {
			throw new Error(`FFmpeg returned unexpected output for ${outputName}.`);
		}
		const bytes = new Uint8Array(outputData);
		return {
			blob: new Blob([bytes], { type: profile.mime }),
			warnings,
		};
	} catch (err) {
		// Terminate the instance on failure so the next video gets a fresh load.
		try { ffmpeg.terminate(); } catch { /* ignore */ }
		ffmpegInstance = null;
		const tail = logLines.slice(-40).join('\n');
		throw new Error(`${err instanceof Error ? err.message : String(err)}\nFFmpeg log:\n${tail}`);
	} finally {
		ffmpeg.off('log', onLog);
		ffmpeg.off('progress', onProgress);
	}
}

// Applies the LSB post-pass to the canvas itself, so the encoded bytes and the
// pixels the encode reads are the same buffer, including the randomize draw.
function applyCanvasLsbPass(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, options: ProcessingOptions): void {
	if (!options.clearLsb && !options.randomizeLsb) return;
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	applyLsbEffect(imageData, options);
	ctx.putImageData(imageData, 0, 0);
}

// ---------------------------------------------------------------------------
// Static image processing
// ---------------------------------------------------------------------------

async function processStaticImage(
	file: File,
	options: ProcessingOptions,
	warnings: string[] = []
): Promise<ProcessingOutput> {
	const img = await loadImageFromFile(file);
	let distort = options.distort;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('Could not create canvas context');

		ctx.drawImage(img, 0, 0);

		if (options.applyBlur && options.blurRadius > 0) {
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
			applyBlurEffect(imageData, options);
			ctx.putImageData(imageData, 0, 0);
		}

		// Oversized images skip the distortion entirely rather than failing; the
		// standard steganography options still run.
		if (distort.enabled && img.naturalWidth * img.naturalHeight > MAX_DISTORT_PIXELS) {
			warnings.push(`Media distortion was skipped because the image exceeds the ${MAX_DISTORT_PIXELS.toLocaleString()} pixel limit; other options were applied.`);
			distort = { ...distort, enabled: false };
		}

		const inputMime = detectInputMime(file);
		const outputMime = getOutputMime(inputMime, options);
		const quality = outputMime === 'image/jpeg' ? options.jpegQuality / 100 : undefined;

		if (distort.enabled) await applyDistortPipeline(canvas, distort, warnings);
		// The LSB pass always runs last, so the bytes that get encoded are the
		// distorted ones and the randomize draw is never overwritten by a stage
		// that ran after it.
		applyCanvasLsbPass(ctx, canvas, options);

		// Snapshot the canvas immediately before serialization. Like every
		// other gate under marginal semantics, the final encode is measured
		// against its own input rather than against some earlier stage's
		// result, so it cannot be blamed for cumulative drift and the user's
		// chosen quality is respected within a small bounded margin. It is
		// built only when the distortion pipeline is active, so its nullness
		// tracks distort.enabled exactly as encodeStaticImage expects. On the
		// JPEG path the same fresh buffer also drives the transparency
		// warning, avoiding a second full-canvas read. The alias stays valid
		// only because encodeStaticImage re-encodes without mutating the
		// canvas before reading it.
		let preEncode: Uint8ClampedArray | null = null;
		if (outputMime === 'image/jpeg') {
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			// Canvas JPEG encoding flattens transparency onto black, so warn
			// regardless of whether the distortion is enabled.
			if (scanHasAlpha(data)) {
				warnings.push('JPEG output discards transparency from the input image.');
			}
			if (distort.enabled) preEncode = data;
		} else if (distort.enabled) {
			preEncode = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		}
		const blob = await encodeStaticImage(canvas, outputMime, quality, distort, preEncode, warnings);
		// The caller needs this hash for the identical-output check, so compute
		// it once here rather than hashing again.
		const outputHash = await computeSha256(blob);

		return { blob, warnings, outputHash };
	} finally {
		URL.revokeObjectURL(img.src);
	}
}

// ---------------------------------------------------------------------------
// Animated GIF processing
// ---------------------------------------------------------------------------

function validateGifAllocation(width: number, height: number, frameCount: number): number {
	if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
		throw new Error('GIF has no frames to process. The file may be a header-only stub.');
	}
	if (![width, height].every((value) => Number.isSafeInteger(value) && value > 0)) {
		throw new Error('GIF dimensions are invalid. Use a valid GIF.');
	}
	const estimatedSize = width * height * frameCount * 4 + 1024 * frameCount + 1024;
	if (!Number.isSafeInteger(estimatedSize) || estimatedSize > MAX_GIF_OUTPUT_BYTES) {
		throw new Error(`GIF output would need about ${(estimatedSize / 1048576).toFixed(0)} MB, over the ${MAX_GIF_OUTPUT_BYTES / 1048576} MB limit; use a smaller GIF.`);
	}
	return estimatedSize;
}

async function processAnimatedGif(
	file: File,
	options: ProcessingOptions,
	warnings: string[] = []
): Promise<ProcessingOutput> {
	const buffer = new Uint8Array(await readFileAsArrayBuffer(file));
	const reader = new GifReader(buffer);
	const width = reader.width;
	const height = reader.height;
	const frameCount = reader.numFrames();
	const estimatedSize = validateGifAllocation(width, height, frameCount);
	let distort = options.distort;

	// Oversized GIFs skip the distortion entirely rather than failing; the
	// standard steganography options still run.
	if (distort.enabled && width * height * frameCount > MAX_GIF_PIXELS) {
		warnings.push(`Media distortion was skipped because the GIF exceeds the ${MAX_GIF_PIXELS.toLocaleString()} total frame pixel limit; other options were applied.`);
		distort = { ...distort, enabled: false };
	}

	const frames: { indices: Uint8Array; palette: number[]; delay: number; transparentIndex: number }[] = [];

	// Generate the random attack parameters once so all frames warp consistently.
	const distortState = distort.enabled ? buildDistortRandomState(width, height, distort) : null;
	// Same per-file draw policy for the palette LSB pass: every frame rebuilds
	// the generator from one seed, so identical palettes get identical low bits
	// instead of flickering between frames.
	const paletteLsbSeed = Math.floor(Math.random() * 4294967296);
	// Reduced palette depth acts as the GIF path's single simulated re-encode
	// round. Median-cut is idempotent at a fixed depth, so additional rounds
	// would not add loss; the configured round count therefore only switches
	// this one round on or off.
	const gifMaxColors = distortState !== null && distort.reencodeRounds > 0
		? gifQualityToMaxColors(distort.reencodeQuality)
		: GIF_DEFAULT_MAX_COLORS;
	if (distortState) {
		const gifSpatialWork = distortState.tileShift !== null
			|| distortState.affine !== null
			|| distortState.color !== null
			|| (Number.isFinite(distort.squeezeFactor) && distort.squeezeFactor > 0 && distort.squeezeFactor < 1)
			|| distort.lumaNoise > 0
			|| distort.bilateral;
		const gifNotes: string[] = [];
		if (gifSpatialWork) {
			gifNotes.push('every frame is distorted unconditionally to avoid flicker, and the quality floor (PSNR) is not applied to animated frames');
		}
		if (distort.reencodeRounds > 1) {
			gifNotes.push('re-encode rounds are capped at one: the reduced-palette quantization is idempotent, so extra rounds would not add further loss');
		}
		if (distort.reencodeRounds > 0 && gifMaxColors === GIF_DEFAULT_MAX_COLORS) {
			gifNotes.push('a re-encode quality of 100% keeps the full 256-color palette, so the re-encode round changes nothing unless the quality is lowered to actually reduce colors');
		}
		if (gifNotes.length > 0) {
			warnings.push(`For GIFs, ${gifNotes.join('. ')}.`);
		}
	}

	// Canvas for compositing frames according to disposal.
	const gifBackground = getGifBackground(buffer, width, height);
	let canvas: Uint8ClampedArray = new Uint8ClampedArray(gifBackground.pixels);
	const background = new Uint8ClampedArray(gifBackground.pixels);

	for (let i = 0; i < frameCount; i += 1) {
		await yieldToBrowser();
		const info = reader.frameInfo(i);

		// Save state before drawing for disposal type 3. Only that mode needs
		// the pre-draw buffer, so skip the full-frame copy for other frames.
		const beforeState = info.disposal === 3 ? new Uint8ClampedArray(canvas) : null;

		// Decode frame on top of current canvas.
		reader.decodeAndBlitFrameRGBA(i, canvas);

		// Process the composed full canvas. The distortion stages run
		// unconditionally on every frame: judging acceptance per frame would
		// make the structural stages flip on and off between neighboring
		// frames, which shows up as visible pulsing in the finished animation.
		// Palette reduction is intentionally left to the serialization pass
		// below, which runs the identical idempotent median-cut at the same
		// depth and reuses its mapping.
		const imageData = new ImageData(new Uint8ClampedArray(canvas), width, height);
		applyBlurEffect(imageData, options);
		if (distortState) {
			// The real warnings array is passed so a later switch to per-frame
			// gating surfaces floor skips instead of silently dropping them.
			await applyDistortStages(imageData, distortState, distort, false, warnings);
			await applyDistortSmoothingStage(imageData, distort, false, warnings);
		}

		// Quantization is the final GIF serialization step. It runs
		// unconditionally so every frame receives the same reduced palette
		// depth; a per-frame floor gate would make the color depth flicker
		// between neighboring frames. Median-cut is idempotent at a fixed
		// depth, so this single pass is the only reduced-palette round the GIF
		// path applies regardless of the configured re-encode round count.
		// When reduced, the computed mapping is reused verbatim during
		// serialization. The LSB pass runs on the palette below rather than on
		// the frame pixels above, because quantization replaces every color
		// and would otherwise overwrite the pass.
		const quantized = distortState && gifMaxColors < GIF_DEFAULT_MAX_COLORS
			? quantizeImageToPalette(imageData, gifMaxColors)
			: null;
		const { palette, indices, transparentIndex } = quantized
			?? medianCutQuantize(imageData.data, GIF_DEFAULT_MAX_COLORS);
		frames.push({
			indices,
			palette: applyPaletteLsb(palette, transparentIndex, options, createSeededRandom(paletteLsbSeed)),
			delay: info.delay,
			transparentIndex,
		});

		// Apply disposal for next frame. Disposal 2 restores only the frame's
		// rectangle, so content outside it survives into later frames; disposal
		// 3 restores the saved pre-frame state; 0/1 leave the canvas as-is.
		canvas = applyGifFrameDisposal(info, canvas, width, height, background, beforeState);
	}

	let gifBuffer: Uint8Array;
	try {
		gifBuffer = new Uint8Array(estimatedSize);
	} catch {
		throw new Error('GIF output is too large to encode in this browser. Use a smaller GIF.');
	}
	const loopCount = reader.loopCount();
	const writerOptions = loopCount === null ? {} : { loop: loopCount };
	if (gifBackground.color !== null) {
		Object.assign(writerOptions, { palette: [0, gifBackground.color], background: 1 });
	}
	const writer = new GifWriter(gifBuffer, width, height, writerOptions);

	for (const frame of frames) {
		// Frames are fully composed canvases, so every output frame is a
		// standalone full rect cleared to the background afterwards
		// (disposal 2). This intentionally normalizes rather than preserves
		// input disposal modes, keeping the writer simple with identical
		// visuals for opaque animations.
		const opts: { palette: number[]; delay: number; disposal: number; transparent?: number } = {
			palette: frame.palette,
			delay: frame.delay,
			disposal: 2,
		};
		if (frame.transparentIndex >= 0) {
			opts.transparent = frame.transparentIndex;
		}
		writer.addFrame(0, 0, width, height, frame.indices, opts);
	}

	writer.end();
	const endPos = writer.getOutputBufferPosition();
	const output = gifBuffer.slice(0, endPos);
	const blob = new Blob([output], { type: GIF_MIME });
	// Shared with the caller so the identical-output check does not rehash.
	const outputHash = await computeSha256(blob);

	return { blob, warnings, outputHash };
}

// ---------------------------------------------------------------------------
// File processing orchestration
// ---------------------------------------------------------------------------

async function processSingleFile(
	queued: QueuedFile,
	options: ProcessingOptions,
	index: number,
	onVideoStatus?: (phase: string, percent: number) => void
): Promise<ProcessedFile> {
	const file = queued.file;
	const id = generateId();
	const inputMime = detectInputMime(file);
	const outputMime = getOutputMime(inputMime, options);
	// Collects warnings as they are produced so a failure mid-pipeline can
	// still surface the explanations gathered before it.
	const outputWarnings: string[] = [];

	try {
		// Reuse the pre-flight hash when it already ran; otherwise compute it
		// once here and keep it for repeat runs.
		const inputHash = queued.inputHash ?? (await computeSha256(file));
		queued.inputHash = inputHash;

		let output: ProcessingOutput;
		if (routesToVideo(inputMime, outputMime)) {
			output = await processVideo(file, options, onVideoStatus, outputWarnings);
		} else if (inputMime === 'image/gif') {
			output = await processAnimatedGif(file, options, outputWarnings);
		} else {
			output = await processStaticImage(file, options, outputWarnings);
		}
		const { blob, warnings, outputHash: processedOutputHash } = output;

		// Image paths already hashed their output for the identical-output
		// check; only video output reaches here without one.
		const outputHash = processedOutputHash ?? (await computeSha256(blob));

		if (inputHash === outputHash) {
			// LSB/blur/JPEG are images-only; video inputs only get metadata
			// stripping plus the distortion approximations, so tailor the advice.
			const identicalError = routesToVideo(inputMime, outputMime)
				? 'Output is identical to input. No steganography was removed. Enable media distortion.'
				: 'Output is identical to input. No steganography was removed. Enable media distortion, LSB clearing, blur, or JPEG re-compression.';
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
				warnings,
				error: identicalError,
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
			warnings,
		};
	} catch (err) {
		// Surface warnings gathered before the failure (e.g. GIF approximation
		// notes or FFmpeg fallback notes) alongside the error.
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
			...(outputWarnings.length > 0 ? { warnings: outputWarnings } : {}),
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

function getOutputFormatsFromRows(): Record<string, string> {
	const map: Record<string, string> = {};
	const selects = outputFormatRows.querySelectorAll('select');
	for (const select of selects) {
		const ext = (select as HTMLSelectElement).dataset.ext;
		if (ext) map[ext] = (select as HTMLSelectElement).value;
	}
	return map;
}

function getDistortPresetFromGroup(): DistortPreset | null {
	const value = getSelectedRadioValue(distortPresetGroup);
	if (value === 'gentle' || value === 'balanced' || value === 'aggressive') {
		return DISTORT_PRESETS[value];
	}
	return null;
}

function applyDistortPreset(preset: DistortPreset): void {
	distortElasticInput.value = String(preset.elasticAlpha);
	distortSigmaInput.value = String(preset.elasticSigma);
	distortRotationInput.value = String(preset.rotationJitter);
	distortSqueezeInput.value = String(preset.squeezeFactor);
	distortColorInput.value = String(preset.colorAmount);
	distortNoiseInput.value = String(preset.lumaNoise);
	distortRoundsInput.value = String(preset.reencodeRounds);
	distortQualityInput.value = String(preset.reencodeQuality);
	distortPsnrFloorInput.value = String(preset.psnrFloor);
	distortBilateralInput.checked = preset.bilateral;
	refreshDistortDisplays();
}

function refreshDistortDisplays(): void {
	distortElasticValue.textContent = `${distortElasticInput.value}px`;
	distortSigmaValue.textContent = `${distortSigmaInput.value}px`;
	distortRotationValue.textContent = `${distortRotationInput.value}°`;
	distortSqueezeValue.textContent = `${parseFloat(distortSqueezeInput.value).toFixed(2)}×`;
	distortColorValue.textContent = `${parseFloat(distortColorInput.value).toFixed(2)}×`;
	distortNoiseValue.textContent = distortNoiseInput.value;
	distortRoundsValue.textContent = distortRoundsInput.value;
	distortQualityValue.textContent = `${distortQualityInput.value}%`;
	distortPsnrFloorValue.textContent = `${distortPsnrFloorInput.value} dB`;
}

// Invalid squeeze factors are treated as disabled (1) rather than
// destructive: the pipeline guards also skip them, so UI tampering can only
// disable the stage, never flatten the image.
function clampSqueezeFactor(value: number): number {
	if (!Number.isFinite(value) || value <= 0 || value > 1) return 1;
	return value;
}

// Bounds a parsed slider value into the slider's own min/max range so
// tampered or programmatic values cannot reach the pipelines unbounded.
function clampToSlider(input: HTMLInputElement, parsed: number, fallback: number): number {
	const min = Number(input.min);
	const max = Number(input.max);
	if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
		return Number.isFinite(parsed) ? parsed : fallback;
	}
	return clampNumber(parsed, min, max, fallback);
}

function getProcessingOptions(): ProcessingOptions {
	const mode = getSelectedRadioValue(filenameModeGroup) as ProcessingOptions['filenameMode'];
	// Tampered fields fall back to the displayed balanced preset (and the
	// matching slider defaults) instead of silently disabling stages with 0.
	const preset = DISTORT_PRESETS.balanced;
	return {
		clearLsb: clearLsbInput.checked,
		randomizeLsb: randomizeLsbInput.checked,
		applyBlur: applyBlurInput.checked,
		blurRadius: clampToSlider(blurRadiusInput, parseNumber(blurRadiusInput.value, 1), 1),
		jpegRecompress: jpegRecompressInput.checked,
		jpegQuality: clampToSlider(jpegQualityInput, parseInteger(jpegQualityInput.value, 85), 85),
		distort: {
			enabled: distortAttackInput.checked,
			elasticAlpha: clampToSlider(distortElasticInput, parseNumber(distortElasticInput.value, preset.elasticAlpha), preset.elasticAlpha),
			elasticSigma: clampToSlider(distortSigmaInput, parseNumber(distortSigmaInput.value, preset.elasticSigma), preset.elasticSigma),
			rotationJitter: clampToSlider(distortRotationInput, parseNumber(distortRotationInput.value, preset.rotationJitter), preset.rotationJitter),
			squeezeFactor: clampSqueezeFactor(parseNumber(distortSqueezeInput.value, 1)),
			colorAmount: clampToSlider(distortColorInput, parseNumber(distortColorInput.value, preset.colorAmount), preset.colorAmount),
			lumaNoise: clampToSlider(distortNoiseInput, parseNumber(distortNoiseInput.value, preset.lumaNoise), preset.lumaNoise),
			lumaNoiseStep: Number(distortNoiseInput.step),
			reencodeRounds: clampToSlider(distortRoundsInput, parseInteger(distortRoundsInput.value, preset.reencodeRounds), preset.reencodeRounds),
			reencodeQuality: clampToSlider(distortQualityInput, parseInteger(distortQualityInput.value, preset.reencodeQuality), preset.reencodeQuality),
			bilateral: distortBilateralInput.checked,
			psnrFloor: clampToSlider(distortPsnrFloorInput, parseInteger(distortPsnrFloorInput.value, preset.psnrFloor), preset.psnrFloor),
		},
		outputFormats: getOutputFormatsFromRows(),
		filenameMode: mode || 'suffix',
		outputSuffix: outputSuffixInput.value.trim() || '-clean',
		outputPrefix: outputPrefixInput.value.trim() || 'file',
		prefixStartIndex: Math.max(0, parseInteger(prefixStartIndexInput.value, 0)),
		hashLength: getHashLength(getSelectedRadioValue(hashPanel)),
	};
}

function setProgress(percent: number, text: string): void {
	progressFill.style.width = `${percent}%`;
	progressBar.setAttribute('aria-valuenow', String(percent));
	progressText.textContent = text;
	progressSection.hidden = false;
}

function updateOutputFormatRows(): void {
	const previous = getOutputFormatsFromRows();
	// Preserve the pre-JPEG-forcing choice across rebuilds so disabling the
	// JPEG override restores the user's original selection.
	const previousPrev: Record<string, string> = {};
	for (const select of outputFormatRows.querySelectorAll('select')) {
		const s = select as HTMLSelectElement;
		if (s.dataset.ext && s.dataset.prevValue) previousPrev[s.dataset.ext] = s.dataset.prevValue;
	}
	const uniqueExtensions = new Set<string>();
	for (const queued of queuedFiles) {
		const mime = detectInputMime(queued.file);
		const ext = getExtensionFromMime(mime);
		uniqueExtensions.add(ext);
	}

	outputFormatsGroup.hidden = uniqueExtensions.size === 0;
	outputFormatRows.innerHTML = '';

	const sortedExtensions = Array.from(uniqueExtensions).sort();
	const baseImageFormats = [
		{ value: 'auto', label: 'Auto (keep input format)' },
		{ value: 'image/png', label: 'PNG' },
		{ value: 'image/jpeg', label: 'JPEG' },
		{ value: 'image/webp', label: 'WebP' },
	];
	// The canvas pipeline cannot export BMP, so BMP inputs always re-encode
	// (PNG by default); label Auto honestly for that type.
	const imageFormatsFor = (ext: string): { value: string; label: string }[] => ext === 'bmp'
		? [
			{ value: 'auto', label: 'Auto (PNG: canvas cannot export BMP)' },
			{ value: 'image/png', label: 'PNG' },
			{ value: 'image/jpeg', label: 'JPEG' },
			{ value: 'image/webp', label: 'WebP' },
		]
		: baseImageFormats;

	for (const ext of sortedExtensions) {
		const isGif = ext === 'gif';
		const isVideo = VIDEO_FORMAT_EXTENSIONS.includes(ext);

		const control = document.createElement('div');
		control.className = 'control';

		const label = document.createElement('label');
		label.className = 'control__label';
		label.textContent = `.${ext} output format${isVideo ? ' (always MP4)' : ''}`;

		const select = document.createElement('select');
		select.id = `output-format-${ext}`;
		label.htmlFor = select.id;
		select.dataset.ext = ext;

		if (isVideo) {
			const opt = document.createElement('option');
			opt.value = 'auto';
			opt.textContent = 'MP4 (default)';
			select.append(opt);
			select.disabled = true;
		} else {
			const formats = isGif
				? [{ value: 'auto', label: 'Auto (keep animated GIF)' }, { value: 'image/gif', label: 'GIF' }, { value: 'video/mp4', label: 'MP4' }]
				: imageFormatsFor(ext);
			for (const fmt of formats) {
				const opt = document.createElement('option');
				opt.value = fmt.value;
				opt.textContent = fmt.label;
				select.append(opt);
			}
			const kept = previous[ext];
			if (kept !== undefined && formats.some((fmt) => fmt.value === kept)) {
				select.value = kept;
			}
			const keptPrev = previousPrev[ext];
			if (keptPrev !== undefined && formats.some((fmt) => fmt.value === keptPrev)) {
				select.dataset.prevValue = keptPrev;
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
		li.dataset.id = queued.id;

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

		// The badge reports the file's own SynthID declaration, so it appears
		// exactly when that declaration is present in the metadata.
		if (queued.synthidDeclared) {
			info.append(createSynthidBadge());
		}

		const remove = document.createElement('button');
		remove.className = 'file-item__remove';
		remove.type = 'button';
		remove.setAttribute('aria-label', `Remove ${queued.file.name}`);
		remove.textContent = '×';
		remove.addEventListener('click', () => removeFileFromQueue(queued.id));
		remove.disabled = isProcessing;

		li.append(remove, thumb, info);
		fileList.append(li);
	}

	buildPagination(fileListSection, fileListPage, totalPages, (page) => {
		fileListPage = page;
		updateFileList();
	});

	processAllBtn.disabled = queuedFiles.length === 0 || isProcessing || isZipping;
	updateOutputFormatRows();
}

function removeFileFromQueue(id: string): void {
	if (isProcessing) return;
	const queued = queuedFiles.find((q) => q.id === id);
	if (queued) URL.revokeObjectURL(queued.objectUrl);
	queuedFiles = queuedFiles.filter((q) => q.id !== id);
	updateFileList();
}

function addFilesToQueue(files: FileList | null): void {
	if (isProcessing || !files) return;
	const skipped: string[] = [];
	for (const file of files) {
		// Extension allowlisting covers files whose platform reports an empty
		// type (e.g. .mkv/.bmp on some systems); detectInputMime resolves them
		// downstream.
		if (!isSupportedFile(file)) {
			skipped.push(file.name);
			continue;
		}
		const queued: QueuedFile = {
			id: generateId(),
			file,
			objectUrl: URL.createObjectURL(file),
		};
		queuedFiles.push(queued);
		// Best-effort pre-check that runs in the background so the file list can
		// appear immediately and then update with the declaration. Every container
		// the app accepts can carry the C2PA action, videos included, so nothing is
		// excluded here. Reads are serialized so a large batch never runs several
		// scans at once and stalls the page.
		enqueuePreflight(queued);
	}
	updateFileList();
	if (skipped.length > 0) {
		const shown = skipped.slice(0, 3).join(', ');
		const extra = skipped.length > 3 ? ` and ${skipped.length - 3} more` : '';
		setProgress(0, `Skipped ${skipped.length} unsupported file${skipped.length === 1 ? '' : 's'} (${shown}${extra}). Use PNG, JPEG, WebP, BMP, GIF, or supported video.`);
	}
}

// Shared cache of metadata declarations, keyed by content digest. The pre-flight
// populates it and any later pass reads through it, so the same bytes are never
// examined twice. Each declaration kind gets its own reader here rather than at
// the call site, so a second steganography type is added by naming its kind and
// its reader and nothing else.
const synthidMetadata = createDeclarationCache({
	synthidMetadata: async (bytes) => hasSynthidDeclarationInBytes(bytes),
});

// Serial queue for the background pre-flight declaration scans. One scan runs
// at a time so adding a large batch cannot start a read per file at once.
let preflightQueue: Promise<void> = Promise.resolve();
// Epoch bumped by clearAll so scans queued for files the user discarded become
// cheap no-ops instead of running behind the new queue.
let preflightEpoch = 0;
// Gate that parks queued pre-flight scans while batch processing runs, so their
// reads do not interleave with the pipeline's own work on the main thread. The
// one scan already executing when the gate closes is awaited by
// pausePreflights before processing begins. A scan is a bounded byte read
// today, so the gate costs little either way; it is kept because a slower
// detector replacing it would need exactly this separation, and a badge that
// appears only after the batch finishes is a fair trade for keeping the
// pipeline's main thread to itself.
let preflightGate: Promise<void> | null = null;
let releasePreflightGate: (() => void) | null = null;
let preflightInflight: Promise<void> | null = null;

async function pausePreflights(): Promise<void> {
	if (!preflightGate) {
		preflightGate = new Promise((resolve) => {
			releasePreflightGate = resolve;
		});
	}
	if (preflightInflight) await preflightInflight;
}

function resumePreflights(): void {
	if (releasePreflightGate) {
		releasePreflightGate();
		preflightGate = null;
		releasePreflightGate = null;
	}
}

function enqueuePreflight(queued: QueuedFile): void {
	const epoch = preflightEpoch;
	preflightQueue = preflightQueue
		.then(async () => {
			if (epoch !== preflightEpoch) return;
			if (preflightGate) await preflightGate;
			const run = async () => {
				try {
					// Re-checked rather than trusted from the gate check above,
					// because every await in this chain is a point where the queue
					// can change. The epoch catches a cleared queue, the membership
					// check catches one file removed from a queue that was not, and
					// a scan that waited out the gate needs both.
					if (epoch !== preflightEpoch) return;
					if (!queuedFiles.includes(queued)) return;
					// A bounded edge scan for Google's declaration, which answers
					// the only question the badge asks and needs no image decode.
					// A small input is read once for both its content key and
					// the search; a large one never has its payload read just to
					// look at its metadata.
					const declared = await readSynthidMetadata(queued);
					if (epoch !== preflightEpoch) return;
					if (!queuedFiles.includes(queued)) return;
					queued.synthidDeclared = declared;
					// The badge is informational only. It reports what the file's own
					// metadata claims, which is not evidence the pixels carry a
					// watermark this tool can affect, so finding one must not change
					// the user's options for them. Clicking the badge is how they ask
					// for the distortion.
					updateQueuedBadge(queued);
				} catch {}
			};
			// The assignment must stay synchronously adjacent to the gate check
			// above: an await in between would let pausePreflights miss this run
			// and start the batch while the read is still going.
			preflightInflight = run();
			try {
				await preflightInflight;
			} finally {
				preflightInflight = null;
			}
		})
		// Without this the chain would both surface an unhandled rejection and
		// stay rejected for good, so every later enqueuePreflight would chain off
		// it and silently stop scanning. Each run already swallows its own errors;
		// this only keeps one bad link from disabling the queue.
		.catch(() => {});
}

// Reads a file's SynthID declaration through the shared cache, choosing how
// much of the file to read first.
//
// Below the large-input threshold the file is read once and the same buffer
// answers both questions the pre-flight has: it is digested into the content
// key the declaration is cached under, and it is searched for the declaration
// itself. Processing reuses that digest too, so a queued file is read once here
// and never again for its key. A digest the queue already holds is preferred
// over deriving a second one from the bytes just read.
//
// At or above the threshold nothing is digested: hashing one would read the
// whole file into memory for a declaration that only needs its two edge
// windows, and with no key there is nothing to cache under, so the bounded
// reader runs directly. Processing derives the digest later, when the
// identical-output check needs one.
//
// A key the cache cannot trust never reaches it, because a collision would hand
// one file another's declaration. On this path that is only the non-
// cryptographic fallback fingerprint, since no digest at all is possible only in
// the large-input branch above, and bypassing the cache costs the search rather
// than the result.
async function readSynthidMetadata(queued: QueuedFile): Promise<boolean> {
	if (queued.file.size >= LARGE_INPUT_BYTES) return hasSynthidManifest(queued.file);
	const buffer = await queued.file.arrayBuffer();
	const digest = queued.inputHash ?? (await sha256HexFromBuffer(buffer));
	if (queued.inputHash === undefined) queued.inputHash = digest;
	if (!isContentDigest(digest)) return hasSynthidDeclarationInBytes(new Uint8Array(buffer));
	return synthidMetadata.get(new Uint8Array(buffer), digest, 'synthidMetadata');
}

// Builds the badge shown on a queued file whose own metadata declares a
// SynthID watermark. This is a read of what Google wrote into the container,
// not a measurement of the watermark in the pixels, so the wording names the
// source and says the pixel watermark was not measured. Clicking it turns on
// media distortion, which is the honest thing to offer: the user has just been
// told this file came from a model that watermarks its output, and the
// distortion may disturb that watermark, but it is not verified to remove it
// and may not. The option applies to the whole batch rather than just this
// file, so the title says so rather than implying a per-file action.
//
// A running batch has already captured the options it will use, so the badge
// locks with the rest of the queue controls: flipping the checkbox mid-batch
// would only take effect on the next run, which reads as a dead control.
function createSynthidBadge(): HTMLButtonElement {
	const badge = document.createElement('button');
	badge.type = 'button';
	badge.className = 'file-item__synthid';
	badge.title = "This file's metadata carries Google's declaration that a SynthID watermark was applied. The badge reports that declaration, not a measurement of the watermark in the pixels. Click to turn on media distortion, which may disturb some embedded watermarks but is not verified to remove this one. The option applies to all inputs.";
	badge.textContent = 'SynthID declared';
	badge.disabled = isProcessing;
	badge.addEventListener('click', () => {
		distortAttackInput.checked = true;
		distortAttackInput.dispatchEvent(new Event('change'));
	});
	return badge;
}

// Refreshes just one file item's badge after its declaration scan resolves,
// without re-rendering the whole (possibly paginated) list.
function updateQueuedBadge(queued: QueuedFile): void {
	const li = fileList.querySelector<HTMLElement>(`[data-id="${CSS.escape(queued.id)}"]`);
	if (!li) return;
	const info = li.querySelector('.file-item__info');
	if (!info) return;
	const existing = li.querySelector('.file-item__synthid');
	if (existing) existing.remove();
	if (queued.synthidDeclared) {
		info.append(createSynthidBadge());
	}
}

// Appends each warning from a result to its info block.
function appendWarnings(info: HTMLElement, warnings: string[]): void {
	for (const warning of warnings) {
		const element = document.createElement('p');
		element.className = 'result-item__warning';
		element.textContent = warning;
		info.append(element);
	}
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
			const isVideo = result.blob.type.startsWith('video/');
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
			// The non-crypto fallback is a local fingerprint, not a digest, so
			// label it honestly instead of claiming SHA-256.
			const hashLabel = isFallbackHash(result.outputHash) ? 'Fingerprint' : 'SHA-256';
			hash.textContent = `${hashLabel}: ${result.outputHash.slice(0, 16)}…`;
			hash.title = `Input: ${result.inputHash}\nOutput: ${result.outputHash}`;

			info.append(name, meta, hash);
			if (result.warnings && result.warnings.length > 0) appendWarnings(info, result.warnings);

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

			if (result.warnings && result.warnings.length > 0) appendWarnings(info, result.warnings);

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

	downloadAllBtn.disabled = isProcessing || isZipping || !processedFiles.some((r) => r.success);
}

function downloadBlob(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.append(a);
	a.click();
	a.remove();
	// Revoking synchronously can abort the download in Firefox/Safari, where
	// the navigation task has not retained the blob yet.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function downloadAllAsZip(): Promise<void> {
	if (isProcessing || isZipping) return;
	const successes = processedFiles.filter((r) => r.success);
	if (successes.length === 0) return;
	isZipping = true;
	// Lock every control that would replace the results or the progress
	// display the running archive is built from.
	downloadAllBtn.disabled = true;
	processAllBtn.disabled = true;
	clearAllBtn.disabled = true;
	try {
		const zip = new JSZip();
		const usedNames = new Set<string>();
		for (const result of successes) {
			// Suffix mode ignores the file index, so duplicate input names would
			// otherwise overwrite each other in the archive. Disambiguate with a
			// counter instead of silently dropping entries.
			let name = result.cleanedName;
			if (usedNames.has(name)) {
				const dot = name.lastIndexOf('.');
				const stem = dot > 0 ? name.slice(0, dot) : name;
				const ext = dot > 0 ? name.slice(dot) : '';
				let n = 1;
				while (usedNames.has(`${stem} (${n})${ext}`)) n += 1;
				name = `${stem} (${n})${ext}`;
			}
			usedNames.add(name);
			zip.file(name, result.blob);
		}
		const blob = await zip.generateAsync({ type: 'blob' });
		downloadBlob(blob, 'steganography-removed.zip');
	} catch (err) {
		setProgress(0, `ZIP generation failed: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		isZipping = false;
		updateResults();
		// Restores Process All from the queue state and, with the results
		// refresh above, Download All from the batch state.
		updateFileList();
		clearAllBtn.disabled = false;
	}
}

async function processAllFiles(): Promise<void> {
	if (isProcessing || isZipping) return;
	if (queuedFiles.length === 0) return;

	isProcessing = true;
	// A batch reads the options once, at its start, so every option control and
	// the declaration badge lock for its duration. Changing one mid-batch would
	// take effect only on the next run, which reads as a control that accepted
	// the change and then ignored it. The queue badge needs its own lock because
	// it lives outside this fieldset.
	optionsLock.disabled = true;
	processAllBtn.disabled = true;
	clearAllBtn.disabled = true;
	fileInput.disabled = true;
	try {
		// Re-render so the per-file remove buttons lock with the other queue
		// controls; the renderer derives their state from isProcessing.
		updateFileList();
		await pausePreflights();
		for (const result of processedFiles) {
			if (result.objectUrl) URL.revokeObjectURL(result.objectUrl);
		}
		processedFiles = [];
		resultsPage = 0;
		updateResults();

		const options = getProcessingOptions();
		const batch = [...queuedFiles];
		const total = batch.length;
		for (let i = 0; i < total; i += 1) {
			const queued = batch[i];
			const queuedInputMime = detectInputMime(queued.file);
			const queuedOutputMime = getOutputMime(queuedInputMime, options);
			const isVideo = routesToVideo(queuedInputMime, queuedOutputMime);
			const base = (i / total) * 100;
			const range = 100 / total;

			setProgress(
				base,
				isVideo
					? (ffmpegInstance
						? `Processing ${queued.file.name} (${i + 1}/${total})…`
						: `Loading FFmpeg.wasm for ${queued.file.name} (${i + 1}/${total})…`)
					: `Processing ${queued.file.name} (${i + 1}/${total})…`
			);

			// Yield to the event loop to keep the UI responsive. setTimeout-based
			// yield works in hidden tabs, where requestAnimationFrame may not fire.
			await yieldToBrowser();

			const result = await processSingleFile(queued, options, i, (phase, pct) => {
				const clamped = Math.max(0, Math.min(100, pct));
				if (phase === 'download') {
					setProgress(base + range * 0.1 * (clamped / 100), `Downloading FFmpeg.wasm ${Math.round(clamped)}% (${i + 1}/${total})…`);
				} else {
					setProgress(base + range * (0.1 + 0.9 * (clamped / 100)), `Converting with FFmpeg.wasm ${Math.round(clamped)}% (${i + 1}/${total})…`);
				}
			});
			processedFiles.push(result);
			setProgress(base + range, `Processed ${queued.file.name} (${i + 1}/${total})…`);
			updateResults();
		}
		setProgress(100, `Finished processing ${total} file${total === 1 ? '' : 's'}.`);
	} catch (err) {
		console.error(err);
		setProgress(0, `Processing stopped: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		resumePreflights();
		isProcessing = false;
		optionsLock.disabled = false;
		clearAllBtn.disabled = false;
		fileInput.disabled = false;
		updateFileList();
		updateResults();
	}
}

function clearAll(): void {
	if (isProcessing || isZipping) return;
	preflightEpoch += 1;
	// Drop cached declarations with the queue so a long session does not retain
	// scans for files the user has cleared. Declarations for files removed
	// individually stay cached until this full clear. Large inputs never enter
	// the cache, so this holds only the small ones.
	synthidMetadata.clear();
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
	setProgress(0, 'Ready');
	fileInput.value = '';
}

// ---------------------------------------------------------------------------
// Event listeners
// ---------------------------------------------------------------------------

['dragenter', 'dragover'].forEach((event) => {
	dropZone.addEventListener(event, (e) => {
		e.preventDefault();
		if (isProcessing) {
			dropZone.classList.remove('drop-zone--dragover');
			const transfer = (e as DragEvent).dataTransfer;
			if (transfer) transfer.dropEffect = 'none';
			return;
		}
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
		const isVideo = VIDEO_FORMAT_EXTENSIONS.includes(s.dataset.ext ?? '');
		if (isVideo) continue;
		if (active) {
			// Snapshot the choice only when not already preserved: row rebuilds
			// while forcing is active restore dataset.prevValue from the
			// pre-forcing selection, and an unconditional write here would
			// overwrite it with the forced JPEG value.
			if (!s.dataset.prevValue) s.dataset.prevValue = s.value;
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
	const options = getProcessingOptions();
	const anyJpeg = queuedFiles.some(
		({ file }) => getOutputMime(detectInputMime(file), options) === 'image/jpeg'
	);
	jpegQualityInput.disabled = !anyJpeg;
}

jpegRecompressInput.addEventListener('change', updateJpegControls);
outputFormatRows.addEventListener('change', updateJpegQualityEnabled);

distortAttackInput.addEventListener('change', () => {
	if (!distortAttackInput.checked) distortAdvancedExpanded = false;
	updateDistortAdvancedVisibility();
});

distortAdvancedToggle.addEventListener('click', () => {
	distortAdvancedExpanded = !distortAdvancedExpanded;
	updateDistortAdvancedVisibility();
});

function updateDistortAdvancedVisibility(): void {
	const enabled = distortAttackInput.checked;
	distortAdvancedToggle.hidden = !enabled;
	const expanded = enabled && distortAdvancedExpanded;
	distortSettingsGroup.hidden = !expanded;
	distortAdvancedToggle.setAttribute('aria-expanded', String(expanded));
}

distortPresetGroup.addEventListener('change', () => {
	const preset = getDistortPresetFromGroup();
	if (preset) applyDistortPreset(preset);
});

// Manual adjustments no longer match any preset, so clear the selection.
function clearDistortPresetSelection(): void {
	for (const radio of distortPresetGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
		radio.checked = false;
	}
}

const distortSliders = [
	distortElasticInput,
	distortSigmaInput,
	distortRotationInput,
	distortSqueezeInput,
	distortColorInput,
	distortNoiseInput,
	distortRoundsInput,
	distortQualityInput,
	distortPsnrFloorInput,
];
for (const slider of distortSliders) {
	slider.addEventListener('input', () => {
		clearDistortPresetSelection();
		refreshDistortDisplays();
	});
}
distortBilateralInput.addEventListener('change', clearDistortPresetSelection);

function updateFilenamePanels(): void {
	const mode = getSelectedRadioValue(filenameModeGroup) as ProcessingOptions['filenameMode'];
	suffixPanel.hidden = mode !== 'suffix';
	prefixPanel.hidden = mode !== 'prefix';
	hashPanel.hidden = mode !== 'hash';
}

filenameModeGroup.addEventListener('change', updateFilenamePanels);

processAllBtn.addEventListener('click', () => {
	processAllFiles().catch((err) => {
		console.error(err);
		setProgress(0, `Processing failed: ${err instanceof Error ? err.message : String(err)}`);
	});
});
downloadAllBtn.addEventListener('click', () => {
	downloadAllAsZip().catch((err) => {
		console.error(err);
	});
});
clearAllBtn.addEventListener('click', () => clearAll());

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

blurRadiusInput.disabled = !applyBlurInput.checked;
updateJpegControls();
updateFilenamePanels();
updateDistortAdvancedVisibility();
applyDistortPreset(DISTORT_PRESETS.balanced);
setProgress(0, 'Ready');

export { processVideo, processAnimatedGif, processAllFiles, createSynthidBadge };
