import { describe, expect, it } from 'vitest';
import { GifReader, GifWriter } from 'omggif';
import { applyGifFrameDisposal } from './gif';
import { getGifBackground, medianCutQuantize } from './quantize';

const PALETTE = [0x000000, 0xff0000, 0x00ff00, 0x0000ff];

function emptyGifBuffer(): Uint8Array {
	return new Uint8Array(4096);
}

function composeGif(buffer: Uint8Array): { reader: GifReader; frames: Uint8ClampedArray[] } {
	const reader = new GifReader(buffer);
	const width = reader.width;
	const height = reader.height;
	const gifBackground = getGifBackground(buffer, width, height);
	let canvas: Uint8ClampedArray = new Uint8ClampedArray(gifBackground.pixels);
	const background = new Uint8ClampedArray(gifBackground.pixels);
	const frames: Uint8ClampedArray[] = [];
	for (let i = 0; i < reader.numFrames(); i += 1) {
		const info = reader.frameInfo(i);
		const beforeState = info.disposal === 3 ? new Uint8ClampedArray(canvas) : null;
		reader.decodeAndBlitFrameRGBA(i, canvas);
		frames.push(new Uint8ClampedArray(canvas));
		canvas = applyGifFrameDisposal(info, canvas, width, height, background, beforeState);
	}
	return { reader, frames };
}

// Full-canvas red, then a partial 1x1 green frame disposed to background, then
// a partial 1x1 blue frame. Outside the disposal rectangle the red background
// must survive, exactly as a browser renders the source.
function encodeDisposalBackgroundGif(): Uint8Array {
	const buffer = emptyGifBuffer();
	const writer = new GifWriter(buffer, 4, 2, { loop: 0 });
	writer.addFrame(0, 0, 4, 2, new Uint8Array(8).fill(1), {
		palette: PALETTE,
		delay: 5,
		disposal: 1,
	});
	writer.addFrame(0, 0, 1, 1, new Uint8Array([2]), {
		palette: PALETTE,
		delay: 5,
		disposal: 2,
	});
	writer.addFrame(0, 0, 1, 1, new Uint8Array([3]), {
		palette: PALETTE,
		delay: 5,
		disposal: 1,
	});
	writer.end();
	return buffer.slice(0, writer.getOutputBufferPosition());
}

