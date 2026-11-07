# Project identity and delivery

This desktop browser is **Uranus Browser**. Its product name is defined in `package.json` and `chromium/branding/BRANDING`; its macOS bundle identifier is `dev.oprimo.anus.browser`. Use `/Applications/Uranus Browser.app` as its stable installed path and keep that copy in the Dock. Arc is an import source. Claw is a separate project and must not be renamed, replaced, or repurposed for this browser.

Follow the existing shell/host build and `chromium/scripts/package-release.sh` packaging workflow, plus the global storage and backup policy. Preserve all local source changes and existing browser features when packaging.
