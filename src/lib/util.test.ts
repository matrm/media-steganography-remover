import { describe, expect, it, vi } from 'vitest';
import {
	cleanedFileName,
	clampNumber,
	computeSha256,
	createSeededRandom,
	detectInputMime,
	formatBytes,
	formatHash,
	generateId,
	getExtensionFromMime,
	getFileExtension,
	getHashLength,
	getMimeFromExtension,
	getOutputMime,
	isContentDigest,
	isFallbackHash,
	isSupportedFile,
	isVideoFile,
	LARGE_INPUT_BYTES,
	parseInteger,
	parseNumber,
	routesToVideo,
	sha256HexFromBuffer,
} from './util';
import { SCAN_WINDOW_BYTES } from './synthid-metadata';
import type { ProcessingOptions } from './types';

function fakeFile(name: string, type: string): File {
	return { name, type } as unknown as File;
}

function baseOptions(overrides: Partial<ProcessingOptions> = {}): ProcessingOptions {
	return {
		clearLsb: false,
		randomizeLsb: false,
		applyBlur: false,
		blurRadius: 1,
		jpegRecompress: false,
		jpegQuality: 85,
		distort: {
			enabled: false,
			elasticAlpha: 0,
			elasticSigma: 50,
			rotationJitter: 0,
			squeezeFactor: 1,
			colorAmount: 0,
			lumaNoise: 0,
			lumaNoiseStep: 0.1,
			reencodeRounds: 0,
			reencodeQuality: 88,
			bilateral: false,
			psnrFloor: 24,
		},
		outputFormats: {},
		filenameMode: 'suffix',
		outputSuffix: '-clean',
		outputPrefix: 'file',
		prefixStartIndex: 0,
		hashLength: 32,
		...overrides,
	};
}

describe('formatBytes', () => {
	it('formats zero, byte range and unit growth', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(500)).toBe('500 B');
		expect(formatBytes(1024)).toBe('1.00 KB');
		expect(formatBytes(1536 * 1024 * 1024)).toBe('1.50 GB');
	});

	it('caps at the largest unit', () => {
		expect(formatBytes(5 * 1024 ** 4)).toContain('GB');
	});

	it('guards non-finite and negative input', () => {
		expect(formatBytes(NaN)).toBe('0 B');
		expect(formatBytes(-1)).toBe('0 B');
		expect(formatBytes(Infinity)).toBe('0 B');
	});

	it('keeps a valid unit for fractional byte counts', () => {
		expect(formatBytes(0.5)).toBe('1 B');
	});
});

describe('generateId', () => {
	it('produces two base36 parts separated by a dash', () => {
		const id = generateId();
		expect(id).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
	});

	it('still matches the pattern when Math.random returns 0', () => {
		vi.spyOn(Math, 'random').mockReturnValue(0);
		try {
			expect(generateId()).toMatch(/^[0-9a-z]+-[0-9a-z]+$/);
		} finally {
			vi.restoreAllMocks();
		}
	});
});

describe('extension and mime mapping', () => {
	it('round trips common image types', () => {
		for (const [mime, ext] of [
			['image/png', 'png'],
			['image/jpeg', 'jpg'],
			['image/webp', 'webp'],
			['image/gif', 'gif'],
			['image/bmp', 'bmp'],
		] as const) {
			expect(getExtensionFromMime(mime)).toBe(ext);
			expect(getMimeFromExtension(ext)).toBe(mime);
		}
	});

	it('treats unknown extensions as PNG and unknown video mimes as MP4', () => {
		expect(getExtensionFromMime('video/x-fancy')).toBe('mp4');
		expect(getExtensionFromMime('text/plain')).toBe('png');
		expect(getMimeFromExtension('xyz')).toBe('image/png');
	});

	it('maps case-insensitively and recognizes uppercase', () => {
		expect(getMimeFromExtension('PNG')).toBe('image/png');
	});
});

