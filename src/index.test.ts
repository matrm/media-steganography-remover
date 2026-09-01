import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GifReader, GifWriter } from 'omggif';
import type { ProcessingOptions, SynthidDetection } from './lib/types';
import { SYNTHID_PRESETS, isSubLevelVideoNoise, subLevelVideoNoiseWarning } from './lib/synthid';

const mocks = vi.hoisted(() => ({
	instances: [] as Array<{
		load: ReturnType<typeof vi.fn>;
		terminate: ReturnType<typeof vi.fn>;
		writeFile: ReturnType<typeof vi.fn>;
		on: ReturnType<typeof vi.fn>;
		off: ReturnType<typeof vi.fn>;
	}>,
	load: vi.fn(),
	write: vi.fn(),
	exec: vi.fn(),
	detect: vi.fn(),
	zip: vi.fn(),
	background: vi.fn(),
	decode: vi.fn(),
	reader: vi.fn(),
	gifSize: null as null | { width: number; height: number; frames: number },
}));

vi.mock('./style.css', () => ({}));
vi.mock('./lib/synthid-detect', () => ({ detectSynthid: mocks.detect }));
vi.mock('@ffmpeg/ffmpeg', () => ({
	FFmpeg: class {
		load = vi.fn(() => mocks.load());
		terminate = vi.fn();
		on = vi.fn();
		off = vi.fn();
		writeFile = vi.fn(async (_name: string, data: Uint8Array) => {
			const transferred = structuredClone(data, { transfer: [data.buffer] });
			await mocks.write(transferred);
		});
		exec = vi.fn(() => mocks.exec());
		readFile = vi.fn(async () => new Uint8Array([9, 8, 7]));
		deleteFile = vi.fn(async () => {});
		constructor() { mocks.instances.push(this); }
	},
}));
vi.mock('jszip', () => ({ default: class {
	file = vi.fn();
	generateAsync = mocks.zip;
} }));
vi.mock('omggif', async (importOriginal) => {
	const actual = await importOriginal<typeof import('omggif')>();
	return { ...actual, GifReader: class {
		constructor(bytes: Uint8Array) {
			mocks.reader();
			const reader = new actual.GifReader(bytes);
			if (mocks.gifSize) {
				reader.width = mocks.gifSize.width;
				reader.height = mocks.gifSize.height;
				reader.numFrames = () => mocks.gifSize!.frames;
				reader.decodeAndBlitFrameRGBA = mocks.decode;
			}
			return reader;
		}
	} };
});
vi.mock('./lib/quantize', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./lib/quantize')>();
	return { ...actual, getGifBackground: (...args: Parameters<typeof actual.getGifBackground>) => {
		mocks.background();
		return actual.getGifBackground(...args);
	} };
});

