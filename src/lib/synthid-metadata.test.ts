import { describe, expect, it } from 'vitest';
import {
	hasSynthidDeclarationInBytes,
	hasSynthidManifest,
	SCAN_HEAD_BYTES as HEAD,
	SCAN_TAIL_BYTES as TAIL,
	SCAN_WINDOW_BYTES as SPAN,
} from './synthid-metadata';

const MARKER = 'Applied imperceptible SynthID watermark';
// Long enough that the tail window cannot reach the head's last byte, which is
// what makes the gap between them a real gap.

describe('hasSynthidManifest', () => {
	it('finds the SynthID C2PA action in a file prefix', async () => {
		const bytes = new Uint8Array(128);
		const encoded = new TextEncoder().encode(`cborc2pa\x00${MARKER}\x00actions`);
		bytes.set(encoded, 8);
		await expect(hasSynthidManifest(new Blob([bytes]))).resolves.toBe(true);
	});

	it('reports no manifest for other content', async () => {
		await expect(hasSynthidManifest(new Blob([new TextEncoder().encode('plain content')]))).resolves.toBe(false);
		await expect(hasSynthidManifest(new Blob([]))).resolves.toBe(false);
		await expect(hasSynthidManifest(new Blob([new TextEncoder().encode('SynthID was discussed here')]))).resolves.toBe(false);
	});

	it('finds the action in a file suffix', async () => {
		// A non-faststart MP4 carries its moov atom, and the C2PA box inside
		// it, after the media payload, so a head-only scan would miss it. The
		// file has to outgrow the tail window for this to prove the tail read
		// happened rather than the whole file being covered by the head.
		const bytes = new Uint8Array(SPAN + 1024);
		const encoded = new TextEncoder().encode(`cborc2pa\x00${MARKER}\x00actions`);
		bytes.set(encoded, bytes.length - encoded.length - 8);
		await expect(hasSynthidManifest(new Blob([bytes]))).resolves.toBe(true);
	});

	it('does not see metadata placed between the two scanned windows', async () => {
		const bytes = new Uint8Array(SPAN + 1024);
		bytes.set(new TextEncoder().encode(MARKER), HEAD + 16);
		await expect(hasSynthidManifest(new Blob([bytes]))).resolves.toBe(false);
	});

	it('covers a file smaller than the head window with the head read alone', async () => {
		// The tail read must be skipped rather than duplicate bytes the head
		// already covered, which a slice on such a file would do.
		const bytes = new Uint8Array(128);
		const encoded = new TextEncoder().encode(`${MARKER}`);
		bytes.set(encoded, bytes.length - encoded.length);
		expect(await readCount(async () => {
			await expect(hasSynthidManifest(new Blob([bytes]))).resolves.toBe(true);
		})).toBe(1);
	});

	it('covers a file between the two window sizes end to end in one read', async () => {
		// Larger than the head window but no larger than the two windows
		// together, so a single read spans the whole file. A typical generated
		// image lands in this range: it is searched end to end rather than
		// sampled at both ends, and its bytes are read once rather than twice.
		// Splitting it would read more than the file holds, because the tail's
		// start clamps back to zero and repeats the head window.
		const bytes = new Uint8Array(HEAD + 4096);
		const encoded = new TextEncoder().encode(MARKER);
		bytes.set(encoded, HEAD + 16);
		expect(await readCount(async () => {
			await expect(hasSynthidManifest(new Blob([bytes]))).resolves.toBe(true);
		})).toBe(1);
	});

	it('reads at most the two windows however large the input is', async () => {
		// The scan is a bound on the read, not a parse, so a file far larger
		// than both windows together must still cost one slice per end.
		const bytes = new Uint8Array(SPAN * 2);
		const reads = await readCount(async () => {
			await expect(hasSynthidManifest(new Blob([bytes]))).resolves.toBe(false);
		});
		expect(reads).toBe(2);
	});

	it('searches bytes already in memory without touching the blob', () => {
		// The pre-flight path: it has read the file whole to derive a content
		// key, so searching that buffer costs no further read.
		const encoded = new TextEncoder().encode(MARKER);
		const bytes = new Uint8Array(4096);
		bytes.set(encoded, 2048);
		expect(hasSynthidDeclarationInBytes(bytes)).toBe(true);
		expect(hasSynthidDeclarationInBytes(new Uint8Array(4096))).toBe(false);
		// A partial needle can never match, however short the buffer.
		expect(hasSynthidDeclarationInBytes(encoded.subarray(0, encoded.length - 1))).toBe(false);
	});
});

// Runs a scan while counting how many byte windows it reads.
async function readCount(run: () => Promise<void>): Promise<number> {
	const slice = Blob.prototype.slice;
	let reads = 0;
	const spy = function (this: Blob, ...args: Parameters<Blob['slice']>) {
		reads += 1;
		return slice.apply(this, args);
	};
	Blob.prototype.slice = spy as typeof Blob.prototype.slice;
	try {
		await run();
	} finally {
		Blob.prototype.slice = slice;
	}
	return reads;
}
