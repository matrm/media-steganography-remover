// Cache of the steganography declarations a file makes about itself, keyed by
// content key, with one field per steganography type. Any code path that needs
// a declaration goes through this cache, so two files with the same bytes are
// examined once between them rather than once each. Keys must be digests: a
// caller holding a cheap, collision-prone identity must not cache under it,
// since a collision would hand one file another's declaration. The pending
// promise is stored, so concurrent callers share one run, and a rejected read
// is evicted so a transient failure can retry.
export interface Declarations {
	synthidMetadata?: Promise<boolean>;
}

// Names the declaration a caller wants, so a second steganography type can be
// added without changing this signature. Every field on Declarations is one
// valid name and needs a matching reader below.
export type DeclarationKind = keyof Declarations;

// One reader per declaration kind, resolved once when the cache is created so
// no caller can pair a kind with the wrong detector. Readers take the whole
// file as bytes: a declaration that needs the complete container therefore
// costs one read however the caller got there, and a reader that needs decoded
// media rather than raw bytes widens this contract when one is added instead
// of being handed a partial window. A caller with no content key, because
// digesting its file was not worth it, skips the cache instead, so no reader
// ever sees less than a whole file.
export type DeclarationReaders = Record<DeclarationKind, (bytes: Uint8Array) => Promise<boolean>>;

// Content-keyed cache of metadata declarations. Callers share one in-flight or
// resolved declaration per key, and a rejected read is dropped so the next
// caller can retry a transient failure.
export interface DeclarationCache {
	/**
	 * Returns the shared declaration of one kind for a content key, starting
	 * the read on a miss. Callers must pass a key derived from the exact bytes
	 * handed to the reader; the same key must never describe different content.
	 */
	get(bytes: Uint8Array, contentKey: string, kind: DeclarationKind): Promise<boolean>;
	/** Drops every cached declaration, e.g. when the file queue is cleared. */
	clear(): void;
}

/**
 * Creates a declaration cache around one reader per steganography kind. A
 * reader is only invoked once per key until its declaration settles, and
 * failed reads are forgotten rather than cached.
 */
export function createDeclarationCache(readers: DeclarationReaders): DeclarationCache {
	const records = new Map<string, Declarations>();
	return {
		get(bytes, contentKey, kind) {
			const record = records.get(contentKey) ?? {};
			const cached = record[kind];
			if (cached) return cached;
			// A reader that throws synchronously still yields a shared promise
			// rather than throwing past the caller, which would leave later
			// callers unable to share one run. The read itself stays inline so a
			// cache hit is still the only way to skip work.
			let pending: Promise<boolean>;
			try {
				pending = Promise.resolve(readers[kind](bytes));
			} catch (err) {
				pending = Promise.reject(err);
			}
			record[kind] = pending;
			records.set(contentKey, record);
			pending.catch(() => {
				if (record[kind] === pending) delete record[kind];
				// A clear may have replaced this record while the read was
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