class Element {
	children: Element[] = [];
	parent: Element | null = null;
	id = '';
	className = '';
	htmlFor = '';
	textContent = '';
	title = '';
	value = '';
	min = '0';
	max = '100';
	checked = false;
	disabled = false;
	hidden = false;
	files: File[] = [];
	dataset: Record<string, string> = {};
	style: Record<string, string> = {};
	attributes: Record<string, string> = {};
	listeners = new Map<string, Array<(event: Event) => void>>();
	classList = {
		add: (name: string) => { if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim(); },
		remove: (name: string) => { this.className = this.className.split(' ').filter((entry) => entry !== name).join(' '); },
		contains: (name: string) => this.className.split(' ').includes(name),
	};
	constructor(public tagName = 'div') {}
	set innerHTML(_value: string) { this.children = []; }
	append(...nodes: Element[]) {
		for (const node of nodes) {
			node.parent = this;
			this.children.push(node);
			if (this.tagName === 'select' && this.children.length === 1) this.value = node.value;
		}
	}
	remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
	setAttribute(key: string, value: string) { this.attributes[key] = value; }
	addEventListener(type: string, listener: (event: Event) => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	removeEventListener(type: string, listener: (event: Event) => void) {
		this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
	}
	dispatchEvent(event: Event) {
		for (const listener of this.listeners.get(event.type) ?? []) listener(event);
		return !event.defaultPrevented;
	}
	querySelectorAll(selector: string): Element[] {
		const matches = (element: Element) => selector.startsWith('.')
			? element.classList.contains(selector.slice(1))
			: selector.startsWith('[data-id="')
				? element.dataset.id === selector.slice(10, -2)
				: selector.startsWith('input[')
					? element.tagName === 'input' && (!selector.endsWith(':checked') || element.checked)
					: element.tagName === selector;
		return this.children.flatMap((child) => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
	}
	querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
	click() { this.dispatchEvent(new Event('click')); }
}

class VideoElement extends Element {
	set src(_value: string) { queueMicrotask(() => this.dispatchEvent(new Event('error'))); }
}

let elements: Map<string, Element>;
let app: typeof import('./index');
const node = (id: string) => {
	if (!elements.has(id)) {
		const element = new Element();
		element.id = id;
		elements.set(id, element);
	}
	return elements.get(id)!;
};
const options = (): ProcessingOptions => ({
	clearLsb: false, randomizeLsb: false, applyBlur: false, blurRadius: 0,
	jpegRecompress: false, jpegQuality: 85,
	synthid: { ...SYNTHID_PRESETS.balanced, enabled: false }, synthidScope: 'detected',
	outputFormats: {}, filenameMode: 'suffix', outputSuffix: '-clean', outputPrefix: 'file', prefixStartIndex: 0, hashLength: 32,
});
const verdict: SynthidDetection = {
	isWatermarked: true, confidence: 0.9, phaseMatch: 0.8, profileKey: 'test-profile', exactMatch: true, conclusive: true,
};
function gif(transparent = false): File {
	const bytes = new Uint8Array(1024);
	const writer = new GifWriter(bytes, 1, 1, { palette: [0, 0xffffff] });
	writer.addFrame(0, 0, 1, 1, new Uint8Array([0]), transparent ? { transparent: 0 } : {});
	return new File([bytes.slice(0, writer.end())], 'tiny.gif', { type: 'image/gif' });
}
function drop(...files: File[]) {
	const event = new Event('drop', { cancelable: true });
	Object.assign(event, { dataTransfer: { files } });
	node('drop-zone').dispatchEvent(event);
}
const video = () => new File(['video input'], 'clip.mp4', { type: 'video/mp4' });

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	mocks.instances.length = 0;
	mocks.gifSize = null;
	mocks.load.mockReset().mockResolvedValue(true);
	mocks.write.mockReset().mockResolvedValue(undefined);
	mocks.exec.mockReset().mockResolvedValue(0);
	mocks.detect.mockReset().mockResolvedValue(verdict);
	mocks.zip.mockReset().mockRejectedValue(new Error('ZIP allocation failed'));
	mocks.background.mockReset();
	mocks.decode.mockReset().mockImplementation(() => { throw new Error('decode must not run'); });
	elements = new Map();
	vi.stubGlobal('document', {
		getElementById: node,
		createElement: (tag: string) => tag === 'video' ? new VideoElement(tag) : new Element(tag),
		body: new Element('body'),
	});
	vi.stubGlobal('HTMLVideoElement', VideoElement);
	vi.stubGlobal('ImageData', class {
		constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
	});
	vi.stubGlobal('CSS', { escape: (value: string) => value });
	vi.stubGlobal('location', { href: 'https://example.test/app/' });
	vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('decode unavailable')));
	vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))));
	vi.stubGlobal('FileReader', class {
		result: ArrayBuffer | null = null;
		onload = () => {};
		async readAsArrayBuffer(file: File) { this.result = await file.arrayBuffer(); this.onload(); }
	});
	vi.spyOn(console, 'error').mockImplementation(() => {});
	app = await import('./index');
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('FFmpeg lifecycle and transferred input', () => {
	it.each([true, false])('reports transparency correctly when writeFile transfers the GIF buffer: %s', async (transparent) => {
		const output = await app.processVideo(gif(transparent), options());
		const data = mocks.instances[0].writeFile.mock.calls[0][1] as Uint8Array;
		expect(data.byteLength).toBe(0);
		expect(mocks.write.mock.calls[0][0].byteLength).toBeGreaterThan(0);
		expect(output.warnings.some((warning) => warning.includes('discards transparency'))).toBe(transparent);
	});

	it('reports the cached input verdict for a still image routed through FFmpeg', async () => {
		const output = await app.processVideo(gif(), options(), undefined, verdict);
		expect(output.synthidCheck).toEqual({ input: verdict, output: null });
	});

	it('retains warnings in the caller collector when the video path fails', async () => {
		mocks.write.mockRejectedValueOnce(new Error('write failed'));
		const warnings: string[] = [];
		await expect(app.processVideo(gif(true), options(), undefined, null, warnings)).rejects.toThrow('write failed');
		expect(warnings.some((warning) => warning.includes('discards transparency'))).toBe(true);
	});

	it('terminates a failed load and retries with a fresh worker', async () => {
		mocks.load.mockRejectedValueOnce(new Error('load failed'));
		await expect(app.processVideo(video(), options())).rejects.toThrow('load failed');
		await expect(app.processVideo(video(), options())).resolves.toHaveProperty('blob.type', 'video/mp4');
		expect(mocks.instances).toHaveLength(2);
		expect(mocks.instances[0].terminate).toHaveBeenCalledOnce();
	});

	it('terminates and removes listeners after a transferred write fails, then retries fresh', async () => {
		mocks.write.mockRejectedValueOnce(new Error('write failed'));
		await expect(app.processVideo(video(), options())).rejects.toThrow('write failed');
		await expect(app.processVideo(video(), options())).resolves.toHaveProperty('blob.type', 'video/mp4');
		expect(mocks.instances).toHaveLength(2);
		expect(mocks.instances[0].terminate).toHaveBeenCalledOnce();
		for (const [type, listener] of mocks.instances[0].on.mock.calls) {
			expect(mocks.instances[0].off).toHaveBeenCalledWith(type, listener);
		}
		expect(mocks.instances[0].off).toHaveBeenCalledTimes(2);
	});

	it('retains filter-builder warnings when metadata is unavailable', async () => {
		const config = options();
		config.synthid.enabled = true;
		config.synthid.squeezeFactor = 0.9;
		const output = await app.processVideo(video(), config);
		expect(output.warnings).toContain('Rotation jitter was skipped: original frame dimensions are unavailable.');
		expect(output.warnings).toContain('Resize squeeze was skipped: original frame dimensions are unavailable.');
	});

	it('reports the metadata-only fallback when the filter-less retry succeeds', async () => {
		const config = options();
		config.synthid = { ...config.synthid, enabled: true };
		config.synthidScope = 'all';
		const warnings: string[] = [];
		mocks.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		const output = await app.processVideo(video(), config, undefined, null, warnings);
		expect(output.blob.type).toBe('video/mp4');
		expect(mocks.exec).toHaveBeenCalledTimes(2);
		expect(warnings).toContain('The video SynthID filter chain failed for this file. Metadata stripping was applied without the SynthID stages.');
	});

	it('does not claim the metadata-only fallback when both attempts fail', async () => {
		const config = options();
		config.synthid = { ...config.synthid, enabled: true };
		config.synthidScope = 'all';
		const warnings: string[] = [];
		mocks.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
		await expect(app.processVideo(video(), config, undefined, null, warnings)).rejects.toThrow('FFmpeg exited with code 1');
		expect(mocks.exec).toHaveBeenCalledTimes(2);
		expect(warnings.some((warning) => warning.includes('Metadata stripping was applied'))).toBe(false);
	});

	it('names the still-image options the video output skipped', async () => {
		const config = options();
		config.clearLsb = true;
		config.applyBlur = true;
		config.blurRadius = 2;
		config.jpegRecompress = true;
		const output = await app.processVideo(gif(), config);
		expect(output.warnings).toContain('Skipped for this video output (still images only): Clear LSBs, Apply blur, JPEG re-compress.');
	});

	it('stays quiet about image-only options when none are checked', async () => {
		const output = await app.processVideo(gif(), options());
		expect(output.warnings.some((warning) => warning.includes('still images only'))).toBe(false);
	});

	it('advises a video luma noise level that actually applies', async () => {
		const config = options();
		config.synthid = { ...config.synthid, enabled: true, lumaNoise: 0.5 };
		config.synthidScope = 'all';
		const output = await app.processVideo(video(), config);
		const warning = output.warnings.find((entry) => entry.includes('Luma noise was skipped'));
		expect(warning).toBeDefined();
		const advised = Number.parseFloat(/at least ([0-9.]+)/.exec(warning!)![1]);
		expect(isSubLevelVideoNoise(advised)).toBe(false);
	});

	it('keeps the shipped luma noise slider able to select the advised minimum', () => {
		// The advice is computed from the slider's step; the control must
		// also be able to reach it. Reading the shipped markup here ties the
		// two sides together, so a coarser step or a max below the threshold
		// fails loudly instead of leaving unselectable advice.
		const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
		const input = /<input type="range" id="synthid-noise"[^>]*>/.exec(html)![0];
		const step = Number.parseFloat(/step="([0-9.]+)"/.exec(input)![1]);
		const max = Number.parseFloat(/max="([0-9.]+)"/.exec(input)![1]);
		const advised = Number.parseFloat(/at least ([0-9.]+)/.exec(subLevelVideoNoiseWarning(step))![1]);
		expect(advised).toBeLessThanOrEqual(max);
		expect(advised / step).toBeCloseTo(Math.round(advised / step), 10);
	});
});

