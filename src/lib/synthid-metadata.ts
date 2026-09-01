// C2PA action description Google writes when its models apply the
// imperceptible SynthID watermark. Finding it in a file's metadata is a
// prior the pixel detector cannot supply on its own: a marginal carrier
// match at an uncovered size is statistically identical to clean content,
// but the manifest names the watermark the score is measuring.
const SYNTHID_ACTION_MARKER = 'Applied imperceptible SynthID watermark';
// Container metadata lives near the start of a file (a PNG chunk, a JPEG
// APP11 segment, or a WebP RIFF chunk), so a bounded prefix scan finds it
// without reading the payload a second time.
const SCAN_PREFIX_BYTES = 1 << 20;

// Plain byte search over a short ASCII needle; the prefix is binary container
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
 * Whether a blob's leading bytes carry Google's SynthID C2PA action. Only the
 * file prefix is scanned, so metadata placed after the scan window is not
 * seen; callers treat a positive result as corroboration for a phase score
 * whose evidence would otherwise be too marginal to trust.
 */
export async function hasSynthidManifest(blob: Blob): Promise<boolean> {
	if (blob.size < SYNTHID_ACTION_MARKER.length) return false;
	const prefix = await blob.slice(0, SCAN_PREFIX_BYTES).arrayBuffer();
	return containsAscii(new Uint8Array(prefix), SYNTHID_ACTION_MARKER);
}
