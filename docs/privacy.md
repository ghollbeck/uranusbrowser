# Privacy and data flows

Ordinary browsing connects to the sites you visit and the search engine you choose.
The privacy settings and data practices of those services still apply.

- **Local browser data.** Chromium and WebKit keep history, tabs and site data in their
  profiles or app containers. Optional browser imports read other profiles locally. On iOS,
  Algorithm Diet records browsing activity and page excerpts in a local database; private tabs
  are excluded. The optional on-device model is downloaded from Hugging Face. Keep profiles,
  exports, transcripts, crash reports and screenshots out of bug reports and commits.
- **AI chat and routines.** If you choose OpenAI API or sign in through Codex, the selected
  provider can receive prompts, page URLs and text read by the agent, plus relevant attachments
  or saved context you include. The OpenAI API key is saved in macOS Keychain. The development
  host can also read `OPENAI_API_KEY` from its environment. The Responses API sets
  `store: false`; [OpenAI API abuse-monitoring retention](https://developers.openai.com/api/docs/guides/your-data)
  is separate. The Codex sign-in path follows the signed-in account's data settings.
- **Meeting notes.** Recording captures the microphone when started; tab audio can be added.
  Cloud transcription sends audio chunks to OpenAI; cloud summaries send transcript text to
  the selected provider. Use local Whisper for transcription and an on-device model for summaries
  to keep those processing steps local. The optional meeting assistant uses a local joinly
  connection; joinly's own backend configuration and the meeting provider determine what it
  sends onward. Obtain permission before recording other people.
- **Calendar and agent tools.** Calendar integration fetches the feed URL you configure.
  Treat private calendar URLs as credentials. The optional MCP server listens on loopback and
  requires a token. Clients you authorize can read or control browser content and may send it
  to their own providers.

See [AI providers](ai-providers.md) and [meeting notes](meeting-notes.md) for setup and details.

## Download website

The separately hosted download website counts page views and download starts. These totals
are approximate and do not count unique people. The analytics counter does not set cookies
or assign visitor identifiers. It does not record visitors' countries. The server receives
the network information needed to respond to requests and uses addresses temporarily for
rate limiting.