describe('queue controls', () => {
	it('ignores drops and file-input changes while processing, then accepts new files', async () => {
		drop(video());
		const running = app.processAllFiles();
		drop(video());
		node('file-input').files = [video()];
		node('file-input').dispatchEvent(new Event('change'));
		const lockedCount = node('file-count').textContent;
		await running;
		expect(lockedCount).toBe('1');
		drop(video());
		expect(node('file-count').textContent).toBe('2');
	});

	it('keeps the status area visible for a skip notice, like the idle Ready state', () => {
		// The progress section is the app's status area and is already shown
		// at init; a pure rejection only replaces its text.
		expect(node('progress-text').textContent).toBe('Ready');
		expect(node('progress-section').hidden).toBe(false);
		drop(new File(['notes'], 'notes.txt', { type: 'text/plain' }), video());
		expect(node('file-count').textContent).toBe('1');
		expect(node('progress-section').hidden).toBe(false);
		expect(node('progress-text').textContent).toContain('Skipped 1 unsupported file');
	});

	it('disables drag feedback and dropEffect while processing', async () => {
		drop(video());
		const running = app.processAllFiles();
		const event = new Event('dragover', { cancelable: true });
		const dataTransfer = { dropEffect: 'copy' };
		Object.assign(event, { dataTransfer });
		node('drop-zone').dispatchEvent(event);
		const highlighted = node('drop-zone').classList.contains('drop-zone--dragover');
		await running;
		expect(event.defaultPrevented).toBe(true);
		expect(highlighted).toBe(false);
		expect(dataTransfer.dropEffect).toBe('none');
	});

	it.each(['image/jpeg', 'image/jpg', ''])('enables quality for automatic JPEG output with MIME %s', (type) => {
		drop(new File(['jpeg'], 'photo.jpg', { type }));
		expect(node('output-format-rows').querySelector('select')?.value).toBe('auto');
		expect(node('jpeg-quality').disabled).toBe(false);
		const select = node('output-format-rows').querySelector('select')!;
		select.value = 'image/png';
		node('output-format-rows').dispatchEvent(new Event('change'));
		expect(node('jpeg-quality').disabled).toBe(true);
	});

	it('associates every output label with a unique select across row rebuilds', () => {
		drop(video(), gif(), new File(['png'], 'photo.png', { type: 'image/png' }));
		for (let pass = 0; pass < 2; pass += 1) {
			const rows = node('output-format-rows').children;
			const ids = rows.map((row) => row.querySelector('select')!.id);
			expect(ids.every(Boolean)).toBe(true);
			expect(new Set(ids).size).toBe(rows.length);
			for (const row of rows) expect(row.querySelector('label')!.htmlFor).toBe(row.querySelector('select')!.id);
			drop(video());
		}
	});

	it('unlocks the queue after setup fails and permits retry', async () => {
		drop(video());
		vi.spyOn(node('filename-mode-group'), 'querySelector').mockImplementationOnce(() => { throw new Error('setup failed'); });
		await app.processAllFiles().catch(() => {});
		expect(node('file-input').disabled).toBe(false);
		expect(node('clear-all').disabled).toBe(false);
		expect(node('process-all').disabled).toBe(false);
		expect(node('progress-text').textContent).toContain('setup failed');
		await app.processAllFiles();
		expect(node('results-list').children).toHaveLength(1);
	});

	it('shows ZIP failures and permits another download attempt', async () => {
		drop(video());
		await app.processAllFiles();
		node('download-all').click();
		await vi.waitFor(() => expect(node('progress-text').textContent).toContain('ZIP allocation failed'));
		expect(node('progress-section').hidden).toBe(false);
		expect(node('download-all').disabled).toBe(false);
		node('download-all').click();
		await vi.waitFor(() => expect(mocks.zip).toHaveBeenCalledTimes(2));
	});

	it('disables the per-file remove buttons as soon as a batch starts', async () => {
		drop(video());
		const running = app.processAllFiles();
		const remove = node('file-list').querySelector('.file-item__remove');
		expect(remove?.disabled).toBe(true);
		await running;
	});

	it('keeps Process All and Clear All locked while ZIP generation is running', async () => {
		drop(video());
		await app.processAllFiles();
		mocks.zip.mockReturnValue(new Promise(() => {}));
		node('download-all').click();
		await vi.waitFor(() => expect(node('download-all').disabled).toBe(true));
		expect(node('process-all').disabled).toBe(true);
		expect(node('clear-all').disabled).toBe(true);
		// Queue mutations re-render the list; the lock must survive them.
		drop(video());
		expect(node('process-all').disabled).toBe(true);
	});
});

