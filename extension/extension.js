// voxtype-wave — audio waveform OSD and status indicator for the Voxtype daemon.
//
// Why a shell extension instead of Voxtype's own OSD: both of its frontends
// (voxtype-osd-gtk4, voxtype-osd-quickshell) require the wlr-layer-shell
// protocol, which Mutter does not implement (see voxtype issue #807). A shell
// extension can draw in the shell's chrome layer instead, which stays above the
// windows, does not appear in the window list and does not steal focus — the
// last one matters because the transcribed text is pasted at the cursor.
//
// The extension does two things:
//   1. a floating waveform panel at the bottom center while recording;
//   2. a top-bar icon with the daemon state, a menu to start/stop/restart the
//      daemon, two Voxtype option switches and a shortcut to the config file.
//
// Data: it spawns `voxtype-audio-bridge`, which exposes the daemon's audio
// socket as NDJSON on stdout, one line per 10 ms frame:
//     {"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}
// The bridge handles reconnection itself, so we only read lines here.
//
// The daemon state (idle/recording/transcribing) comes from its state file,
// watched with Gio.FileMonitor (no polling). The shell loads extensions before
// the daemon creates that file, so the monitor setup retries every 2 s, and a
// 5 s low-cost safety check covers any missed event.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// --- waveform panel ---------------------------------------------------------
const PANEL_W = 340;          // logical pixels
const PANEL_H = 64;
const BARS = 48;              // number of bars in the waveform
const BAR_GAP = 2;            // gap between bars
const BOTTOM_MARGIN = 96;     // distance from the bottom edge of the monitor
const TICK_MS = 33;           // ~30 fps redraw
const FADE_START_MS = 400;    // start fading when recording ends
const FADE_END_MS = 850;      // fully invisible at this point (panel hidden)
const BRIDGE_RETRY_SECS = 3;  // respawn the bridge if it exits

// --- waveform shape ---------------------------------------------------------
// Frames are mirrored from the center, so the newest audio is in the middle and
// there is no lateral scroll. HISTORY_FRAMES = 1 makes it purely instantaneous.
const HISTORY_FRAMES = 6;     // 10 ms frames kept, mirrored from the center
const EDGE_FALLOFF = 0.55;    // amplitude drop towards the edges (0 = flat bars)
const RELEASE = 0.72;         // per-tick decay when the audio drops
const SILENT_LEVEL = 0.02;    // below this, the flat idle line is drawn
const FLAT_LINE_H = 3;
const FLAT_LINE_ALPHA = 0.35;

// --- daemon state / panel indicator ----------------------------------------
const VOXTYPE_RUNTIME = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'voxtype']);
const STATE_FILE = GLib.build_filenamev([VOXTYPE_RUNTIME, 'state']);
const PID_FILE = GLib.build_filenamev([VOXTYPE_RUNTIME, 'pid']);
const CONFIG_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'voxtype', 'config.toml']);
const SAFETY_POLL_SECS = 5;   // safety net in case the monitor misses an event
const MONITOR_RETRY_SECS = 2; // retry until the state file exists

const STATE_ICON = {
    idle: 'audio-input-microphone-symbolic',
    recording: 'media-record-symbolic',
    transcribing: 'view-refresh-symbolic',
    stopped: 'microphone-sensitivity-muted-symbolic',
};

const STATE_CLASS = {
    idle: 'voxtype-wave-idle',
    recording: 'voxtype-wave-recording',
    transcribing: 'voxtype-wave-transcribing',
    stopped: 'voxtype-wave-stopped',
};

const STATE_LABEL = {
    idle: 'ready — press F9 to dictate',
    recording: 'recording…',
    transcribing: 'transcribing…',
    stopped: 'daemon stopped',
};

// GNOME accent colors (org.gnome.desktop.interface accent-color).
const ACCENTS = {
    blue:   [0.208, 0.518, 0.894],
    teal:   [0.129, 0.565, 0.643],
    green:  [0.227, 0.580, 0.290],
    yellow: [0.784, 0.533, 0.000],
    orange: [0.929, 0.357, 0.000],
    red:    [0.902, 0.176, 0.259],
    pink:   [0.835, 0.380, 0.600],
    purple: [0.569, 0.255, 0.675],
    slate:  [0.435, 0.514, 0.588],
};

// Look for executables by absolute path first: the shell's PATH may not include
// ~/.local/bin, where standalone installs of voxtype live.
function findBinary(name, candidates) {
    for (const path of candidates) {
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return GLib.find_program_in_path(name);
}

function findBridge() {
    return findBinary('voxtype-audio-bridge', [
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'voxtype-audio-bridge']),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'voxtype', 'voxtype-audio-bridge']),
        '/usr/local/bin/voxtype-audio-bridge',
        '/usr/lib/voxtype/voxtype-audio-bridge',
    ]);
}

