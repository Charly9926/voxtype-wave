# How it works

Technical explanation of the voice-dictation setup, meant for anyone who wants to understand it,
debug it or modify it. To install it, see `docs/INSTALL.md`; for problems, see
`docs/TROUBLESHOOTING.md`.

---

## What it is and why it exists

The `voxtype` daemon already solves the hard part: capturing audio, transcribing and delivering
the text. What cannot be used on GNOME is its OSD (the floating waveform), because its two
official frontends (`voxtype-osd-gtk4` and `voxtype-osd-quickshell`) depend on the
`wlr-layer-shell` protocol, which **Mutter does not implement**. It is not a missing-dependency
problem: installing `gtk4-layer-shell` does not help, because the protocol is not offered by the
compositor. It is reported in the project's issue #807:
<https://github.com/peteonrails/voxtype/issues/807>.

This repo's solution is its own GNOME Shell extension that draws the waveform in the shell's
*chrome* layer through `Main.layoutManager.addTopChrome()`. It is deliberately called without
parameters: GNOME 50 removed `affectsInputRegion`, and passing an unknown key throws
`Unrecognized parameter` when the extension loads. That layer sits above the windows and
outside the window list, so the panel floats without stealing focus.

The second problem this setup solves is the trigger. Voxtype's evdev listener is disabled
(`[hotkey] enabled = false`) so it does not clash with the fact that gaming mice expose USB
interfaces that impersonate a keyboard and "steal" the device from the evdev listener. Instead,
the trigger is a GNOME custom shortcut that runs `voxtype record toggle`.

---

## Complete flow

### Text delivery

```
F9 (GNOME custom shortcut)
  |
  v
voxtype record toggle  ->  signal to the daemon
  |
  v
daemon: audio capture (ALSA through pipewire-alsa)
  |
  v
Parakeet TDT 0.6B v3 int8 (ONNX Runtime, CPU with AVX-512)
  |
  v
transcribed text
  |
  v
[output] mode = "clipboard"  ->  wl-copy
  |
  v
post_output_command: sleep 0.2; echo 'key ctrl+shift+v' | dotool
  |
  v
dotool writes events to /dev/uinput
  |
  v
the text appears at the cursor of the focused application
```

### Waveform visualization

```
(recording is in progress)
daemon: buckets the audio into 10 ms windows (100 Hz)
  |
  v
16-byte binary frames  ->  $XDG_RUNTIME_DIR/voxtype/audio.sock
  |
  v
voxtype-audio-bridge (subprocess spawned by the extension)
  |
  v
NDJSON on stdout:  {"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}
  |
  v
extension: reads lines, computes the bars and repaints
  |
  v
St.DrawingArea + cairo  ->  shell "chrome" layer (bottom center of the monitor)

In parallel, for the top-bar icon:
$XDG_RUNTIME_DIR/voxtype/state  ->  state (ready / recording / transcribing)
$XDG_RUNTIME_DIR/voxtype/pid    ->  check that the daemon is still alive
```

---

## Audio socket protocol

The daemon publishes the frames on `$XDG_RUNTIME_DIR/voxtype/audio.sock`. It is a Unix socket with
a *best-effort* broadcast: slow subscribers get disconnected, the daemon never blocks on a
consumer. The hub that serves it lives as long as the daemon and accepts subscribers between
recordings, but **it only emits frames while recording**.

A frame is 16 bytes, in the machine's native order (x86_64: little endian). The format is
documented in the daemon's source (`src/audio/levels.rs`) and is exactly:

| Offset | Bytes | Type | Field | Description |
|---|---|---|---|---|
| 0 | 4 | `u32` | `seq` | monotonic frame counter (wraps around) |
| 4 | 4 | `f32` | `min` | minimum value in the 10 ms window (range -1.0 to 1.0) |
| 8 | 4 | `f32` | `max` | maximum value in the 10 ms window (range -1.0 to 1.0) |
| 12 | 4 | `f32` | `peak_dbfs` | peak in dBFS; in silence it tends to -infinity (clamped to -120) |

Rate: 100 Hz (one frame every 10 ms).

### The bridge and the NDJSON

`voxtype-audio-bridge` connects to that socket and exposes it as NDJSON on stdout, one line per
frame:

```json
{"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}
```

It also emits connection changes in the same stream:

```json
{"status":"connected"}
{"status":"disconnected"}
```

The bridge handles reconnection on its own. The fields the extension uses are `peak` (peak level,
0 to 1) and `rms` (approximate RMS level); `vad` and `ts_ms` are available for anyone who wants
other behaviours.

---

## Important paths

