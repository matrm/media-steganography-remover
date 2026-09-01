import { describe, expect, it, vi } from 'vitest';
import { createDetectionCache } from './detection-cache';
import type { SynthidDetection } from './types';

function cleanDetection(overrides: Partial<SynthidDetection> = {}): SynthidDetection {
	return {
		isWatermarked: false,
		confidence: 0.1,
		phaseMatch: 0.4,
		profileKey: 'test/64x64',
		exactMatch: true,
		conclusive: true,
		...overrides,
	};
}

describe('createDetectionCache', () => {
	it('shares one detection promise across concurrent and repeated callers', async () => {
		const detect = vi.fn(async () => cleanDetection({ isWatermarked: true }));
		const cache = createDetectionCache(detect);
		const blob = new Blob(['bytes']);

		const first = cache.get(blob, 'hash-a');
		const second = cache.get(blob, 'hash-a');
		expect(second).toBe(first);
		expect(detect).toHaveBeenCalledTimes(1);
		expect((await first).isWatermarked).toBe(true);

		// A resolved verdict stays cached for later callers.
		expect(cache.get(blob, 'hash-a')).toBe(first);
		expect(detect).toHaveBeenCalledTimes(1);
	});

	it('keeps a separate verdict per content key', async () => {
		const detect = vi.fn(async () => cleanDetection());
		const cache = createDetectionCache(detect);
		const blob = new Blob(['bytes']);

		cache.get(blob, 'hash-a');
		cache.get(blob, 'hash-b');
		expect(detect).toHaveBeenCalledTimes(2);
	});

	it('evicts a rejected detection so the next caller can retry', async () => {
		const detect = vi.fn()
			.mockRejectedValueOnce(new Error('decode failed'))
			.mockResolvedValueOnce(cleanDetection());
		const cache = createDetectionCache(detect);
		const blob = new Blob(['bytes']);

		await expect(cache.get(blob, 'hash-a')).rejects.toThrow('decode failed');
		await expect(cache.get(blob, 'hash-a')).resolves.toMatchObject({ isWatermarked: false });
		expect(detect).toHaveBeenCalledTimes(2);
	});

	it('does not let a stale rejection evict an entry registered after a clear', async () => {
		const blob = new Blob(['bytes']);
		let rejectStale!: (error: Error) => void;
		const detect = vi.fn()
			.mockImplementationOnce(() => new Promise<SynthidDetection>((_, reject) => {
				rejectStale = reject;
			}))
			.mockResolvedValue(cleanDetection());
		const cache = createDetectionCache(detect);

		const stale = cache.get(blob, 'hash-a');
		cache.clear();
		const fresh = cache.get(blob, 'hash-a');

		rejectStale(new Error('decode failed'));
		await expect(stale).rejects.toThrow('decode failed');

		// The stale run was cleared before the replacement was registered, so
		// its cleanup must not remove the replacement.
		expect(cache.get(blob, 'hash-a')).toBe(fresh);
		expect(detect).toHaveBeenCalledTimes(2);
	});
});
