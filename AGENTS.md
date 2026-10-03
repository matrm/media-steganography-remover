# Context: Media Steganography Remover

A single-file web page that removes steganography from media files.

## Project Structure

- **`src/index.html`** - The whole UI. Imports `index.ts` as a module.
- **`src/index.ts`** - Entry point: file queue, options, processing orchestration, results.
- **`src/style.css`** - All styling.
- **`src/lib/types.ts`** - Shared types.
- **`src/lib/util.ts`** - MIME/extension mapping, filenames, hashing, other generic helpers.
- **`src/lib/pixels.ts`** - Per-pixel algorithms: LSB, blur, resampling, warps, noise, bilateral.
- **`src/lib/metrics.ts`** - PSNR and transparency checks.
- **`src/lib/quantize.ts`** - GIF palette quantization.
- **`src/lib/gif.ts`** - GIF frame disposal and compositing.
- **`src/lib/synthid-metadata.ts`** - Bounded byte scan for Google's SynthID C2PA declaration.
- **`src/lib/declaration-cache.ts`** - Content-keyed cache of file declarations.
- **`src/lib/distort.ts`** - The distortion pipeline and its video filter approximations.
- **`src/lib/*.test.ts`** - Vitest unit tests colocated with the module they cover.
- **`src/types/*.d.ts`** - Ambient declarations for untyped imports.
- **`vite.config.ts`** - Build config: single-file inlining and FFmpeg asset copying.
- **`tsconfig.json`** - TypeScript config.
- **`package.json`** - Dependencies and scripts.
- **`.editorconfig`** - Editor style rules.
- **`.github/workflows/deploy.yml`** - Build and deploy to GitHub Pages.
- **`README.md`** - Project readme.
- **`dist/`** - Build output. Not tracked in version control.

## Conventions

- The following files and directories must only be modified by human developers; do not edit them: `package.json`, `tsconfig.json`, `.github/workflows/deploy.yml`.
- Avoid adding dependencies unless essential. The user must be asked for permission before installing any.
- Avoid hardcoding values as much as reasonably possible.
- Never reference line numbers, non example dates, issue numbers, or workflow items in commit messages, tests, or code.
- Comments shouldn't reference older versions of the codebase unless the context is backwards compatibility.
- Comment style: Use `/** ... */` JSDoc only for public method documentation describing the API contract (parameters, return values, purpose). All other comments, including internal implementation notes, design decisions, test documentation, benchmark comments, and section headers, must use the `// ` prefix, except CSS comments may use `/* ... */` block syntax. Inline single-word comments inside code blocks (e.g., `catch (e) { /* expected */ }`) are an exception and may remain `/* */` for readability.
- The em dash character (U+2014) must not be used anywhere in the codebase.
