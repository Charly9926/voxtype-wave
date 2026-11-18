# Voxtype patch: PipeWire/Pulse capture host

The stock Voxtype 1.1.0 binary captures through ALSA, so `[audio] device` only
accepts the names its ALSA backend enumerates (`default`, `pipewire`). A
PipeWire source such as Easy Effects' virtual microphone fails with
`Audio device not found`.

This patch switches the capture to cpal's **PulseAudio host** (served by
`pipewire-pulse`), which exposes every PipeWire source by name. Voxtype then
records whichever device you pick in the extension menu, and nothing outside
Voxtype changes (no system default to break).

`voxtype-pulse-capture-host.patch` applies to the `v1.1.0` tag.

## Apply and build

```bash
# 1. Build dependencies (Fedora). rustfmt/clippy are optional.
sudo dnf install rust cargo alsa-lib-devel clang-devel pulseaudio-libs-devel cmake pkgconf

# 2. Clone the exact tag and apply the patch
git clone --depth 1 --branch v1.1.0 https://github.com/peteonrails/voxtype.git
cd voxtype
git apply ../voxtype-pulse-capture-host.patch

# 3. Build the ONNX engine this setup uses
cargo build --release --features parakeet

# 4. Install it next to the stock binary (do not overwrite ~/.local/bin/voxtype)
install -Dm755 target/release/voxtype ~/.local/bin/voxtype-pw
```

## Point the service at it

`~/.config/systemd/user/voxtype.service.d/patched-binary.conf`:

```ini
[Service]
ExecStart=
ExecStart=%h/.local/bin/voxtype-pw daemon
```

```bash
systemctl --user daemon-reload && systemctl --user restart voxtype
```

Check that the Pulse host is in use:

```bash
~/.local/bin/voxtype-pw info devices     # logs "Audio host: PulseAudio"
```

## Rollback

```bash
rm ~/.config/systemd/user/voxtype.service.d/patched-binary.conf
systemctl --user daemon-reload && systemctl --user restart voxtype
```

`update-voxtype.sh` keeps updating the stock `~/.local/bin/voxtype`; the
patched `voxtype-pw` stays as built until you rebuild it for a new version.

## What changed

- `Cargo.toml`: `cpal` 0.15 -> 0.18.2 with the `pulseaudio` feature, and
  `rodio` 0.19 -> 0.23 (it must share cpal 0.18) with the `playback` feature.
- `src/audio/cpal_capture.rs`: `capture_host()` prefers the Pulse host when it
  has a default input and falls back to the platform default, so a machine
  without a sound server behaves exactly as before. The stream uses
  `BufferSize::Fixed(480)`: with the default buffer the Pulse host prebuffered
  ~2 s and the first words of every recording were lost. Also adapted to the cpal
  0.18 API (`description()` instead of `name()`, `sample_rate()` is a `u32`,
  `cpal::Error`, `StreamConfig` by value).
  `cpal::Error`, `StreamConfig` by value).
- `src/audio/devices.rs`: `voxtype info devices` uses the same host, so the
  menu lists exactly what the daemon can open.
- `src/audio/feedback.rs`: migrated to the rodio 0.23 API
  (`DeviceSinkBuilder` + `Player`).