describe('detectInputMime', () => {
	it('prefers the declared file type', () => {
		expect(detectInputMime(fakeFile('x.bin', 'image/webp'))).toBe('image/webp');
		expect(detectInputMime(fakeFile('x.mp4', 'video/mp4'))).toBe('video/mp4');
	});

	it('normalizes the image/jpg alias to image/jpeg', () => {
		expect(detectInputMime(fakeFile('x.jpg', 'image/jpg'))).toBe('image/jpeg');
	});

	it('falls back to the extension for unknown declared types', () => {
		expect(detectInputMime(fakeFile('photo.webp', ''))).toBe('image/webp');
	});
});

describe('getFileExtension', () => {
	it('returns the text after the last dot and nothing without one', () => {
		expect(getFileExtension('movie.mp4')).toBe('mp4');
		expect(getFileExtension('archive.tar.gz')).toBe('gz');
		expect(getFileExtension('dotless')).toBe('');
		expect(getFileExtension('trailing.')).toBe('');
		expect(getFileExtension('.bashrc')).toBe('');
	});
});

describe('isSupportedFile', () => {
	it('accepts browser-typed image and video files', () => {
		expect(isSupportedFile(fakeFile('x', 'image/png'))).toBe(true);
		expect(isSupportedFile(fakeFile('x', 'video/mp4'))).toBe(true);
	});

	it('rejects non-allowlisted image and video types', () => {
		expect(isSupportedFile(fakeFile('x.heic', 'image/heic'))).toBe(false);
		expect(isSupportedFile(fakeFile('x.svg', 'image/svg+xml'))).toBe(false);
	});

	it('accepts extension-allowlisted files only when the type is empty', () => {
		expect(isSupportedFile(fakeFile('clip.mkv', ''))).toBe(true);
		expect(isSupportedFile(fakeFile('photo.bmp', ''))).toBe(true);
		expect(isSupportedFile(fakeFile('notes.txt', ''))).toBe(false);
		expect(isSupportedFile(fakeFile('dotless', ''))).toBe(false);
		expect(isSupportedFile(fakeFile('clip.mkv', 'application/octet-stream'))).toBe(false);
	});
});

describe('isVideoFile', () => {
	it('falls back to the extension when the type is empty', () => {
		expect(isVideoFile(fakeFile('clip.mkv', ''))).toBe(true);
		expect(isVideoFile(fakeFile('photo.bmp', ''))).toBe(false);
		expect(isVideoFile(fakeFile('clip.mkv', 'application/octet-stream'))).toBe(false);
	});

	it('tolerates a missing type without throwing', () => {
		const noType = { name: 'clip.mkv' } as unknown as File;
		expect(isVideoFile(noType)).toBe(true);
		expect(isSupportedFile(noType)).toBe(true);
		expect(detectInputMime(noType)).toBe('video/x-matroska');
	});
});

describe('getOutputMime', () => {
	it('keeps recognizable input formats without overrides', () => {
		const options = baseOptions();
		expect(getOutputMime('image/png', options)).toBe('image/png');
		expect(getOutputMime('image/gif', options)).toBe('image/gif');
	});

	it('forces JPEG on recompress except for GIF input', () => {
		const options = baseOptions({ jpegRecompress: true });
		expect(getOutputMime('image/webp', options)).toBe('image/jpeg');
		expect(getOutputMime('image/gif', options)).toBe('image/gif');
	});

	it('honors per-extension output format overrides but not auto', () => {
		const options = baseOptions({
			outputFormats: { webp: 'image/png', png: 'auto' },
		});
		expect(getOutputMime('image/webp', options)).toBe('image/png');
		expect(getOutputMime('image/png', options)).toBe('image/png');
	});

	it('always returns MP4 for video input', () => {
		expect(getOutputMime('video/quicktime', baseOptions())).toBe('video/mp4');
	});

	it('falls back to PNG for unmanaged image types', () => {
		// BMP input is handled by the canvas pipeline, which re-encodes to the
		// default PNG unless an explicit override exists.
		expect(getOutputMime('image/bmp', baseOptions())).toBe('image/png');
		expect(getOutputMime('application/octet-stream', baseOptions())).toBe('image/png');
	});
});