function findVoxtype() {
    return findBinary('voxtype', [
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'voxtype']),
        '/usr/local/bin/voxtype',
        '/usr/lib/voxtype/voxtype',
    ]);
}

function findVoxtypeUnit() {
    const candidates = [
        GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user', 'voxtype.service']),
        '/usr/lib/systemd/user/voxtype.service',
        '/etc/systemd/user/voxtype.service',
    ];
    for (const path of candidates) {
        if (GLib.file_test(path, GLib.FileTest.EXISTS))
            return path;
    }
    return null;
}

// Small ASCII file reader (avoids TextDecoder for a few bytes).
function readAscii(path, max = 64) {
    try {
        const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
        if (!ok || !contents)
            return null;
        let text = '';
        for (let i = 0; i < contents.length && i < max; i++)
            text += String.fromCharCode(contents[i]);
        return text.trim();
    } catch (e) {
        return null;
    }
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.arc(x + w - r, y + r, r, 1.5 * Math.PI, 2 * Math.PI);
    cr.arc(x + w - r, y + h - r, r, 0, 0.5 * Math.PI);
    cr.arc(x + r, y + h - r, r, 0.5 * Math.PI, Math.PI);
    cr.closePath();
}

export default class VoxtypeWaveExtension extends Extension {
    enable() {
        this._bars = new Array(BARS).fill(0);
        this._hist = [];
        this._silent = true;
        this._lastFrameUs = 0;
        this._visible = false;
        this._bridge = null;
        this._stdout = null;
        this._bridgeRetryId = 0;
        this._monitorsChangedId = 0;
        this._paintId = 0;
        this._state = null;
        this._serviceActive = null;
        this._stateMonitor = null;
        this._stateMonitorId = 0;
        this._monitorRetryId = 0;
        this._safetyId = 0;
        this._updatingSwitches = false;
        this._accent = this._readAccent();
        this._unitPath = findVoxtypeUnit();
        this._voxtype = findVoxtype();

        this._buildWavePanel();
        this._buildIndicator();
        this._startStateWatch();
        this._spawnBridge();
    }

    disable() {
        if (this._paintId) {
            GLib.source_remove(this._paintId);
            this._paintId = 0;
        }
        if (this._bridgeRetryId) {
            GLib.source_remove(this._bridgeRetryId);
            this._bridgeRetryId = 0;
        }
        if (this._monitorRetryId) {
            GLib.source_remove(this._monitorRetryId);
            this._monitorRetryId = 0;
        }
        if (this._safetyId) {
            GLib.source_remove(this._safetyId);
            this._safetyId = 0;
        }
        if (this._monitorsChangedId) {
            Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }
        this._teardownStateMonitor();
        this._stopBridge();
        this._area?.destroy();
        this._area = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._bars = null;
        this._hist = null;
    }

    // =======================================================================
    //  Waveform panel
    // =======================================================================
    _buildWavePanel() {
        this._area = new St.DrawingArea({reactive: false, can_focus: false});
        this._area.set_size(PANEL_W, PANEL_H);
        this._area.connect('repaint', () => this._draw());

        // addTopChrome() is called without parameters on purpose: GNOME 50
        // removed the `affectsInputRegion` key and passing unknown keys throws
        // "Unrecognized parameter" while loading the extension. The defaults are
        // fine, and the actor takes no input because it is not reactive.
        Main.layoutManager.addTopChrome(this._area);
        this._area.hide();

        this._monitorsChangedId =
            Main.layoutManager.connect('monitors-changed', () => this._reposition());

        this._paintId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _readAccent() {
        try {
            const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
            const name = settings.get_string('accent-color');
            if (ACCENTS[name])
                return ACCENTS[name];
        } catch (e) {
            // accent-color was added in a later GNOME release
        }
        return ACCENTS.blue;
    }

    _monitorUnderPointer() {
        const [x, y] = global.get_pointer();
        for (const mon of Main.layoutManager.monitors) {
            if (x >= mon.x && x < mon.x + mon.width && y >= mon.y && y < mon.y + mon.height)
                return mon;
        }
        return Main.layoutManager.primaryMonitor;
    }

    _reposition() {
        if (!this._area)
            return;
        const mon = this._monitorUnderPointer() ?? Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const x = mon.x + Math.round((mon.width - PANEL_W) / 2);
        const y = mon.y + mon.height - PANEL_H - BOTTOM_MARGIN;
        this._area.set_position(x, y);
    }

    // =======================================================================
    //  Panel indicator
    // =======================================================================
    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.5, 'Voxtype', false);

