# Uranus Browser for iPhone

Native SwiftUI browser on `WKWebView`, requiring iOS 26 and Xcode 26.
Install [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
From this directory:

- `./run.sh build` builds for the simulator without signing.
- `./run.sh` builds and runs it in a simulator. Install the iOS 26.5 runtime to let the script create its default simulator, or set `FLECHA_SIM` to an existing iOS 26 simulator name.
- For a physical iPhone, set `ANUS_IOS_TEAM` to your Apple development team and `ANUS_IOS_BUNDLE_ID` to a bundle identifier you control, then run `./run.sh device-build`. To install and launch on a paired device, also set `FLECHA_DEVICE` and run `./run.sh device`. This requires local signing and provisioning. This checkout does not include TestFlight upload tooling or profiles.

The Xcode target and scheme are named `Flecha`. A deep link can be tested with
`xcrun simctl openurl booted 'flecha://open?url=https%3A%2F%2Fexample.org'`.

## Built and checked in the simulator (iOS 26.5)
- **Shell:** the page runs edge to edge, under the Dynamic Island (blur fades it out at the top) and under the bottom bar. The bar is a real blur of the page mixed with the page's average colour (sampled from a 48 px snapshot after loads and after scrolling stops) and flips light/dark with the page; controls: Arc-style two-card tab stack (no circle), glass "+", chevron; load-progress line; new-tab page with Space gradient. Known gap: fixed-position page elements at the bottom (cookie bars) sit under our bar; the status bar text colour follows the app setting, so a scrim keeps it readable on pages of the opposite brightness.
- **Search sheet:** address or search, history and open-tab suggestions, URL selected on open. Search engines: Google, DuckDuckGo, Bing, Brave.
- **Tab switcher:** card carousel with snapshots; close by swiping a card up, the X, or long-press; pin via long-press; Spaces / "+" / settings bar.
- **Spaces:** each has its own tabs, history, archive and its own persistent cookie/storage (`WKWebsiteDataStore(forIdentifier:)`). Checked: the same origin in two Spaces saw separate cookies and localStorage.
- **Private mode:** non-persistent data store, tabs discarded when you leave Private, nothing written to disk for private tabs.
- **Page menu:** back/forward, copy link, reload, Find on Page (`WKWebView.find`), Pin, Share, Page Zoom, Request Desktop Site.
- **Site Settings:** per-site Block Ads / Cookie Banners / Trackers using WebKit content rules (small starter lists, not EasyList). Checked: banner hidden and ad/tracker requests failed in ~4 ms with blocking on; with it off the banner showed and the requests went out.
- **Archive:** tabs idle longer than the chosen time (1 day default) move to the Archive on launch and foreground; tap to restore.
- **Settings:** search engine, appearance (system/light/dark), auto-open keyboard, archive timing, clear browsing data (current Space), export tab URLs.
- **Favicons:** cached per site (memory + disk, 7-day freshness with background refresh, failures remembered 24 h, private tabs memory-only).
- **Twin pills (experimental top style, Settings > Top bar style):** the Dynamic Island stays the fixed middle piece, two black pills (clock left, Wi-Fi/battery right) glide either side of it with the phone's tilt and bounce off the screen edges and the island (pure physics in `Sources/TwinPillPhysics.swift`, checked by `Tools/physics-check.swift`; views in `Sources/TwinPills.swift`). The system status bar is hidden while it is on. No motion hardware (Simulator): a floating "Tilt" slider; launch args `-topStyle twinPills -simTilt 0.8|auto`. Never the default.
- **Persistence:** `Application Support/state.json` plus tab snapshots in Caches. Up to 5 background tabs keep a live web view; older ones keep a snapshot and are reloaded when opened.

## Options to try (Settings)
- **Top bar style:** Blur, Black pill, Black pill + flowers (editable), Twin pills (physics). The pill styles also show over the tab switcher.
- **Motion:** pick A (calm), B (snappy) or C (expressive) for each of the 12 animated moments, live, plus Slow motion x4. Same numbering as `design/animations.html`. Honest limits per moment are shown under each picker (for example: system sheets cannot be retimed, so B and C use a custom sheet).

## Algorithm Diet (`Sources/Diet/`)
What you read and watch, sorted into categories and scored A to E. Inference and storage run locally; the model is downloaded once. This is a browsing reflection score inspired by food labels, not the official food Nutri-Score.
Open it from Settings > Algorithm Diet, `flecha://diet`, or launch arg `-openDiet 1`.
- **Automatic tracking** (`DietTracker`): navigation events and 5-second foreground samples record the visible selected page, its description/channel, and a bounded article or visible transcript excerpt (2,400 characters). Identifiable feed-post permalinks start separate visits. Video playback follows the video clock up to 2× speed; seeks and inactive gaps add nothing. First samples add zero time. Rules classify each visit immediately, and downloaded Woof automatically resolves unknown sites/videos. No import or manual classification is required for new browsing. Private tabs are never recorded. Toggle in the Diet's ... menu. Stored in `Application Support/diet/diet.sqlite`, separate from browser history.
- **Import:** `python3 Tools/export-history.py --arc -o history.json` (also `--chrome`, `--anus`, or a Chromium `History` file; `--since YYYY-MM-DD`) exports every Arc profile with Chromium's visit durations. Import it with the Diet's ... > Import History (Files app). Simulator: copy it to the app container's `Documents/history-import.json`; it's imported on the next open and renamed. Never commit an export.
- **Classifier** (`DietClassifier`, rules in `DietRules`): logins/redirects first (kept, never counted), then the site (host + first path segment, parent domains, prefixes like `docs.`, suffixes like `.edu`/`.vercel.app`), then the URL shape (Shorts/TikTok/Reels, `/watch`, search queries, subreddits), then title cues: on "container" sites (YouTube, Reddit, X, search, unknown) a clear title decides, so a YouTube lecture is learning. Each category has six nutrients (protein, fiber, vitamins vs sugar, salt, fat, each 0-10); clickbait adds sugar, outrage adds salt, long focused sessions add fiber, long feed sessions and late-night junk add fat. Grade = Nutri-Score style bad minus good points. Checked by `Tools/diet-check.swift` (35 golden cases; pass an export for a report):
  `swiftc -O -parse-as-library Sources/Diet/{DietModels,DietRules,DietClassifier,DietStats}.swift Tools/diet-check.swift -o /tmp/diet-check && /tmp/diet-check history.json`
- **On-device model: Underdog Woof 2B 1.1** (ConwayResearch, Apache-2.0; the chat model Underdog itself ships on phones). The newer Poodle 4B (Oct 24) is a 3 GB vision/agent model, too heavy for this. Woof sorts the 120 busiest sites the rules don't know and up to 150 video titles per run (JSON answers, temperature 0), and writes the chat answers.
  - iPhone: the model is downloaded in the Diet screen. llama.cpp runs on device. Test launch arg `-dietDownload 1` starts the download when the Diet opens.
  - Simulator: the llama.cpp release has no Simulator slice, so `Tools/woof-bridge.sh` serves the same Woof 2B (MLX build from OpenWhisper's cache) with mlx-lm on `127.0.0.1:8799` and the app streams from it.
  - No model: rules still classify and the chat answers from the numbers.
- **Screens:** measured browsing, estimated imported time and measured video playback are shown separately. Explore pages & videos searches the full recorded history in the selected range and shows source links, excerpts and classification evidence. Nutrition points use a 0–10 scale with explicit grade boundaries. The score card (plate donut, health 0-100, A-E strip that sweeps to your grade), Nutrition Facts label, time by category, day-by-day bars, top sites, "Ingredients" (topics, counted once per day), a diet plan (halve a junk category, see the new grade). The classification run shows phase, a springy gradient bar with shimmer, the item just sorted and bouncing A-E counters.
- **Chat** (`DietChat`): the question picks a range (today, yesterday, this/last week, this/last month, a month name, last N days; default 30 days) and a focus (learning, videos, searches, news...). Notes = stats, topics, recent searches and the most relevant titles, then Woof answers. Launch args for testing: `-dietChat 1 -dietAsk "What did I learn this month?"`, `-dietAutoRun 1`.

## Web apps

From a regular tab, open the page menu and choose **Share › Save as Web App**.
The saved site appears on the new tab page and opens full screen with the storage
of the Space where it was saved. YouTube and Instagram have dedicated controls.
Manage saved sites in **Settings › Web Apps**, or open one from Shortcuts with
**Open Web App**. Private tabs cannot be saved.

For device builds with Apple's default browser entitlement, set
`ANUS_BROWSER_ENTITLEMENT=1` alongside your signing settings. This enables the
native Add to Home Screen sheet. The entitlement is optional for the simulator,
the in-app web app grid, and Shortcuts.

Run the simulator UI tests with the `Flecha` scheme and `FlechaUITests` target.
They cover saving and reopening a live site and the YouTube and Instagram controls.

## Privacy

Use synthetic examples for tests. Imports, tab snapshots, app data and model weights are local
files and must stay outside the repo. See [privacy and data flows](../../docs/privacy.md).
