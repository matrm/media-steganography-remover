# Context: Media Steganography Remover

A single-file web page that removes steganography from media files.

## Project Structure

- **`src/index.html`** - The single HTML page with the full UI: drop zone, file list, processing option checkboxes (strip metadata, clear/randomize LSBs, blur, JPEG re-compress), Remove SynthID option with preset/parameter controls (elastic warp, affine jitter, resize squeeze, color shift, luma noise, re-encode rounds, PSNR floor, bilateral smoothing), filename mode controls (suffix/prefix/hash), action buttons, progress bar, and results list. Imports `index.ts` as a module.
- **`src/index.ts`** - The application entry point and UI layer. Handles file drag-and-drop/selection, renders file lists, option rows, progress, results (including per-file warnings), ZIP bundling via `jszip`, and orchestrates per-file processing: FFmpeg.wasm loading/transcoding for videos (`@ffmpeg/ffmpeg`, metadata stripping), static-image processing through the canvas pipeline, and animated GIF frame decoding/re-encoding via `omggif`. Computes SHA-256 hashes. All media-manipulation algorithms live in `src/lib/*` modules.
- **`src/lib/types.ts`** - Shared types. Defines `Bitmap` as a structural `{ width, height, data }` image buffer so pixel pipelines run both in the browser and under Node-based tests.
- **`src/lib/util.ts`** - Generic helpers: MIME/extension mapping, input detection, output-format selection, output filename modes, blob/file reading, SHA-256 hashing, numeric option parsing with NaN fallbacks, canvas-to-blob export, and browser yield helpers.
- **`src/lib/pixels.ts`** - Pixel-level algorithms: LSB clearing/randomization, box blur, Lanczos-3/area separable resampling, resize squeeze, per-tile integer shift fragmentation applied as a smooth continuous displacement field (tile offsets interpolated across each cell), affine jitter warping with a Lanczos-3 sampler, combined color-shift matrix, luma noise, and bilateral filtering.
- **`src/lib/metrics.ts`** - Quality metrics: RGB PSNR, alpha PSNR, combined score, and transparency scanning.
- **`src/lib/quantize.ts`** - GIF quantization: median-cut palette generation with power-of-two padding, in-place palette mapping, palette-level LSB clearing/randomization for GIF output, and raw GIF background-color parsing.
- **`src/lib/gif.ts`** - GIF frame composition: applies a decoded frame's disposal to the compositing canvas, restoring only the disposed rectangle for disposal 2 (matching the spec and browsers) and the saved pre-frame state for disposal 3.
- **`src/lib/fft.ts`** - Discrete Fourier transforms: iterative radix-2 Cooley-Tukey plus Bluestein chirp-z so arbitrary (non-power-of-two) transform lengths match the codebook's native resolutions exactly.
- **`src/lib/synthid-codebook.ts`** - Compact SynthID carrier codebook: per Gemini model and resolution, the strongest-consensus FFT carrier bins and reference phases, distilled offline from the reverse-SynthID V4 artifact (MIT). Committed as a generated constant; regeneration is an upstream-tooling task (the .npz it derives from is LZMA-compressed and not decodable by browser tooling).
- **`src/lib/detection-cache.ts`** - Content-keyed cache of SynthID detection promises, shared by the pre-flight badge, the processing-time input verdict, retry probes, and output verification. Rejected detections are evicted so transient decode failures can retry, and eviction only removes the map entry that still holds the failed promise.
- **`src/lib/synthid-detect.ts`** - Statistical SynthID detection: FFT phase comparison at codebook carrier bins with cross-channel weighting and sigmoid confidence, used to verify input and output images in the results list. Heuristic, tuned for Gemini models; not a substitute for Google's verifier.
- **`src/lib/synthid-metadata.ts`** - Scans a file's leading bytes for Google's SynthID C2PA action, which corroborates a phase score too marginal to trust on pixels alone; processed outputs carry no metadata, so their verification stays pixel-only.
- **`src/lib/synthid.ts`** - Best-effort SynthID attack pipeline: strength presets, per-file random state, per-stage PSNR floor gating with rollback and skip warnings, with the geometric relocation stages (tile shifts, affine jitter) exempt because per-pixel PSNR misjudges them, re-encode round simulation, edge-preserving smoothing stage runner, and FFmpeg video filter-chain approximations. The spatial attack fragments the watermark's phase consensus via per-tile whole-pixel shifts applied as a smooth continuous displacement field (each tile's offset interpolates across its cell into its neighbours') plus a small global rotation.
- **`src/lib/*.test.ts`** - Vitest unit tests colocated with the modules they cover (`npm test`). Tests construct plain structural buffers instead of DOM `ImageData`, and use mocked `Math.random` sequences that respect the `[0, 1)` contract.
- **`src/style.css`** - Dark-themed CSS for the entire UI. Defines CSS custom properties for colors, spacing, and radii. Uses BEM-like class naming. Responsive grid layouts for file/results lists and options.
- **`src/types/css.d.ts`** - TypeScript ambient declaration for importing `.css` files as modules (returns a string).
- **`src/types/omggif.d.ts`** - TypeScript declarations for the `omggif` library (GIF reader/writer types).
- **`vite.config.ts`** - Vite config: sets `root` to `src/`, enables `vite-plugin-singlefile` to inline all assets, and uses `vite-plugin-static-copy` to copy FFmpeg.wasm worker/core/wasm files into `dist/ffmpeg/` so the in-page loader can resolve them.
- **`tsconfig.json`** - TypeScript config targeting ESNext with bundler module resolution and strict mode.
- **`package.json`** - Dependencies: `@ffmpeg/core`, `@ffmpeg/ffmpeg` (video processing), `jszip` (ZIP download), `omggif` (GIF reading/writing). Dev deps: TypeScript, Vite, `vite-plugin-singlefile`, `vite-plugin-static-copy`, `vitest`. Scripts: `dev`, `build`, `preview`, `test`.
- **`.editorconfig`** - Editor style rules: LF line endings, UTF-8, tab indentation (4 spaces), with exceptions for YAML workflows and JSON files (space, 2 spaces).
- **`.github/workflows/deploy.yml`** - GitHub Actions workflow for building and deploying to GitHub Pages on pushes to `main`.
- **`README.md`** - Project readme with link to the GitHub Pages deployment.
- **`dist/`** - Build output directory. Contains the bundled `index.html`, FFmpeg worker/core/wasm files in `dist/ffmpeg/`, and the generated JS bundle. Not tracked in version control (see `.gitignore`).

## Conventions

- The following files and directories must only be modified by human developers; do not edit them: `package.json`, `tsconfig.json`, `.github/workflows/deploy.yml`.
- Avoid adding dependencies unless essential. The user must be asked for permission before installing any.
- Avoid hardcoding values as much as reasonably possible.
- Never reference line numbers, non example dates, issue numbers, or workflow items in commit messages, tests, or code.
- Comments shouldn't reference older versions of the codebase unless the context is backwards compatibility.
- Comment style: Use `/** ... */` JSDoc only for public method documentation describing the API contract (parameters, return values, purpose). All other comments, including internal implementation notes, design decisions, test documentation, benchmark comments, and section headers, must use the `// ` prefix, except CSS comments may use `/* ... */` block syntax. Inline single-word comments inside code blocks (e.g., `catch (e) { /* expected */ }`) are an exception and may remain `/* */` for readability.
- The em dash character (U+2014) must not be used anywhere in the codebase.