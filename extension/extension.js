// voxtype-wave — OSD de onda de audio + indicador de estado para Voxtype (GNOME Shell).
//
// Por qué una extensión y no el OSD de Voxtype: sus dos frontends
// (voxtype-osd-gtk4 y voxtype-osd-quickshell) necesitan el protocolo
// wlr-layer-shell, que Mutter NO implementa (issue upstream #807, reportado
// justamente en Fedora 44 / GNOME 50.5 / voxtype 1.1.0). Una extensión dibuja
// en la capa "chrome" del shell: queda por encima de las ventanas, no aparece
// en el listado de ventanas y no roba el foco (clave: el pegado automático del
// texto depende de que el foco siga donde estabas dictando).
//
// Este archivo hace dos cosas:
//   1) Panel flotante con la onda de audio mientras se graba (abajo al centro).
//   2) Icono en la barra superior con el estado y menú para arrancar/parar el
//      daemon, así no hace falta abrir una terminal para administrarlo.
//
// Datos: lanza `voxtype-audio-bridge`, que expone el socket de audio del daemon
// como NDJSON en stdout (una línea por trama de 10 ms):
//     {"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}
//     {"status":"connected"}
// El bridge ya maneja la reconexión, así que acá solo leemos líneas.
// El estado (idle/recording/transcribing) sale del archivo de estado del daemon.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

// --- panel de la onda -------------------------------------------------------
const PANEL_W = 340;          // ancho en píxeles lógicos
const PANEL_H = 64;           // alto
const BARS = 48;              // cantidad de barras de la onda
const BAR_GAP = 2;            // separación entre barras
const BOTTOM_MARGIN = 96;     // distancia al borde inferior de la pantalla
const TICK_MS = 33;           // ~30 fps de redibujado
const FADE_START_MS = 400;    // arranca el desvanecido
const FADE_END_MS = 850;      // a esta altura ya está invisible (se oculta)
const BRIDGE_RETRY_SECS = 3;  // si el bridge muere, reintentar

// --- visualización: onda "actual", simétrica y sin scroll lateral -----------
const HISTORY_FRAMES = 6;     // frames de 10 ms reflejados desde el centro. 1 = instantáneo puro,
                              // 6 = 60 ms (un poco de textura), 16 = 160 ms (más movimiento)
const EDGE_FALLOFF = 0.55;    // cuánto baja la amplitud hacia los bordes (0 = todo igual)
const RELEASE = 0.72;         // caída por tick cuando el audio baja (1 = no baja nunca)
const SILENT_LEVEL = 0.02;    // por debajo de esto se dibuja la línea plana (reposo)
const FLAT_LINE_H = 3;        // alto de la línea plana
const FLAT_LINE_ALPHA = 0.35; // opacidad de la línea plana

// --- indicador de la barra superior ----------------------------------------
const STATE_FILE = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'voxtype', 'state']);
const STATE_POLL_MS = 250;

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
    idle: 'listo — F9 para dictar',
    recording: 'grabando…',
    transcribing: 'transcribiendo…',
    stopped: 'daemon detenido',
};

// Colores de acento de GNOME (org.gnome.desktop.interface accent-color).
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

function findBridge() {
    const candidates = [
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'voxtype-audio-bridge']),
        GLib.build_filenamev([GLib.get_user_data_dir(), 'voxtype', 'voxtype-audio-bridge']),
        '/usr/local/bin/voxtype-audio-bridge',
        '/usr/lib/voxtype/voxtype-audio-bridge',
    ];
    for (const path of candidates) {
        if (GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE))
            return path;
    }
    return GLib.find_program_in_path('voxtype-audio-bridge');
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

