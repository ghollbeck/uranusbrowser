# Third-party notices

- **Flecha Browser:** based on [Luciano de Souza's Flecha Browser](https://github.com/lucianodiisouza/flecha-browser). The original MIT notice is in [LICENSE](LICENSE).
- **Chromium:** the patches target the version recorded in [CHROMIUM_VERSION](chromium/CHROMIUM_VERSION). Chromium's [BSD-style notice](licenses/Chromium.txt) and notices for its dependencies apply to their respective code. Include the generated Chromium credits and applicable notices with any binary distribution.
- **joinly:** meeting-page selectors are adapted from [joinly](https://github.com/joinly-ai/joinly) under the [MIT license](licenses/joinly.txt). The optional joinly service is installed separately.
- **OpenWhisper:** meeting processing code was adapted from OpenWhisper ([MIT](licenses/OpenWhisper.txt)); see [meeting notes](docs/meeting-notes.md).
- **EasyList and EasyPrivacy:** the shell build fetches these lists and translates them into browser rules. They are by [The EasyList authors](https://easylist.to/) under their [dual GPL and CC BY-SA terms](https://easylist.to/pages/licence.html). No list or generated rule bundle is included here.
- **Sparkle, llama.cpp, and model weights:** fetched separately when enabled. See the [Sparkle license](https://github.com/sparkle-project/Sparkle/blob/2.10.0/LICENSE), [llama.cpp license](https://github.com/ggml-org/llama.cpp/blob/b11600/LICENSE) and [Underdog Woof model card](https://huggingface.co/ConwayResearch/Underdog-Woof-2B-1.1).
- **Node dependencies:** the lockfile identifies dependencies. Their packages retain their individual license notices.
