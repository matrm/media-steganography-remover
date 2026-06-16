import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { viteStaticCopy } from 'vite-plugin-static-copy';

export default defineConfig({
	base: './',
	root: 'src',
	plugins: [
		viteSingleFile(),
		viteStaticCopy({
			targets: [
				{
					src: '../node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js',
					dest: 'ffmpeg',
					rename: { stripBase: true }
				},
				{
					src: '../node_modules/@ffmpeg/ffmpeg/dist/esm/const.js',
					dest: 'ffmpeg',
					rename: { stripBase: true }
				},
				{
					src: '../node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js',
					dest: 'ffmpeg',
					rename: { stripBase: true }
				},
				{
					src: '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js',
					dest: 'ffmpeg',
					rename: { stripBase: true }
				},
				{
					src: '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm',
					dest: 'ffmpeg',
					rename: { stripBase: true }
				}
			]
		})
	],
	build: {
		target: 'esnext',
		cssCodeSplit: false,
		outDir: '../dist',
		emptyOutDir: true,
		minify: false
	}
});
