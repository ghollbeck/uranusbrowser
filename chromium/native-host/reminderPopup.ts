/**
 * The meeting reminder as a small floating panel on the display the pointer is on, above every
 * app (UrAnus Browser in front or not), drawn by macOS itself: AppKit through `osascript -l
 * JavaScript`, so no Chromium change and nothing extra to sign in the app.
 *
 * The shell says what to show (`show(spec)`) or that nothing is due (`show(undefined)`). The panel
 * is a non-activating NSPanel: it takes clicks without taking the keyboard or bringing Anus
 * Browser forward, joins every Space (full-screen ones too) and moves to the pointer's display
 * when the pointer goes to another one. It looks like the window's card (ScienceOS colours for
 * light or dark, 32pt buttons, a live line and progress bar); ✕ dismisses. Its buttons print one line (`action join` …) that comes
 * back to the shell through `onAction`; the panel then closes, and the shell decides what is next.
 *
 * The title is someone else's text (an invitation): it reaches the script as an argument and is
 * set as a label's string value, never run or parsed as anything but JSON.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import type { ReminderAction, ReminderSpec } from '../shared/calendar';
import { MEETING_LOGOS } from '../shared/meetingLogos';

export type { ReminderAction, ReminderSpec };

const ACTIONS: readonly ReminderAction[] = ['join', 'record', 'assistant', 'dismiss'];

/** The panel. Every `$`-call is AppKit; `spec` comes in as argv[0] (JSON), the host's pid as argv[1]. */
export const POPUP_SCRIPT = String.raw`
ObjC.import('Cocoa');
ObjC.bindFunction('kill', ['int', ['int', 'int']]);
ObjC.bindFunction('exit', ['void', ['int']]);

function run(argv) {
  const spec = JSON.parse(argv[0]);
  const parent = Number(argv[1]) || 0;
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy(1); // accessory: no Dock icon, no menu bar

  // ScienceOS colours (the shell's tokens), picked for the system's light or dark appearance.
  const dark = ObjC.unwrap(app.effectiveAppearance.bestMatchFromAppearancesWithNames($(['NSAppearanceNameAqua', 'NSAppearanceNameDarkAqua']))) === 'NSAppearanceNameDarkAqua';
  const hex = (h, a) => $.NSColor.colorWithSRGBRedGreenBlueAlpha(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255, a === undefined ? 1 : a);
  const C = dark
    ? { ink: hex('#ececec'), muted: hex('#a4a4a4'), soft: hex('#323232'), panel: hex('#1e1e1e'), page: hex('#191919'), live: hex('#f04438') }
    : { ink: hex('#202123'), muted: hex('#74767a'), soft: hex('#eaeaec'), panel: hex('#fafafb'), page: hex('#ffffff'), live: hex('#d92d20') };

  const W = 380, PAD = 16, GAP = 8, MARGIN = 14, BTN = 32;
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  const say = (line) => out.writeData($(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  const pad2 = (n) => (n < 10 ? '0' : '') + n;
  const clock = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  // The same line as the window's card (shared/calendar.ts reminderStatus).
  const status = () => {
    const now = Date.now();
    const live = now >= spec.start;
    const inMin = Math.max(0, Math.round((now - spec.start) / 60000));
    const ahead = Math.max(0, Math.round((spec.start - now) / 60000));
    const text = live ? 'Live · ' + (inMin ? inMin + ' min in' : 'just started') + ' · until ' + clock(spec.end) : (ahead ? 'In ' + ahead + ' min' : 'Starting') + ' · ' + clock(spec.start) + '–' + clock(spec.end);
    const progress = spec.end > spec.start ? Math.min(1, Math.max(0, (now - spec.start) / (spec.end - spec.start))) : 0;
    return { live: live, text: text, progress: progress };
  };
  const symbol = (name, size) => {
    const img = $.NSImage.imageWithSystemSymbolNameAccessibilityDescription($(name), $());
    return img.isNil() ? img : img.imageWithSymbolConfiguration($.NSImageSymbolConfiguration.configurationWithPointSizeWeight(size, 0));
  };

  const names = ['join', 'record'].concat(spec.assistant ? ['assistant'] : []).concat(['dismiss']);
  let panel, statusLabel, dot, fill, track, snapPath;

  // The pointer's display.
  function pointerScreen() {
    const p = $.NSEvent.mouseLocation;
    const screens = $.NSScreen.screens;
    for (let i = 0; i < screens.count; i++) {
      const s = screens.objectAtIndex(i);
      const f = s.frame;
      if (p.x >= f.origin.x && p.x < f.origin.x + f.size.width && p.y >= f.origin.y && p.y < f.origin.y + f.size.height) return s;
    }
    return $.NSScreen.mainScreen;
  }
  let screen = pointerScreen();
  // Top right of the display, under the menu bar, where macOS puts its own notifications.
  function placeOn(s, height, offscreen) {
    const v = s.visibleFrame;
    const x = v.origin.x + v.size.width - W - MARGIN + (offscreen ? W + MARGIN : 0);
    return $.NSMakeRect(x, v.origin.y + v.size.height - height - MARGIN, W, height);
  }
  function update() {
    const st = status();
    statusLabel.stringValue = $(st.text);
    dot.fillColor = st.live ? C.live : C.muted;
    fill.frame = $.NSMakeRect(0, 0, Math.max(st.progress > 0 ? 3 : 0, track.frame.size.width * st.progress), 3);
  }

  ObjC.registerSubclass({
    name: 'AnusReminderTarget',
    methods: {
      'act:': {
        types: ['void', ['id']],
        implementation: function (sender) {
          say('action ' + names[sender.tag]);
          panel.orderOut(null);
          $.exit(0);
        },
      },
      'snap:': {
        types: ['void', ['id']],
        implementation: function () {
          const view = panel.contentView;
          const rep = view.bitmapImageRepForCachingDisplayInRect(view.bounds);
          view.cacheDisplayInRectToBitmapImageRep(view.bounds, rep);
          rep.representationUsingTypeProperties(4, $()).writeToFileAtomically($(snapPath), true); // PNG
          say('snapshot');
        },
      },
      'tick:': {
        types: ['void', ['id']],
        implementation: function () {
          // The host is gone (UrAnus Browser quit or crashed): so is the reminder.
          if (parent && $.kill(parent, 0) !== 0) $.exit(0);
          if (Date.now() >= spec.end) { say('ended'); $.exit(0); }
          update();
          const s = pointerScreen();
          if (!s.isEqual(screen)) {
            screen = s;
            panel.setFrameDisplayAnimate(placeOn(screen, panel.frame.size.height, false), true, false);
          }
        },
      },
    },
  });
  const target = $.AnusReminderTarget.alloc.init;

  const label = (text, size, weight, color) => {
    const l = $.NSTextField.labelWithString($(text));
    l.font = $.NSFont.systemFontOfSizeWeight(size, weight);
    l.textColor = color;
    l.lineBreakMode = 4; // truncate tail
    l.maximumNumberOfLines = 1;
    return l;
  };
  // A filled, rounded shape (NSBox takes NSColors; layer CGColors don't cross the JS bridge).
  const box = (frame, color, radius, border) => {
    const v = $.NSBox.alloc.initWithFrame(frame);
    v.boxType = 4; // custom
    v.titlePosition = 0; // no title
    v.contentViewMargins = $.NSMakeSize(0, 0);
    v.fillColor = color;
    v.cornerRadius = radius;
    v.borderWidth = border ? 1 : 0;
    v.borderColor = border || $.NSColor.clearColor;
    return v;
  };
  // A 32pt button drawn from the tokens: ink fill for the primary one, a hairline for the others.
  const button = (text, name, icon, primary, tip) => {
    const b = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, 0, 10, BTN));
    b.bordered = false;
    b.title = $(text);
    b.font = $.NSFont.systemFontOfSizeWeight(13, primary ? 0.23 : 0);
    // A borderless button's tint colours its title and symbol.
    b.contentTintColor = primary ? C.page : C.ink;
    if (icon) {
      const img = symbol(icon, 12);
      if (!img.isNil()) {
        b.image = img;
        b.imagePosition = 7; // leading
        b.imageHugsTitle = true;
      }
    }
    b.sizeToFit;
    const width = b.frame.size.width + 20;
    b.frame = $.NSMakeRect(0, 0, Math.ceil(width), BTN);
    b.target = target;
    b.action = 'act:';
    b.tag = names.indexOf(name);
    b.toolTip = $(tip);
    return b;
  };

  // ---- the parts --------------------------------------------------------------------------
  // One row: Join first (it takes the room the others leave), then the two that record. Full
  // labels when they fit, the short ones otherwise.
  const row = (long) => {
    const list = [button('Join', 'join', null, true, 'Open in ' + spec.platform), button(long || !spec.assistant ? 'Join & record' : 'Record', 'record', null, false, 'Join and record meeting notes')];
    if (spec.assistant) list.push(button(long ? 'Record + AI assistant' : 'Record + AI', 'assistant', null, false, 'Join, record and bring the AI assistant'));
    return list;
  };
  let buttons = row(true);
  const othersOf = (list) => list.slice(1).reduce((w, b) => w + b.frame.size.width + 6, 0);
  if (W - 2 * PAD - othersOf(buttons) < 64) buttons = row(false);
  buttons[0].frame = $.NSMakeRect(0, 0, W - 2 * PAD - othersOf(buttons), BTN);

  const ICON = 36, CAPTION = 14, BAR = 3;
  const H = PAD + CAPTION + GAP + BTN + 12 + BAR + 12 + ICON + PAD;
  panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer(placeOn(screen, H, true), (1 << 7) | (1 << 15), 2, false); // non-activating, full-size content
  panel.level = 25; // status window level: above other apps' windows and floating panels
  panel.collectionBehavior = (1 << 0) | (1 << 4) | (1 << 8); // every Space, stationary, beside full-screen apps
  panel.floatingPanel = true;
  panel.hidesOnDeactivate = false;
  panel.becomesKeyOnlyIfNeeded = true;
  panel.opaque = false;
  panel.backgroundColor = $.NSColor.clearColor;
  panel.hasShadow = true;
  panel.movableByWindowBackground = true;
  panel.alphaValue = 0;

  const glass = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, H));
  glass.material = 6; // popover
  glass.blendingMode = 0; // behind the window
  glass.state = 1; // always active
  // Rounded by a mask: the blur ignores a layer's corner radius and showed its square corners
  // behind the hairline. The window's shadow follows the mask too.
  const mask = $.NSImage.alloc.initWithSize($.NSMakeSize(25, 25));
  mask.lockFocus;
  $.NSColor.blackColor.setFill;
  $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(0, 0, 25, 25), 12, 12).fill;
  mask.unlockFocus;
  mask.capInsets = { top: 12, left: 12, bottom: 12, right: 12 };
  mask.resizingMode = 1; // stretch
  glass.maskImage = mask;
  panel.contentView = glass;
  // The one hairline round the panel.
  glass.addSubview(box($.NSMakeRect(0, 0, W, H), $.NSColor.clearColor, 12, C.soft));

  // Bottom up (AppKit's y goes up).
  let y = PAD;
  const caption = label('If you record, tell the others.', 11, 0, C.muted);
  caption.frame = $.NSMakeRect(PAD, y, W - 2 * PAD, CAPTION);
  glass.addSubview(caption);
  y += CAPTION + GAP;
  let x = PAD;
  buttons.forEach((b, i) => {
    const w = b.frame.size.width;
    // The button's shape: ink for Join, a hairline for the others.
    glass.addSubview(box($.NSMakeRect(x, y, w, BTN), i === 0 ? C.ink : $.NSColor.clearColor, 8, i === 0 ? null : C.soft));
    b.frame = $.NSMakeRect(x, y, w, BTN);
    glass.addSubview(b);
    x += w + 6;
  });
  y += BTN + 12;
  track = box($.NSMakeRect(PAD, y, W - 2 * PAD, BAR), C.soft, 1.5);
  fill = box($.NSMakeRect(0, 0, 0, BAR), C.muted, 1.5);
  track.addSubview(fill);
  glass.addSubview(track);
  y += BAR + 12;

  // The app the meeting is in, by its own mark (constant SVG from the host); a camera otherwise.
  const tile = box($.NSMakeRect(PAD, y, ICON, ICON), C.panel, 8, C.soft);
  const logo = spec.logo ? $.NSImage.alloc.initWithData($(spec.logo).dataUsingEncoding($.NSUTF8StringEncoding)) : $();
  const mark = $.NSImageView.imageViewWithImage(logo.isNil() ? symbol('video', 15) : logo);
  if (logo.isNil()) mark.contentTintColor = C.ink;
  else mark.imageScaling = 3; // proportionally up or down
  mark.frame = logo.isNil() ? $.NSMakeRect(0, 0, ICON, ICON) : $.NSMakeRect(7, 7, ICON - 14, ICON - 14);
  mark.toolTip = $(spec.platform);
  tile.addSubview(mark);
  glass.addSubview(tile);

  const textX = PAD + ICON + 12;
  const title = label(spec.title, 15, 0.23, C.ink); // medium
  title.frame = $.NSMakeRect(textX, y + 17, W - textX - PAD - 28, 20);
  glass.addSubview(title);
  dot = box($.NSMakeRect(textX, y + 5, 6, 6), C.live, 3);
  glass.addSubview(dot);
  statusLabel = label('', 12, 0, C.muted);
  statusLabel.frame = $.NSMakeRect(textX + 12, y - 1, W - textX - 12 - PAD, 16);
  glass.addSubview(statusLabel);

  const close = $.NSButton.alloc.initWithFrame($.NSMakeRect(W - PAD - 22, H - PAD - 22, 24, 24));
  close.bordered = false;
  close.image = symbol('xmark', 11);
  close.imagePosition = 1; // image only
  close.contentTintColor = C.muted;
  close.target = target;
  close.action = 'act:';
  close.tag = names.indexOf('dismiss');
  close.toolTip = $('Dismiss');
  glass.addSubview(close);
  update();

  panel.orderFrontRegardless;
  panel.invalidateShadow;
  // Slides in from the right edge of the display and fades in.
  $.NSAnimationContext.beginGrouping;
  $.NSAnimationContext.currentContext.duration = 0.32;
  panel.animator.setFrameDisplay(placeOn(screen, H, false), true);
  panel.animator.alphaValue = 1;
  $.NSAnimationContext.endGrouping;

  $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(1, target, 'tick:', null, true);
  say('shown ' + JSON.stringify(ObjC.unwrap(screen.localizedName)));
  // Tests: a picture of the panel's content (screen captures may leave other apps' windows out).
  const snapshot = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('ANUS_REMINDER_SNAPSHOT'));
  if (snapshot) {
    snapPath = snapshot;
    $.NSTimer.scheduledTimerWithTimeIntervalTargetSelectorUserInfoRepeats(0.8, target, 'snap:', null, false);
  }
  app.run;
}
`;