describe('output verification', () => {
	it('retains the input verdict and adds a warning when output decoding fails', async () => {
		const warnings: string[] = [];
		const result = await app.verifyOutputSynthid(new Blob(['output']), options().synthid, verdict, warnings, 'output-hash');
		expect(result).toEqual({ input: verdict, output: null });
		expect(warnings.join(' ')).toMatch(/output.*verification.*failed/i);
	});

	it('renders missing output as unavailable, never as not detected', () => {
		const info = new Element();
		app.appendSynthidVerdict(info as unknown as HTMLElement, { input: verdict, output: null });
		expect(info.children[0].textContent).toContain('input detected (90%)');
		expect(info.children[0].textContent).toContain('output unavailable');
		expect(info.children[0].title).toContain('output unavailable');
		expect(info.children[0].classList.contains('result-item__synthid--flagged')).toBe(false);
	});

	it('renders an unverifiable size as inconclusive instead of shaky percentages', () => {
		const info = new Element();
		const inconclusive: SynthidDetection = { ...verdict, conclusive: false, confidence: 0.53 };
		app.appendSynthidVerdict(info as unknown as HTMLElement, { input: inconclusive, output: { ...inconclusive, confidence: 0.57 } });
		expect(info.children[0].textContent).toContain('input inconclusive (size too small)');
		expect(info.children[0].textContent).toContain('output inconclusive (size too small)');
		expect(info.children[0].textContent).not.toContain('%');
		expect(info.children[0].title).toContain('input test-profile (size too small for a trusted check)');
		expect(info.children[0].classList.contains('result-item__synthid--flagged')).toBe(false);
	});

	it('does not warn about a still-detectable output when the size cannot be verified', async () => {
		const warnings: string[] = [];
		const inconclusive: SynthidDetection = { ...verdict, conclusive: false, confidence: 0.53 };
		mocks.detect.mockResolvedValue(inconclusive);
		const result = await app.verifyOutputSynthid(gif(), { ...options().synthid, enabled: true }, inconclusive, warnings, 'output-hash');
		expect(result).toEqual({ input: inconclusive, output: inconclusive });
		expect(warnings).toEqual([]);
	});
});

