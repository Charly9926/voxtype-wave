# Troubleshooting

This document covers the known failures of the voice dictation setup, which is made of three
pieces:

- the `voxtype` daemon (standalone binary at `~/.local/bin/voxtype`), running as a systemd user
  service;
- `voxtype-audio-bridge` (standalone binary at `~/.local/bin/voxtype-audio-bridge`), which turns
  the daemon's audio socket into NDJSON;
- the GNOME Shell extension `voxtype-wave@charly9926.github.io`, which draws the waveform and the status icon.

None of this depends on internet or on external services: audio is captured and transcribed on
the machine. Almost every problem is diagnosed by looking at the journal and at the extension
state.

If this is your first install, see `docs/INSTALL.md`.

---

## The waveform does not appear

**Likely cause.** The floating panel is drawn **only while recording**: the daemon emits audio
frames only during a recording. If you are not recording, there is nothing to show. The other
causes are that the daemon is not running, that the `voxtype-audio-bridge` binary is missing, or
that the extension is not loaded.

**Diagnosis.**

```bash
# 1. is the daemon alive?
systemctl --user status voxtype --no-pager

# 2. does the bridge exist and is it executable?
ls -l ~/.local/bin/voxtype-audio-bridge

# 3. is the extension loaded?
gnome-extensions info voxtype-wave@charly9926.github.io

# 4. are frames arriving from the daemon? (dictate while it runs)
~/.local/bin/voxtype-audio-bridge
```

