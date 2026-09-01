import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { GifReader, GifWriter } from 'omggif';
import JSZip from 'jszip';
import type {
	Bitmap,
	FrameSize,
	ProcessingOptions,
	ProcessingOutput,
	SynthidCheckResult,
	SynthidDetection,
	SynthidOptions,
	SynthidPreset,
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
	isFallbackHash,
	isSupportedFile,
	isVideoFile,
	parseInteger,
	parseNumber,
	readFileAsArrayBuffer,
	yieldToBrowser,
	canvasToBlob,
	computeSha256,
	createSeededRandom,
} from './lib/util';
import { applyBlurEffect, applyLsbEffect, boxFilter, resampleSeparable } from './lib/pixels';
import {
	GIF_DEFAULT_MAX_COLORS,
	applyPaletteLsb,
	getGifBackground,
	gifHasTransparency,
	medianCutQuantize,
	quantizeImageToPalette,
} from './lib/quantize';
import { applyGifFrameDisposal } from './lib/gif';
import { createDetectionCache } from './lib/detection-cache';
import {
	MAX_DETECT_DIMENSION,
	MAX_SYNTHID_GIF_PIXELS,
	MAX_SYNTHID_IMAGE_PIXELS,
	SYNTHID_PRESETS,
	SYNTHID_RETRY_ATTEMPTS,
	applySynthidDistortionStages,
	applySynthidPipeline,
	applySynthidSmoothingStage,
	buildSynthidRandomState,
	buildSynthidVideoFilters,
	encodeStaticImage,
	gateSynthidByDetection,
	gateVideoSynthid,
	gifQualityToMaxColors,
	isSubLevelVideoNoise,
	selectGifCheckIndices,
	shouldRestoreBestDraw,
	shouldRetrySynthidAttempt,
	subLevelVideoNoiseWarning,
} from './lib/synthid';
import { detectSynthid } from './lib/synthid-detect';
import { hasSynthidManifest } from './lib/synthid-metadata';
import { scanHasAlpha } from './lib/metrics';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface QueuedFile {
	id: string;
	file: File;
	objectUrl: string;
	// Content hash, computed once by the pre-flight pass (or by processing when
	// the pre-flight was skipped) and reused for detection caching and the
	// identical-output check.
	inputHash?: string;
	// Pre-flight SynthID verdict for static images, so the UI can prompt the
	// user to enable the removal option before they process the file.
	synthidDetected?: SynthidDetection;
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
	synthidCheck?: SynthidCheckResult;
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
// lookups that feed the SynthID filter builder.
const VIDEO_METADATA_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const dropZone = document.getElementById('drop-zone') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const fileListSection = document.getElementById('file-list-section') as HTMLElement;
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
const synthidAttackInput = document.getElementById('synthid-attack') as HTMLInputElement;
const synthidAdvancedToggle = document.getElementById('synthid-advanced-toggle') as HTMLButtonElement;
const synthidSettingsGroup = document.getElementById('synthid-settings') as HTMLElement;
const synthidPresetGroup = document.getElementById('synthid-preset-group') as HTMLElement;
const synthidScopeGroup = document.getElementById('synthid-scope-group') as HTMLElement;
const synthidScopeWrap = document.getElementById('synthid-scope-wrap') as HTMLElement;
const synthidElasticInput = document.getElementById('synthid-elastic') as HTMLInputElement;
const synthidElasticValue = document.getElementById('synthid-elastic-value') as HTMLElement;
const synthidSigmaInput = document.getElementById('synthid-sigma') as HTMLInputElement;
const synthidSigmaValue = document.getElementById('synthid-sigma-value') as HTMLElement;
const synthidRotationInput = document.getElementById('synthid-rotation') as HTMLInputElement;
const synthidRotationValue = document.getElementById('synthid-rotation-value') as HTMLElement;
const synthidSqueezeInput = document.getElementById('synthid-squeeze') as HTMLInputElement;
const synthidSqueezeValue = document.getElementById('synthid-squeeze-value') as HTMLElement;
const synthidColorInput = document.getElementById('synthid-color') as HTMLInputElement;
const synthidColorValue = document.getElementById('synthid-color-value') as HTMLElement;
const synthidNoiseInput = document.getElementById('synthid-noise') as HTMLInputElement;
const synthidNoiseValue = document.getElementById('synthid-noise-value') as HTMLElement;
const synthidRoundsInput = document.getElementById('synthid-rounds') as HTMLInputElement;
const synthidRoundsValue = document.getElementById('synthid-rounds-value') as HTMLElement;
const synthidQualityInput = document.getElementById('synthid-quality') as HTMLInputElement;
const synthidQualityValue = document.getElementById('synthid-quality-value') as HTMLElement;
const synthidPsnrFloorInput = document.getElementById('synthid-psnr-floor') as HTMLInputElement;
const synthidPsnrFloorValue = document.getElementById('synthid-psnr-floor-value') as HTMLElement;
const synthidBilateralInput = document.getElementById('synthid-bilateral') as HTMLInputElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let queuedFiles: QueuedFile[] = [];
let processedFiles: ProcessedFile[] = [];
let fileListPage = 0;
let resultsPage = 0;
let synthidAdvancedExpanded = false;
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
	inputCheck: SynthidDetection | null = null,
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
		let synthidFilters: string[] = [];
		// Real videos get the scope-only rule because the detector cannot read
		// them: under "detected images, no videos" a video can never be
		// confirmed as watermarked, so removal is skipped silently and the
		// other options still run. Both "detected images, all videos" and "all
		// inputs" run the FFmpeg approximations on every video. Still images
		// routed through FFmpeg (a GIF converted to MP4) remain covered by
		// the detector and use the same verdict gate as the GIF path, so the
		// chosen output container cannot change whether removal runs.
		const videoSynthid = gateVideoSynthid(
			inputMime.startsWith('video/'),
			options.synthid,
			options.synthidScope,
			inputCheck,
			warnings
		);
		if (videoSynthid.enabled) {
			const frameSize = await getVideoFrameSize(file);
			if (frameSize === null && videoSynthid.elasticAlpha >= 1) {
				warnings.push('The warp approximation was skipped because the video frame size could not be determined.');
			}
			synthidFilters = buildSynthidVideoFilters(videoSynthid, frameSize, Math.random, warnings);
			if (isSubLevelVideoNoise(videoSynthid.lumaNoise)) {
				warnings.push(subLevelVideoNoiseWarning(Number(synthidNoiseInput.step)));
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

		let exitCode = await ffmpeg.exec(buildArgs(synthidFilters), 300000);
		if (exitCode !== 0 && synthidFilters.length > 0) {
			// The SynthID filter chain can fail on unusual inputs; retry with
			// metadata stripping only instead of failing the whole file.
			logLines.push('--- retrying without SynthID filters ---');
			exitCode = await ffmpeg.exec(buildArgs([]), 300000);
			// A retry that fails as well throws below, so only a retry with
			// output may claim metadata stripping was applied.
			if (exitCode === 0) {
				warnings.push('The video SynthID filter chain failed for this file. Metadata stripping was applied without the SynthID stages.');
			}
		} else if (synthidFilters.length > 0) {
			// Only describe the approximations when the chain actually ran, so
			// a chain that failed into the metadata-only fallback does not
			// also carry a note implying the SynthID stages were applied.
			warnings.push('This video uses a simplified SynthID filter chain. The re-encode rounds, re-encode quality, quality floor, and smoothing settings were skipped because they apply to still images only.');
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
			// A still image routed through FFmpeg stays covered by the detector,
			// so report its input verdict when the attack ran or the input
			// looked watermarked; a real video has none to offer and the MP4
			// output cannot be verified.
			synthidCheck: inputCheck !== null && (videoSynthid.enabled || inputCheck.isWatermarked)
				? { input: inputCheck, output: null }
				: undefined,
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

// Capped draw dimensions for a source: the longest side is bounded at
// MAX_DETECT_DIMENSION. `scaled` is false when the source is already within the
// cap and needs no resample. Single source of truth for the cap policy.
function capDimensions(width: number, height: number): { cw: number; ch: number; scaled: boolean } {
	const scale = Math.min(1, MAX_DETECT_DIMENSION / Math.max(width, height));
	return {
		cw: Math.max(1, Math.round(width * scale)),
		ch: Math.max(1, Math.round(height * scale)),
		scaled: scale < 1,
	};
}

// Renders a source into a canvas capped at MAX_DETECT_DIMENSION on its
// longest side, so SynthID detection never allocates a buffer proportional to
// an unbounded input resolution. `scaled` reports whether the cap actually
// resampled, so detection can report an honest exactMatch.
function drawCappedBitmap(source: CanvasImageSource, width: number, height: number): { bitmap: Bitmap; scaled: boolean } {
	const { cw, ch, scaled } = capDimensions(width, height);
	const canvas = document.createElement('canvas');
	canvas.width = cw;
	canvas.height = ch;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (!ctx) throw new Error('Could not create canvas context for detection');
	ctx.drawImage(source, 0, 0, cw, ch);
	return { bitmap: { width: cw, height: ch, data: ctx.getImageData(0, 0, cw, ch).data }, scaled };
}

// Re-renders an existing pixel buffer through the same bounded-resolution
// draw, so detection on raw buffers (e.g. a decoded GIF frame) never feeds the
// resampler an unbounded source. Buffers already within the cap are returned
// unchanged, skipping a pointless resample. Downscaling runs on the raw buffer
// directly instead of a full-size canvas round-trip, so peak memory stays near
// one frame plus the capped output.
function capBitmap(bitmap: Bitmap): { bitmap: Bitmap; scaled: boolean } {
	const { cw, ch, scaled } = capDimensions(bitmap.width, bitmap.height);
	if (!scaled) {
		return { bitmap, scaled: false };
	}
	const data = resampleSeparable(bitmap.data, bitmap.width, bitmap.height, cw, ch, boxFilter);
	return { bitmap: { width: cw, height: ch, data }, scaled: true };
}

// Whether the blob holds GIF data. Checks the magic header in addition to
// the MIME type so files with an empty type (extension-allowlisted .gif)
// still take the GIF reader path on both preflight and verification.
async function isGifBlob(blob: Blob): Promise<boolean> {
	if (blob.type === GIF_MIME) return true;
	try {
		if (blob.size < 6) return false;
		const header = new Uint8Array(await blob.slice(0, 6).arrayBuffer());
		return header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46
			&& header[3] === 0x38 && (header[4] === 0x37 || header[4] === 0x39) && header[5] === 0x61;
	} catch {
		return false;
	}
}

// Shared cache for the pipeline's detection passes. Keys are the hashes the
// pipeline computes anyway for its identical-output check, so the pre-flight
// badge, the processing-time input verdict, each retry probe, and the final
// output verification never detect the same bytes twice.
const synthidVerdicts = createDetectionCache(detectBlobSynthid);

function detectSynthidCached(blob: Blob, contentHash: string): Promise<SynthidDetection> {
	// The fallback fingerprint is not a cryptographic digest, so a collision
	// could return another file's verdict; skip the shared cache rather than
	// risk that.
	if (isFallbackHash(contentHash)) return detectBlobSynthid(blob);
	// Detection classifies GIFs by MIME before inspecting the magic bytes, so
	// identical bytes can take different decode branches under different
	// types; namespace the key so a verdict never crosses classifications.
	const key = blob.type === GIF_MIME ? `${GIF_MIME}:${contentHash}` : `bytes:${contentHash}`;
	return synthidVerdicts.get(blob, key);
}

// Decodes an encoded image blob and runs the SynthID carrier check on its
// pixels, so the verdict reflects exactly what will be downloaded. Animated
// GIFs check the first, middle, and last composed frames and report a
// watermark when any of them conclusively flags, since later frames can carry
// content the first frame does not. Without a conclusive flag the first
// sampled frame's verdict is reported, because an inconclusive score is noise
// either way and must not decide the verdict on its own. Google's C2PA
// SynthID action, when present, is a prior that lets the detector read a
// marginal carrier score it would
// otherwise dismiss as clean content; processed outputs carry no metadata, so
// their verification stays on the strict pixel test.
async function detectBlobSynthid(blob: Blob): Promise<SynthidDetection> {
	const sensitive = await hasSynthidManifest(blob);
	if (await isGifBlob(blob)) {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const reader = new GifReader(bytes);
		const frameCount = reader.numFrames();
		validateGifAllocation(reader.width, reader.height, frameCount);
		const indices = selectGifCheckIndices(frameCount);
		if (indices.length === 0) {
			throw new Error('GIF has no frames to process. The file may be a header-only stub.');
		}
		const wanted = new Set(indices);
		const gifBackground = getGifBackground(bytes, reader.width, reader.height);
		let canvas: Uint8ClampedArray = new Uint8ClampedArray(gifBackground.pixels);
		const background = new Uint8ClampedArray(gifBackground.pixels);
		let first: SynthidDetection | null = null;
		for (let i = 0; i < frameCount; i += 1) {
			const info = reader.frameInfo(i);
			const beforeState = info.disposal === 3 ? new Uint8ClampedArray(canvas) : null;
			reader.decodeAndBlitFrameRGBA(i, canvas);
			if (wanted.has(i)) {
				const { bitmap, scaled } = capBitmap({ width: reader.width, height: reader.height, data: canvas });
				const detection = await detectSynthid(bitmap, { preResampled: scaled, sensitive });
				if (!first) first = detection;
				// Only a trusted verdict can short-circuit the frame scan; an
				// inconclusive frame would return on noise.
				if (detection.isWatermarked && detection.conclusive) return detection;
			}
			canvas = applyGifFrameDisposal(info, canvas, reader.width, reader.height, background, beforeState);
		}
		if (!first) {
			throw new Error('GIF has no frames to process. The file may be a header-only stub.');
		}
		return first;
	}
	const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
	try {
		const { bitmap: capped, scaled } = drawCappedBitmap(bitmap, bitmap.width, bitmap.height);
		return await detectSynthid(capped, { preResampled: scaled, sensitive });
	} finally {
		bitmap.close();
	}
}

// Applies the LSB post-pass to the canvas itself so the retry probe and the
// delivered bytes are the same pixels, including the randomize draw. Each
// attempt redraws from the pristine source, so draws stay independent.
function applyCanvasLsbPass(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, options: ProcessingOptions): void {
	if (!options.clearLsb && !options.randomizeLsb) return;
	const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
	applyLsbEffect(imageData, options);
	ctx.putImageData(imageData, 0, 0);
}

// Runs the output-side SynthID check against the encoded blob and pairs it
// with the input verdict, shared by the static and GIF paths. The "still
// detectable" warning only fires when the attack actually ran (synthid.enabled)
// and both ends conclusively read as watermarked; an inconclusive verdict is
// noise and must not speak for either end.
async function verifyOutputSynthid(
	blob: Blob,
	synthid: SynthidOptions,
	inputCheck: SynthidDetection | null,
	warnings: string[],
	outputHash: string
): Promise<SynthidCheckResult | undefined> {
	if (!inputCheck) return undefined;
	try {
		const outputCheck = await detectSynthidCached(blob, outputHash);
		if (synthid.enabled && inputCheck.conclusive && inputCheck.isWatermarked && outputCheck.conclusive && outputCheck.isWatermarked) {
			warnings.push('SynthID may still be detectable in the output. Try a stronger preset or raise the attack strengths.');
		}
		return { input: inputCheck, output: outputCheck };
	} catch {
		warnings.push('SynthID output verification failed, so the output verdict is unavailable.');
		return { input: inputCheck, output: null };
	}
}

// ---------------------------------------------------------------------------
// Static image processing
// ---------------------------------------------------------------------------

async function processStaticImage(
	file: File,
	options: ProcessingOptions,
	inputHash: string,
	warnings: string[] = []
): Promise<ProcessingOutput> {
	const img = await loadImageFromFile(file);
	let synthid = options.synthid;
	try {
		const canvas = document.createElement('canvas');
		canvas.width = img.naturalWidth;
		canvas.height = img.naturalHeight;
		const ctx = canvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) throw new Error('Could not create canvas context');

		ctx.drawImage(img, 0, 0);

		// Input verdict comes from the shared blob probe, before any processing
		// touches the canvas. Sharing the cached detector with the pre-flight
		// badge, the retry probe, and the output verification keeps every
		// verdict on one decoder instead of mixing Image-element and
		// ImageBitmap decodes, whose EXIF and color handling can disagree.
		let inputCheck: SynthidDetection | null = null;
		try {
			inputCheck = await detectSynthidCached(file, inputHash);
		} catch {
			// Reported as a missing check below rather than failing the file.
		}

		if (options.applyBlur && options.blurRadius > 0) {
			const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
			applyBlurEffect(imageData, options);
			ctx.putImageData(imageData, 0, 0);
		}

		// When scoped to detected images, skip the attack on clean inputs so
		// heavy distortion isn't wasted on files that carry no watermark. This
		// runs before the pixel-limit guard so a clean oversized image is not
		// mistaken for one that exceeded the limit. The other steganography
		// options still apply below; only SynthID removal is gated.
		synthid = gateSynthidByDetection(synthid, options.synthidScope, inputCheck, warnings);

		// Oversized images skip SynthID processing entirely rather than
		// failing; the standard steganography options still run.
		if (synthid.enabled && img.naturalWidth * img.naturalHeight > MAX_SYNTHID_IMAGE_PIXELS) {
			warnings.push(`SynthID removal was skipped because the image exceeds the ${MAX_SYNTHID_IMAGE_PIXELS.toLocaleString()} pixel limit; other options were applied.`);
			synthid = { ...synthid, enabled: false };
		}

		const inputMime = detectInputMime(file);
		const outputMime = getOutputMime(inputMime, options);
		const quality = outputMime === 'image/jpeg' ? options.jpegQuality / 100 : undefined;

		if (synthid.enabled) {
			// The attack is a per-file draw: tile shifts, rotation and noise
			// come from fresh randomness, so an individual run can leave a
			// marginal watermark above the detection boundary. When the encoded
			// result still reads as watermarked, redraw the pristine source and
			// draw again instead of reporting the unlucky draw, so re-running
			// "process all" is not the user's only remedy.
			const totalAttempts = 1 + SYNTHID_RETRY_ATTEMPTS;
			// The best draw measured so far, plus the verdict of the draw whose
			// pixels are currently on the canvas (cleared when a redraw replaces
			// them), so the deliverable attempt can be chosen after the loop.
			let bestDraw: { image: ImageData; warnings: string[]; confidence: number } | null = null;
			let drawnCheck: SynthidDetection | null = null;
			for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
				// Warnings describe the delivered bytes, so a discarded attempt
				// must not leave its skip warnings behind for the next attempt
				// to inherit. The checkpoint restores the pre-attempt state when
				// the retry rule fires below.
				const warningsCheckpoint = warnings.length;
				if (attempt > 0) {
					// Start from the pre-pipeline state rather than the previous
					// attempt's output, so retries are independent draws and the
					// quality cost never compounds. The clear is required because
					// drawImage composites: without it, transparent and
					// semi-transparent source pixels would retain the previous
					// attempt's distortion.
					ctx.clearRect(0, 0, canvas.width, canvas.height);
					ctx.drawImage(img, 0, 0);
					drawnCheck = null;
					if (options.applyBlur && options.blurRadius > 0) {
						const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
						applyBlurEffect(imageData, options);
						ctx.putImageData(imageData, 0, 0);
					}
				}
				await applySynthidPipeline(canvas, synthid, warnings);
				// The LSB pass runs on the canvas before probing, so the probe
				// encodes exactly the bytes the download will use, including
				// the randomize draw.
				applyCanvasLsbPass(ctx, canvas, options);
				// Retrying is only meaningful when the detector can actually
				// read the watermark; an inconclusive size would redraw on noise.
				if (!inputCheck?.isWatermarked || !inputCheck.conclusive) break;
				try {
					// Probe with the same encoder the download will use, so a
					// retry only happens when the bytes the user would get
					// still read as watermarked.
					const probe = await canvasToBlob(canvas, outputMime, quality);
					if (probe.type !== outputMime) break;
					// Hashing the probe lets the final verification below reuse
					// this verdict because the final encode re-encodes the same
					// canvas pixels.
					const probeHash = await computeSha256(probe);
					const check = await detectSynthidCached(probe, probeHash);
					// Keep the strongest evidence of removal across draws: the
					// lowest confidence wins, and its pixels and warnings are
					// snapshotted together so the delivered bytes always match
					// the verdict they were measured with.
					drawnCheck = check;
					if (!bestDraw || check.confidence < bestDraw.confidence) {
						bestDraw = {
							image: ctx.getImageData(0, 0, canvas.width, canvas.height),
							warnings: [...warnings],
							confidence: check.confidence,
						};
					}
					// Only a trusted output flag justifies a redraw; an
					// inconclusive output size would redraw on noise.
					if (!shouldRetrySynthidAttempt(inputCheck.isWatermarked, check.conclusive && check.isWatermarked, attempt, totalAttempts)) break;
					// The next attempt redraws from the pristine source with a
					// fresh random draw, so this attempt's verdicts are replaced.
					warnings.length = warningsCheckpoint;
				} catch {
					// The probe is additive; the final verification below still
					// reports the downloaded bytes honestly.
					break;
				}
			}
			// The loop stops on the first draw that reads clean, with that draw
			// on the canvas. When the canvas holds a flagged draw, or a draw
			// whose probe failed before measuring it, put the least watermarked
			// measured draw back instead of the last: draws differ in luck as
			// much as strength, so ending on an unlucky roll or on an unmeasured
			// one would report a worse verdict than an earlier draw earned.
			if (bestDraw && shouldRestoreBestDraw(bestDraw, drawnCheck)) {
				ctx.putImageData(bestDraw.image, 0, 0);
				warnings.length = 0;
				warnings.push(...bestDraw.warnings);
			}
		} else {
			// Without the SynthID pipeline the LSB pass still runs once here;
			// with it, each attempt above already applied it.
			applyCanvasLsbPass(ctx, canvas, options);
		}

		// Snapshot the canvas immediately before serialization. Like every
		// other gate under marginal semantics, the final encode is measured
		// against its own input rather than against some earlier stage's
		// result, so it cannot be blamed for cumulative drift and the user's
		// chosen quality is respected within a small bounded margin. It is
		// built only when the SynthID pipeline is active, so its nullness
		// tracks synthid.enabled exactly as encodeStaticImage expects. On the
		// JPEG path the same fresh buffer also drives the transparency
		// warning, avoiding a second full-canvas read. The alias stays valid
		// only because encodeStaticImage re-encodes without mutating the
		// canvas before reading it.
		let preEncode: Uint8ClampedArray | null = null;
		if (outputMime === 'image/jpeg') {
			const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
			// Canvas JPEG encoding flattens transparency onto black, so warn
			// regardless of whether SynthID removal is enabled.
			if (scanHasAlpha(data)) {
				warnings.push('JPEG output discards transparency from the input image.');
			}
			if (synthid.enabled) preEncode = data;
		} else if (synthid.enabled) {
			preEncode = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		}
		const blob = await encodeStaticImage(canvas, outputMime, quality, synthid, preEncode, warnings);
		// The caller needs this hash for the identical-output check, so compute
		// it once here and share it with the output-side SynthID cache.
		const outputHash = await computeSha256(blob);

		// Report the detector verdict only when the SynthID attack actually ran
		// or the input looked watermarked. A clean input under a detected scope
		// skips removal entirely, so a verdict line there would claim a check
		// the user scoped out; a flagged input still reports even when a gate
		// skipped the attack, so the skip stays visible next to the verdict
		// that triggered it.
		const shouldVerify = inputCheck !== null && (synthid.enabled || inputCheck.isWatermarked);
		const synthidCheck = shouldVerify ? await verifyOutputSynthid(blob, synthid, inputCheck, warnings, outputHash) : undefined;

		return { blob, warnings, synthidCheck, outputHash };
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
	inputHash: string,
	warnings: string[] = []
): Promise<ProcessingOutput> {
	const buffer = new Uint8Array(await readFileAsArrayBuffer(file));
	const reader = new GifReader(buffer);
	const width = reader.width;
	const height = reader.height;
	const frameCount = reader.numFrames();
	const estimatedSize = validateGifAllocation(width, height, frameCount);
	// When scoped to detected images, skip the heavy per-frame attack on clean
	// GIFs. This runs before the pixel-limit guard so a clean oversized GIF is
	// not mistaken for one that exceeded the limit. The other steganography
	// options still apply per frame below; only SynthID removal is gated.
	let synthid = options.synthid;
	// Input verdict from the sampled composed frames, shared with the
	// pre-flight pass and repeat runs through the content-hash verdict cache,
	// so the frame composition and detector only run once per GIF. A
	// conclusive watermark in any sampled frame enables removal and is the
	// reported verdict; otherwise the first sampled frame's verdict is
	// reported.
	let inputCheck: SynthidDetection | null = null;
	try {
		inputCheck = await detectSynthidCached(file, inputHash);
	} catch {
		// Detection is additive; a missing verdict degrades to no gating.
		inputCheck = null;
	}
	synthid = gateSynthidByDetection(synthid, options.synthidScope, inputCheck, warnings);

	// Oversized GIFs skip SynthID processing entirely rather than failing;
	// the standard steganography options still run.
	if (synthid.enabled && width * height * frameCount > MAX_SYNTHID_GIF_PIXELS) {
		warnings.push(`SynthID removal was skipped because the GIF exceeds the ${MAX_SYNTHID_GIF_PIXELS.toLocaleString()} total frame pixel limit; other options were applied.`);
		synthid = { ...synthid, enabled: false };
	}

	const frames: { indices: Uint8Array; palette: number[]; delay: number; transparentIndex: number }[] = [];

	// Generate the random attack parameters once so all frames warp consistently.
	const synthidState = synthid.enabled ? buildSynthidRandomState(width, height, synthid) : null;
	// Same per-file draw policy for the palette LSB pass: every frame rebuilds
	// the generator from one seed, so identical palettes get identical low bits
	// instead of flickering between frames.
	const paletteLsbSeed = Math.floor(Math.random() * 4294967296);
	// Reduced palette depth acts as the GIF path's single simulated re-encode
	// round. Median-cut is idempotent at a fixed depth, so additional rounds
	// would not add loss; the configured round count therefore only switches
	// this one round on or off.
	const gifMaxColors = synthidState !== null && synthid.reencodeRounds > 0
		? gifQualityToMaxColors(synthid.reencodeQuality)
		: GIF_DEFAULT_MAX_COLORS;
	if (synthidState) {
		const gifSpatialWork = synthidState.tileShift !== null
			|| synthidState.affine !== null
			|| synthidState.color !== null
			|| (Number.isFinite(synthid.squeezeFactor) && synthid.squeezeFactor > 0 && synthid.squeezeFactor < 1)
			|| synthid.lumaNoise > 0
			|| synthid.bilateral;
		const gifNotes: string[] = [];
		if (gifSpatialWork) {
			gifNotes.push('every frame is distorted unconditionally to avoid flicker, and the quality floor (PSNR) is not applied to animated frames');
		}
		if (synthid.reencodeRounds > 1) {
			gifNotes.push('re-encode rounds are capped at one: the reduced-palette quantization is idempotent, so extra rounds would not add further loss');
		}
		if (synthid.reencodeRounds > 0 && gifMaxColors === GIF_DEFAULT_MAX_COLORS) {
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

		// Process the composed full canvas. SynthID distortion stages run
		// unconditionally on every frame: judging acceptance per frame would
		// make the structural stages flip on and off between neighboring
		// frames, which shows up as visible pulsing in the finished animation.
		// Palette reduction is intentionally left to the serialization pass
		// below, which runs the identical idempotent median-cut at the same
		// depth and reuses its mapping.
		const imageData = new ImageData(new Uint8ClampedArray(canvas), width, height);
		applyBlurEffect(imageData, options);
		if (synthidState) {
			// The real warnings array is passed so a later switch to per-frame
			// gating surfaces floor skips instead of silently dropping them.
			await applySynthidDistortionStages(imageData, synthidState, synthid, false, warnings);
			await applySynthidSmoothingStage(imageData, synthid, false, warnings);
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
		const quantized = synthidState && gifMaxColors < GIF_DEFAULT_MAX_COLORS
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

	// Same verdict rule as the static path: report only when the attack ran or
	// the input looked watermarked.
	const shouldVerify = inputCheck !== null && (synthid.enabled || inputCheck.isWatermarked);
	const synthidCheck = shouldVerify ? await verifyOutputSynthid(blob, synthid, inputCheck, warnings, outputHash) : undefined;

	return { blob, warnings, synthidCheck, outputHash };
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
			// A still image routed through FFmpeg (a GIF converted to MP4) is
			// still covered by the detector, so fetch its cached verdict;
			// real videos have no verdict to offer. The verdict feeds both the
			// scope gate and the result reporting, so it is fetched whenever
			// the detector can produce one instead of only when the gate
			// consults it, matching the static image and GIF paths.
			let inputCheck: SynthidDetection | null = null;
			if (!inputMime.startsWith('video/')) {
				try {
					inputCheck = await detectSynthidCached(file, inputHash);
				} catch {
					// The scope gate reports the failed detection as a warning.
				}
			}
			output = await processVideo(file, options, onVideoStatus, inputCheck, outputWarnings);
		} else if (inputMime === 'image/gif') {
			output = await processAnimatedGif(file, options, inputHash, outputWarnings);
		} else {
			output = await processStaticImage(file, options, inputHash, outputWarnings);
		}
		const { blob, warnings, synthidCheck, outputHash: processedOutputHash } = output;

		// Image paths already hashed their output for the verdict cache; only
		// video output reaches here without one.
		const outputHash = processedOutputHash ?? (await computeSha256(blob));

		if (inputHash === outputHash) {
			// LSB/blur/JPEG are images-only; video inputs only get metadata
			// stripping plus the SynthID approximations, so tailor the advice.
			const identicalError = routesToVideo(inputMime, outputMime)
				? 'Output is identical to input. No steganography was removed. Enable SynthID removal.'
				: 'Output is identical to input. No steganography was removed. Enable SynthID removal, LSB clearing, blur, or JPEG re-compression.';
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
				synthidCheck,
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
			synthidCheck,
		};
	} catch (err) {
		// Surface warnings gathered before the failure (e.g. gate notes,
		// GIF approximation notes, or FFmpeg fallback notes) alongside the
		// error.
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

function getSynthidPresetFromGroup(): SynthidPreset | null {
	const value = getSelectedRadioValue(synthidPresetGroup);
	if (value === 'gentle' || value === 'balanced' || value === 'aggressive') {
		return SYNTHID_PRESETS[value];
	}
	return null;
}

function applySynthidPreset(preset: SynthidPreset): void {
	synthidElasticInput.value = String(preset.elasticAlpha);
	synthidSigmaInput.value = String(preset.elasticSigma);
	synthidRotationInput.value = String(preset.rotationJitter);
	synthidSqueezeInput.value = String(preset.squeezeFactor);
	synthidColorInput.value = String(preset.colorAmount);
	synthidNoiseInput.value = String(preset.lumaNoise);
	synthidRoundsInput.value = String(preset.reencodeRounds);
	synthidQualityInput.value = String(preset.reencodeQuality);
	synthidPsnrFloorInput.value = String(preset.psnrFloor);
	synthidBilateralInput.checked = preset.bilateral;
	refreshSynthidDisplays();
}

function refreshSynthidDisplays(): void {
	synthidElasticValue.textContent = `${synthidElasticInput.value}px`;
	synthidSigmaValue.textContent = `${synthidSigmaInput.value}px`;
	synthidRotationValue.textContent = `${synthidRotationInput.value}°`;
	synthidSqueezeValue.textContent = `${parseFloat(synthidSqueezeInput.value).toFixed(2)}×`;
	synthidColorValue.textContent = `${parseFloat(synthidColorInput.value).toFixed(2)}×`;
	synthidNoiseValue.textContent = synthidNoiseInput.value;
	synthidRoundsValue.textContent = synthidRoundsInput.value;
	synthidQualityValue.textContent = `${synthidQualityInput.value}%`;
	synthidPsnrFloorValue.textContent = `${synthidPsnrFloorInput.value} dB`;
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
	const preset = SYNTHID_PRESETS.balanced;
	return {
		clearLsb: clearLsbInput.checked,
		randomizeLsb: randomizeLsbInput.checked,
		applyBlur: applyBlurInput.checked,
		blurRadius: clampToSlider(blurRadiusInput, parseNumber(blurRadiusInput.value, 1), 1),
		jpegRecompress: jpegRecompressInput.checked,
		jpegQuality: clampToSlider(jpegQualityInput, parseInteger(jpegQualityInput.value, 85), 85),
		synthid: {
			enabled: synthidAttackInput.checked,
			elasticAlpha: clampToSlider(synthidElasticInput, parseNumber(synthidElasticInput.value, preset.elasticAlpha), preset.elasticAlpha),
			elasticSigma: clampToSlider(synthidSigmaInput, parseNumber(synthidSigmaInput.value, preset.elasticSigma), preset.elasticSigma),
			rotationJitter: clampToSlider(synthidRotationInput, parseNumber(synthidRotationInput.value, preset.rotationJitter), preset.rotationJitter),
			squeezeFactor: clampSqueezeFactor(parseNumber(synthidSqueezeInput.value, 1)),
			colorAmount: clampToSlider(synthidColorInput, parseNumber(synthidColorInput.value, preset.colorAmount), preset.colorAmount),
			lumaNoise: clampToSlider(synthidNoiseInput, parseNumber(synthidNoiseInput.value, preset.lumaNoise), preset.lumaNoise),
			reencodeRounds: clampToSlider(synthidRoundsInput, parseInteger(synthidRoundsInput.value, preset.reencodeRounds), preset.reencodeRounds),
			reencodeQuality: clampToSlider(synthidQualityInput, parseInteger(synthidQualityInput.value, preset.reencodeQuality), preset.reencodeQuality),
			bilateral: synthidBilateralInput.checked,
			psnrFloor: clampToSlider(synthidPsnrFloorInput, parseInteger(synthidPsnrFloorInput.value, preset.psnrFloor), preset.psnrFloor),
		},
		synthidScope: (getSelectedRadioValue(synthidScopeGroup) || 'detected') as ProcessingOptions['synthidScope'],
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

		// Only a trusted verdict earns the badge; an inconclusive clean match
		// too small to carry the carriers would advertise a detection the
		// detector cannot actually back up.
		if (queued.synthidDetected?.isWatermarked && queued.synthidDetected.conclusive) {
			info.append(createSynthidBadge(queued.synthidDetected));
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
		if (!isVideoFile(file)) {
			// Best-effort pre-check that runs in the background so the file
			// list can appear immediately and then update with the verdict.
			// Detections are serialized so a large batch doesn't run several
			// multi-FFT passes at once and freeze the page.
			enqueuePreflight(queued);
		}
	}
	updateFileList();
	if (skipped.length > 0) {
		const shown = skipped.slice(0, 3).join(', ');
		const extra = skipped.length > 3 ? ` and ${skipped.length - 3} more` : '';
		setProgress(0, `Skipped ${skipped.length} unsupported file${skipped.length === 1 ? '' : 's'} (${shown}${extra}). Use PNG, JPEG, WebP, BMP, GIF, or supported video.`);
	}
}

// Serial queue for the background pre-flight SynthID checks. Delegates to the
// same decoder used for output verification so the badge verdict and the
// processing-time probe share one decoder per format: GIFs are blitted through
// the GIF reader on both sides (magic-sniffed, not MIME-sniffed), while static
// images both decode via createImageBitmap with pinned orientation.
let preflightQueue: Promise<void> = Promise.resolve();
// Epoch bumped by clearAll so stale queued detections become cheap no-ops
// instead of running multi-FFT passes behind new files.
let preflightEpoch = 0;
// Gate that parks queued pre-flight checks while batch processing runs, so
// their multi-FFT passes do not interleave with the pipeline's own detection
// work on the main thread. The one detection already executing when the gate
// closes is awaited by pausePreflights before processing begins.
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
	preflightQueue = preflightQueue.then(async () => {
		if (epoch !== preflightEpoch) return;
		if (preflightGate) await preflightGate;
		if (epoch !== preflightEpoch) return;
		const run = async () => {
			try {
				// Check before hashing so a file removed while its pre-flight
				// waited in the serial queue is not read and hashed for nothing;
				// re-check after the hash await because the queue can change.
				if (epoch !== preflightEpoch) return;
				if (!queuedFiles.includes(queued)) return;
				const inputHash = queued.inputHash ?? (await computeSha256(queued.file));
				queued.inputHash = inputHash;
				if (epoch !== preflightEpoch) return;
				if (!queuedFiles.includes(queued)) return;
				const detection = await detectSynthidCached(queued.file, inputHash);
				if (epoch !== preflightEpoch) return;
				if (!queuedFiles.includes(queued)) return;
				queued.synthidDetected = detection;
				updateQueuedBadge(queued);
			} catch {}
		};
		preflightInflight = run();
		await preflightInflight;
	});
}

// Builds the clickable "SynthID detected" badge for a queued image.
function createSynthidBadge(detection: SynthidDetection): HTMLButtonElement {
	const badge = document.createElement('button');
	badge.type = 'button';
	badge.className = 'file-item__synthid';
	badge.title = `Statistical detector flagged this image (${Math.floor(detection.confidence * 100)}% confidence). Enable the SynthID option to attempt removal.`;
	badge.textContent = 'SynthID detected';
	badge.addEventListener('click', () => {
		synthidAttackInput.checked = true;
		synthidAttackInput.dispatchEvent(new Event('change'));
	});
	return badge;
}

// Refreshes just one file item's badge after its detection resolves, without
// re-rendering the whole (possibly paginated) list.
function updateQueuedBadge(queued: QueuedFile): void {
	const li = fileList.querySelector<HTMLElement>(`[data-id="${CSS.escape(queued.id)}"]`);
	if (!li) return;
	const info = li.querySelector('.file-item__info');
	if (!info) return;
	const existing = li.querySelector('.file-item__synthid');
	if (existing) existing.remove();
	if (queued.synthidDetected?.isWatermarked && queued.synthidDetected.conclusive) {
		info.append(createSynthidBadge(queued.synthidDetected));
	}
}

// Appends the "SynthID check: input …, output …" verdict line to a result
// item's info block, flagging it when the output is still watermarked.
function appendSynthidVerdict(info: HTMLElement, check: SynthidCheckResult): void {
	const { input, output } = check;
	const formatVerdict = (detection: SynthidDetection) =>
		// A size too small to carry the profile's carriers carries no
		// trustworthy signal, so it reports as inconclusive rather than
		// borrowing the confidence percentage. Floor, not round: a heuristic
		// verdict should never display as 100%.
		detection.conclusive
			? `${detection.isWatermarked ? 'detected' : 'not detected'} (${Math.floor(detection.confidence * 100)}%)`
			: 'inconclusive (size too small)';
	const synthidLine = document.createElement('p');
	synthidLine.className = 'result-item__synthid';
	if (output?.isWatermarked && output.conclusive) synthidLine.classList.add('result-item__synthid--flagged');
	synthidLine.textContent = `SynthID check: input ${formatVerdict(input)}, output ${output ? formatVerdict(output) : 'unavailable'}`;
	const formatProfile = (detection: SynthidDetection) =>
		!detection.conclusive
			? `${detection.profileKey} (size too small for a trusted check)`
			: detection.exactMatch ? detection.profileKey : `${detection.profileKey} (scaled match)`;
	synthidLine.title = `Statistical carrier-phase detector tuned for Gemini model generations, not Google's own verifier. Profiles: input ${formatProfile(input)}, output ${output ? formatProfile(output) : 'unavailable'}.`;
	info.append(synthidLine);
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
			if (result.synthidCheck) appendSynthidVerdict(info, result.synthidCheck);
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

			if (result.synthidCheck) appendSynthidVerdict(info, result.synthidCheck);
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
		clearAllBtn.disabled = false;
		fileInput.disabled = false;
		updateFileList();
		updateResults();
	}
}

function clearAll(): void {
	if (isProcessing || isZipping) return;
	preflightEpoch += 1;
	// Drop cached verdicts with the queue so a long session does not retain
	// detections for files the user has cleared. Verdicts for files removed
	// individually stay cached until this full clear.
	synthidVerdicts.clear();
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

synthidAttackInput.addEventListener('change', () => {
	if (!synthidAttackInput.checked) synthidAdvancedExpanded = false;
	updateSynthidAdvancedVisibility();
});

synthidAdvancedToggle.addEventListener('click', () => {
	synthidAdvancedExpanded = !synthidAdvancedExpanded;
	updateSynthidAdvancedVisibility();
});

function updateSynthidAdvancedVisibility(): void {
	const enabled = synthidAttackInput.checked;
	synthidScopeWrap.hidden = !enabled;
	synthidAdvancedToggle.hidden = !enabled;
	const expanded = enabled && synthidAdvancedExpanded;
	synthidSettingsGroup.hidden = !expanded;
	synthidAdvancedToggle.setAttribute('aria-expanded', String(expanded));
}

synthidPresetGroup.addEventListener('change', () => {
	const preset = getSynthidPresetFromGroup();
	if (preset) applySynthidPreset(preset);
});

// Manual adjustments no longer match any preset, so clear the selection.
function clearSynthidPresetSelection(): void {
	for (const radio of synthidPresetGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]')) {
		radio.checked = false;
	}
}

const synthidSliders = [
	synthidElasticInput,
	synthidSigmaInput,
	synthidRotationInput,
	synthidSqueezeInput,
	synthidColorInput,
	synthidNoiseInput,
	synthidRoundsInput,
	synthidQualityInput,
	synthidPsnrFloorInput,
];
for (const slider of synthidSliders) {
	slider.addEventListener('input', () => {
		clearSynthidPresetSelection();
		refreshSynthidDisplays();
	});
}
synthidBilateralInput.addEventListener('change', clearSynthidPresetSelection);

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
updateSynthidAdvancedVisibility();
applySynthidPreset(SYNTHID_PRESETS.balanced);
setProgress(0, 'Ready');

export { processVideo, processAnimatedGif, detectBlobSynthid, verifyOutputSynthid, appendSynthidVerdict, processAllFiles };