        this._icon = new St.Icon({
            icon_name: STATE_ICON.stopped,
            style_class: `system-status-icon ${STATE_CLASS.stopped}`,
        });
        this._indicator.add_child(this._icon);

        this._statusItem = new PopupMenu.PopupMenuItem('Voxtype', {reactive: false});
        this._indicator.menu.addMenuItem(this._statusItem);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._toggleItem = new PopupMenu.PopupMenuItem('Start daemon');
        this._toggleItem.connect('activate', () => this._toggleDaemon());
        this._indicator.menu.addMenuItem(this._toggleItem);

        this._restartItem = new PopupMenu.PopupMenuItem('Restart daemon');
        this._restartItem.connect('activate', () => this._restartDaemon());
        this._indicator.menu.addMenuItem(this._restartItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // These switches write Voxtype's config. The daemon does not reload its
        // config, so each change restarts the service.
        this._punctuationItem = new PopupMenu.PopupSwitchMenuItem('Spoken punctuation', false);
        this._punctuationItem.connect('toggled', (item, state) => {
            this._setConfig('text.spoken_punctuation', state);
        });
        this._indicator.menu.addMenuItem(this._punctuationItem);

        this._fillersItem = new PopupMenu.PopupSwitchMenuItem('Remove filler words', false);
        this._fillersItem.connect('toggled', (item, state) => {
            this._setConfig('text.filter_filler_words', state);
        });
        this._indicator.menu.addMenuItem(this._fillersItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._openConfigItem = new PopupMenu.PopupMenuItem('Open configuration');
        this._openConfigItem.connect('activate', () => this._openConfig());
        this._indicator.menu.addMenuItem(this._openConfigItem);

        if (!this._unitPath) {
            this._toggleItem.label.text = 'Service missing (run: voxtype setup systemd)';
            this._toggleItem.setSensitive(false);
            this._restartItem.setSensitive(false);
        } else {
            this._refreshService();
        }

        // Subprocesses (systemctl, voxtype config) run when the menu opens, not
        // from a timer, so nothing is spawned while the extension is idle.
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (!open)
                return;
            if (this._unitPath)
                this._refreshService();
            this._refreshSwitches();
        });

