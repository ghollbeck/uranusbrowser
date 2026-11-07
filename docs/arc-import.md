# Importing from Arc on macOS

Use Settings → Import → Arc, or the import step during initial setup. The optional password checkbox is selected initially. macOS may request access to **Arc Safe Storage**. The importer reads Arc's original files without changing them.

| Arc | This browser |
| --- | --- |
| Spaces | Spaces, with names, available emoji and nearest solid theme color |
| Favorites in every profile | Global favorites shelf |
| Pinned tabs and nested folders | Pinned tabs and nested folders in the matching Space |
| Split groups | A folder containing each member tab |
| Unpinned tabs | Today, restored without loading every page |
| Custom profiles | Isolated Spaces (each has its own session; Spaces do not share an Arc profile session) |
| History | Browser history and command-bar suggestions |
| Saved passwords | Local Chromium password store |

Existing imported Spaces and favorites are preserved on a repeated import, using Arc item IDs saved with the browser state. This is a migration, not an ongoing sync: changes inside an already imported Space are not synchronized. Existing local tabs are preserved. Unsupported Arc documents, easels, internal URLs, malformed entries and oversized trees are reported as skipped.

Passwords are read from every Arc profile's `Login Data` and `Login Data For Account`. Supported macOS v10 credentials are decrypted in memory after Keychain authorization, then sent only to the trusted background worker and saved using `chrome.passwordsPrivate.addPassword`. Credentials do not enter the settings/onboarding renderer, sidebar state, extension storage, CSV files or logs. The password-manager tab opens in the background to initialize Chromium's password delegate and remains available for reviewing the result. Existing origin/username pairs take precedence; duplicates across Arc profiles are skipped. The UI reports added/kept/skipped totals and partial failures, and offers **Import passwords** separately for retrying.

Cached page bytes, cookies, active sign-ins and passkeys are not transferred. Pages reload when opened. Isolated Spaces require signing in again. Arc remains untouched.

## Validation

`npm run typecheck`, `npm test` and `chromium/tests/arcMigration.test.ts` cover decoding, cycles/unsafe URLs, split/nested nodes, all favorites containers, colors, persistence, repeat imports, local tab preservation, empty import and v10 decryption. Real-browser scenarios are specified in `chromium/tests/scenarios.jsonl`; the private runner lives in the ignored `.scratch` folder. Real tests use a separate profile under `the browser profile Import Tests/`, with normal OS encryption. These profiles contain personal imported data and must not be published or treated as disposable build output.

## Packaging and delivery

Shell/host changes require no native Chromium compile. Reuse the installed browser's native bundle via the existing `chromium/scripts/package-release.sh`, with `ANUS_APP_IN` pointing at that bundle, `ANUS_NODE` pointing at its bundled Node, and `ANUS_RELEASE_DIR` set to the guarded managed output. Use the build environment from `~/flecha-chromium/run-build.sh`. Move the resulting single app to the managed output root, and move signing receipts outside the managed output. Run `agent-storage run --producer codex --session <actual-session> --kind macos-app --integrated-into mine/dev` with explicit `codesign --verify --deep --strict` verification.

Acquire a `use` lease before copying a managed app for installation. Keep source changes and release receipts. Back up the installed bundle before replacing `/Applications/UrAnus Browser.app`, retain two verified previous browser bundles in the existing canonical backup root, update the Dock path, and reopen/verify the installed copy. Never launch the sealed managed export itself: Chromium writes generated extension metadata into a running bundle.

## Replay setup safely

Settings → General → **Replay onboarding** reopens the walkthrough without resetting the profile. Existing Space names, colors, folders, pins and tabs are shown without editable Space-setup controls. Skipping or completing replay clears only its replay flag. Explicitly choosing an import, default-browser action or permission action still performs that action. An interrupted replay survives restarting the browser.