describe('applyGifFrameDisposal', () => {
	function solidCanvas(width: number, height: number, color: [number, number, number]): Uint8ClampedArray {
		const canvas = new Uint8ClampedArray(width * height * 4);
		for (let i = 0; i < canvas.length; i += 4) {
			canvas[i] = color[0];
			canvas[i + 1] = color[1];
			canvas[i + 2] = color[2];
			canvas[i + 3] = 255;
		}
		return canvas;
	}

	it('clears only the disposed rectangle, keeping pixels outside it', () => {
		const canvas = solidCanvas(4, 2, [255, 0, 0]);
		const background = new Uint8ClampedArray(4 * 2 * 4);
		const result = applyGifFrameDisposal(
			{ x: 1, y: 0, width: 2, height: 1, disposal: 2 },
			canvas,
			4,
			2,
			background,
			null
		);
		expect(result).toBe(canvas);
		// The disposed rectangle becomes transparent.
		for (const [x, y] of [[1, 0], [2, 0]] as const) {
			const i = (y * 4 + x) * 4;
			expect([result[i], result[i + 1], result[i + 2], result[i + 3]]).toEqual([0, 0, 0, 0]);
		}
		// Every pixel outside the rectangle keeps the red background.
		for (const [x, y] of [[0, 0], [3, 0], [0, 1], [3, 1]] as const) {
			const i = (y * 4 + x) * 4;
			expect([result[i], result[i + 1], result[i + 2], result[i + 3]]).toEqual([255, 0, 0, 255]);
		}
	});

	it('leaves the canvas untouched for disposal 0 and 1', () => {
		for (const disposal of [0, 1]) {
			const canvas = solidCanvas(2, 2, [10, 20, 30]);
			const before = Array.from(canvas);
			const result = applyGifFrameDisposal(
				{ x: 0, y: 0, width: 1, height: 1, disposal },
				canvas,
				2,
				2,
				new Uint8ClampedArray(16),
				null
			);
			expect(Array.from(result)).toEqual(before);
		}
	});

	it('restores the saved pre-frame state for disposal 3', () => {
		const canvas = solidCanvas(2, 2, [10, 20, 30]);
		const beforeState = solidCanvas(2, 2, [1, 2, 3]);
		const result = applyGifFrameDisposal(
			{ x: 0, y: 0, width: 1, height: 1, disposal: 3 },
			canvas,
			2,
			2,
			new Uint8ClampedArray(16),
			beforeState
		);
		expect(result).toBe(beforeState);
	});

	it('clips rectangles that extend past the canvas edges', () => {
		const canvas = solidCanvas(2, 2, [50, 60, 70]);
		const background = new Uint8ClampedArray(2 * 2 * 4);
		const result = applyGifFrameDisposal(
			{ x: -1, y: -1, width: 3, height: 3, disposal: 2 },
			canvas,
			2,
			2,
			background,
			null
		);
		// Only the in-bounds intersection [0, 2) x [0, 2) is cleared.
		expect(Array.from(result)).toEqual(Array.from(background));
	});

	it.each([
		['entirely right of the canvas', { x: 5, y: 0, width: 2, height: 2 }],
		['entirely below the canvas', { x: 0, y: 5, width: 2, height: 2 }],
		['entirely left of the canvas', { x: -5, y: 0, width: 2, height: 2 }],
		['entirely above the canvas', { x: 0, y: -5, width: 2, height: 2 }],
	])('leaves the canvas untouched when the disposal rectangle is %s', (_name, rect) => {
		const canvas = solidCanvas(2, 2, [50, 60, 70]);
		const before = Array.from(canvas);
		const result = applyGifFrameDisposal(
			{ ...rect, disposal: 2 },
			canvas,
			2,
			2,
			new Uint8ClampedArray(16),
			null
		);
		expect(result).toBe(canvas);
		expect(Array.from(result)).toEqual(before);
	});

	it('composes a partial disposal-2 frame like a browser', () => {
		const { frames } = composeGif(encodeDisposalBackgroundGif());
		// Frame 1: red with a green pixel at (0, 0).
		expect([frames[1][0], frames[1][1], frames[1][2], frames[1][3]]).toEqual([0, 255, 0, 255]);
		expect([frames[1][4], frames[1][7]]).toEqual([255, 255]);
		// Frame 2: the disposal cleared only (0, 0), so the red background
		// survives everywhere except the new blue pixel.
		expect([frames[2][0], frames[2][1], frames[2][2], frames[2][3]]).toEqual([0, 0, 255, 255]);
		expect([frames[2][4], frames[2][5], frames[2][6], frames[2][7]]).toEqual([255, 0, 0, 255]);
	});

	it('round trips an animation through composition, quantization, and writing', () => {
		// Input: full-canvas pattern, a partial disposal-2 update, then another
		// full-canvas frame, with a transparent pixel in the first frame.
		const input = emptyGifBuffer();
		const inputWriter = new GifWriter(input, 6, 4, { loop: 3, palette: PALETTE, background: 3 });
		const frame0 = new Uint8Array(24);
		for (let i = 0; i < frame0.length; i += 1) frame0[i] = (i % 3) + 1;
		frame0[0] = 0;
		inputWriter.addFrame(0, 0, 6, 4, frame0, { palette: [0, 0xff0000, 0x00ff00, 0x0000ff], delay: 7, disposal: 1, transparent: 0 });
		inputWriter.addFrame(2, 1, 2, 2, new Uint8Array(4).fill(3), {
			palette: [0, 0xffffff, 0xcccccc, 0x888888],
			delay: 11,
			disposal: 2,
		});
		inputWriter.addFrame(0, 0, 6, 4, new Uint8Array(24).fill(1), {
			palette: [0, 0x00ff00, 0x000000, 0x000000],
			delay: 5,
			disposal: 1,
		});
		inputWriter.end();
		const inputBytes = input.slice(0, inputWriter.getOutputBufferPosition());

		const { reader, frames } = composeGif(inputBytes);
		// Serialize each composed frame with the same steps processAnimatedGif
		// uses: median-cut at full depth, one local palette per frame, disposal 2
		// on the output.
		const output = new Uint8Array(4096);
		const outputWriter = new GifWriter(output, reader.width, reader.height, { loop: reader.loopCount() ?? 0 });
		for (let f = 0; f < frames.length; f += 1) {
			const bmp = { width: reader.width, height: reader.height, data: new Uint8ClampedArray(frames[f]) };
			const { palette, indices, transparentIndex } = medianCutQuantize(bmp.data, 256);
			outputWriter.addFrame(0, 0, reader.width, reader.height, indices, {
				palette,
				delay: reader.frameInfo(f).delay,
				disposal: 2,
				...(transparentIndex >= 0 ? { transparent: transparentIndex } : {}),
			});
		}
		outputWriter.end();
		const outputBytes = output.slice(0, outputWriter.getOutputBufferPosition());

		const reread = new GifReader(outputBytes);
		expect(reread.numFrames()).toBe(frames.length);
		expect(reread.loopCount()).toBe(3);
		for (let f = 0; f < frames.length; f += 1) {
			expect(reread.frameInfo(f).delay).toBe(reader.frameInfo(f).delay);
		}
		const { frames: outputFrames } = composeGif(outputBytes);
		for (let f = 0; f < frames.length; f += 1) {
			for (let p = 0; p < frames[f].length; p += 4) {
				// Transparency must survive, and visible colors must match
				// within median-cut error.
				expect(outputFrames[f][p + 3]).toBe(frames[f][p + 3]);
				if (frames[f][p + 3] === 0) continue;
				for (let c = 0; c < 3; c += 1) {
					expect(Math.abs(outputFrames[f][p + c] - frames[f][p + c])).toBeLessThanOrEqual(2);
				}
			}
		}
	});
});
