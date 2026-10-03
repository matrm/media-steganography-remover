import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { GifReader, GifWriter } from 'omggif';
import type { ProcessingOptions } from './lib/types';
import { DISTORT_PRESETS, isSubLevelVideoNoise, subLevelVideoNoiseWarning } from './lib/distort';
import { LARGE_INPUT_BYTES } from './lib/util';

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
	zip: vi.fn(),
	background: vi.fn(),
	decode: vi.fn(),
	reader: vi.fn(),
	declarationScan: vi.fn(),
	gifSize: null as null | { width: number; height: number; frames: number },
}));

vi.mock('./style.css', () => ({}));
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
// The declaration search is wrapped so a test can count how many times a file's
// bytes were examined, which is the only externally visible difference between
// a cache hit and a fresh search once both callers read their own file to
// derive a content key. The real implementation is passed through, so the badge
// still reflects the file's actual contents.
vi.mock('./lib/synthid-metadata', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./lib/synthid-metadata')>();
	return {
		...actual,
		hasSynthidDeclarationInBytes: (bytes: Uint8Array) =>
			mocks.declarationScan(bytes, actual.hasSynthidDeclarationInBytes),
	};
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
	jpegRecompress: false, jpegQuality: 85, distort: { ...DISTORT_PRESETS.balanced, enabled: false, lumaNoiseStep: 0.1 },
	outputFormats: {}, filenameMode: 'suffix', outputSuffix: '-clean', outputPrefix: 'file', prefixStartIndex: 0, hashLength: 32,
});
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
// crypto.subtle is a shared global, so a spy installed before anything a
// previous test left in flight settles would record that straggler too.
// Crossing a macrotask boundary first lets it finish where no spy can see
// it, so an exact count below measures only this test's own work.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
	vi.resetModules();
	vi.clearAllMocks();
	mocks.instances.length = 0;
	mocks.gifSize = null;
	mocks.load.mockReset().mockResolvedValue(true);
	mocks.write.mockReset().mockResolvedValue(undefined);
	mocks.exec.mockReset().mockResolvedValue(0);
	mocks.zip.mockReset().mockRejectedValue(new Error('ZIP allocation failed'));
	mocks.background.mockReset();
	mocks.decode.mockReset().mockImplementation(() => { throw new Error('decode must not run'); });
	mocks.declarationScan.mockReset().mockImplementation(
		async (bytes: Uint8Array, scan: (bytes: Uint8Array) => boolean) => scan(bytes)
	);
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

	it('retains warnings in the caller collector when the video path fails', async () => {
		mocks.write.mockRejectedValueOnce(new Error('write failed'));
		const warnings: string[] = [];
		await expect(app.processVideo(gif(true), options(), undefined, warnings)).rejects.toThrow('write failed');
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
		config.distort.enabled = true;
		config.distort.squeezeFactor = 0.9;
		const output = await app.processVideo(video(), config);
		expect(output.warnings).toContain('Rotation jitter was skipped: original frame dimensions are unavailable.');
		expect(output.warnings).toContain('Resize squeeze was skipped: original frame dimensions are unavailable.');
	});

	it('reports the metadata-only fallback when the filter-less retry succeeds', async () => {
		const config = options();
		config.distort = { ...config.distort, enabled: true };
		const warnings: string[] = [];
		mocks.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
		const output = await app.processVideo(video(), config, undefined, warnings);
		expect(output.blob.type).toBe('video/mp4');
		expect(mocks.exec).toHaveBeenCalledTimes(2);
		expect(warnings).toContain('The video distortion filter chain failed for this file. Metadata stripping was applied without the distortion stages.');
	});

	it('does not claim the metadata-only fallback when both attempts fail', async () => {
		const config = options();
		config.distort = { ...config.distort, enabled: true };
		const warnings: string[] = [];
		mocks.exec.mockResolvedValueOnce(1).mockResolvedValueOnce(1);
		await expect(app.processVideo(video(), config, undefined, warnings)).rejects.toThrow('FFmpeg exited with code 1');
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
		config.distort = { ...config.distort, enabled: true, lumaNoise: 0.5 };
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
		const input = /<input type="range" id="distort-noise"[^>]*>/.exec(html)![0];
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

	it('locks the whole options panel for the duration of a batch', async () => {
		// A batch reads the options once at its start, so every option control
		// and the declaration badge lock together. Leaving any of them live
		// would accept a change that only takes effect on the next run, which
		// reads as a control that ignored the user.
		const lock = node('options-lock') as unknown as HTMLFieldSetElement;
		expect(lock.disabled).toBe(false);
		drop(new File(
			[new TextEncoder().encode('header bytes Applied imperceptible SynthID watermark trailing bytes')],
			'marked.png',
			{ type: 'image/png' }
		));
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
		const running = app.processAllFiles();
		expect(lock.disabled).toBe(true);
		expect(node('file-list').querySelector('.file-item__synthid')!.disabled).toBe(true);
		await running;
		expect(lock.disabled).toBe(false);
		expect(node('file-list').querySelector('.file-item__synthid')!.disabled).toBe(false);
	});

	it('unlocks the options panel even when a batch fails', async () => {
		// The lock opens from the batch's cleanup path, so a failure part way
		// through must still release it or every option stays inert for the rest
		// of the session.
		const lock = node('options-lock') as unknown as HTMLFieldSetElement;
		drop(video());
		const group = node('filename-mode-group');
		const original = group.querySelector.bind(group);
		let reads = 0;
		vi.spyOn(group, 'querySelector').mockImplementation((selector: string) => {
			reads += 1;
			if (reads > 1) throw new Error('setup failed');
			return original(selector);
		});
		await app.processAllFiles().catch(() => {});
		expect(node('progress-text').textContent).toContain('setup failed');
		expect(lock.disabled).toBe(false);
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

describe('SynthID declaration badge', () => {
	// The badge reports what Google wrote into the file's own metadata, not a
	// measurement of the watermark in the pixels.
	const marked = () => new File(
		[new TextEncoder().encode('header bytes Applied imperceptible SynthID watermark trailing bytes')],
		'marked.png',
		{ type: 'image/png' }
	);

	it('names what it found and where that came from', () => {
		const badge = app.createSynthidBadge();
		// The label reports a declaration, not a measurement, so it must not
		// claim the watermark was detected.
		expect(badge.textContent).toBe('SynthID declared');
		expect(badge.textContent).not.toMatch(/detected/i);
		// Says plainly that it reports the file's declaration, not a
		// measurement of the pixels.
		expect(badge.title).toMatch(/not a measurement of the watermark in the pixels/i);
		// Names the option it actually turns on.
		expect(badge.title).toMatch(/media distortion/i);
		// The option covers the whole batch, so the per-file badge must not read
		// as a per-file action.
		expect(badge.title).toMatch(/all inputs/i);
		// Claims no removal, since nothing here measures whether a watermark
		// survived the distortion.
		expect(badge.title).toMatch(/not verified to remove/i);
	});

	it('turns the distortion option on when clicked', () => {
		const input = node('distort-attack') as unknown as HTMLInputElement;
		input.checked = false;
		app.createSynthidBadge().click();
		expect(input.checked).toBe(true);
	});

	it('badges a declaring file without changing the user\'s options', async () => {
		// The badge is informational. What the metadata claims is not evidence
		// that the pixels carry a watermark this tool can affect, so adding a
		// file must never turn an option on for the user. Clicking the badge is
		// how they ask for the distortion, which the test above covers.
		const input = node('distort-attack') as unknown as HTMLInputElement;
		input.checked = false;
		drop(marked());
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
		expect(input.checked).toBe(false);
		expect(node('file-list').querySelector('.file-item__synthid')!.textContent).toBe('SynthID declared');
	});

	it('badges a declaring video as well as a still image', async () => {
		// The pre-flight is a bounded byte search over the container's edges, so
		// it reads any supported format without decoding. Leaving videos out
		// would hide the declaration on exactly the AI-generated media most
		// likely to carry one.
		drop(new File(
			[new TextEncoder().encode('ftypbrand Applied imperceptible SynthID watermark moovdata')],
			'clip.mp4',
			{ type: 'video/mp4' }
		));
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
		expect(node('file-list').querySelector('.file-item__synthid')!.textContent).toBe('SynthID declared');
	});

	it('badges nothing and changes nothing for a file with no declaration', async () => {
		const input = node('distort-attack') as unknown as HTMLInputElement;
		input.checked = false;
		drop(new File([new TextEncoder().encode('plain content')], 'plain.png', { type: 'image/png' }));
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item')).not.toBeNull());
		expect(input.checked).toBe(false);
		expect(node('file-list').querySelector('.file-item__synthid')).toBeNull();
	});

	it('keeps exactly one badge for a declaring file after the list re-renders', async () => {
		// Two render paths can add the badge: the incremental update once the
		// pre-flight resolves, and the full rebuild updateFileList runs on every
		// queue mutation. Both read the same stored declaration, so the second
		// must refresh the badge rather than stack a duplicate.
		drop(marked());
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
		drop(new File([new TextEncoder().encode('plain content')], 'plain.png', { type: 'image/png' }));
		const badges = node('file-list').querySelectorAll('.file-item__synthid');
		expect(badges).toHaveLength(1);
		expect(badges[0].textContent).toBe('SynthID declared');
	});

	it('reads each queued file once and shares the declaration between identical copies', async () => {
		// A small input is read whole to derive its content key, and that same
		// buffer is searched for the declaration, so one read answers both. The
		// second copy cannot skip its own read, since it needs the same key, but
		// it must reuse the first copy's declaration rather than searching again.
		await settle();
		// A scan the previous test queued can still land after the beforeEach
		// reset, so the count is cleared again now that nothing is in flight.
		mocks.declarationScan.mockClear();
		const read = vi.spyOn(Blob.prototype, 'arrayBuffer');
		const slice = vi.spyOn(Blob.prototype, 'slice');
		drop(marked());
		await vi.waitFor(() => expect(node('file-list').querySelectorAll('.file-item__synthid')).toHaveLength(1));
		drop(new File(
			[new TextEncoder().encode('header bytes Applied imperceptible SynthID watermark trailing bytes')],
			'copy.png',
			{ type: 'image/png' }
		));
		await vi.waitFor(() => expect(node('file-list').querySelectorAll('.file-item__synthid')).toHaveLength(2));
		// One read per file, and no windowed read at all: the small-input path
		// searches the buffer it already has rather than slicing the blob again.
		expect(read).toHaveBeenCalledTimes(2);
		expect(slice).not.toHaveBeenCalled();
		expect(mocks.declarationScan).toHaveBeenCalledTimes(1);
	});

	it('badges a large input without ever reading the whole file', async () => {
		// A large input is not digested up front, because hashing it would
		// materialize the entire file just to scan its container edges. The
		// scan must stay bounded and the input must still be badged, so this
		// pins both halves of that tradeoff. The marker sits in the trailing
		// window, the layout a non-faststart MP4 uses, so the scan has to read
		// both ends rather than stopping early.
		const digest = vi.spyOn(crypto.subtle, 'digest');
		const slice = vi.spyOn(Blob.prototype, 'slice');
		const marker = new TextEncoder().encode('Applied imperceptible SynthID watermark');
		const bytes = new Uint8Array(LARGE_INPUT_BYTES);
		bytes.set(marker, LARGE_INPUT_BYTES - marker.length - 8);
		const sparse = new File([bytes], 'huge.png', { type: 'image/png' });
		drop(sparse);
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
		// The badge is the scan's last step, so its appearing also means the
		// digest decision has already been made and no digest is still to
		// arrive on this spy.
		expect(digest).not.toHaveBeenCalled();
		// The whole-file read the small-input path takes is absent, so the
		// windows below are the only reads there are.
		expect(mocks.declarationScan).not.toHaveBeenCalled();
		// One window per end, and each a fraction of the file, so the payload
		// between them is never read.
		expect(slice).toHaveBeenCalledTimes(2);
		for (const [start, end] of slice.mock.calls as [number, number][]) {
			expect(end - start).toBeLessThan(sparse.size);
		}
	});

	it('searches duplicate bytes again when no trustworthy content key exists', async () => {
		// Without crypto.subtle the digest degrades to a non-cryptographic
		// fingerprint, which can collide, so a declaration must never be
		// cached under it. Two copies of the same bytes are therefore each
		// searched, where a real digest would have collapsed them into one.
		// Both still get badged, since bypassing the cache must not cost the
		// result.
		vi.stubGlobal('crypto', undefined);
		drop(marked());
		await vi.waitFor(() => expect(node('file-list').querySelectorAll('.file-item__synthid')).toHaveLength(1));
		drop(new File(
			[new TextEncoder().encode('header bytes Applied imperceptible SynthID watermark trailing bytes')],
			'copy.png',
			{ type: 'image/png' }
		));
		await vi.waitFor(() => expect(node('file-list').querySelectorAll('.file-item__synthid')).toHaveLength(2));
		expect(mocks.declarationScan).toHaveBeenCalledTimes(2);
	});

	it('parks a queued pre-flight while a batch runs and resumes it after', async () => {
		// Processing and the pre-flight both read files, so the scan must not
		// interleave with the pipeline. Dropping an image and starting the batch
		// in the same tick parks the scan behind the gate; the badge must still
		// appear once the batch releases it, or the file stays unbadged forever.
		drop(marked());
		const running = app.processAllFiles();
		// Nothing has had a chance to run yet, so no scan can have completed.
		expect(node('file-list').querySelector('.file-item__synthid')).toBeNull();
		await running;
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
	});

	it('releases a parked pre-flight even when the batch fails', async () => {
		// The gate is opened from the batch's cleanup path, so a batch that
		// throws part way through must still release it. Otherwise the failure
		// strands every scan queued behind it and their badges never appear,
		// with nothing on screen to say why.
		drop(marked());
		// The batch reads the options twice: once to relock the queue controls
		// and once for itself. Failing only the second call puts the failure
		// after the gate closed, which is the ordering under test.
		const group = node('filename-mode-group');
		const original = group.querySelector.bind(group);
		let reads = 0;
		vi.spyOn(group, 'querySelector').mockImplementation((selector: string) => {
			reads += 1;
			if (reads > 1) throw new Error('setup failed');
			return original(selector);
		});
		await app.processAllFiles().catch(() => {});
		expect(node('progress-text').textContent).toContain('setup failed');
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
	});

	it('never reads a file removed while its scan waited its turn', async () => {
		// Scans are serialized, so a file can sit queued behind a slower one and
		// be discarded in the meantime. Reading it then would spend a read on a
		// file the user already threw away. The two files differ so neither can
		// be answered from the other's cached declaration.
		const declaring = (fill: string) => new File(
			[new TextEncoder().encode(`${fill} Applied imperceptible SynthID watermark tail`)],
			'marked.png',
			{ type: 'image/png' }
		);
		const original = Blob.prototype.arrayBuffer;
		let release!: () => void;
		const held = new Promise<void>((resolve) => { release = resolve; });
		const scan = vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function (this: Blob) {
			await held;
			return original.apply(this);
		});

		drop(declaring('kept'), declaring('discarded'));
		// Only the first file's scan has started, and it is parked mid-read.
		await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
		node('file-list').querySelectorAll('.file-item__remove')[1].click();
		expect(node('file-count').textContent).toBe('1');
		release();

		// The surviving file's badge proves the queue moved on, so the read
		// count below is measuring the discarded file rather than a stall.
		await vi.waitFor(() => expect(node('file-list').querySelectorAll('.file-item__synthid')).toHaveLength(1));
		await settle();
		expect(scan).toHaveBeenCalledTimes(1);
	});

	it('locks the badge while a batch runs, since the options are already captured', async () => {
		// The batch reads the options once at the start, so a badge clicked
		// mid-batch would only affect the next run, which reads as a control
		// that did nothing. It locks with the rest of the queue controls.
		drop(marked());
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
		expect(node('file-list').querySelector('.file-item__synthid')!.disabled).toBe(false);
		const running = app.processAllFiles();
		expect(node('file-list').querySelector('.file-item__synthid')!.disabled).toBe(true);
		await running;
		expect(node('file-list').querySelector('.file-item__synthid')!.disabled).toBe(false);
	});

	it('leaves a file unbadged and still queued when the metadata read fails', async () => {
		// The pre-flight is additive, so a read failure must not reject, drop the
		// file from the queue, or surface as a broken list. Swallow it at the
		// read both the content key and the search come from.
		const slice = vi.spyOn(Blob.prototype, 'arrayBuffer').mockRejectedValue(new Error('read failed'));
		drop(marked());
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item')).not.toBeNull());
		expect(node('file-count').textContent).toBe('1');
		expect(node('file-list').querySelector('.file-item__synthid')).toBeNull();
		slice.mockRestore();
		// The declaration stays unset across a later rebuild rather than the
		// file being re-scanned behind the user's back.
		drop(new File([new TextEncoder().encode('plain content')], 'plain.png', { type: 'image/png' }));
		expect(node('file-count').textContent).toBe('2');
		expect(node('file-list').querySelectorAll('.file-item__synthid')).toHaveLength(0);
	});
});

describe('content hash reuse', () => {
	// The pre-flight is only observable through the badge, so these use a
	// declaring file: the badge appears exactly when the pre-flight has
	// finished, which pins the digest count without racing the queue.
	const marked = () => new File(
		[new TextEncoder().encode('header bytes Applied imperceptible SynthID watermark trailing bytes')],
		'marked.png',
		{ type: 'image/png' }
	);

	it('reuses the pre-flight digest instead of re-reading the file when processing', async () => {
		drop(marked());
		// The badge is the pre-flight's last step, so its appearance pins the
		// digest the pre-flight took without racing the serial queue.
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item__synthid')).not.toBeNull());
		await settle();
		const digest = vi.spyOn(crypto.subtle, 'digest');
		await app.processAllFiles();
		// The input is already hashed, so processing must not digest it again.
		// The static image path cannot decode without a browser, so it fails
		// after the hash step; the empty spy proves the re-read never happened.
		expect(digest).not.toHaveBeenCalled();
	});

	it('digests an input whose pre-flight scan had not run yet', async () => {
		// Control for the assertion above, so a clean pass there cannot come
		// from a spy that records nothing. A video dropped and processed in the
		// same tick has its scan park behind the batch gate, so processing is
		// what hashes it.
		await settle();
		const digest = vi.spyOn(crypto.subtle, 'digest');
		drop(video());
		await app.processAllFiles();
		expect(digest).toHaveBeenCalled();
	});
});

describe('GIF allocation admission', () => {
	it('rejects excessive total GIF pixels before background allocation or decoding', async () => {
		mocks.gifSize = { width: 512, height: 512, frames: 256 };
		mocks.background.mockImplementation(() => { throw new Error('background must not allocate'); });
		await expect(app.processAnimatedGif(gif(), options())).rejects.toThrow(/GIF output.*limit/);
		expect(mocks.reader).toHaveBeenCalledOnce();
		expect(mocks.background).not.toHaveBeenCalled();
		expect(mocks.decode).not.toHaveBeenCalled();
	});

	it('never decodes a GIF during the pre-flight metadata scan', async () => {
		// The pre-flight reads the file's declaration from a bounded prefix and
		// nothing more, so it cannot allocate on an oversized animation no
		// matter how the file was added. The limit is still enforced, by the
		// processing path, and surfaces in the result the same way.
		mocks.gifSize = { width: 512, height: 512, frames: 256 };
		mocks.background.mockImplementation(() => { throw new Error('background must not allocate'); });
		drop(gif());
		await vi.waitFor(() => expect(node('file-list').querySelector('.file-item')).not.toBeNull());
		expect(mocks.reader).not.toHaveBeenCalled();
		expect(mocks.background).not.toHaveBeenCalled();
		await app.processAllFiles();
		expect(node('results-list').querySelector('.result-item__meta')!.textContent).toMatch(/GIF output.*limit/);
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
		const output = await app.processAnimatedGif(file, config);

		const reader = new GifReader(new Uint8Array(await output.blob.arrayBuffer()));
		expect(reader.numFrames()).toBe(2);
		const first = new Uint8ClampedArray(16);
		const second = new Uint8ClampedArray(16);
		reader.decodeAndBlitFrameRGBA(0, first);
		reader.decodeAndBlitFrameRGBA(1, second);
		expect(Array.from(second)).toEqual(Array.from(first));
	});
});
