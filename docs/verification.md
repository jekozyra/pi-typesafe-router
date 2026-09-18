# Local implementation verification

Verified on Node.js 22.23.2 with Pi 0.85.1.

- `npm run check`: TypeScript passes; 121 tests pass, zero failures or skips.
- `npm run smoke:package`: packed tarball installs into an isolated directory and loads through Pi's actual extension loader with production dependencies.
- `git diff --check` and staged whitespace check: pass.
- Independent multi-persona review identified three command/recovery defects. All were fixed, covered by regressions, and confirmed fixed in a separate source review.

The regressions cover delayed confirmations, reload versus off/shutdown, concurrent input, non-cancellable model selection, navigation vetoes, and recovery attribution after manual model changes. Real Pi SDK tests cover selection before generation, off-mode pass-through, and failure without router replay.

No live classification or generation API calls were made. No real credentials were read for tests, installed Pi settings were changed, or remote package/repository publication performed. Live backend contract checks, particularly Vercel confidence metadata, remain a release prerequisite. Pi's non-cancellable setter and imperfect ownership identification between extensions remain documented host limitations. Do not enable competing routers.