// Lectura de un archivo ASCII chico sin depender de TextDecoder.
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
        // --- estado interno ---
        this._bars = new Array(BARS).fill(0);
        this._hist = [];
        this._silent = true;
        this._lastFrameUs = 0;
        this._bridge = null;
        this._stdout = null;
        this._retryId = 0;
        this._visible = false;
        this._state = null;
        this._serviceActive = null;
        this._unitPath = findVoxtypeUnit();
        this._accent = this._readAccent();

        this._buildWavePanel();
        this._buildIndicator();

        this._startStateWatch();
        this._spawnBridge();
    }

    disable() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        if (this._retryId) {
            GLib.source_remove(this._retryId);
            this._retryId = 0;
        }
        if (this._stateTimerId) {
            GLib.source_remove(this._stateTimerId);
            this._stateTimerId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        this._stopBridge();
        if (this._area) {
            this._area.destroy();
            this._area = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._bars = null;
        this._hist = null;
    }

    // =======================================================================
    //  Panel flotante con la onda
    // =======================================================================
    _buildWavePanel() {
        this._area = new St.DrawingArea({reactive: false, can_focus: false});
        this._area.set_size(PANEL_W, PANEL_H);
        this._area.connect('repaint', () => this._draw());
        // Parámetros válidos de addChrome en GNOME 50: SOLO `trackFullscreen` y
        // `affectsStruts` (defaultParams en js/ui/layout.js). `affectsInputRegion`
        // existía en versiones viejas y ahora tira "Unrecognized parameter" al
        // cargar la extensión (verificado con la traza de la shell).
        // trackFullscreen: false => no se oculta cuando hay una ventana a pantalla
        // completa (útil si dictás dentro de un juego o video).
        // El panel no captura clics porque el actor es reactive: false.
        Main.layoutManager.addChrome(this._area, {
            affectsStruts: false,
            trackFullscreen: false,
        });
        this._area.hide();

        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._reposition());

        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
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
            // GNOME sin 'accent-color' (<= 46)
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
    //  Indicador de la barra superior
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

        this._toggleItem = new PopupMenu.PopupMenuItem('Iniciar daemon');
        this._toggleItem.connect('activate', () => this._toggleDaemon());
        this._indicator.menu.addMenuItem(this._toggleItem);

        this._restartItem = new PopupMenu.PopupMenuItem('Reiniciar daemon');
        this._restartItem.connect('activate', () => this._restartDaemon());
        this._indicator.menu.addMenuItem(this._restartItem);

        if (!this._unitPath) {
            // Todavía no corrió `voxtype setup systemd`: avisamos en el menú.
            this._toggleItem.label.text = 'Falta el servicio (voxtype setup systemd)';
            this._toggleItem.setSensitive(false);
            this._restartItem.setSensitive(false);
        } else {
            this._refreshService();
        }

        Main.panel.addToStatusArea('voxtype-wave', this._indicator);
    }

    _startStateWatch() {
        this._stateTicks = 0;
        this._refreshState();
        this._stateTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STATE_POLL_MS, () => {
            this._refreshState();
            // Cada ~2 s refrescamos también el estado del servicio (para el menú).
            this._stateTicks = (this._stateTicks + 1) % 8;
            if (this._stateTicks === 0 && this._unitPath)
                this._refreshService();
            return GLib.SOURCE_CONTINUE;
        });
    }

    // El archivo de estado sobrevive al daemon, así que la fuente de verdad de
    // "está corriendo" es el PID file: si el proceso existe, el daemon vive.
    _daemonRunning() {
        const raw = readAscii(GLib.build_filenamev([GLib.get_user_runtime_dir(), 'voxtype', 'pid']));
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

    _runSystemctl(args, callback) {
        let proc;
        try {
            proc = Gio.Subprocess.new(['systemctl', '--user', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, '[voxtype-wave] no pude ejecutar systemctl');
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

    _refreshService() {
        this._runSystemctl(['is-active', 'voxtype'], out => {
            this._serviceActive = out === 'active';
            if (this._toggleItem)
                this._toggleItem.label.text = this._serviceActive ? 'Detener daemon' : 'Iniciar daemon';
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

    // =======================================================================
    //  Puente de audio
    // =======================================================================
    _spawnBridge() {
        if (!this._area)
            return;
        const path = findBridge();
        if (!path) {
            log('[voxtype-wave] no encontré voxtype-audio-bridge en el PATH ni en ~/.local/bin');
            return;
        }
        try {
            this._bridge = Gio.Subprocess.new([path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, '[voxtype-wave] no pude lanzar voxtype-audio-bridge');
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
                // ya había terminado
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
                // El bridge terminó: lo relanzamos por si el daemon se reinició.
                this._stopBridge();
                if (!this._retryId) {
                    this._retryId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT,
                        BRIDGE_RETRY_SECS, () => {
                            this._retryId = 0;
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
        // Guardamos los frames recientes (10 ms cada uno). La onda se dibuja
        // reflejada desde el centro, así que "lo más nuevo" está en el medio.
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
    //  Animación y dibujo
    // =======================================================================
    _tick() {
        if (!this._area)
            return;

        const elapsedMs = this._lastFrameUs
            ? (GLib.get_monotonic_time() - this._lastFrameUs) / 1000
            : Infinity;

        // Onda "actual" sin scroll: cada barra toma un frame reciente según su
        // distancia al centro (reflejado), así el centro es lo más nuevo y la
        // forma se apaga hacia los bordes en vez de correrse hacia un lado.
        const frames = this._hist.length;
        const centre = (BARS - 1) / 2;
        let loudest = 0;
        for (let i = 0; i < BARS; i++) {
            let target = 0;
            if (frames > 0) {
                const d = Math.abs(i - centre) / centre;          // 0 centro .. 1 borde
                const idx = Math.min(frames - 1, Math.floor(d * (frames - 1)));
                const f = this._hist[idx];
                // Mezcla peak (envolvente) con rms (textura) para que no sea monótono.
                const mix = i % 2 === 0 ? f.peak : Math.max(f.rms * 1.4, f.peak * 0.5);
                target = Math.min(1, mix) * (1 - EDGE_FALLOFF * d);
            }
            // Ataque rápido, liberación lenta: se siente vivo pero no vibra.
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

        // No gastamos repintados cuando no hay nada que mostrar (importa: la
        // máquina también corre IA local).
        if (this._visible || !this._silent)
            this._area.queue_repaint();
    }

    _draw() {
        const cr = this._area.get_context();
        const [w, h] = this._area.get_surface_size();
        const [r, g, b] = this._accent;

        // fondo tipo píldora
        cr.setSourceRGBA(0.05, 0.05, 0.07, 0.62);
        roundedRect(cr, 0.5, 0.5, w - 1, h - 1, h / 2);
        cr.fill();

        // borde sutil
        cr.setSourceRGBA(1, 1, 1, 0.10);
        cr.setLineWidth(1);
        roundedRect(cr, 0.5, 0.5, w - 1, h - 1, h / 2);
        cr.stroke();

        // barras / línea plana
        const padX = 14;
        const padY = 9;
        const usableW = w - padX * 2;
        const maxH = h - padY * 2;

        if (this._silent) {
            // Sin voz: una línea plana y limpia (nada de barras ni scroll).
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

        if (cr.$dispose)
            cr.$dispose();
    }
}
