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
//   2) Icono en la barra superior con el estado, menú para arrancar/parar el
//      daemon, interruptores de configuración de Voxtype y acceso al archivo de
//      configuración.
//
// Datos: lanza `voxtype-audio-bridge`, que expone el socket de audio del daemon
// como NDJSON en stdout (una línea por trama de 10 ms):
//     {"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}
// El bridge ya maneja la reconexión, así que acá solo leemos líneas.
//
// El estado (idle/recording/transcribing) sale del archivo de estado del daemon,
// observado con Gio.FileMonitor (sin polling). Si el archivo todavía no existe
// —el shell carga las extensiones antes de que el daemon lo cree— se reintenta
// cada 2 s, y un chequeo de seguridad cada 5 s cubre cualquier evento perdido.

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
const FADE_START_MS = 400;    // arranca el desvanecido al terminar la grabación
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
const VOXTYPE_RUNTIME = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'voxtype']);
const STATE_FILE = GLib.build_filenamev([VOXTYPE_RUNTIME, 'state']);
const PID_FILE = GLib.build_filenamev([VOXTYPE_RUNTIME, 'pid']);
const CONFIG_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'voxtype', 'config.toml']);
const SAFETY_POLL_SECS = 5;   // red de seguridad por si el monitor pierde un evento
const MONITOR_RETRY_SECS = 2; // reintento hasta que el archivo de estado exista

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

// Busca un ejecutable por rutas absolutas primero (el PATH del shell puede no
// incluir ~/.local/bin) y recién después en el PATH.
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
        this._voxtype = findVoxtype();
        this._accent = this._readAccent();
        this._stateMonitor = null;
        this._stateMonitorId = 0;
        this._monitorRetryId = 0;
        this._safetyId = 0;
        this._updatingSwitches = false;

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
        if (this._monitorRetryId) {
            GLib.source_remove(this._monitorRetryId);
            this._monitorRetryId = 0;
        }
        if (this._safetyId) {
            GLib.source_remove(this._safetyId);
            this._safetyId = 0;
        }
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        this._teardownStateMonitor();
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
        // addTopChrome SIN parámetros a propósito: en GNOME 50 el set de claves
        // válidas cambió (por ejemplo `affectsInputRegion` fue eliminado y tiraba
        // "Unrecognized parameter" al cargar la extensión), así que no pasamos
        // ninguna y quedan los valores por defecto. El panel no captura clics
        // porque el actor es reactive: false.
        Main.layoutManager.addTopChrome(this._area);
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

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Interruptores que escriben la config de Voxtype. El daemon no recarga
        // la config en caliente, así que cada cambio reinicia el servicio.
        this._punctuationItem = new PopupMenu.PopupSwitchMenuItem('Puntuación hablada', false);
        this._punctuationItem.connect('toggled', (item, state) => {
            this._setConfig('text.spoken_punctuation', state);
        });
        this._indicator.menu.addMenuItem(this._punctuationItem);

        this._fillersItem = new PopupMenu.PopupSwitchMenuItem('Quitar muletillas', false);
        this._fillersItem.connect('toggled', (item, state) => {
            this._setConfig('text.filter_filler_words', state);
        });
        this._indicator.menu.addMenuItem(this._fillersItem);

        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._openConfigItem = new PopupMenu.PopupMenuItem('Abrir configuración');
        this._openConfigItem.connect('activate', () => this._openConfig());
        this._indicator.menu.addMenuItem(this._openConfigItem);

        if (!this._unitPath) {
            // Todavía no corrió `voxtype setup systemd`: avisamos en el menú.
            this._toggleItem.label.text = 'Falta el servicio (voxtype setup systemd)';
            this._toggleItem.setSensitive(false);
            this._restartItem.setSensitive(false);
        } else {
            this._refreshService();
        }

        // Los subprocesos (systemctl, voxtype config) se lanzan al ABRIR el menú,
        // no en un temporizador: en reposo no gastamos nada.
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
    //  Estado del daemon (FileMonitor + reintento + red de seguridad)
    // =======================================================================
    _startStateWatch() {
        this._refreshState();
        this._setupStateMonitor();
        // Red de seguridad de bajo coste: un chequeo cada 5 s corrige cualquier
        // evento perdido (por ejemplo si el daemon recrea el archivo de estado)
        // y detecta que el proceso murió aunque el archivo no cambie.
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
        // En el login el shell carga la extensión antes de que el daemon cree el
        // archivo de estado, y monitorear algo que no existe no sirve.
        if (!GLib.file_test(STATE_FILE, GLib.FileTest.EXISTS)) {
            this._scheduleMonitorRetry();
            return;
        }
        try {
            this._stateMonitor = Gio.File.new_for_path(STATE_FILE)
                .monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            logError(e, '[voxtype-wave] no pude monitorear el archivo de estado');
            this._stateMonitor = null;
            this._scheduleMonitorRetry();
            return;
        }
        this._stateMonitorId = this._stateMonitor.connect('changed', (_mon, _file, event) => {
            if (event === Gio.FileMonitorEvent.DELETED || event === Gio.FileMonitorEvent.MOVED_OUT) {
                // El archivo se recreó (o el daemon se reinició): soltamos este
                // monitor y el reintento arma uno nuevo sobre el archivo actual.
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

    // El archivo de estado sobrevive al daemon, así que la fuente de verdad de
    // "está corriendo" es el PID file: si el proceso existe, el daemon vive.
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
    //  Acciones del menú
    // =======================================================================
    _runCommand(argv, callback) {
        let proc;
        try {
            proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, `[voxtype-wave] no pude ejecutar ${argv.join(' ')}`);
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

    // Lee el valor actual de los interruptores desde la config de Voxtype.
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
                this._updatingSwitches = true;
                item.state = out.split('\n')[0].trim() === 'true';
                this._updatingSwitches = false;
            });
        }
    }

    // Escribe una clave con el CLI de Voxtype (preserva comentarios y valida) y
    // reinicia el servicio, porque el daemon no recarga la config en caliente.
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
            logError(e, '[voxtype-wave] no pude abrir la configuración');
        }
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