Command 4 is the most direct one: if you dictate and no `{"peak":...}` lines show up, the problem
is in the daemon (see "The daemon does not start"). If those lines do appear and the waveform is
still missing, the problem is in the extension (see "The extension shows an error / does not
load").

**Solution.**

- If the bridge is missing, reinstall the binaries with `./install.sh` or copy
  `voxtype-audio-bridge` from the release into `~/.local/bin/` with execute permissions.
- If the extension is in `ERROR` or `OUT_OF_DATE`, follow that section.
- Keep in mind that the state file `$XDG_RUNTIME_DIR/voxtype/state` **outlives** the daemon. The
  extension does not use it to tell whether the daemon is alive: it looks at the PID file
  `$XDG_RUNTIME_DIR/voxtype/pid` and checks that `/proc/<pid>` exists.

---

## The text is not pasted

**Likely cause.** In order of frequency:

1. `dotool` is not installed, or it cannot write to `/dev/uinput`.
2. The `post_output_command` hook is written wrong: `dotool` reads its commands from **stdin**,
   not from arguments.
3. `wl-copy` fails because the service has no `WAYLAND_DISPLAY`.
4. Voxtype's `paste` mode is being used, and it does not accept `dotool` for sending the chord.

**Diagnosis.**

```bash
# is dotool installed and can it write to uinput?
command -v dotool && [ -w /dev/uinput ] && echo "uinput OK" || echo "no access to /dev/uinput"

# does the clipboard work?
printf 'test' | wl-copy && wl-paste

# is the hook written correctly?
grep post_output_command ~/.config/voxtype/config.toml

# what does the daemon say?
journalctl --user -u voxtype -n 50 --no-pager
```

**Solution.**

- **`dotool` permissions:** `sudo usermod -aG input "$USER"` and log out. The udev rule for
  `/dev/uinput` ships with the `dotool` package. Security note: belonging to the `input` group
  lets you read the whole keyboard of the machine. If the system already gives the active user
  access to `/dev/uinput` through an ACL (`uaccess`), the group is not needed; Voxtype's evdev
  listener is disabled in this setup, so the group is only needed for `dotool`.
- **Correct hook:**
  ```toml
  post_output_command = "sleep 0.2; echo 'key ctrl+shift+v' | dotool"
  ```
  Without the pipe, the hook fails with
  `dotool: there should be no arguments, commands are read from stdin`.
- **`paste` mode does not work on GNOME.** Internally Voxtype only tries `wtype`, `eitype` or
  `ydotool` to send the chord; the binary strings say so:
  `No keystroke tool available (tried wtype, eitype, ydotool)`. `dotool` is not in that list, and
  `wtype` does not work because Mutter does not implement `zwp_virtual_keyboard_v1`. The
  combination that works is clipboard mode plus the `dotool` hook:
  ```toml
  [output]
  mode = "clipboard"
  restore_clipboard = false
  post_output_command = "sleep 0.2; echo 'key ctrl+shift+v' | dotool"
  ```
- **Direct check of the injector**, with the cursor in a text field:
  ```bash
  echo type "test ñ á é í" | dotool
  ```
  On a `us` layout the accents will warn (see "Accents or odd characters"); that does not stop
  the `ctrl+shift+v` chord from working.
- If the chord does not land in one particular application (for example an editor where
  `ctrl+shift+v` means something else), try `ctrl+v` in the hook.

---

## Nothing happens when pressing F9

**Likely cause.** The GNOME custom shortcut does not exist, it points to the wrong command, or the
daemon is not running. GNOME shortcuts must use the **absolute path** of the binary, because they
do not inherit the shell's `PATH`.

**Diagnosis.**

```bash
# does the shortcut exist and where does it point?
S=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding
B=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/
gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings
gsettings get "$S:$B" name
gsettings get "$S:$B" command
gsettings get "$S:$B" binding

# does the daemon answer the shortcut's command?
voxtype record toggle
```

If the daemon is not running, `record toggle` answers `Error: Voxtype daemon is not running.`

**Solution.**

- Recreate the shortcut with `./install.sh`, or by hand in Settings → Keyboard → View and
  Customize Shortcuts → Custom Shortcuts: any name, command
  `/home/<user>/.local/bin/voxtype record toggle`, key F9.
- If the daemon is not running, see the next section.
- If another application captures F9, change the shortcut key (and, if you want, the status
  indicator does not change: the top-bar icon is independent).

---

## The extension shows an error / does not load

**Diagnosis.**

```bash
gnome-extensions info voxtype-wave@charly9926.github.io
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

The `State` field can be:

| State | Meaning | What to do |
|---|---|---|
| `ENABLED` | loaded and working | nothing |
| `OUT_OF_DATE` | GNOME moved to a new major version and `metadata.json` does not declare it | see "After updating GNOME" |
| `ERROR` | it failed to load: the journal trace points at the file and the line | read the trace and fix the API |

**Known case (GNOME 50).** On GNOME 50, `Main.layoutManager.addChrome()` accepts **only**
`trackFullscreen` and `affectsStruts`. The `affectsInputRegion` parameter existed in earlier
versions and was removed:

```
Error: Unrecognized parameter "affectsInputRegion"
  addChrome@resource:///org/gnome/shell/ui/layout.js
  _buildWavePanel@file:///.../voxtype-wave@charly9926.github.io/extension.js
```

The fix is to pass only those two parameters. A load error **does not break the session**: the
extension stays in the `ERROR` state and the desktop keeps working.

**Editing the extension requires logging out.** GNOME caches the ES module, so on reload you get:

```
A different version was loaded previously. You need to log out for changes to take effect.
```

To test changes without logging out:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

That opens a GNOME Shell inside a window, which loads the same extensions from the same directory.
Two warnings: in that nested session the keyboard-shortcut service does not run, so **F9 does not
work** and recording is triggered with `voxtype record toggle` from another terminal; and to exit
you close the window or press Ctrl+C.

**GNOME's safety net.** If the shell crashes with extensions enabled, on the next login GNOME
disables them (file `gnome-shell-disable-extensions` in the runtime dir). That is: a broken
extension does not leave the desktop permanently unusable.

---

## The daemon does not start

**Diagnosis.**

```bash
systemctl --user status voxtype --no-pager
journalctl --user -u voxtype -f
systemctl --user show-environment | grep WAYLAND_DISPLAY
```

**Causes and solutions.**

- **Missing `WAYLAND_DISPLAY`.** In clipboard mode, Voxtype calls `wl-copy`, which needs that
  variable. If it does not show up in the systemd manager's environment, add a drop-in:
  ```bash
  mkdir -p ~/.config/systemd/user/voxtype.service.d
  printf '[Service]\nEnvironment=WAYLAND_DISPLAY=wayland-0\n' > ~/.config/systemd/user/voxtype.service.d/wayland.conf
  systemctl --user daemon-reload
  systemctl --user restart voxtype
  ```
- **PID file from a previous daemon.** If you ran it by hand before and a PID file was left
  behind, startup detects it and cleans it up on its own (`Removing stale pid file`). No action
  required.
- **Starting it with `voxtype daemon -v`.** That fails: `-v` is a **global** flag and goes before
  the subcommand. The error is `unexpected argument '-v' found`. The correct form is:
  ```bash
  voxtype -v daemon
  ```
- **Missing config or model.** General check:
  ```bash
  voxtype setup check
  ```
- The unit is a user unit: `~/.config/systemd/user/voxtype.service`, with
  `PartOf=graphical-session.target` and `Environment=XDG_RUNTIME_DIR=%t`. To make it start at
  login: `systemctl --user enable voxtype`.

---

## Dictation is slow or RAM goes up

**What is expected (not a problem).**

- The first sentence of each dictation takes around **1.5 s**: the model is loaded on demand
  (`on_demand_loading = true`) and released when it finishes.
- The transcription itself takes around **0.1 s** per sentence.
- The daemon uses **~6 MB when idle** (measured peak: 9.3 MB). The int8 model takes 670 MB on disk
  and is only in memory while you dictate.
- The engine runs on the **CPU with AVX-512 and uses no GPU or VRAM**, so it does not compete with
  other GPU workloads.

**Diagnosis.**

```bash
free -h                                        # before and after dictating
grep on_demand_loading ~/.config/voxtype/config.toml
journalctl --user -u voxtype -n 30 --no-pager  # look for the model load
```

**Solution.**

- If RAM does not come back after dictating, confirm that the config has
  `[parakeet] on_demand_loading = true`.
- If you prefer less latency in exchange for permanent RAM, set `on_demand_loading = false`: the
  model stays loaded (the 670 MB stop being released).

---

## Accents or odd characters

**Cause.** With a `us` keyboard layout, `dotool` cannot type accents:

```
dotool: WARNING: impossible character for layout: ñ
dotool: WARNING: impossible character for layout: á
```

That is why this setup **pastes** the text (exact Unicode through the clipboard) instead of typing
it with key events. `dotool` is only used to send the `ctrl+shift+v` chord, which does not depend
on the layout.

**Diagnosis.**

```bash
localectl status | grep -i layout
echo type "test ñ á é í" | dotool
```

**Solution.**

- Keep `[output] mode = "clipboard"` plus the `dotool` hook: that is what avoids the problem.
- If the paste does not land in one particular application, try `ctrl+v` instead of
  `ctrl+shift+v`.
- Do not try to solve it with `mode = "type"`: it would type without accents or with the wrong
  characters, because it translates text into keys according to the active layout.

---

## After updating GNOME

A major GNOME update can leave the extension in two different states:

- **`State: OUT_OF_DATE`.** That is the `shell-version` field in `metadata.json`. GNOME compares
  only the major number (shell 51.x against the `"51"` entry). Fix: add the new number to the
  field's list.
- **`State: ERROR`.** An internal shell API changed. The journal trace points at the exact file
  and line.

```bash
gnome-extensions info voxtype-wave@charly9926.github.io
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

Normal Fedora updates (kernel, Mesa, PipeWire, systemd, drivers) do not affect the extension,
which lives in `~/.local` and depends on no system packages beyond GNOME Shell itself.

**Voxtype's binaries are not updated by `dnf`:** they are standalone in `~/.local/bin`. They are
updated with `./update-voxtype.sh` or by downloading the new release by hand and verifying
`SHA256SUMS.txt`.

---

## 30-second diagnosis

```bash
# 1. is the daemon alive and healthy?
systemctl --user status voxtype --no-pager

# 2. is the extension loaded?
gnome-extensions info voxtype-wave@charly9926.github.io

# 3. are audio frames coming out? (dictate while it runs)
~/.local/bin/voxtype-audio-bridge

# 4. are there shell errors?
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

Extra commands depending on the symptom:

```bash
voxtype setup check                         # dependencies and configuration
journalctl --user -u voxtype -f             # live daemon
echo type "test ñ á é í" | dotool            # direct text injector
free -h                                     # RAM should come back after dictating
```

---

## How to report a problem

Paste into the issue, in this order:

1. System version: `uname -r` and `rpm -E %fedora`.
2. GNOME version: `gnome-shell --version`.
3. Extension state: `gnome-extensions info voxtype-wave@charly9926.github.io`.
4. Filtered shell errors:
   ```bash
   journalctl --user -b -g voxtype-wave --no-pager | tail -30
   ```
5. If the problem is the daemon:
   ```bash
   systemctl --user status voxtype --no-pager
   ```
6. If the problem is transcription or text output:
   ```bash
   journalctl --user -u voxtype -n 50 --no-pager
   ```
7. Which application had focus, what you did, and what you expected to happen.
