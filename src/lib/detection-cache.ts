import type { SynthidDetection } from './types';

// Detection verdicts keyed by content key, with one field per steganography
// type (today only SynthID). Detection is a multi-FFT pass, and every check
// goes through this cache: the pre-flight badge, the processing-time input
// verdict, each retry probe, and the final output verification. Keys are the
// hashes the pipeline computes anyway for its identical-output check, so the
// same bytes are never detected twice and the map costs almost no memory.
// The pending promise is stored, so concurrent callers share one run; a
// rejected detection is evicted so a transient decode error can be retried.
export interface DetectionVerdicts {
	synthid?: Promise<SynthidDetection>;
}

// Content-keyed cache of SynthID detection promises. Callers share one
// in-flight or resolved verdict per key, and a rejected verdict is dropped so
// the next caller can retry a transient decode failure.
export interface DetectionCache {
	/**
	 * Returns the shared detection for a content key, starting the detector on
	 * a miss. Callers must pass a key derived from the exact bytes handed to
	 * the detector; the same key must never describe different content.
	 */
	get(blob: Blob, contentKey: string): Promise<SynthidDetection>;
	/** Drops every cached verdict, e.g. when the file queue is cleared. */
	clear(): void;
}

/**
 * Creates a detection cache around a detector function. The detector is only
 * invoked once per key until its verdict settles, and failed verdicts are
 * forgotten rather than cached.
 */
export function createDetectionCache(detect: (blob: Blob) => Promise<SynthidDetection>): DetectionCache {
	const records = new Map<string, DetectionVerdicts>();
	return {
		get(blob, contentKey) {
			const cached = records.get(contentKey)?.synthid;
			if (cached) return cached;
			const record = records.get(contentKey) ?? {};
			const pending = detect(blob);
			record.synthid = pending;
			records.set(contentKey, record);
			pending.catch(() => {
				if (record.synthid === pending) delete record.synthid;
				// A clear may have replaced this record while the detection was
				// pending, so only drop the map entry when it still holds it.
				if (Object.keys(record).length === 0 && records.get(contentKey) === record) {
					records.delete(contentKey);
				}
			});
			return pending;
		},
		clear() {
			records.clear();
		},
	};
}
