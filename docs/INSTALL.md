# Step-by-step installation

There are two paths. **A** is the automatic installer: it does everything path B describes,
verifications included. **B** is the same procedure by hand, explaining why each step is needed
and how to check it; it is the one to follow if you want to understand what each piece touches,
or if the installer failed at some specific point.

In both cases, at the end you have to **log out and back in**.

---

## Path A — automatic installer

```bash
git clone https://github.com/Charly9926/voxtype-wave.git
cd voxtype-wave
./install.sh
```


| Option | What it does |
|---|---|
| `--no-model` | Does not download the model (670 MB); it is left for doing later by hand |
| `--hotkey '<Super><Shift>v'` | Uses another key instead of F9 |
| `--no-service` | Does not install or enable the systemd service |
| `--yes` | Answers yes to everything (non-interactive) |
| `--help` | Shows the help |

The script installs and verifies: `dotool`, access to `/dev/uinput`, the Voxtype binaries and
the bridge, the model, the configuration, the user service and the extension with its shortcut.
For the shortcut it uses `scripts/gnome-settings.py`, which **adds** a new entry without
overwriting the custom shortcuts you already have.

When it finishes it will ask you to log out. After logging back in, the extension is enabled and
you can try F9.

---

## Path B — manual step by step

The steps that use paths relative to the repository (`config/`, `extension/`, `scripts/`) are run
from the folder where you cloned it. In the examples that folder is called `$REPO`: define it
once and adjust it if you cloned it somewhere else.

```bash
REPO="$HOME/voxtype-wave"
cd "$REPO"
```

### Step 1 — Prerequisites

You need **GNOME Shell 50 on Wayland** (tested on Fedora 44 with GNOME 50.5; the extension's
`metadata.json` also declares 51 and 52), a systemd user session, `pipewire-alsa` (the daemon
captures audio through ALSA on top of PipeWire), `wl-clipboard` and `curl`.

Check it like this:

```bash
# GNOME version and session
gnome-shell --version
echo "$XDG_SESSION_TYPE"          # it has to say: wayland

# packages (Fedora)
rpm -q pipewire-alsa wl-clipboard curl
```

If something is missing:

```bash
sudo dnf install pipewire-alsa wl-clipboard curl
```

`pipewire-alsa` matters: without it, the daemon does not find the audio device and you will see
"device not available" errors.

### Step 2 — Install dotool

`dotool` is what sends the paste chord (Ctrl+Shift+V) to the system clipboard. Without it, the
text is transcribed and stays in the clipboard, but it does not appear at the cursor by itself.

**Fedora** (it is in a third-party COPR, it is a leaf package):

```bash
sudo dnf copr enable smallcms/dotool
sudo dnf install dotool
```

**Arch:**

```bash
sudo pacman -S dotool
```

**Debian / Ubuntu** (not packaged; it is compiled):

```bash
sudo apt install libxkbcommon-dev
git clone https://git.sr.ht/~geb/dotool
cd dotool && ./build.sh && sudo install -Dm755 dotool /usr/local/bin/dotool
```

Verification:

```bash
command -v dotool
```

It has to print the path of the binary. If it prints nothing, it did not end up in the `PATH`.

### Step 3 — Verify access to `/dev/uinput`

`dotool` writes keyboard events through `/dev/uinput`. On many systems your user already has
permission through a `uaccess` ACL; on others you need to belong to the `input` group.

```bash
[ -w /dev/uinput ] && echo OK || echo MISSING
```

If it says `MISSING`:

```bash
sudo usermod -aG input "$USER"
```

and **log out and back in** (running `newgrp` is not enough, because the daemon starts with the
session). After logging in, check that the group is active:

```bash
id | tr ',' '\n' | grep input
```

Security note: the `input` group allows reading **the whole** keyboard, not just the dictation
key. It is the same requirement other tools of this kind have.

### Step 4 — Download the Voxtype binaries and the bridge

Voxtype is distributed as standalone binaries per release. You have to download two: the daemon
(in the variant that matches your CPU) and the audio bridge, which turns the daemon's audio
socket into NDJSON so that the extension can read it.

The variants published in release v1.1.0 are:

| Architecture | Variant | File |
|---|---|---|
| x86_64 with AVX-512 | `onnx-avx512` | `voxtype-1.1.0-linux-x86_64-onnx-avx512` |
| x86_64 without AVX-512 | `onnx-avx2` | `voxtype-1.1.0-linux-x86_64-onnx-avx2` |
| aarch64 | `onnx` | `voxtype-1.1.0-linux-aarch64-onnx` |

The bridge is called `voxtype-1.1.0-linux-<architecture>-audio-bridge`.

This block picks the variant by itself, downloads everything and **verifies integrity** against
the published `SHA256SUMS.txt` before installing:

```bash
base=https://github.com/peteonrails/voxtype/releases/download/v1.1.0
arch=$(uname -m)
if [ "$arch" = "aarch64" ]; then
  variant=onnx
else
  grep -qm1 avx512f /proc/cpuinfo && variant=onnx-avx512 || variant=onnx-avx2
fi

bin="voxtype-1.1.0-linux-${arch}-${variant}"
bridge="voxtype-1.1.0-linux-${arch}-audio-bridge"

mkdir -p ~/Downloads/voxtype && cd ~/Downloads/voxtype
curl -fLO "$base/$bin"
curl -fLO "$base/$bridge"
curl -fLO "$base/SHA256SUMS.txt"

# integrity: every file has to say OK
grep -E "$bin|$bridge" SHA256SUMS.txt | sha256sum -c -
```

