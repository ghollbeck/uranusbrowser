# UrAnus Browser Agent panel: user guide

This guide covers what the Agent panel can do beyond plain chat: companions (their knowledge, skills and memory), artifacts, routines, meeting notes, and the agent joining a meeting. Every statement here was checked against the code in this repository (the file names are in brackets where that helps). The base setup (OpenAI key, how the agent works on pages) is in the [README](../README.md#agent-panel).

Open the panel with **⌥⌘A** or the button next to the sidebar toggle. Its header, left to right: New conversation (pencil), the companion picker, then icons for Meeting notes (microphone), Routines (clock, shown when routines are available), Agent in a meeting (people) and Close. The panel does not exist in private windows.

## Contents

1. [Companions: knowledge, skills and memory](#companions-knowledge-skills-and-memory)
2. [Artifacts](#artifacts)
3. [Routines](#routines)
4. [Meeting notes](#meeting-notes)
5. [Agent in a meeting](#agent-in-a-meeting)
6. [First-run permissions](#first-run-permissions)
7. [Keyboard shortcuts](#keyboard-shortcuts)
8. [Where your data lives](#where-your-data-lives)
9. [When something goes wrong](#when-something-goes-wrong)
10. [Not built yet](#not-built-yet)

## Companions: knowledge, skills and memory

A companion is a name, a one-line role and some instructions that shape how the agent works for you, plus what it knows (project context and files), how it does recurring tasks (skills) and what it remembers (notes). Open the sheet from the composer's selector ("Companions, skills and files…"). Click a companion's row to work as it; click its chevron to open its **profile**, with four tabs: About, Knowledge, Skills and Memory. Each row says what the companion has ("2 skills · 1 file · 5 notes"). Picking another companion starts a new conversation, and you can't switch while the agent is working (stop it or wait). [`shared/companions.ts`, `shared/knowledge.ts`, `shared/skills.ts`, `shell/agentPanel.ts`, `shell/ui/companionsSheet.ts`]

**Built-in presets:** General (no extra instructions), Researcher, Sales, Marketing, Recruiting, Executive assistant. A preset's name and instructions can't be edited (About › "Make an editable copy" gives you one that can), but its knowledge, skills and memory are yours to fill.

**Your own companions:** New companion in the list. Limits: up to 12 of your own, name 40 characters, role 80, instructions 2000. A new one opens on its profile. Removing one also deletes its notes, context, files and skills.

Instructions, context and skills can change focus, tone and habits. They cannot switch off approval cards or allow something the safety rules forbid: those rules run in code, not in the prompt.

### Knowledge: project context and files

**Project context** (Knowledge tab) is background the companion gets with every message: what you're working on, who it's for, names and terms. Up to 6000 characters. It's saved when you leave the field (or press Save).

**Files:** Add files (or drop them on the box) to give a companion documents to work from: PDF, Word (`.doc`, `.docx`), RTF, OpenDocument, HTML, Markdown, CSV, JSON and other plain text, up to 15 MB each and 10 per companion. [`native-host/fileText.ts`]

- Only the **text** is kept, in this profile (up to 200,000 characters a file; a longer one is cut and marked "(cut)"). The original file isn't copied.
- PDFs and documents are read **on this Mac** by UrAnus Browser's helper, with macOS's own PDFKit and `textutil`. Nothing is uploaded to read them. A scanned PDF with no text layer is refused ("has no text that can be read").
- The agent sees each file's name and size with every message and reads a file (24,000 characters at a time) with its `read_file` tool when it could help. That shows as a step ("Read “Brief.pdf”") and the part it read goes to OpenAI with the conversation.
- A file's text is handled like a web page: the agent uses what it says and never follows instructions in it.
- Click a file to see its first lines; the trash button removes it (and its text).

### Skills

A skill is a saved way of doing a task: a name, one line on **when to use it**, and the **steps**, written as you would for a new colleague. Up to 20 per companion, steps up to 4000 characters. The agent sees every skill's name and when-line with each message and loads a skill's steps (its `use_skill` tool, shown as "Using the skill “…”") when a request matches.

Three ways to make one:

- **Write it** in the Skills tab (New skill).
- **Ask in chat:** "save how you did that as a skill". The agent writes it with its `save_skill` tool, and an **approval card** shows the whole skill, steps open, before anything is saved. Decline and nothing is saved.
- **From a routine run that went well:** Routines › a routine's History › a run marked Done › **Save as skill**. This opens the skill form with a draft: the routine's instructions and the steps that worked in that run (declined or failed steps are left out). Edit it and Save; nothing is kept until you do.

**Use one straight away:** type **/** at the start of a message to list the active companion's skills (type more to filter, arrow keys and Enter, or click). The skill sits above the text field as a chip; send your message and its steps go with it. Sending with only the chip runs the skill as it is. The chip's × (or Backspace in an empty field) takes it off. A skill's Use button does the same from the Skills tab.

A skill that holds something that looks like a password or API key is refused. Skills go to OpenAI with your messages, like instructions.

### Memory

Each companion keeps a short list of notes for later conversations, in its Memory tab (with a count out of 40). Notes are added in two ways:

- **You type one** in the notes box (Add).
- **The agent proposes one** with its `remember` tool, when you ask it to remember something or state a lasting preference. This always shows an **approval card** ("Save to General's memory: ..."). Decline and nothing is saved; the agent is told not to save it another way.

Rules for notes:

- One line, 300 characters at most. Up to 40 notes per companion. A duplicate is refused. When it is full, remove one first.
- Anything that looks like a password, API key, card number or "my password is ..." is refused, both when you type it and when the agent proposes it.
- The notes reach the model as data, below the safety rules, and go to OpenAI with your later messages. The agent is told never to save what a web page or a tool result said.
- Remove one note with its trash button, or "Clear all notes" (it asks first).

## How answers look

The agent writes its answers in Markdown, and the panel draws it: headings, **bold**, lists (with ticked boxes for "- [x]"), quotes, inline code, code blocks with their language and a **Copy** button, and tables (numbers right-aligned when the agent says so; a wide table scrolls sideways). [`shell/lib/markdown.ts`, `shell/ui/markdownView.ts`]

- **Links are pills**: the site's icon, the page title or a short address ("ethz.ch/en/…"), and the site. The full address is the tooltip; a click opens it in a new tab. Icons come from the browser's own icon cache, so nothing is fetched from the site to draw them. Only web (http/https) and mail links become pills; anything else stays as words.
- **Images wait for a click.** An image is a card naming its site ("From example.com. Click to show it."). It isn't loaded until you click: a page the agent read could have talked it into an image address that carries what it saw, and loading the image is what would send it.
- Raw HTML in an answer is shown as text, never run.

## Artifacts

When you ask for a table, a chart, key numbers or a summary, or when the agent compares things side by side, it can show a visual inside the conversation instead of long text. An artifact is display only: it reads nothing and changes nothing, and it holds plain text and numbers only (no links, images or HTML). [`shared/artifacts.ts`, `shell/ui/artifacts.ts`]

| Kind | Shows | Limits |
| --- | --- | --- |
| Table | columns and rows, scrolls sideways with a fade hint | 8 columns, 50 rows |
| Chart | bar, line or pie; optional unit | 24 labels (12 for pie), up to 6 series; pie takes one series of non-negative numbers |
| Cards | a few key numbers with a label and an optional note | up to 12 cards |
| One-pager | headed sections with text and bullets | up to 8 sections |

Anything the agent puts in an artifact still comes from you or from pages it read, so treat it as data.

**Copy and download** (buttons under each artifact, run when you click):

- Copy: the content as a Markdown table (tables, charts, cards) or as Markdown (one-pager).
- Table and cards: CSV. Chart: SVG or PNG. One-pager: `.md`.
- Files are named after the artifact's title.

**Change an artifact:** ask ("make it a bar chart", "add a row"). The agent calls the tool again with the same id and the full new content, and the old artifact is replaced in place. A new request without an id adds a new one.

In a routine's run record an artifact is kept only as a line such as "Showed a chart: Title"; its data isn't stored there.

## Routines

A routine is a task the agent does on a schedule. Open it with the clock button. Each routine has a name, the companion that runs it, instructions (what you would type in the chat), a trigger and an on/off switch. [`shared/routines.ts`, `shell/routines.ts`]

**Triggers**

| Trigger | Meaning |
| --- | --- |
| Daily | a time (24-hour, your local time) on the days you pick; presets for Weekdays and Every day |
| Interval | every N minutes, at least 15 and at most one week; counts from when you save |
| Once | a date and time in the future (within five years) |

A once-only routine that has run shows "Ran once. Edit its time to run it again". Up to 20 routines.

### Around your meetings

With a calendar connected (Meeting notes › Connect a calendar…), a routine can run **around each meeting**: pick **Meeting** under When, then how many minutes (0 to 120) **before it starts** or **after it ends**, and optionally a word its title must contain ("standup", "Acme"). A meeting here is a timed calendar event with a Google Meet, Zoom or Teams link. A new routine offers two starting points: **Prepare for meetings** (10 minutes before: a short brief on who and what) and **Follow up after meetings** (5 minutes after: summary, decisions, action items, and a draft email that it does not send). [`shared/routines.ts`, `shell/routines.ts`]

- The run's message is the routine's instructions plus the meeting's title, time and platform, fenced as untrusted data: whoever sent the invitation wrote the title, so a title that sounds like an order is only a title.
- **After** a meeting, if you recorded it with Meeting notes (a recording started from 15 minutes before it until its end), its notes and as much of the transcript as fits (about 5,000 characters) go along, fenced the same way.
- A meeting that moves or is cancelled moves or drops the run (the calendar is read every 10 minutes). Without a calendar, or with no matching meeting coming up, the routine stays on and waits. **Run now** uses the matching meeting nearest to now.
- The same rules as any routine: only while UrAnus Browser is open, missed runs wait for you as overdue, and every approval card still asks. Nothing joins or records a meeting by itself.

### What a run is

A run is an ordinary conversation started for you: the panel opens, it switches to the routine's companion, starts a new conversation and sends the instructions as your message. It meets the same approval cards as anything else. **Nothing is ever approved automatically.** If an approval card sits unanswered for 10 minutes, the run is stopped, the card counts as declined, nothing is done, and the record says "Needed you". A new card starts a new 10-minute clock.

### Only while UrAnus Browser is open

Routines do not run when UrAnus Browser is closed. What happens at a due time:

- **UrAnus Browser open, agent free:** it starts at once.
- **UrAnus Browser open, agent busy:** it waits its turn (shown as "Waiting for the agent to finish"). If the wait passes 30 minutes it becomes overdue. One run at a time; a routine whose next time arrives while it is still running skips that time.
- **Overdue:** the time passed while UrAnus Browser was closed, the Mac slept (more than 5 minutes late), or the wait ran long. Nothing runs late on its own. A card above the conversation and a badge on the clock button show it, with **Run now** and **Skip**. Skip keeps a "Skipped" record.

If UrAnus Browser closes mid-run, that run is recorded as failed ("UrAnus Browser closed before the run finished"). If the routine's companion was deleted, the run fails with a message; edit the routine and pick another.

### Run records

Each routine has a History: status (Running, Done, Stopped, Needed you, Failed, Skipped), when, how long, and a trimmed copy of the conversation (the last 40 entries, 1000 characters each, 8000 in all). Up to 30 records per routine and 150 in total; older ones fall off. You can delete one record or clear a routine's history. Records are stored in this profile on this Mac and shown as plain text.

## Meeting notes

UrAnus Browser can record a meeting you are in, show a live transcript, and write notes when you stop. Open it with the microphone button. It starts only when you click **Start recording**, on the tab you are looking at, and a recording bar stays visible until it stops. The card reminds you to tell the other people that you are recording; check what applies where you are. It can also remind you from your calendar and offer to record when a tab is a meeting (below), but those only bring you to the same Start button. [`docs/meeting-notes.md` has the technical detail]

### Start and stop

1. Open the meeting in a tab and keep it as the current tab.
2. Choose the transcription engine and microphone (below).
3. Press **Start recording**. If UrAnus Browser has no microphone permission yet, it says so and offers "Allow the microphone..." (see [First-run permissions](#first-run-permissions)).
4. Words appear a few seconds after they are spoken. Audio is cut into 10-second pieces, quiet pieces are dropped, and the audio itself is never saved.
5. Press **Stop**. Stop always works and never waits on the helper. The transcript is saved, and notes are written.

A recording also ends if the meeting tab closes, the helper stops, the recorder fails, or it reaches 3 hours. Closing the panel while recording asks: Stop and close, Keep recording, or Cancel. If a recording ends early, what was captured is kept. If nothing was said, nothing is saved.

### Calendar reminders

Connect your calendar and UrAnus Browser reminds you about two minutes before a meeting that has a Google Meet, Zoom or Teams link. There is no sign-in: it reads the calendar's private iCal address. [`shell/calendar.ts`, `shared/calendar.ts`]

**Set it up:** microphone button › **Upcoming today** › **Connect a calendar…** (or the calendar icon beside "Upcoming today"). Paste the address, press **Test** to see what it finds, then **Save**.

- **Google Calendar:** on the web, Settings › click your calendar under "Settings for my calendars" › Integrate calendar › **Secret address in iCal format**.
- **Outlook:** Settings › Calendar › Shared calendars › Publish a calendar, then copy the ICS link.
- **iCloud:** a calendar shared as a public calendar gives a `webcal://` link; it works too (UrAnus Browser reads it over https).

Only https and `webcal://` addresses are accepted. Save reads the calendar first and refuses an address that doesn't work.

**The address is a secret.** Anyone who has it can read your calendar. UrAnus Browser keeps it only in this profile, under its own key, shows it as the host and an ellipsis (`calendar.google.com…`), never logs it, reads it without your cookies, and never gives it, or any event, to the AI model. Event titles are shown as plain text only. To stop, press **Remove** on the Calendar screen; the address and the meetings read from it are deleted. If Google says the address was reset, copy the new one and use **Use another address**.

**When it reads:** when UrAnus Browser starts, every 10 minutes, and when you press **Check now**. It looks at the next 36 hours and expands repeating events (daily, weekly, monthly, yearly, with exceptions and moved occurrences). All-day events and events without a meeting link are left out.

**What you see:**

- A macOS notification, about 2 minutes before the start: "*Title* starts in 2 min". It stays offered until 10 minutes after the start, once per occurrence. What you can do from it:
  - **Click it**: the meeting opens in a new tab, to join yourself. Nothing records.
  - **Join & record**: the meeting opens and meeting notes **start by themselves** once its tab is in front (your microphone; add the others' voices with ⇧⌘Y on the meeting tab, below). A second notification, "Recording *Title*", has **Stop recording**.
  - **Record + AI assistant** (shown instead of **Dismiss** when "Let the agent join meetings for me" is on in Agent in a meeting): the same, and the joinly assistant joins the meeting as a visible participant too. If it can't (joinly isn't running, say), a notification says why; the recording goes on.
  - **Dismiss** (when the assistant is off): remembered for that occurrence.
  Your click is the go-ahead: nothing opens, records or joins before it. If the notes can't start by themselves (no microphone permission yet, another recording running), the Meetings sheet's **Ready to record this meeting** card asks instead.
- **Open & record** in the panel or the list does the same as Join & record.
- **Upcoming today** in the Meetings sheet: the next three meetings today with their time, title, platform, **Join** (just opens the link) and **Open & record**.
- Within 5 minutes of a start, a small strip above the conversation with **Open & record** and a dismiss button.

macOS has to allow notifications for UrAnus Browser (System Settings › Notifications); if it doesn't, the panel's strip and the Upcoming card still work.

### When the tab is a meeting

Without any calendar: when the tab you are on is a live Google Meet (`meet.google.com/abc-defg-hij`, or `/meet/abc-defg-hij` when not signed in), Zoom (`…zoom.us/j/…`, `app.zoom.us/wc/…`) or Teams meeting link (`teams.microsoft.com`, `teams.live.com`) and nothing is recording, the panel shows "Record this meeting?" with **Record** and **Not now**. Record opens the ready card for that tab; Not now is remembered for that meeting for 12 hours. Only the tab's address is read; nothing is added to the page. Turn it off with **Offer to record meetings** on the Calendar screen (on by default).

### Engine and where audio goes

| | OpenAI | On this Mac |
| --- | --- | --- |
| Audio to text | each 10-second piece goes to OpenAI with your key | a local `whisper-server` on 127.0.0.1; audio never leaves the Mac |
| Notes written at Stop | by an OpenAI model | a no-model "quick digest" |

The setting is Automatic (OpenAI if available, else local), OpenAI, or On this Mac; an option that isn't available is greyed out with the reason. The local engine only works if a `whisper-server` and a ggml model are already installed (`ANUS_WHISPER_SERVER`, `ANUS_WHISPER_MODEL`, or the ones OpenWhisper keeps). UrAnus Browser never downloads or installs them. The model names can be changed with `ANUS_MEETING_TRANSCRIBE_MODEL` (default `gpt-4o-mini-transcribe`) and `ANUS_MEETING_SUMMARY_MODEL` in the helper's environment.

### Microphone picker

The card has a **Microphone** menu:

- **This Mac's microphone (recommended)**: the default. UrAnus Browser looks for the Mac's own input (names like MacBook, iMac or built-in) and uses it instead of an iPhone, AirPods, display or USB device that happens to be the system default. If it finds no built-in one, it keeps the system default.
- **System default**: whatever macOS has selected.
- **Any input by name**: the list fills in a moment after the card opens. A saved device that is unplugged shows as "(not connected)" and falls back to the system default.

### Hearing the other people: tab audio

Your microphone is "Me". The other participants are the meeting tab's sound, "Others", and Chromium only allows capturing a tab after a gesture on an extension's own UI. So Start begins with the microphone alone, and the card says "Remote participants' audio isn't being captured yet". Add the tab's sound while recording, in either of two ways:

- Click the meeting tab, then press **⇧⌘Y**. This works wherever the focus is. (The panel shows the key Chromium actually assigned, and leaves it out if none was.)
- Right-click inside the meeting page (not the sidebar) and choose **UrAnus Browser: add this tab's audio to the meeting notes**. The item exists only while a recording runs.

Once it works the card names the site and an "Others" meter appears; the tab keeps playing out loud. If you skip this, only your microphone is recorded, and other people appear only if your speakers carry them to the microphone, as "Me". A second press on the same tab changes nothing; a press on a different tab replaces the first.

### Speaker names

On Google Meet, Zoom and Microsoft Teams (web), UrAnus Browser reads the highlighted speaker tile once a second while recording and puts that name on the "Others" lines. It does this on demand, adds nothing to the page and clicks nothing. It fails soft: if a page changes or a name can't be read, the lines stay "Others". The names it reads depend on the page's own layout and, in places, English labels, so another interface language may give fewer names. If someone says "I'm Alice" or "ich bin Alice", the meeting view only suggests a label for you to accept.

### Notes, storage, delete

Notes have four parts: Overview, Decisions, Action items, Open questions. For the OpenAI engine the model returns only the numbers of transcript lines; the notes quote those original lines with speaker and time, so it can't invent text, and a line that tells the model to do something is just a line.

From a saved meeting you can rename it, **Copy as Markdown**, **Discuss in chat**, or delete it.

- **Discuss in chat** sends the notes and up to 20,000 characters of the transcript to the agent as your own message, fenced as untrusted data. That goes to OpenAI like any message. It is refused while the agent is working.
- **Delete** removes one meeting, notes and transcript, for good. "Delete all" removes every meeting. Up to 500 meetings are kept; UrAnus Browser asks you to delete some before recording another.
- Meetings are stored only in this browser profile (`chrome.storage.local`). Transcripts are never logged.

### Write notes with OpenAI, or on this Mac

After a meeting you can re-run the notes:

- **Write notes with OpenAI**: the default for the OpenAI engine. The transcript text goes to OpenAI.
- **Quick digest (nothing leaves this Mac)**: no model. Picks lines that say it outright ("we decided...", "I will...", an unanswered question) and says "None identified" otherwise.
- **Write on this Mac (Underdog)**: appears only when set up. Underdog Woof (a small on-device model, run through MLX) picks the lines, so nothing is sent anywhere. It is never the default and never runs unless you click it.

Underdog needs, already installed: OpenWhisper's `llm_mlx_server.py`, its Python environment with MLX (`~/.local/share/voxtral-transcribe/.venv`), and the Woof snapshot in the Hugging Face cache (download it in OpenWhisper, Settings, Intelligence). Nothing loads until the first prompt, and the model is released after 5 idle minutes. `ANUS_UNDERDOG_MODEL` picks `woof-2b-1.1` (default) or `woof-4b-1.1`. If any of that is missing, the button is simply not shown.

### Language limits as they stand

- **Transcription:** UrAnus Browser doesn't set a language. OpenAI detects it; the local engine runs with automatic language. Mixed-language calls are up to the engine.
- **Quick digest:** it recognises explicit phrasing mainly in English and German, with some French, Spanish and Italian. In other languages it will find little.
- **Self-introduction suggestions:** English and German only.
- **Titles (OpenAI):** written in the language of the meeting.
- **Underdog:** the instructions are the same English ones as for OpenAI; nothing in the code claims other languages work well, and none were tested.

## Agent in a meeting

This is different from meeting notes. Here the **agent itself joins** a Google Meet, Zoom or Microsoft Teams meeting as a visible participant, through **joinly**, a meeting-bot server that you run yourself on this Mac (Docker). UrAnus Browser is only a client of it; it never starts joinly for you and ships none of it. [`shared/joinly.ts`, `native-host/joinlyClient.ts`]

### Opt-in and consent

It is off by default. Open "Agent in a meeting" (people icon) and turn on "Let the agent join meetings for me". Turning it on shows a consent panel first ("I understand, turn on"). While it is off, nothing is joined or listened to, and the agent isn't even given the meeting tools. The points the panel makes, which are also the caveats:

- The bot joins as a visible participant and announces itself as an AI assistant working for you. Tell the other attendees before it joins.
- It listens. Many countries and workplaces require everyone's consent to record or transcribe a call. Getting it is on you.
- Some platforms and employers forbid bots. The host can remove the bot.
- What the agent reads from the meeting (words and names) goes to OpenAI with your messages.
- What people say in a meeting is treated as information, never as instructions.

### Voice mode: the bot answers out loud by itself (local model)

By default the agent speaks in a meeting only when you ask and approve a card. **Voice mode** is the other thing: once the bot is in a meeting, the sheet offers *Turn on voice mode*. After one confirmation (the first time), the bot hears people with joinly's local speech recognition, asks a model that runs on this Mac (Ollama, `127.0.0.1:11434`; `qwen3:4b` if installed, or pick another in the sheet), and speaks the answer with joinly's local voice. It starts speaking the first sentence while the model is still writing the second. [`native-host/voiceMode.ts`, `shared/voiceMode.ts`]

- It is **off in every new meeting**, and nothing else can turn it on. The banner says *Voice mode on* with a **Stop voice** button; the sheet shows the last reply's timing.
- It switches itself off after 20 minutes, when you leave or the meeting ends, when joinly can't speak, and when the model fails twice in a row.
- It only speaks: no tools, no chat posts, no sharing, no leaving. Answers are one or two short sentences (about 200 characters), without links, markdown or anything that looks like a secret, at most 8 a minute. It skips noise, filler words and what speech recognition invents out of silence ("Thank you."), never answers itself, and stops when someone talks over it.
- What people say in the meeting reaches the model fenced as untrusted data; a participant saying "ignore your rules" changes nothing.
- Choose the **Spoken language** before joining: joinly's speech recognition assumes English unless told. Its voice exists for English, Spanish, French and Italian.

### Start joinly (your own playground)

The sheet shows the start command and never runs it. In the repository you keep for the playground, from its directory and with Docker Desktop running:

```bash
cd /path/to/your/joinly-playground
./scripts/playground.sh start
```

Then press **Check again** in the sheet. UrAnus Browser looks for it at `http://127.0.0.1:18765/mcp/`. Only this computer is accepted as the address (127.0.0.1, localhost or [::1]); you can change the port in the sheet. The sheet says if nothing answers, if something answers that isn't joinly, or if the connection is lost.

### Joining

Two ways, both need your yes:

- **In the sheet:** pick the meeting (no pasting: **This tab** when the tab you're on is a meeting, and today's meetings from your connected calendar), or paste a link; the link is filled in for you when the sheet opens. Pick a bot name, press Join, then confirm "Join this meeting?". Only https links on meet.google.com, zoom.us, teams.microsoft.com or teams.live.com are accepted.
- **In the chat:** ask ("join this meeting ..."). An **approval card** shows the platform, the host and the bot name before anything happens.

Pick a name that makes clear it's an AI assistant (the default is "UrAnus Browser AI assistant"). Joining can wait for minutes while someone lets the bot in; Cancel joining is there. One meeting at a time.

### Speaking and chat need a card each time

Once in, the agent can read the latest talk and the participant list without asking. Two things always show an approval card with the exact words first:

- **Say aloud** (at most 500 characters, in the bot's synthetic voice).
- **Post in the meeting chat** (at most 1000 characters, visible to everyone).

Text that looks like a password or key is blocked outright. If the meeting changes while a card is open, the action is cancelled. Leaving needs no card.

### Leaving

The agent leaves when you press **Leave meeting** in the sheet, when you press **Stop** in the panel, when you start a new conversation, when you switch the opt-in off, and when the helper shuts down. The panel shows a banner while the agent is in or joining a meeting.

### Limits and honest caveats

- Joining as an anonymous guest on Google Meet failed in testing with HTTP 403 (see [When something goes wrong](#when-something-goes-wrong)). The route that worked used a separate signed-in Google profile inside joinly.
- Zoom and Teams controllers exist but have not been tested against live meetings.
- What the agent hears is automatic speech recognition by joinly: it can be wrong, and speaker names can be missing.
- The agent's voice and who hears it are not something UrAnus Browser can take back. Check the card.

## First-run permissions

The welcome tour has a **Permissions** step with three optional buttons:

- **Microphone**: used by meeting notes only after you press Start; the audio isn't kept.
- **Camera**: video calls ask for it themselves. Allowing it now means macOS asks once, here, not in the middle of a call.
- **App Management**: macOS can block UrAnus Browser from changing app files, for example when it updates. This opens the right System Settings pane, since macOS has no prompt for it.

For the microphone and camera, a small tab opens: choose "Allow while visiting the site" there, then Allow when macOS asks. The row shows "Allowed" once it is granted. You can change any of them later in System Settings > Privacy & Security.

To replay the tour: **Settings > General > Welcome tour > Show Tour**.

The packaged app declares a microphone usage description; without one macOS refuses the request.

## Keyboard shortcuts

| Keys | What it does |
| --- | --- |
| ⌥⌘A | Show or hide the Agent panel |
| Enter / Shift+Enter | Send the message / new line in the message box |
| Esc | Closes an open sheet; pressing it again closes the panel (it asks first if a meeting is recording) |
| ⇧⌘Y | While a meeting is recording: add the current tab's audio |
| Enter or Space on the panel's grip | Move the panel to the other side |
| Arrow keys on the panel's edge | Resize it in 16 px steps |

The panel can also be docked by dragging its grip.

## Where your data lives

- **On this Mac, per profile (`chrome.storage.local`):** companions and their notes, project context, the text of attached files, skills, routines and run records, saved meetings (notes and transcripts), the meeting settings, the calendar's private address (its own key) and the next day and a half of meetings read from it (titles, times, links; no descriptions), joinly's settings, and the panel's side and width. Another profile has its own.
- **The conversation** lives in UrAnus Browser's helper process while it runs. UrAnus Browser doesn't write it to disk. A new conversation, or the helper stopping, ends it.
- **The OpenAI API key** stays in the macOS Keychain, read only by the helper. The panel, the shell and web pages never see it.
- **What leaves the Mac:** your messages and what the agent reads on pages (to the selected cloud provider; see [privacy and data flows](privacy.md)); the active companion's project context, file names and skills, and the parts of files it reads; meeting audio pieces and transcript text if you use the OpenAI engine or OpenAI notes; what the agent reads from a meeting it joined. The calendar address is fetched from the calendar's own server (Google, Microsoft, Apple), without cookies, and nothing from it goes anywhere else. Everything else stays: the local engine, the quick digest and Underdog never send anything. The joinly connection is loopback only.
- **Algorithm Diet** (the 🍴 button in the sidebar's toolbar): the pages you read (address, title, description, a visible excerpt, time and video playback) and imported history are kept in the shell's own IndexedDB on this Mac, per profile; incognito windows are never recorded. Its model is always Underdog on this Mac; Erase Diet Data (⋯ menu) deletes all of it.
- **Audio** is never saved by UrAnus Browser.
- UrAnus Browser doesn't log meeting text, page text or your key; its diagnostics are names, counts and timings.

## When something goes wrong

**The Agent button shows but does nothing, or the chat button is dead after an update.** Chromium keeps an extension's old background worker until the extension's version changes, so a profile can run the old script beside the new pages. Builds now version the shell by its built files so this is fixed for new builds, but a profile that is already stuck may need a clean restart: quit UrAnus Browser (⌘Q), wait about 10 seconds, reopen it. [commit 5f63873]

**"UrAnus Browser's helper is older than meeting notes" (or similar).** The native helper hasn't been refreshed after an update. Quit and reopen UrAnus Browser so it registers the new one. The same applies to "helper isn't registered" messages in Settings.

**The microphone drops out mid-meeting (iPhone, AirPods, Bluetooth).** When the input disappears, the recorder reopens it and carries on from the same clock. If the chosen device keeps vanishing (more than 3 times) the recording ends with a message and keeps what was captured. Fix: set the microphone menu to **This Mac's microphone** (the default) and avoid having a phone or headset as the system input.

**"UrAnus Browser may need your permission first" when you press Start.** Press "Allow the microphone..." in the card; it opens a tab where Chromium can ask. Then press Start again. If macOS had said no earlier, turn UrAnus Browser on in System Settings > Privacy & Security > Microphone.

**Only my side of the call was recorded.** You didn't add the tab's audio. During the recording, click the meeting tab and press ⇧⌘Y, or use the item in the page's own right-click menu (not the sidebar tab menu).

**The Meet bot is refused (HTTP 403).** Google Meet rejected an anonymous browser guest ("CreateMeetingDevice" returned 403). This is a joinly/Google limit, also tracked upstream. The working setup is joinly's browser signed in to a separate Google account (the playground has a `login` script for that). Note that Meet may then show that account's name rather than the bot name you chose.

**"joinly isn't running" or "That isn't joinly".** Start the playground (Docker Desktop must be running) and press Check again, or fix the address in the sheet. It must be a loopback address.

**A routine didn't run.** UrAnus Browser was closed, the Mac slept, or the agent was busy for too long, so it is overdue: use Run now or Skip. If "The agent didn't start", check that the OpenAI key is set up.

**macOS permission notices.** Microphone, camera and App Management are all optional and can be granted or removed any time in System Settings > Privacy & Security. Meeting notes need the microphone; updates may need App Management.

**A PDF or document won't attach ("needs UrAnus Browser's helper").** Reading PDFs and documents happens in the helper: quit and reopen UrAnus Browser so the new helper is registered. Plain-text files attach without it. A PDF that is only scanned images has no text to read; export it with text recognition (Preview › Export as PDF doesn't add it; a scanner app's OCR does) and attach that.

**No meeting reminder came.** Check the Calendar screen: it says when the calendar was last read and how many meetings with a link it found. A meeting needs a Google Meet, Zoom or Teams link in its location, description or conference field, and a start time (all-day events are skipped). macOS must allow notifications for UrAnus Browser; without them the panel's strip still shows. Reminders only come while UrAnus Browser is open.

**"The calendar address was refused".** The secret address was reset or mistyped. Copy it again and use **Use another address** on the Calendar screen.

**Notes failed to write.** The sheet shows the reason (no network, key not accepted, ...). Press "Write notes with OpenAI" again, or use the quick digest, which needs nothing.

## Not built yet

Routine event triggers on a page or a message (calendar meetings are done); running routines while UrAnus Browser is closed; Zoom and Teams live testing for joinly and for speaker names; joinly anonymous guest entry on Google Meet; signing in with an OpenAI account instead of a key; adding the meeting tab's audio automatically at Start (today it takes the shortcut or the menu item; a Chromium patch is the fallback if those ever fail).