describe('SynthID verdict reporting', () => {
	it('omits the verdict when a detected-scope input is clean', async () => {
		const config = options();
		config.synthid = { ...config.synthid, enabled: true };
		mocks.detect.mockResolvedValue({ ...verdict, isWatermarked: false, confidence: 0.41 });
		const output = await app.processAnimatedGif(gif(), config, 'clean-gif');
		expect(output.synthidCheck).toBeUndefined();
	});

	it('reports the verdict when the attack ran', async () => {
		const config = options();
		config.synthid = { ...config.synthid, enabled: true };
		mocks.detect.mockResolvedValue(verdict);
		const output = await app.processAnimatedGif(gif(), config, 'flagged-gif');
		expect(output.synthidCheck).toEqual({ input: verdict, output: verdict });
	});
});

describe('GIF allocation admission', () => {
	it.each(['processing', 'detection', 'preflight'])('rejects excessive total GIF pixels before background allocation or decoding in %s', async (path) => {
		mocks.gifSize = { width: 512, height: 512, frames: 256 };
		mocks.background.mockImplementation(() => { throw new Error('background must not allocate'); });
		const file = gif();
		if (path === 'processing') {
			await expect(app.processAnimatedGif(file, options(), 'large-gif')).rejects.toThrow(/GIF output.*limit/);
		} else if (path === 'detection') {
			await expect(app.detectBlobSynthid(file)).rejects.toThrow(/GIF output.*limit/);
		} else {
			drop(file);
			await vi.waitFor(() => expect(mocks.reader).toHaveBeenCalledOnce());
			await app.processAllFiles();
			expect(node('results-list').querySelector('.result-item__meta')!.textContent).toMatch(/GIF output.*limit/);
		}
		if (path === 'processing') expect(mocks.reader).toHaveBeenCalledOnce();
		expect(mocks.background).not.toHaveBeenCalled();
		expect(mocks.decode).not.toHaveBeenCalled();
		expect(mocks.detect).not.toHaveBeenCalled();
	});
});

describe('animated GIF palette randomization', () => {
	it('randomizes identical frames identically so the animation does not flicker', async () => {
		const bytes = new Uint8Array(1024);
		const writer = new GifWriter(bytes, 2, 2, { palette: [0x000000, 0xc86432] });
		writer.addFrame(0, 0, 2, 2, new Uint8Array([1, 1, 1, 1]), { delay: 10 });
		writer.addFrame(0, 0, 2, 2, new Uint8Array([1, 1, 1, 1]), { delay: 10 });
		const file = new File([bytes.slice(0, writer.end())], 'two.gif', { type: 'image/gif' });

		const config = options();
		config.randomizeLsb = true;
		const output = await app.processAnimatedGif(file, config, 'palette-hash');

		const reader = new GifReader(new Uint8Array(await output.blob.arrayBuffer()));
		expect(reader.numFrames()).toBe(2);
		const first = new Uint8ClampedArray(16);
		const second = new Uint8ClampedArray(16);
		reader.decodeAndBlitFrameRGBA(0, first);
		reader.decodeAndBlitFrameRGBA(1, second);
		expect(Array.from(second)).toEqual(Array.from(first));
	});
});