| Path | What it is |
|---|---|
| `~/.local/bin/voxtype` | daemon (standalone binary) |
| `~/.local/bin/voxtype-audio-bridge` | socket-to-NDJSON bridge |
| `~/.config/voxtype/config.toml` | daemon configuration and output hook |
| `~/.local/share/voxtype/models/parakeet-tdt-0.6b-v3-int8/` | model (670 MB on disk) |
| `~/.config/systemd/user/voxtype.service` | user unit (`PartOf=graphical-session.target`, `Environment=XDG_RUNTIME_DIR=%t`) |
| `~/.config/systemd/user/voxtype.service.d/wayland.conf` | optional drop-in for `WAYLAND_DISPLAY` |
| `~/.local/share/gnome-shell/extensions/voxtype-wave@charly9926.github.io/` | extension: `extension.js`, `metadata.json`, `stylesheet.css` |
| `$XDG_RUNTIME_DIR/voxtype/state` | daemon state (`idle` / `recording` / `transcribing`) |
| `$XDG_RUNTIME_DIR/voxtype/pid` | daemon PID |
| `$XDG_RUNTIME_DIR/voxtype/audio.sock` | audio frame socket |
| `/dev/uinput` | used by `dotool` to inject the paste chord |

---

## Design decisions and their rationale

### Why a GNOME extension and not the official OSD

Because the official OSD needs `wlr-layer-shell` and Mutter does not implement it (see the
introduction). The extension uses the shell's *chrome* layer, which does exist on GNOME and is the
same one the panel and the rest of the desktop elements use.

### Why the trigger is a GNOME shortcut and the evdev listener is off

Voxtype's evdev listener picks one device from `/dev/input` to listen for the key. Gaming mice
expose a USB interface that impersonates a keyboard, and the daemon ends up listening on that
interface instead of the real keyboard, so the physical key never arrives. With
`[hotkey] enabled = false` the daemon does not open any input device and the trigger is done by a
GNOME custom shortcut that runs `voxtype record toggle` (one press starts recording, another one
stops it).

### Why the output is clipboard mode and not type mode

With a `us` keyboard layout, `dotool` cannot type accents:

```
dotool: WARNING: impossible character for layout: ñ
```

`type` mode translates text into keyboard events according to the active layout, so Spanish with
accents would come out incomplete or with the wrong characters. `clipboard` mode copies the exact
Unicode text to the clipboard, and the hook takes care of pasting it. On top of that, pasting is
atomic: it does not depend on how fast the application processes keyboard events.

In this setup `restore_clipboard = false` on purpose: that way the text stays available in the
clipboard after dictating (useful if pasting fails in some application; paste it by hand once).

### Why the hook uses `dotool` with a pipe

Two reasons, both verified against the binary:

1. Voxtype's `paste` mode **does not accept `dotool`** to send the chord. Internally it only tries
   `wtype`, `eitype` or `ydotool`; the binary strings say so:
   `No keystroke tool available (tried wtype, eitype, ydotool)`. On GNOME, `wtype` does not work
   because Mutter does not implement `zwp_virtual_keyboard_v1` either, so `paste` mode has no way
   to send the chord.
2. `dotool` reads its commands from **stdin**, not from arguments. A hook written as
   `dotool key ctrl+shift+v` fails with
   `dotool: there should be no arguments, commands are read from stdin`. The correct form is
   `echo 'key ctrl+shift+v' | dotool`.

`dotool` is appropriate for this even though it cannot type accents: the `ctrl+shift+v` chord does
not depend on the keyboard layout.

### Why the extension reads through the bridge and not from the socket directly

Because the socket delivers 16-byte binary frames in native order, and a client would have to
handle *framing* (partial reads), type conversion and reconnection by itself. The bridge already
does all of that and exposes text lines: the extension only parses NDJSON and takes care of
drawing. That keeps the extension code small, which matters because it runs inside the shell
process.

### Why the panel does not steal focus

Because automatic pasting depends on focus staying on the application where you are dictating. The
panel is added with `Main.layoutManager.addTopChrome()` to the shell's *chrome* layer (above the
windows, outside the window list) and the actor is non-reactive, so it captures neither clicks nor
focus. On top of that, the panel does not appear in the window list or in Alt+Tab.

### Why the state icon uses the PID and not the state file

Because the state file `$XDG_RUNTIME_DIR/voxtype/state` **survives** the daemon: if the daemon
stops, the file keeps the last value. To know whether the daemon is alive, the extension reads the
PID file `$XDG_RUNTIME_DIR/voxtype/pid` and checks that `/proc/<pid>` exists. Only if the process
exists does it interpret the contents of the state file.

### How the state is watched (without polling)

The state file is watched with `Gio.FileMonitor`, so the icon changes the instant Voxtype goes
from `idle` to `recording` or `transcribing`, without spending CPU while idle. Two details are
needed to make that reliable:

- **Retry at login.** GNOME Shell loads extensions before the daemon creates the state file, and
  monitoring a file that does not exist is useless. If the file is not there, the extension
  retries every 2 s until it appears (without marking the extension as *errored*, which is what
  would happen if the monitor setup were allowed to fail).
