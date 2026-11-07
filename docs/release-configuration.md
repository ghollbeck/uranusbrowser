# Release configuration

The normal source build requires no publishing credentials. It is ad hoc signed, and Sparkle
is disabled. The iOS simulator build requires no Apple team or provisioning profile.

For a distribution you control, configure macOS signing through a local
`ANUS_SIGN_IDENTITY` and `ANUS_NOTARY_PROFILE` backed by Keychain. Set a monotonic
`ANUS_BUILD_NUMBER` for each release. To include Sparkle, set `ANUS_UPDATES=1`,
`ANUS_SPARKLE_FEED_URL` (the HTTPS appcast for the architecture you build), and
`ANUS_SPARKLE_PUBLIC_KEY`. Keep the signing **private** key in your Keychain.
Use `chromium/scripts/build-release.sh --dmg` to build an installer.

`make-appcast.sh` needs `ANUS_RELEASE_SITE_URL` and `ANUS_DOWNLOAD_URL_PREFIX`.
`publish-release.sh` uploads to explicitly configured `ANUS_GITHUB_REPO` and
`ANUS_R2_BUCKET`, using `ANUS_DOWNLOAD_URL_PREFIX` to check the appcast. It leaves
old objects in place. Publishing requires your own authenticated GitHub and Cloudflare accounts.
Keep those credentials outside the repo.

For iOS distribution use your own signing and export configuration, outside this repository.
The contributor script has no TestFlight upload mode. Check dependency notices and package
contents before distributing any signed installer.
