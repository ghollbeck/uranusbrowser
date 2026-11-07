# Agent panel feature log

One entry per feature, newest first, taken from `git log`. Dates are commit dates. For how to use each feature, see [user-guide.md](user-guide.md).

## 2026-10-31: Algorithm Diet on the desktop

The iOS app's Algorithm Diet, in the browser: the 🍴 button next to the Agent button in the sidebar's toolbar. Hover it for today in brief (grade, health, an hour-by-hour strip coloured by grade and a scrollable breakdown by category); click it for the full Diet in a tab, with the same cards as on the phone (score and plate, consumption, Nutrition Facts, categories, day by day, top sites, ingredients, diet plan), the animated classification run, **Ask your history** (chat) and **Pages & videos** (every recorded visit and why it got its score). Pages are tracked as you read them: every 5 s the active tab of the window in front is sampled (title, description, a visible article or transcript excerpt, the video clock), only while you're at the Mac or a video is playing; incognito is never recorded. Past history from Arc, Chrome or Uranus Browser can be imported (`mobile/app/Tools/export-history.py`). The rules and scores are the iOS ones (`shell/lib/diet*.ts`, checked against the Swift implementation); Underdog Woof 2B sorts unknown sites and video titles and answers the chat, on this Mac only (the helper's `dietComplete`). Everything stays in the shell's own IndexedDB.

## 2026-10-31: ⌘Z in the sidebar reopens closed tabs

With the sidebar focused, ⌘Z brings back what the last close or delete took away, in the same Space, folder and place, and shows it: a Today tab closed with its ✕, Close Tabs Below / Other Tabs, Clear (all of Today, as one undo), archived or deleted tabs (pinned ones go back into their folder), a folder deleted with its tabs (it comes back whole), and an unloaded pinned tab (it opens again at the page it was on). Press it again to go further back, up to the last 30 closes; the list is saved, so it still works minutes or a restart later. ⇧⌘T does the same, then falls back to the archive. ⌘Z in a text field stays that field's undo. Auto-archive, phone mirrors and tabs moved to Uranus Mini aren't undone.

## 2026-10-31: The meeting reminder records, and can bring the AI assistant

The macOS notification before a calendar meeting: a click opens it to join yourself; **Join & record** opens it and starts meeting notes by themselves (a "Recording …" notification has Stop); **Record + AI assistant** (when joinly is switched on) also sends the joinly assistant in. Open & record in the panel starts the notes the same way. If they can't start by themselves, the ready card asks as before. In Agent in a meeting, the link is filled in for you (the meeting tab you're on, else your next calendar meeting) and today's meetings are one-click picks: no pasting.

## 2026-10-30: Answers in Markdown, links as pills

The agent's answers are drawn from Markdown: headings, lists, task boxes, quotes, code blocks with Copy, and tables. Links and bare addresses are pills with the site's icon (from the local icon cache) and open in a new tab; images are cards that load only on a click (a loaded image address can leak what the agent read). The model is told to format with Markdown and cite pages as links. No HTML from an answer is ever used as markup.

## 2026-10-30: One model picker

The composer's left model button is gone; the selector on the right is the only picker. Its pill shows the companion and the model, Model › lists every provider's models, and Thinking › (Light to Ultra) sets the effort, which now reaches ChatGPT too (it was fixed at low). The Efficient / Default / Expert modes are gone. With ChatGPT, Codex's own bundled skills (image generation and others, whose tools are off here) are no longer advertised.

## 2026-10-30: Routines around calendar meetings

A routine's When can be **Meeting**: N minutes before each meeting starts or after it ends, optionally only meetings whose title contains a word. Meetings come from the connected calendar (timed events with a Meet, Zoom or Teams link) and a moved meeting moves its run. The run gets the meeting's title, time and platform fenced as untrusted data, and an "after" run gets that meeting's recorded notes. Two templates: Prepare for meetings, Follow up after meetings.

## 2026-10-30: Companion profiles: knowledge, files and skills