- **Safety net every 5 s.** If the daemon restarts and the file is recreated with another inode,
  the old monitor ends up pointing at nothing: on receiving `DELETED`/`MOVED_OUT` it is dropped
  and a new one is set up. On top of that, a low-cost check every 5 s refreshes the state and
  detects that the process died even if the file has not changed.

The subprocesses (`systemctl --user`, `voxtype config`) are only launched when the icon **menu is
opened** or when an action is taken, never from a periodic timer.

### The icon menu

Besides the state and starting/stopping/restarting the daemon, the menu has:

- two switches (**Spoken punctuation** and **Remove filler words**) that write the corresponding
  key with `voxtype config set` —which preserves comments and validates the value— and then
  restart the service, because **Voxtype does not reload its configuration on the fly** (its own
  CLI says so when writing: `Restart voxtype to apply: systemctl --user restart voxtype`);
- **Open configuration**, which launches `~/.config/voxtype/config.toml` with the default editor
  (if the file does not exist yet, it opens the folder).

> **Note on language.** The spoken-punctuation vocabulary and the default filler-word list are
> English-only; for other languages use `text.replacements` (literal substitutions, independent of
> the language) and a custom `filler_words` list. Sentence punctuation and capitalization come
> from the model itself, not from `spoken_punctuation`.


---

## Memory lifecycle

The engine runs on the CPU (AVX-512) and **uses no GPU or VRAM**, so it does not compete with
other GPU workloads on the machine.

With `[parakeet] on_demand_loading = true`:

| Stage | Memory |
|---|---|
| Idle (daemon not recording) | ~6 MB (measured peak: 9.3 MB) |
| When recording starts | the model is loaded: ~1.5 s of wait |
| Transcribing | int8 model in memory (670 MB on disk) |
| When it finishes | the model is released |

The transcription itself takes around 0.1 s per sentence. The practical effect is that RAM goes up
while dictating and comes back afterwards; to check it, `free -h` before and after.

If you prefer less latency in exchange for permanent RAM, `on_demand_loading = false` keeps the
model loaded continuously.

---

## Extension constants

They are all at the top of `extension.js`. They are changed by editing the file and reloading the
extension (logging out, or testing with the nested shell; see `docs/TROUBLESHOOTING.md`).

| Constant | Default value | What it does | Suggested values |
|---|---|---|---|
| `HISTORY_FRAMES` | `6` | how many 10 ms frames are mirrored from the center toward the edges | `1` = purely instantaneous; `6` = 60 ms of texture; `16` = 160 ms, more motion |
| `EDGE_FALLOFF` | `0.55` | how much amplitude drops toward the panel edges | `0` = all bars equal (meter-like); `0.8` = peak concentrated in the center |
| `RELEASE` | `0.72` | how much each bar falls per tick when the audio drops | close to `1` = fades out more slowly; `0.6` = drier |
| `SILENT_LEVEL` | `0.02` | below this level the flat idle line is drawn | raise it if background noise makes the line tremble |
| `FLAT_LINE_H` | `3` | height of the flat line, in pixels | `2` to `5` |
| `FLAT_LINE_ALPHA` | `0.35` | opacity of the flat line | `0.2` to `0.5` |
| `PANEL_W` | `340` | panel width, in logical pixels | depends on the monitor |
| `PANEL_H` | `64` | panel height, in logical pixels | `48` to `96` |
| `BARS` | `48` | number of bars in the waveform | more bars = finer detail |
| `BOTTOM_MARGIN` | `96` | distance from the panel to the bottom edge of the screen | `40` to `160` |
| `TICK_MS` | `33` | how often it repaints (33 ms = ~30 fps) | do not go much lower: the panel spends no repaints while idle, but the shell is a single process |

The colour of the waveform and the icon comes from `org.gnome.desktop.interface accent-color`, with
a blue fallback if the schema does not exist.

---

## Maintenance notes

- **`shell-version` in `metadata.json`.** GNOME compares only the major number (shell 51.x against
  the `"51"` entry). If it does not match, the extension ends up `OUT_OF_DATE` and does not load:
  it is fixed by adding the number to the list.
- **Internal shell APIs.** The extension uses `Main.layoutManager`, `Main.panel`, `PanelMenu`,
  `PopupMenu` and `St`. They are the most stable ones, but there is no compatibility guarantee
  across major versions: it already happened with `affectsInputRegion`, removed in GNOME 50. When
  it happens, the extension ends up in the `ERROR` state (it does not break the session) and the
  journal trace says the file and line.
- **Voxtype's binaries are not updated by `dnf`**, because they are standalone in `~/.local/bin`.
  They are updated with `./update-voxtype.sh` or by downloading the new release by hand and
  verifying `SHA256SUMS.txt`.
- **Nothing depends on the internet** to work: the model is on disk and transcription is local.
  Leaving the setup un-updated does not break it.
