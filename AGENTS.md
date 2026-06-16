# Context: Media Steganography Remover

A single-file web page that removes steganography from media files.

## Project Structure

- **`src/index.html`** — The single HTML page with the full UI: drop zone, file list, processing option checkboxes (strip metadata, clear/randomize LSBs, blur, JPEG re-compress), filename mode controls (suffix/prefix/hash), action buttons, progress bar, and results list. Imports `index.ts` as a module.
- **`src/index.ts`** — The main application logic. Handles file drag-and-drop/selection, renders file lists and results, orchestrates per-file processing, and contains all image manipulation algorithms: LSB clearing/randomization, box blur, median-cut quantization (GIF), and animated GIF frame decoding/re-encoding via `omggif`. Uses FFmpeg.wasm (`@ffmpeg/ffmpeg`) for video transcoding and metadata stripping. Computes SHA-256 hashes for integrity checks. Bundles output into ZIP via `jszip`.
- **`src/style.css`** — Dark-themed CSS for the entire UI. Defines CSS custom properties for colors, spacing, and radii. Uses BEM-like class naming. Responsive grid layouts for file/results lists and options.
- **`src/types/css.d.ts`** — TypeScript ambient declaration for importing `.css` files as modules (returns a string).
- **`src/types/omggif.d.ts`** — TypeScript declarations for the `omggif` library (GIF reader/writer types).
- **`vite.config.ts`** — Vite config: sets `root` to `src/`, enables `vite-plugin-singlefile` to inline all assets, and uses `vite-plugin-static-copy` to copy FFmpeg.wasm worker/core/wasm files into `dist/ffmpeg/` so the in-page loader can resolve them.
- **`tsconfig.json`** — TypeScript config targeting ESNext with bundler module resolution and strict mode.
- **`package.json`** — Dependencies: `@ffmpeg/core`, `@ffmpeg/ffmpeg` (video processing), `jszip` (ZIP download), `omggif` (GIF reading/writing). Dev deps: TypeScript, Vite, `vite-plugin-singlefile`, `vite-plugin-static-copy`. Scripts: `dev`, `build`, `preview`.
- **`.editorconfig`** — Editor style rules: LF line endings, UTF-8, tab indentation (4 spaces), with exceptions for YAML workflows and JSON files (space, 2 spaces).
- **`.github/workflows/deploy.yml`** — GitHub Actions workflow for building and deploying to GitHub Pages on pushes to `main`.
- **`README.md`** — Project readme with link to the GitHub Pages deployment.
- **`dist/`** — Build output directory. Contains the bundled `index.html`, FFmpeg worker/core/wasm files in `dist/ffmpeg/`, and the generated JS bundle. Not tracked in version control (see `.gitignore`).

## Conventions

- The following files and directories must only be modified by human developers; do not edit them: `package.json`, `tsconfig.json`, `.github/workflows/deploy.yml`.
- Avoid adding dependencies unless essential. The user must be asked for permission before installing any.
- Avoid hardcoding values as much as reasonably possible.
- Never reference line numbers, non example dates, issue numbers, or workflow items in commit messages, tests, or code.
- Comments shouldn't reference older versions of the codebase unless the context is backwards compatibility.
- Comment style: Use `/** ... */` JSDoc only for public method documentation describing the API contract (parameters, return values, purpose). All other comments, including internal implementation notes, design decisions, test documentation, benchmark comments, and section headers, must use the `// ` prefix. Inline single-word comments inside code blocks (e.g., `catch (e) { /* expected */ }`) are an exception and may remain `/* */` for readability.
- The em dash character (—) must not be used anywhere in the codebase.