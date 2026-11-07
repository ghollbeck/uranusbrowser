# Contributing to UrAnus Browser

Thanks for looking. UrAnus Browser is a young project with a strong opinion about how it should look and feel, so it helps to read this before sending anything.

## Reporting bugs

Open an issue with: what you did, what you expected, what happened, your macOS version and the UrAnus Browser version. A screenshot or a short screen recording helps a lot for anything visual. For a crash, describe the action using a public example. Remove personal tabs, meeting links, API keys, and account information from attachments; use a clean profile to reproduce bugs.

## Setup

You need macOS on Apple Silicon, Node 24, and for native changes a Chromium checkout. [README.md](README.md#build-from-source) has the full list.

```bash
npm ci
npm run typecheck
```

## Two kinds of change

**Shell changes** (anything under `chromium/shell/`, `chromium/shared/` or `chromium/native-host/`) need no Chromium build. This is where most work happens:

```bash
node chromium/shell/build.mjs          # or: npm run shell:watch
chromium/scripts/run.sh                # relaunch the dev build with the new shell
```

**Native changes** (window frame, Peek, extension APIs, anything Chromium itself must do) are patches against the Chromium checkout, kept in `chromium/patches/` as plain unified diffs.

### Writing a patch

1. Run `chromium/scripts/apply.sh` so the checkout has every existing patch.
2. Edit the checkout under `$CHROMIUM_SRC` (see `chromium/scripts/env.sh`).
3. Turn your edit into a patch and number it after the last one. For a change that stands alone, add a new file with `git diff > chromium/patches/00NN-short-name.patch`, containing only your edit. For a follow-up to an existing patch, regenerate that patch's diff for the files it covers.
4. Run `chromium/scripts/apply.sh` again on its own: it resets every file it touches, then applies all patches in order, so it proves the set still applies cleanly.
5. Build with `chromium/scripts/build.sh` and try it.

Keep a patch small and about one thing. Put a comment at the top of new files, and `// UrAnus Browser:` comments at the edits inside Chromium's files, saying why. New code goes in new files where possible, so Chromium upgrades hurt less. Packaging patches are numbered from 0050.

## Style

- Match the code around you: naming, structure, formatting. TypeScript is strict; `npm run typecheck` must pass.
- Comments explain why, not what. A short doc comment on each module and on anything whose reason isn't obvious; none on the obvious.
- No new dependencies without a reason. The shell is bundled by esbuild into an MV3 extension and should stay small.
- Don't copy Arc code, assets or text. Interface ideas are fair game; implementations are our own.

## Design

UrAnus Browser's interface has to feel polished, at the level of Arc itself. Spacing, alignment, motion, dark mode and corner radii are part of correctness here. If you change something visible, check it in light and dark, and attach a screenshot to the pull request.

## Commits

Make small, focused commits, one idea each, in conventional style:

```
feat(chromium): the release dmg opens as an installer window
fix(shell): the frame page draws no empty-state card of its own
docs: README lists what the Chromium build has
```

Use `feat`, `fix`, `docs`, `refactor`, `chore`, with a scope (`chromium`, `shell`, `native-host`) when it helps. Say what changed and why in a sentence or two when the title isn't enough. A patch and the shell code that uses it can be separate commits.

## License

By contributing you agree that your work is released under the [MIT license](LICENSE).
