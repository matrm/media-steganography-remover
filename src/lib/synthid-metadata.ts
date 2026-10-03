// C2PA action description Google writes when its models apply the
// imperceptible SynthID watermark. Finding it in a file's metadata is a
// declaration the file makes about itself: nothing here decodes pixels or
// measures the watermark they may carry, so a positive result is a claim the
// container makes, which is exactly what the queue badge reports.
const SYNTHID_ACTION_MARKER = 'Applied imperceptible SynthID watermark';
// The two windows are deliberately different sizes, because the layouts they
// have to reach differ in size rather than in position.
//
// Start-side metadata (a PNG chunk, a WebP RIFF chunk, a JPEG APP11 segment)
// sits within the first few kilobytes of a file, so a small window covers it.
//
// End-side metadata lives in an MP4 moov atom, which a non-faststart file
// writes after the media payload, and a moov atom grows with the clip: it holds
// a sample table entry per frame, so a long recording reaches tens of megabytes.
// The action sits somewhere inside it, so this window is sized to reach into a
// moov atom rather than to cover one. It is still a bound on the read, not a
// parse: an unusually long clip can push the action past the window, which is
// why the badge presents a positive result as a declaration and never a
// verified finding.
//
// A file no larger than the two windows together is read whole in one pass
// rather than sampled at both ends, so a typical generated image is searched
// end to end and its bytes are read once instead of twice.
//
// Exported so the pre-flight's large-input threshold can be kept above this
// total by assertion rather than by restating the numbers, which is the only
// thing coupling the two.
export const SCAN_HEAD_BYTES = 1 << 20;
export const SCAN_TAIL_BYTES = 8 << 20;
export const SCAN_WINDOW_BYTES = SCAN_HEAD_BYTES + SCAN_TAIL_BYTES;

// Plain byte search over a short ASCII needle; each window is binary container
// data, so no text decoding is involved.
function containsAscii(haystack: Uint8Array, needle: string): boolean {
	const length = needle.length;
	if (length === 0 || haystack.length < length) return false;
	const first = needle.charCodeAt(0);
	search: for (let start = 0; start <= haystack.length - length; start += 1) {
		if (haystack[start] !== first) continue;
		for (let offset = 1; offset < length; offset += 1) {
			if (haystack[start + offset] !== needle.charCodeAt(offset)) continue search;
		}
		return true;
	}
	return false;
}

/**
 * Whether bytes already held in memory carry Google's SynthID C2PA action.
 * Searches the whole buffer, so the caller must pass a complete file rather
 * than a window: a caller that already read a file whole to key something else
 * by its content uses this instead of making the scanner read it again.
 */
export function hasSynthidDeclarationInBytes(bytes: Uint8Array): boolean {
	return containsAscii(bytes, SYNTHID_ACTION_MARKER);
}

/**
 * Whether a blob's bytes carry Google's SynthID C2PA action. A file no larger
 * than the two scan windows is read whole; a larger one has only its leading
 * and trailing windows read, never the payload between them, so metadata
 * placed in that gap is not seen. The search is a plain ASCII substring match
 * rather than a parse of the manifest, so a file whose bytes happen to contain
 * the marker reports true without carrying the action; and because the windows
 * are bounded, a large file can report false while carrying the action further
 * from either end. Callers present the result as a declaration the container
 * makes, never as a verified finding.
 */
export async function hasSynthidManifest(blob: Blob): Promise<boolean> {
	if (blob.size < SYNTHID_ACTION_MARKER.length) return false;
	// Small enough that the two windows together span it, so one read covers
	// the whole file. Splitting it would read more than the file holds: the
	// tail's start goes negative and clamps back to zero, re-reading the head
	// window the first read already had.
	if (blob.size <= SCAN_WINDOW_BYTES) {
		const whole = await blob.slice(0, blob.size).arrayBuffer();
		return hasSynthidDeclarationInBytes(new Uint8Array(whole));
	}
	const head = await blob.slice(0, SCAN_HEAD_BYTES).arrayBuffer();
	if (hasSynthidDeclarationInBytes(new Uint8Array(head))) return true;
	const tail = await blob.slice(blob.size - SCAN_TAIL_BYTES, blob.size).arrayBuffer();
	return hasSynthidDeclarationInBytes(new Uint8Array(tail));
}