/** Runs at most one panel at a time; a new spec replaces the old panel, `undefined` closes it. */
export class ReminderPopup {
  private child: ChildProcess | undefined;
  private shownKey = '';
  private readonly onAction: (id: string, action: ReminderAction) => void;
  private readonly log: (...args: unknown[]) => void;
  private readonly osascript: string;

  constructor(onAction: (id: string, action: ReminderAction) => void, log: (...args: unknown[]) => void = () => {}, osascript = '/usr/bin/osascript') {
    this.onAction = onAction;
    this.log = log;
    this.osascript = osascript;
  }

  /** Whether a panel is up. */
  get open() {
    return !!this.child;
  }

  show(spec: ReminderSpec | undefined) {
    const key = spec ? JSON.stringify([spec.id, spec.title, spec.platform, spec.start, spec.end, spec.assistant]) : '';
    if (key === this.shownKey && (this.child || !spec)) return;
    this.close();
    if (!spec || process.platform !== 'darwin') return;
    this.shownKey = key;
    const id = spec.id;
    const logo = MEETING_LOGOS[spec.platform as keyof typeof MEETING_LOGOS];
    const child = spawn(this.osascript, ['-l', 'JavaScript', '-e', POPUP_SCRIPT, JSON.stringify({ ...spec, logo }), String(process.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      buffer += data;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        const action = /^action (\w+)$/.exec(line)?.[1] as ReminderAction | undefined;
        if (action && ACTIONS.includes(action)) this.onAction(id, action);
        else if (line) this.log('reminder panel:', line);
      }
    });
    // Only AppKit's own complaints come here; never the title.
    child.stderr?.on('data', (data: Buffer) => this.log('reminder panel:', String(data).trim().slice(0, 300)));
    child.on('error', (err) => this.log('reminder panel failed to start:', err.message));
    child.on('exit', () => {
      if (this.child === child) this.child = undefined;
    });
  }

  close() {
    const child = this.child;
    this.child = undefined;
    this.shownKey = '';
    if (child && child.exitCode === null) child.kill();
  }
}
