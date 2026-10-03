import { describe, expect, it, vi } from 'vitest';
import { createDeclarationCache } from './declaration-cache';

const bytes = new Uint8Array([1, 2, 3]);

describe('createDeclarationCache', () => {
	it('shares one read promise across concurrent and repeated callers', async () => {
		const read = vi.fn(async () => true);
		const cache = createDeclarationCache({ synthidMetadata: read });

		const first = cache.get(bytes, 'hash-a', 'synthidMetadata');
		const second = cache.get(bytes, 'hash-a', 'synthidMetadata');
		expect(second).toBe(first);
		expect(read).toHaveBeenCalledTimes(1);
		await expect(first).resolves.toBe(true);

		// A resolved declaration stays cached for later callers.
		expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).toBe(first);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('hands the reader the exact bytes it was keyed with', async () => {
		const read = vi.fn(async () => true);
		const cache = createDeclarationCache({ synthidMetadata: read });
		await cache.get(bytes, 'hash-a', 'synthidMetadata');
		expect(read).toHaveBeenCalledWith(bytes);
	});

	it('turns a reader that throws synchronously into a shared rejection', async () => {
		// A reader that throws inline would escape the cache before the record
		// is written, so a second caller could not share the failed run and the
		// entry would be left half-populated.
		const cache = createDeclarationCache({
			synthidMetadata: () => { throw new Error('read failed'); },
		});
		const first = cache.get(bytes, 'hash-a', 'synthidMetadata');
		expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).toBe(first);
		await expect(first).rejects.toThrow('read failed');
		// The failed run is evicted, so the next caller retries.
		await expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).rejects.toThrow('read failed');
	});

	it('caches a negative declaration too, so a clean file is not re-read', async () => {
		const read = vi.fn(async () => false);
		const cache = createDeclarationCache({ synthidMetadata: read });

		await expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).resolves.toBe(false);
		await expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).resolves.toBe(false);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it('keeps a separate declaration per content key', async () => {
		const read = vi.fn(async () => false);
		const cache = createDeclarationCache({ synthidMetadata: read });

		cache.get(bytes, 'hash-a', 'synthidMetadata');
		cache.get(bytes, 'hash-b', 'synthidMetadata');
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('evicts a rejected read so the next caller can retry', async () => {
		const read = vi.fn()
			.mockRejectedValueOnce(new Error('read failed'))
			.mockResolvedValueOnce(true);
		const cache = createDeclarationCache({ synthidMetadata: read });

		await expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).rejects.toThrow('read failed');
		await expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).resolves.toBe(true);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it('does not let a stale rejection evict an entry registered after a clear', async () => {
		let rejectStale!: (error: Error) => void;
		const read = vi.fn()
			.mockImplementationOnce(() => new Promise<boolean>((_, reject) => {
				rejectStale = reject;
			}))
			.mockResolvedValue(true);
		const cache = createDeclarationCache({ synthidMetadata: read });

		const stale = cache.get(bytes, 'hash-a', 'synthidMetadata');
		cache.clear();
		const fresh = cache.get(bytes, 'hash-a', 'synthidMetadata');

		rejectStale(new Error('read failed'));
		await expect(stale).rejects.toThrow('read failed');

		// The stale run was cleared before the replacement was registered, so
		// its cleanup must not remove the replacement.
		expect(cache.get(bytes, 'hash-a', 'synthidMetadata')).toBe(fresh);
		expect(read).toHaveBeenCalledTimes(2);
	});
});
