# voxtype-wave

Push-to-talk dictation for **GNOME Shell on Wayland**, with a floating audio-waveform OSD,
built on [Voxtype](https://github.com/peteonrails/voxtype). Press F9, speak, press F9 again:
the text is pasted at the cursor, and a waveform panel appears at the bottom of the screen
while you talk. Everything runs locally — no internet, no GPU.

Requirements: GNOME Shell 50 on Wayland (tested on Fedora 44 / GNOME 50.5), `pipewire-alsa`,
`wl-clipboard`, `dotool`, `curl`, and ~700 MB of disk for the model.

```bash
git clone https://github.com/Charly9926/voxtype-wave.git
cd voxtype-wave
./install.sh
```

The script prints what it does and asks before touching anything. Log out and back in when it
tells you to. The step-by-step manual guide is in [docs/INSTALL.md](docs/INSTALL.md) (Spanish).

---

## What it is and what problem it solves

A complete voice-dictation setup for **GNOME Shell on Wayland**: you press a key, you speak,
and the text appears at the cursor by itself. All speech recognition runs locally on your
machine.

The engine is [Voxtype](https://github.com/peteonrails/voxtype) (MIT, by Peter Jackson), a
push-to-talk dictation daemon that already ships its own waveform OSD. The problem is that
**that OSD does not work on GNOME**: both of its frontends (`voxtype-osd-gtk4` and
`voxtype-osd-quickshell`) need the `wlr-layer-shell` protocol, which Mutter does not
implement. It is reported upstream in issue
[#807](https://github.com/peteonrails/voxtype/issues/807), and it was reproduced exactly on
Fedora 44 + GNOME 50.5 + voxtype 1.1.0. Installing `gtk4-layer-shell` does not help: what is
missing is the protocol in the compositor, not the library.

This repo solves it with its own **GNOME Shell extension** that draws the panel in the
shell's *chrome* layer, using the same audio frames the daemon emits. Drawing there means:

- it stays above the windows and never shows up in the window list;
- it **does not steal focus**, which is the critical part: the text is pasted at the cursor,
  so focus has to stay where you were typing.

If you use **Hyprland, Sway or KDE, you do not need this repo**: Voxtype's own OSD works
there as-is (Omarchy already ships it integrated with Quickshell).

## What it looks like in use

1. You press **F9**. You hear a beep, the waveform panel appears at the bottom center of the
   screen, and the top-bar icon turns red.
2. You speak. While you are silent the panel stays **flat** (a thin line); when you speak, the
   wave grows from the center and fades away as you stop.
3. You press **F9** again. The icon turns amber while it transcribes, and the text is pasted
   at the cursor wherever you were typing. The panel fades out on its own.

The **top-bar icon** shows the state: ready, recording or transcribing. Left-clicking it opens
a menu with the current state, **start / stop / restart the daemon**, switches for two Voxtype
options (**spoken punctuation** and **filler-word removal**), and **Open configuration**, which
opens `~/.config/voxtype/config.toml` in your default editor. Flipping a switch writes the option
through `voxtype config set` (comments and validation preserved) and restarts the daemon, because
Voxtype does not reload its config on the fly. So you never need a terminal to manage it.

The state is watched with a `Gio.FileMonitor` on `$XDG_RUNTIME_DIR/voxtype/state` (no polling),
with a 2 s retry until the file exists at login and a 5 s low-cost safety check.

## Requirements

- **GNOME Shell 50 on Wayland** (tested on Fedora 44 with GNOME 50.5; `metadata.json` also
  declares 51 and 52; the extension uses internal shell APIs).
- A systemd user session (standard on GNOME).
- `pipewire-alsa` (the daemon captures audio through ALSA on top of PipeWire).
- `wl-clipboard` (text is delivered through the clipboard).
- `dotool` (sends the paste chord).
- `curl` (downloads).
- ~700 MB of disk for the model.

On some systems your user also has to belong to the `input` group so `dotool` can write to
`/dev/uinput`, followed by a re-login. The installer checks this on its own.

## Quick install

```bash
git clone https://github.com/Charly9926/voxtype-wave.git
cd voxtype-wave
./install.sh
```

It is also published on [extensions.gnome.org](https://extensions.gnome.org) — search for
*Voxtype Waveform*. Note that the extensions.gnome.org path installs **only** the extension: the
Voxtype daemon, `dotool` and the configuration still have to be set up, which is exactly what
`install.sh` does for you.

The script messages are in English. Options:

| Option | What it does |
|---|---|
| `--no-model` | Skip the model download (670 MB); fetch it later by hand |
| `--hotkey '<Super><Shift>v'` | Use a different key instead of F9 |
| `--no-service` | Do not install or enable the systemd service |
| `--version X.Y.Z` | Install a specific Voxtype version (default `1.1.0`) |
| `--latest` | Use the latest version published on GitHub |
| `--yes` | Answer yes to everything (non-interactive) |
| `--help` | Show the help |

When it finishes, the script asks you to **log out and back in**: that is how GNOME loads the
new extension and, if it was needed, how the `input` group takes effect. It leaves the
extension already enabled for the next login.

## Manual install (summary)

If you prefer doing it by hand, or want to understand what each piece touches. The detailed
version, with a verification for every step, is in [docs/INSTALL.md](docs/INSTALL.md).

1. **Requirements and `dotool`.** Check GNOME/Wayland, `pipewire-alsa` and `wl-clipboard`, and
   install `dotool` (Fedora: COPR `smallcms/dotool`; Arch: `pacman -S dotool`; Debian/Ubuntu:
   build it from <https://git.sr.ht/~geb/dotool>).
2. **Access to `/dev/uinput`.** Check with `[ -w /dev/uinput ]`. If it fails, add your user to
   the `input` group and log back in.
3. **Voxtype binaries.** Download the daemon binary from the v1.1.0 release (the variant depends
   on your CPU) plus the audio bridge, verify the published `SHA256SUMS.txt`, and copy both to
   `~/.local/bin/`.
4. **Model.** `voxtype setup --download --model parakeet-tdt-0.6b-v3-int8` (~670 MB).
5. **Config.** Copy `config/voxtype-config.toml` to `~/.config/voxtype/config.toml` and
   validate it.
6. **Service.** `voxtype setup systemd` and `systemctl --user enable --now voxtype`.
7. **Extension and shortcut.** Copy the 3 files from `extension/` to
   `~/.local/share/gnome-shell/extensions/voxtype-wave@charly9926.github.io/` and create the GNOME shortcut
   that calls `~/.local/bin/voxtype record toggle`. Then: log out, log back in, and enable the
   extension.

## Usage

- **F9** starts recording. **F9** again stops it and pastes the text at the cursor.
- The **waveform** appears at the bottom center of the monitor where your pointer is. It stays
  flat in silence and moves with your voice.
- The **top-bar icon** shows ready / recording / transcribing, and its menu lets you start,
  stop and restart the daemon.

The trigger is a GNOME custom shortcut, not a compositor keybinding: it works in any
application and on any monitor.

## Memory and performance

Numbers measured on the author's machine, not estimates:

| Moment | Memory |
|---|---|
| Daemon idle | **~6 MB** |
| int8 model on disk | **670 MB** |
| While dictating | the loaded model (~1.5 s to load, released afterwards) |

- Transcribing one sentence: **~0.1 s**.
- **No GPU and no VRAM**: inference runs on the CPU with AVX-512.
- The model is loaded when you press F9 and released once transcription finishes
  (`on_demand_loading`), so at rest you only pay for the daemon.

This is what makes it coexist well with heavy local workloads (for example, training or
running models on the same machine): it uses no VRAM and does not keep the model in memory
between dictations.

## Customization

**The key.** It is a GNOME custom shortcut, so you can change it from the UI
(Settings → Keyboard → View and Customize Shortcuts → Custom Shortcuts) or by passing
`--hotkey` to the installer. The associated command is:

```
~/.local/bin/voxtype record toggle
```

**The waveform panel.** The constants live at the top of `extension.js`:

| Constant | What it controls |
|---|---|
| `HISTORY_FRAMES` | How many 10 ms frames are mirrored from the center. `1` = purely instantaneous, `6` = 60 ms (default, a bit of texture), `16` = 160 ms (more motion) |
| `EDGE_FALLOFF` | How much amplitude drops toward the edges. `0` = all bars equal, `0.8` = peak concentrated in the center |
| `RELEASE` | How fast bars fall when the audio drops. Closer to `1` = slower |
| `SILENT_LEVEL` | Threshold below which the flat idle line is drawn |
| `PANEL_W`, `PANEL_H` | Panel size |
| `BARS` | Number of bars |
| `BOTTOM_MARGIN` | Distance from the bottom edge of the screen |

The color of the wave and the icon comes from your GNOME theme's accent color
(`org.gnome.desktop.interface accent-color`).

## Updating

Voxtype's binaries are *standalone* in `~/.local/bin`, so **`dnf` does not update them**. To
fetch them again from the latest release, with integrity verification:

```bash
./update-voxtype.sh
```

## Uninstalling

```bash
./uninstall.sh
```

Removes the extension, the GNOME shortcut and the service. With `--purge` it also deletes the
binaries, the configuration and the models:

```bash
./uninstall.sh --purge
```

## Limitations and honest notes

- **GNOME Shell on Wayland only.** On Hyprland, Sway or KDE do not use this repo: Voxtype's
  OSD works natively there.
- **The `input` group.** On systems without a `uaccess` ACL on `/dev/uinput`, `dotool` needs
  your user in the `input` group (together with the udev rule its package ships) and a
  re-login. Be aware of the cost: that group **lets you read the whole keyboard**, not just
  the dictation key.
- **The binaries are not updated by `dnf`** because they do not come from a distribution
  repository. Use `./update-voxtype.sh`. The flip side is that a system update cannot break
  them either.
- **It uses ~700 MB of disk** for the model.
- **The extension uses internal shell APIs**, which GNOME does not guarantee across major
  versions. It is **tested on GNOME 50** (Fedora 44 / GNOME 50.5), and `metadata.json` declares
  that version only, as extensions.gnome.org requires: after a GNOME release the extension has to
  be tested and the version added. If an API changes, it ends up in the ERROR state (without
  breaking the session) and it is usually a one-line fix (see
  [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)).
- **The extension uuid is `voxtype-wave@charly9926.github.io`**. If you rename it, you also have
  to change the install directory and the `uuid` field in `metadata.json`, because GNOME requires
  them to match.

## Repository structure

```
README.md
LICENSE
install.sh
uninstall.sh
update-voxtype.sh
config/voxtype-config.toml
extension/extension.js
extension/metadata.json
extension/stylesheet.css
scripts/gnome-settings.py
scripts/lib.sh
scripts/make-release-zip.sh
docs/INSTALL.md
docs/TROUBLESHOOTING.md
docs/HOW-IT-WORKS.md
```

The `config/voxtype-config.toml` template is installed to `~/.config/voxtype/config.toml` and
defines the behaviour: `parakeet` engine with the int8 model and on-demand loading, Voxtype's
built-in hotkey disabled (GNOME handles the shortcut), clipboard output with automatic pasting
through `dotool`, its own OSD disabled (the extension replaces it), desktop notifications off,
beeps on, and voice activity detection with the `energy` backend.

## Credits and licenses

- **[Voxtype](https://github.com/peteonrails/voxtype)** — Peter Jackson, MIT license. It is the
  daemon that does audio capture, transcription and text insertion.
- **dotool** — geb, GPL3 license. <https://git.sr.ht/~geb/dotool>
- **NVIDIA Parakeet TDT 0.6B v3 model** — NVIDIA, CC-BY-4.0 license. Multilingual with
  automatic language detection (25 European languages, Spanish included).
- **Inspiration** — Omarchy, which integrates Voxtype with its Quickshell OSD on Hyprland.
- **Author of this repo** — Carlos Jiménez. License: MIT (see `LICENSE`).

This repository **does not redistribute** Voxtype's binaries, the model or `dotool`: the
installer downloads them from their original sources and they remain under their own licenses
(MIT, GPL3 and CC-BY-4.0 respectively).