        Main.panel.addToStatusArea('voxtype-wave', this._indicator);
    }

    // =======================================================================
    //  Daemon state (FileMonitor + retry + safety net)
    // =======================================================================
    _startStateWatch() {
        this._refreshState();
        this._setupStateMonitor();
        this._safetyId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, SAFETY_POLL_SECS, () => {
            this._refreshState();
            if (!this._stateMonitor)
                this._setupStateMonitor();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scheduleMonitorRetry() {
        if (this._monitorRetryId)
            return;
        this._monitorRetryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
            MONITOR_RETRY_SECS, () => {
                this._monitorRetryId = 0;
                this._setupStateMonitor();
                return GLib.SOURCE_REMOVE;
            });
    }

    _setupStateMonitor() {
        if (this._stateMonitor || !this._area)
            return;
        // At login the shell loads extensions before the daemon creates the
        // state file, and monitoring a file that does not exist yet is useless.
        if (!GLib.file_test(STATE_FILE, GLib.FileTest.EXISTS)) {
            this._scheduleMonitorRetry();
            return;
        }
        try {
            this._stateMonitor = Gio.File.new_for_path(STATE_FILE)
                .monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            logError(e, '[voxtype-wave] could not monitor the state file');
            this._stateMonitor = null;
            this._scheduleMonitorRetry();
            return;
        }
        this._stateMonitorId = this._stateMonitor.connect('changed', (_mon, _file, event) => {
            if (event === Gio.FileMonitorEvent.DELETED ||
                event === Gio.FileMonitorEvent.MOVED_OUT) {
                // The file was recreated (daemon restart): drop this monitor and
                // let the retry arm a new one on the current file.
                this._teardownStateMonitor();
                this._scheduleMonitorRetry();
            }
            this._refreshState();
        });
    }

    _teardownStateMonitor() {
        if (this._stateMonitor && this._stateMonitorId)
            this._stateMonitor.disconnect(this._stateMonitorId);
        this._stateMonitorId = 0;
        if (this._stateMonitor) {
            this._stateMonitor.cancel();
            this._stateMonitor = null;
        }
    }

    // The state file outlives the daemon, so liveness comes from the PID file:
    // if that process exists, the daemon is running.
    _daemonRunning() {
        const raw = readAscii(PID_FILE);
        if (!raw)
            return false;
        const pid = Number.parseInt(raw, 10);
        if (!Number.isFinite(pid) || pid <= 0)
            return false;
        return GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS);
    }

    _refreshState() {
        let state;
        if (!this._daemonRunning()) {
            state = 'stopped';
        } else {
            const raw = readAscii(STATE_FILE);
            state = raw && STATE_ICON[raw] ? raw : 'idle';
        }
        if (state === this._state)
            return;
        this._state = state;
        this._updateIndicator();
    }

    _updateIndicator() {
        if (!this._icon)
            return;
        this._icon.icon_name = STATE_ICON[this._state];
        this._icon.style_class = `system-status-icon ${STATE_CLASS[this._state]}`;
        this._statusItem.label.text = `Voxtype: ${STATE_LABEL[this._state]}`;
    }

    // =======================================================================
    //  Menu actions
    // =======================================================================
    _runCommand(argv, callback) {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, `[voxtype-wave] could not run ${argv.join(' ')}`);
            return;
        }
        proc.communicate_utf8_async(null, null, (p, res) => {
            let out = '';
            try {
                const [, stdout] = p.communicate_utf8_finish(res);
                out = (stdout ?? '').trim();
            } catch (e) {
                out = '';
            }
            callback?.(out);
        });
    }

    _runSystemctl(args, callback) {
        this._runCommand(['systemctl', '--user', ...args], callback);
    }

    _refreshService() {
        this._runSystemctl(['is-active', 'voxtype'], out => {
            this._serviceActive = out === 'active';
            if (this._toggleItem) {
                this._toggleItem.label.text =
                    this._serviceActive ? 'Stop daemon' : 'Start daemon';
            }
        });
    }

    _toggleDaemon() {
        const action = this._serviceActive ? 'stop' : 'start';
        this._runSystemctl([action, 'voxtype'], () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._refreshService();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _restartDaemon() {
        this._runSystemctl(['restart', 'voxtype'], () => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                this._refreshService();
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    _refreshSwitches() {
        if (!this._voxtype)
            return;
        const pairs = [
            [this._punctuationItem, 'text.spoken_punctuation'],
            [this._fillersItem, 'text.filter_filler_words'],
        ];
        for (const [item, key] of pairs) {
            this._runCommand([this._voxtype, 'config', 'get', key], out => {
                if (!item)
                    return;
                // Setting `state` also emits ::toggled, so guard the handler to
                // avoid writing the config back while we sync the switch.
                this._updatingSwitches = true;
                item.state = out.split('\n')[0].trim() === 'true';
                this._updatingSwitches = false;
            });
        }
    }

    _setConfig(key, value) {
        if (this._updatingSwitches || !this._voxtype)
            return;
        this._runCommand([this._voxtype, 'config', 'set', key, String(value)], () => {
            if (!this._unitPath)
                return;
            this._runSystemctl(['restart', 'voxtype'], () => {
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1200, () => {
                    this._refreshService();
                    return GLib.SOURCE_REMOVE;
                });
            });
        });
    }

    _openConfig() {
        const file = Gio.File.new_for_path(CONFIG_FILE);
        const target = GLib.file_test(CONFIG_FILE, GLib.FileTest.EXISTS)
            ? file
            : Gio.File.new_for_path(GLib.path_get_dirname(CONFIG_FILE));
        try {
            Gio.AppInfo.launch_default_for_uri(target.get_uri(), null);
        } catch (e) {
            logError(e, '[voxtype-wave] could not open the configuration');
        }
    }

    // =======================================================================
    //  Audio bridge
    // =======================================================================
    _spawnBridge() {
        if (!this._area)
            return;
        const path = findBridge();
        if (!path) {
            console.warn('[voxtype-wave] voxtype-audio-bridge not found; ' +
                'the waveform will not be shown');
            return;
        }
        try {
            this._bridge = Gio.Subprocess.new([path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, '[voxtype-wave] could not start voxtype-audio-bridge');
            this._bridge = null;
            return;
        }
        this._stdout = new Gio.DataInputStream({base_stream: this._bridge.get_stdout_pipe()});
        this._readLine();
    }

    _stopBridge() {
        this._stdout = null;
        if (this._bridge) {
            try {
                this._bridge.force_exit();
            } catch (e) {
                // already gone
            }
            this._bridge = null;
        }
    }

    _readLine() {
        if (!this._stdout)
            return;
        this._stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
            let line = null;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch (e) {
                line = null;
            }
            if (line === null) {
                // The bridge exited (for example after a daemon restart): spawn
                // a new one shortly.
                this._stopBridge();
                if (!this._bridgeRetryId) {
                    this._bridgeRetryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                        BRIDGE_RETRY_SECS, () => {
                            this._bridgeRetryId = 0;
                            this._spawnBridge();
                            return GLib.SOURCE_REMOVE;
                        });
                }
                return;
            }
            if (line.length > 0)
                this._onLine(line);
            this._readLine();
        });
    }

    _onLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (e) {
            return;
        }
        if (typeof msg.peak !== 'number')
            return;
        this._hist.unshift({
            peak: msg.peak,
            rms: typeof msg.rms === 'number' ? msg.rms : msg.peak,
        });
        if (this._hist.length > HISTORY_FRAMES)
            this._hist.length = HISTORY_FRAMES;
        this._lastFrameUs = GLib.get_monotonic_time();

        if (!this._visible) {
            this._visible = true;
            this._reposition();
            this._area.set_opacity(255);
            this._area.show();
        }
    }

    // =======================================================================
    //  Animation and drawing
    // =======================================================================
    _tick() {
        if (!this._area)
            return;

        const elapsedMs = this._lastFrameUs
            ? (GLib.get_monotonic_time() - this._lastFrameUs) / 1000
            : Infinity;

        const frames = this._hist.length;
        const centre = (BARS - 1) / 2;
        let loudest = 0;
        for (let i = 0; i < BARS; i++) {
            let target = 0;
            if (frames > 0) {
                const d = Math.abs(i - centre) / centre;          // 0 center .. 1 edge
                const idx = Math.min(frames - 1, Math.floor(d * (frames - 1)));
                const f = this._hist[idx];
                // Mixing peak (envelope) and rms (texture) keeps the shape from
                // looking monotone.
                const mix = i % 2 === 0 ? f.peak : Math.max(f.rms * 1.4, f.peak * 0.5);
                target = Math.min(1, mix) * (1 - EDGE_FALLOFF * d);
            }
            // Fast attack, slow release: lively without flickering.
            this._bars[i] = target > this._bars[i] ? target : this._bars[i] * RELEASE;
            loudest = Math.max(loudest, this._bars[i]);
        }
        this._silent = loudest < SILENT_LEVEL;

        if (this._visible) {
            if (elapsedMs >= FADE_END_MS) {
                this._visible = false;
                this._area.hide();
                this._bars.fill(0);
                this._hist.length = 0;
                this._silent = true;
            } else if (elapsedMs > FADE_START_MS) {
                const t = (elapsedMs - FADE_START_MS) / (FADE_END_MS - FADE_START_MS);
                this._area.set_opacity(Math.round(255 * (1 - Math.min(1, t))));
            } else {
                this._area.set_opacity(255);
            }
        }

        // Skip repaints when there is nothing to show: the machine may also be
        // running heavy local workloads.
        if (this._visible || !this._silent)
            this._area.queue_repaint();
    }

    _draw() {
        const cr = this._area.get_context();
        const [w, h] = this._area.get_surface_size();
        const [r, g, b] = this._accent;

        // pill-shaped background
        cr.setSourceRGBA(0.05, 0.05, 0.07, 0.62);
        roundedRect(cr, 0.5, 0.5, w - 1, h - 1, h / 2);
        cr.fill();

        // subtle border
        cr.setSourceRGBA(1, 1, 1, 0.10);
        cr.setLineWidth(1);
        roundedRect(cr, 0.5, 0.5, w - 1, h - 1, h / 2);
        cr.stroke();

        const padX = 14;
        const padY = 9;
        const usableW = w - padX * 2;
        const maxH = h - padY * 2;

        if (this._silent) {
            // Silence: a clean flat line instead of tiny bars.
            cr.setSourceRGBA(r, g, b, FLAT_LINE_ALPHA);
            roundedRect(cr, padX, (h - FLAT_LINE_H) / 2, usableW, FLAT_LINE_H, FLAT_LINE_H / 2);
            cr.fill();
        } else {
            const colW = usableW / BARS;
            const barW = Math.max(2, colW - BAR_GAP);
            for (let i = 0; i < BARS; i++) {
                const amp = Math.min(1, Math.sqrt(Math.max(0, this._bars[i])));
                const barH = Math.max(2, amp * maxH);
                const x = padX + i * colW + (colW - barW) / 2;
                const y = (h - barH) / 2;
                cr.setSourceRGBA(r, g, b, 0.35 + 0.65 * amp);
                roundedRect(cr, x, y, barW, barH, barW / 2);
                cr.fill();
            }
        }

        // Release the Cairo context wrapper (GJS convention in repaint handlers).
        if (cr.$dispose)
            cr.$dispose();
    }
}