If any line does not say `OK`, do not continue: download the file again.

Installation:

```bash
install -Dm755 "$bin" ~/.local/bin/voxtype
install -Dm755 "$bridge" ~/.local/bin/voxtype-audio-bridge

voxtype --version
```

It has to print `voxtype 1.1.0`. On Fedora `~/.local/bin` is usually in `PATH`; if
`voxtype --version` is not found, use the full path `~/.local/bin/voxtype` or add that folder to
your `PATH`.

Go back to the repository root before continuing (the previous step left you in `~/Downloads`):

```bash
cd "$REPO"
```

### Step 5 — Download the model

```bash
voxtype setup --download --model parakeet-tdt-0.6b-v3-int8
```

They are ~670 MB and stay in `~/.local/share/voxtype/models/`.

Why the **int8** variant and not the full-precision one: the fp32 model takes 2.5 GB, while int8
takes 670 MB, and the latter is also hardware-accelerated if your CPU has `avx512_vnni` (check it
with `grep -qm1 avx512_vnni /proc/cpuinfo && echo yes`). With the on-demand loading the
configuration ships with, the model is loaded when you press the key and released when you
finish, so at rest it takes no memory. If you prefer maximum accuracy, `parakeet-tdt-0.6b-v3`
(2.5 GB) exists; it is changed with one line in the configuration file.

### Step 6 — Install the configuration

```bash
cd "$REPO"
mkdir -p ~/.config/voxtype
cp config/voxtype-config.toml ~/.config/voxtype/config.toml
```

Validation (if something is misspelled, Voxtype warns and discards that section):

```bash
voxtype config 2>&1 | grep -i warn || echo OK
```

The template already ships what this setup needs: the `parakeet` engine with the int8 model and
on-demand loading, Voxtype's built-in hotkey disabled (GNOME handles the shortcut), clipboard
output with automatic pasting through `dotool`, its own OSD disabled (the extension replaces it),
desktop notifications off, beeps on, and voice activity detection with the `energy` backend.

### Step 7 — systemd user service

This way the daemon starts on its own at every login, without opening a terminal:

```bash
voxtype setup systemd
systemctl --user enable --now voxtype
systemctl --user status voxtype --no-pager
```

In the status you have to see `Active: active (running)` and, at rest, a memory usage of a few MB.

**If pasting does not work**, check that the service inherits `WAYLAND_DISPLAY`: the output mode
uses `wl-copy`, which needs it to talk to the compositor.

```bash
systemctl --user show-environment | grep WAYLAND_DISPLAY
```

If it prints nothing, add a drop-in to the service:

```bash
mkdir -p ~/.config/systemd/user/voxtype.service.d
printf '[Service]\nEnvironment=WAYLAND_DISPLAY=wayland-0\n' > ~/.config/systemd/user/voxtype.service.d/wayland.conf
systemctl --user daemon-reload
systemctl --user restart voxtype
```

### Step 8 — Install the extension and create the shortcut

The extension is what draws the waveform. It is three files:

```bash
cd "$REPO"
mkdir -p ~/.local/share/gnome-shell/extensions/voxtype-wave@charly9926.github.io
cp extension/extension.js extension/metadata.json extension/stylesheet.css \
   ~/.local/share/gnome-shell/extensions/voxtype-wave@charly9926.github.io/
```

The folder name **has to match** the `uuid` field in `metadata.json` (`voxtype-wave@charly9926.github.io`): if
you rename one, change the other.

Now the shortcut. The command is always the same:

```
~/.local/bin/voxtype record toggle
```

**Simple option, through the UI:** Settings → Keyboard → View and Customize Shortcuts → Custom
Shortcuts → `+`. Name `Voxtype dictation (toggle)`, the command above, and when it asks for the
key press **F9**.

**Console option.** Careful: there is a single custom-shortcut list, so you have to **add** the
new entry without deleting the ones you already had. First look at what you have:

```bash
gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings
```

Suppose the list it returns includes `custom0`. Then you create the new one as `custom2` and
afterwards you publish the **complete** list (the old ones plus the new one):

```bash
S=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding
B=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/

gsettings set "$S:$B" name 'Voxtype dictation (toggle)'
gsettings set "$S:$B" command "$HOME/.local/bin/voxtype record toggle"
gsettings set "$S:$B" binding 'F9'

gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings \
  "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/', '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/']"
```

The last line is the critical one: it has to list **all** the entries you want to keep. If you get
that wrong, you lose the other custom shortcuts (they can be created again from the UI). The
repository installer avoids this risk by using `scripts/gnome-settings.py`, which reads the
current list and appends the new entry.

### Step 9 — Log out, enable and test

Log out and back in. This is needed for two reasons: GNOME does not load new extensions on the
fly, and if you had to add yourself to the `input` group, the change only takes effect then.

Then enable the extension. Through the UI: **Extensions** app → **Voxtype Waveform** → the
switch. Through the console:

```bash
gnome-extensions enable voxtype-wave@charly9926.github.io
```

Test:

1. Put the cursor in any text field.
2. Press **F9**: the beep has to sound, the waveform has to appear at the bottom center and the
   top-bar icon has to turn red.
3. Speak for a few seconds.
4. Press **F9** again: the icon turns amber for a moment and the text appears pasted at the
   cursor.

---

## Final verification

```bash
# the extension: it has to say Enabled: Yes and State: ACTIVE (or ENABLED)
gnome-extensions info voxtype-wave@charly9926.github.io

# the daemon: Active: active (running)
systemctl --user status voxtype --no-pager

# extension errors in this session (it should print nothing)
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

## If something does not work

See [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