describe('cleanedFileName', () => {
	it('appends the suffix in suffix mode with a fallback default', () => {
		const options = baseOptions({ filenameMode: 'suffix', outputSuffix: '' });
		expect(cleanedFileName('photo.old.png', 'image/png', options, 0, 'ab')).toBe('photo.old-clean.png');
	});

	it('numbers files in prefix mode from the start index', () => {
		const options = baseOptions({ filenameMode: 'prefix', outputPrefix: 'img-', prefixStartIndex: 7 });
		expect(cleanedFileName('any.png', 'image/jpeg', options, 3, 'ab')).toBe('img-10.jpg');
	});

	it('names files after the hash in hash mode respecting length', () => {
		const full = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
		for (const hashLength of [16, 32, 'full'] as const) {
			const options = baseOptions({ filenameMode: 'hash', hashLength });
			const expected = `${hashLength === 'full' ? full : full.slice(0, hashLength)}.png`;
			expect(cleanedFileName('x.gif', 'image/png', options, 0, full)).toBe(expected);
		}
	});
});

describe('formatHash and getHashLength', () => {
	const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
	it('slices or keeps the digest', () => {
		expect(formatHash(hash, 16)).toBe(hash.slice(0, 16));
		expect(formatHash(hash, 'full')).toBe(hash);
	});

	it('defaults invalid hash length selections to 32', () => {
		expect(getHashLength('48')).toBe(32);
		expect(getHashLength('')).toBe(32);
		expect(getHashLength('full')).toBe('full');
	});

	it('returns numeric lengths for numeric selections', () => {
		expect(getHashLength('16')).toBe(16);
		expect(getHashLength('32')).toBe(32);
		expect(typeof getHashLength('16')).toBe('number');
	});
});

describe('parseNumber and parseInteger', () => {
	it('returns parsed values for valid input', () => {
		expect(parseNumber('2.5', 0)).toBe(2.5);
		expect(parseInteger('42', 0)).toBe(42);
	});

	it('falls back on empty, garbage and non-finite values', () => {
		for (const bad of ['', 'abc', 'Infinity', '-Infinity', 'NaN']) {
			expect(parseNumber(bad, -1)).toBe(-1);
			expect(parseInteger(bad, -1)).toBe(-1);
		}
	});

	it('keeps fractional values in parseNumber and truncates only in parseInteger', () => {
		expect(parseNumber('2.75', 0)).toBe(2.75);
		expect(parseInteger('2.75', 0)).toBe(2);
	});

	it('rejects trailing garbage instead of parsing a prefix', () => {
		expect(parseNumber('123abc', -1)).toBe(-1);
		expect(parseInteger('123abc', -1)).toBe(-1);
		expect(parseInteger('42.9', 0)).toBe(42);
	});
});

describe('clampNumber', () => {
	it('bounds values into the range', () => {
		expect(clampNumber(999, 1, 100, 85)).toBe(100);
		expect(clampNumber(-5, 1, 100, 85)).toBe(1);
		expect(clampNumber(42, 1, 100, 85)).toBe(42);
	});

	it('falls back on non-finite values', () => {
		expect(clampNumber(NaN, 1, 100, 85)).toBe(85);
		expect(clampNumber(Infinity, 1, 100, 85)).toBe(85);
	});
});