Each companion now has a profile with four tabs (About, Knowledge, Skills, Memory), and the list says what each one has. **Knowledge:** project context sent with every message, and attached files (PDF, Word, RTF, HTML, text) read into text on this Mac by the helper (PDFKit, `textutil`) and read by the agent a window at a time with `read_file`, fenced as untrusted data. **Skills:** saved ways of doing a task that the agent loads with `use_skill` when a request matches; made by hand, by asking the agent (`save_skill`, behind an approval card that shows the steps), or drafted from a routine run that went well (History › Save as skill). Type **/** in the composer to pick one for a message.

## 2026-10-30: Calendar reminders for meeting notes

Connect a calendar by its private iCal address (Google's "Secret address in iCal format", or an Outlook or iCloud ICS / webcal link; no OAuth) in the Meetings sheet. About 2 minutes before a meeting with a Google Meet, Zoom or Teams link, a notification offers **Open & record**: the link opens in a new tab and the Agent panel opens on a "Ready to record this meeting" card, where the user's click on Start recording starts it. The sheet lists today's next three meetings, and a strip above the conversation shows one about to start. Without a calendar, a Meet, Zoom or Teams meeting tab gets "This looks like a meeting. Record notes?" (switchable with "Offer to record meetings"). The address is treated as a secret (own key, masked, never logged or sent to the model); event text is plain text only and never reaches the model. Dismissals are remembered per occurrence.
Commits: `3e9a040` (iCal parsing, recurrence and meeting links), `eafae6b` (tests), `4a208ee` (notifications, ready card, Upcoming card, Calendar screen, meeting-tab strip).

## 2026-10-29: Voice mode for the meeting bot (local, opt-in)

While the bot is in a meeting, an opt-in "Voice mode" lets it answer out loud by itself: joinly's local speech recognition, then a local Ollama model (default `qwen3:4b`, 127.0.0.1 only), then joinly's local voice, with the first sentence spoken while the model is still writing. Off in every meeting, started by a confirmed click in the Meetings sheet, shown in the banner with a Stop button, and switched off after 20 minutes, on Leave, or when anything goes wrong. It only speaks (no tools, no chat posts), at most 2 sentences and 8 answers a minute; what people say reaches the model fenced as untrusted data. Also: the panel's latest talk now follows joinly's push notices instead of 4-second polling, and a spoken-language picker tells joinly's speech recognition what language to expect.

## 2026-10-29: First-run permissions step

Microphone, camera and App Management buttons in the welcome tour, replayable from Settings > General > Welcome tour. The camera and microphone requests open in one tidy tab.
Commits: `4fbccfb` (ask for permissions up front, with buttons), `5a7e74d` (ask for the camera and microphone at once, in one tidy tab). Packaging also adds the microphone usage description (`8d0f876`, 2026-10-28).

## 2026-10-28: Underdog Woof, an optional on-device notes writer

A "Write on this Mac" button for meeting notes that runs Underdog Woof through MLX. Never the default, nothing loads until the first prompt, released after 5 idle minutes.
Commit: `a8aa5eb`.

## 2026-10-28: Microphone picker

Meeting notes use this Mac's built-in microphone by default, with System default and any input by name as choices.
Commits: `5c02555` (choose the microphone; this Mac's built-in one by default), `33bae2c` (pick any microphone by name), `cb406f6` (reopen the microphone when it disappears mid-recording).

## 2026-10-28: Agent in a meeting (joinly client)

The agent can join Google Meet, Zoom or Teams through a joinly server you run on this Mac. Opt-in with consent; join, speak and chat each need an approval card; Stop makes it leave.
Commits: `c3c7886` (meeting tools and a loopback joinly client in the native host), `7a6323f` (Meetings sheet, opt-in and live banner), `be46575` (end-to-end test against a fake joinly server), merged in `6f1fcd8`.

## 2026-10-28: Meeting notes

Record a meeting from the Agent panel with a live transcript, speaker names on Meet/Zoom/Teams, grounded notes (overview, decisions, action items, open questions), saved meetings, and tab audio added by shortcut or context-menu item.
Commits: `3b80d99` (pure logic), `6f2a431` (host transcription with OpenAI or local whisper, grounded summaries), `50a3bdf` (offscreen recorder, chunker, speaker names), `bc77001` (recorder card, live transcript, notes, saved meetings), `51963ae` (tab audio from a context-menu item or a command), `f1437e9` (hint leads with the shortcut), `39c28ab` (only the capture page may report). Merged in `4fec527` and `e295e4a`.

## 2026-10-28: Routines

Scheduled agent tasks (daily, interval, once) that run only while Uranus Browser is open. Overdue runs wait for you; approvals are never automatic; a card unanswered for 10 minutes stops the run; each run leaves a record.
Commits: `e10472d` (scheduled agent tasks), `6a4943d` (Routines sheet, overdue badge and card), merged in `10c9040`.

## 2026-10-28: Artifacts

Tables, charts, key-number cards and one-pagers shown in the conversation, with copy and download, replaced in place by id.
Commits: `faa0c2d` (visual artifacts), `18d03a7` (chart sizing, table scroll hint, end-to-end test).

## 2026-10-28: Companions and memory

Built-in and custom companions, and per-companion memory that only grows through an approval card or your own typing.
Commit: `8cd10fd`.

## Related fixes in the same period

- 2026-10-28, `5f63873`: the shell's manifest version now comes from a hash of its built files, so Chromium replaces a stale cached background worker after an update.
- 2026-10-29, `b4fb736`: the ScienceOS design system's colours, shapes and icons are adopted across the shell.
