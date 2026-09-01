// ---------------------------------------------------------------------------
// GIF frame composition
// ---------------------------------------------------------------------------

export interface GifFrameDisposal {
	x: number;
	y: number;
	width: number;
	height: number;
	disposal: number;
}

/**
 * Applies a decoded GIF frame's disposal to the compositing canvas and
 * returns the canvas the next frame should draw on. Disposal 2 restores only
 * the frame's rectangle to the background, matching the GIF spec and browser
 * rendering, so pixels outside the rectangle survive into the next frame;
 * disposal 3 restores the saved pre-frame state. Other methods leave the
 * canvas as-is.
 */
export function applyGifFrameDisposal(
	frame: GifFrameDisposal,
	canvas: Uint8ClampedArray,
	canvasWidth: number,
	canvasHeight: number,
	background: Uint8ClampedArray,
	beforeState: Uint8ClampedArray | null
): Uint8ClampedArray {
	if (frame.disposal === 2) {
		// Restore only the frame's rectangle, clipped to the canvas, so
		// content outside it survives into the next frame.
		const left = Math.max(0, frame.x);
		const top = Math.max(0, frame.y);
		const right = Math.min(canvasWidth, frame.x + frame.width);
		const bottom = Math.min(canvasHeight, frame.y + frame.height);
		if (left >= right || top >= bottom) return canvas;
		for (let y = top; y < bottom; y += 1) {
			const start = (y * canvasWidth + left) * 4;
			const end = (y * canvasWidth + right) * 4;
			canvas.set(background.subarray(start, end), start);
		}
		return canvas;
	}
	if (frame.disposal === 3 && beforeState) {
		return beforeState;
	}
	return canvas;
}
