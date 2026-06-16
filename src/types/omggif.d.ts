declare module 'omggif' {
	export interface FrameInfo {
		x: number;
		y: number;
		width: number;
		height: number;
		has_local_palette: boolean;
		palette_offset: number | null;
		palette_size: number | null;
		data_offset: number;
		data_length: number;
		transparent_index: number | null;
		interlaced: boolean;
		delay: number;
		disposal: number;
	}

	export interface GifReaderFrameInfo extends FrameInfo { }

	export class GifReader {
		width: number;
		height: number;

		constructor(buffer: Uint8Array);

		numFrames(): number;
		loopCount(): number | null;
		frameInfo(frameNum: number): FrameInfo;
		decodeAndBlitFrameRGBA(frameNum: number, pixels: Uint8Array | Uint8ClampedArray): void;
	}

	export interface GifWriterOptions {
		loop?: number;
		palette?: number[];
		background?: number;
	}

	export interface GifWriterFrameOptions {
		palette?: number[];
		delay?: number;
		disposal?: number;
		transparent?: number;
	}

	export class GifWriter {
		constructor(
			buffer: Uint8Array,
			width: number,
			height: number,
			gopts?: GifWriterOptions
		);

		addFrame(
			x: number,
			y: number,
			w: number,
			h: number,
			indexedPixels: Uint8Array | number[],
			opts?: GifWriterFrameOptions
		): number;

		end(): number;
		getOutputBuffer(): Uint8Array;
		getOutputBufferPosition(): number;
		setOutputBufferPosition(v: number): void;
	}
}
