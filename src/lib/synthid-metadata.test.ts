import { describe, expect, it } from 'vitest';
import { hasSynthidManifest } from './synthid-metadata';

const MARKER = 'Applied imperceptible SynthID watermark';

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

	it('does not see metadata placed past the scan window', async () => {
		const bytes = new Uint8Array((1 << 20) + MARKER.length);
		bytes.set(new TextEncoder().encode(MARKER), 1 << 20);
		await expect(hasSynthidManifest(new Blob([bytes]))).resolves.toBe(false);
	});
});