describe('computeSha256', () => {
	it('matches the known empty-input digest', async () => {
		const blob = new Blob([new TextEncoder().encode('')]);
		await expect(computeSha256(blob)).resolves.toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
	});

	it('falls back to a prefixed fingerprint without crypto.subtle', async () => {
		const realCrypto = globalThis.crypto;
		vi.stubGlobal('crypto', undefined);
		try {
			const encoder = new TextEncoder();
			const first = await computeSha256(new Blob([encoder.encode('abc')]));
			expect(first).toMatch(/^fnv1a-[0-9a-f]{16}$/);
			// A wider fingerprint still has to separate different content.
			await expect(computeSha256(new Blob([encoder.encode('abd')]))).resolves.not.toBe(first);
		} finally {
			vi.stubGlobal('crypto', realCrypto);
		}
	});

	it('distinguishes fallback fingerprints from SHA-256 digests', () => {
		expect(isFallbackHash('fnv1a-0123abcd')).toBe(true);
		expect(isFallbackHash('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(false);
	});
});

describe('sha256HexFromBuffer', () => {
	it('agrees with computeSha256 on the same bytes', async () => {
		// The pre-flight digests a buffer it read for another reason, so the two
		// entry points must produce the same key or a file's content key would
		// depend on which caller hashed it.
		const bytes = new TextEncoder().encode('the quick brown fox');
		await expect(sha256HexFromBuffer(bytes.buffer as ArrayBuffer))
			.resolves.toBe(await computeSha256(new Blob([bytes])));
	});

	it('falls back to the same prefixed fingerprint without crypto.subtle', async () => {
		const realCrypto = globalThis.crypto;
		vi.stubGlobal('crypto', undefined);
		try {
			const bytes = new TextEncoder().encode('abc');
			const digest = await sha256HexFromBuffer(bytes.buffer as ArrayBuffer);
			expect(digest).toMatch(/^fnv1a-[0-9a-f]{16}$/);
			await expect(sha256HexFromBuffer(bytes.buffer as ArrayBuffer)).resolves.toBe(digest);
		} finally {
			vi.stubGlobal('crypto', realCrypto);
		}
	});
});

describe('isContentDigest', () => {
	it('accepts a SHA-256 digest as a cache key', () => {
		expect(isContentDigest('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true);
	});

	it('rejects the non-cryptographic fallback fingerprint', () => {
		// The fallback is not collision-resistant, so a declaration cached
		// under one could belong to a different file.
		expect(isContentDigest('fnv1a-0123abcd0123abcd')).toBe(false);
	});
});

describe('LARGE_INPUT_BYTES', () => {
	it('sits above the total the bounded declaration scan can read', () => {
		// Above this size nothing is digested eagerly, which only pays off
		// while the bounded scan reads less than a digest of the whole file
		// would. Asserting against the scanner's own exported total rather
		// than restating it here is what makes the two stay in step when a
		// window grows.
		expect(LARGE_INPUT_BYTES).toBeGreaterThan(SCAN_WINDOW_BYTES);
	});
});

describe('createSeededRandom', () => {
	it('replays the same sequence for one seed and differs across seeds', () => {
		const first = createSeededRandom(1234);
		const second = createSeededRandom(1234);
		const values = Array.from({ length: 5 }, () => first());
		expect(Array.from({ length: 5 }, () => second())).toEqual(values);
		for (const value of values) {
			expect(value).toBeGreaterThanOrEqual(0);
			expect(value).toBeLessThan(1);
		}
		const other = createSeededRandom(9999);
		expect(other()).not.toBe(values[0]);
	});
});

describe('routesToVideo', () => {
	it('sends every video input through FFmpeg regardless of output', () => {
		expect(routesToVideo('video/mp4', 'video/mp4')).toBe(true);
		expect(routesToVideo('video/quicktime', 'video/mp4')).toBe(true);
	});

	it('sends GIF inputs through FFmpeg only for video outputs', () => {
		expect(routesToVideo('image/gif', 'video/mp4')).toBe(true);
		expect(routesToVideo('image/gif', 'image/gif')).toBe(false);
	});

	it('keeps static images on the canvas pipeline', () => {
		expect(routesToVideo('image/png', 'image/png')).toBe(false);
		expect(routesToVideo('image/png', 'image/jpeg')).toBe(false);
	});
});
