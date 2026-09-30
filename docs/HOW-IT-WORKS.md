# Cómo funciona

Explicación técnica del setup de dictado por voz, pensada para quien quiera entenderlo,
depurarlo o modificarlo. Para instalarlo, ver `docs/INSTALL.md`; para problemas, ver
`docs/TROUBLESHOOTING.md`.

---

## Qué es y por qué existe

El daemon `voxtype` ya resuelve la parte difícil: capturar audio, transcribir y entregar el
texto. Lo que no se puede usar en GNOME es su OSD (la onda flotante), porque sus dos frontends
oficiales (`voxtype-osd-gtk4` y `voxtype-osd-quickshell`) dependen del protocolo
`wlr-layer-shell`, que **Mutter no implementa**. No es un problema de dependencias faltantes:
instalar `gtk4-layer-shell` no ayuda, porque el protocolo no lo ofrece el compositor. Está
reportado en el issue #807 del proyecto:
<https://github.com/peteonrails/voxtype/issues/807>.

La solución de este repo es una extensión de GNOME Shell propia que dibuja la onda en la capa
*chrome* del shell mediante `Main.layoutManager.addChrome()`. Esa capa queda por encima de las
ventanas y fuera del listado de ventanas, así que el panel flota sin robar el foco.

El segundo problema que resuelve este setup es el disparador. El listener evdev de Voxtype está
desactivado (`[hotkey] enabled = false`) para no chocar con el hecho de que los mouse gamer
exponen interfaces USB que se hacen pasar por teclado y le "roban" el dispositivo al listener
evdev. En su lugar, el disparador es un atajo personalizado de GNOME que ejecuta
`voxtype record toggle`.

---

## Flujo completo

### Entrega del texto

```
F9 (atajo personalizado de GNOME)
  |
  v
voxtype record toggle  ->  senal al daemon
  |
  v
daemon: captura de audio (ALSA via pipewire-alsa)
  |
  v
Parakeet TDT 0.6B v3 int8 (ONNX Runtime, CPU con AVX-512)
  |
  v
texto transcripto
  |
  v
[output] mode = "clipboard"  ->  wl-copy
  |
  v
post_output_command: sleep 0.2; echo 'key ctrl+shift+v' | dotool
  |
  v
dotool escribe eventos en /dev/uinput
  |
  v
el texto aparece en el cursor de la aplicacion que tiene el foco
```

### Visualización de la onda

```
(se esta grabando)
daemon: bucketiza el audio en ventanas de 10 ms (100 Hz)
  |
  v
tramas binarias de 16 bytes  ->  $XDG_RUNTIME_DIR/voxtype/audio.sock
  |
  v
voxtype-audio-bridge (subproceso lanzado por la extension)
  |
  v
NDJSON por stdout:  {"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}
  |
  v
extension: lee lineas, calcula las barras y redibuja
  |
  v
St.DrawingArea + cairo  ->  capa "chrome" del shell (abajo al centro del monitor)

En paralelo, para el icono de la barra superior:
$XDG_RUNTIME_DIR/voxtype/state  ->  estado (listo / grabando / transcribiendo)
$XDG_RUNTIME_DIR/voxtype/pid    ->  comprobacion de que el daemon sigue vivo
```

---

## Protocolo del socket de audio

El daemon publica las tramas en `$XDG_RUNTIME_DIR/voxtype/audio.sock`. Es un socket Unix con un
broadcast *best-effort*: los suscriptores lentos se desconectan, el daemon nunca se bloquea por
un consumidor. El hub que lo sirve vive mientras vive el daemon y acepta suscriptores entre
grabaciones, pero **solo emite tramas mientras se está grabando**.

La trama mide 16 bytes, en orden nativo de la máquina (x86_64: little endian). El formato está
documentado en el código del daemon (`src/audio/levels.rs`) y es exactamente:

| Offset | Bytes | Tipo | Campo | Descripción |
|---|---|---|---|---|
| 0 | 4 | `u32` | `seq` | contador monotónico de tramas (se reinicia al dar la vuelta) |
| 4 | 4 | `f32` | `min` | valor mínimo de la ventana de 10 ms (rango -1.0 a 1.0) |
| 8 | 4 | `f32` | `max` | valor máximo de la ventana de 10 ms (rango -1.0 a 1.0) |
| 12 | 4 | `f32` | `peak_dbfs` | pico en dBFS; en silencio tiende a -infinito (recortado a -120) |

Frecuencia: 100 Hz (una trama cada 10 ms).

### El bridge y el NDJSON

`voxtype-audio-bridge` conecta a ese socket y lo expone como NDJSON por stdout, una línea por
trama:

```json
{"peak":0.421,"rms":0.180,"vad":1,"ts_ms":1234567}
```

Además emite cambios de conexión en la misma corriente:

```json
{"status":"connected"}
{"status":"disconnected"}
```

El bridge maneja la reconexión por su cuenta. Los campos que usa la extensión son `peak`
(nivel de pico, 0 a 1) y `rms` (nivel RMS aproximado); `vad` y `ts_ms` están disponibles para
quien quiera otros comportamientos.

---

## Rutas importantes

| Ruta | Qué es |
|---|---|
| `~/.local/bin/voxtype` | daemon (binario standalone) |
| `~/.local/bin/voxtype-audio-bridge` | puente socket a NDJSON |
| `~/.config/voxtype/config.toml` | configuración del daemon y del hook de salida |
| `~/.local/share/voxtype/models/parakeet-tdt-0.6b-v3-int8/` | modelo (670 MB en disco) |
| `~/.config/systemd/user/voxtype.service` | unidad de usuario (`PartOf=graphical-session.target`, `Environment=XDG_RUNTIME_DIR=%t`) |
| `~/.config/systemd/user/voxtype.service.d/wayland.conf` | drop-in opcional para `WAYLAND_DISPLAY` |
| `~/.local/share/gnome-shell/extensions/voxtype-wave@cmj_pc/` | extensión: `extension.js`, `metadata.json`, `stylesheet.css` |
| `$XDG_RUNTIME_DIR/voxtype/state` | estado del daemon (`idle` / `recording` / `transcribing`) |
| `$XDG_RUNTIME_DIR/voxtype/pid` | PID del daemon |
| `$XDG_RUNTIME_DIR/voxtype/audio.sock` | socket de tramas de audio |
| `/dev/uinput` | lo usa `dotool` para inyectar el acorde de pegado |

---

## Decisiones de diseño y su motivo

### Por qué una extensión de GNOME y no el OSD oficial

Porque el OSD oficial necesita `wlr-layer-shell` y Mutter no lo implementa (ver la introducción).
La extensión usa la capa *chrome* del shell, que sí existe en GNOME y es la misma que usan el
panel y demás elementos del escritorio.

### Por qué el disparador es un atajo de GNOME y el listener evdev está apagado

El listener evdev de Voxtype elige un dispositivo de `/dev/input` para escuchar la tecla. Los
mouse gamer exponen una interfaz USB que se hace pasar por teclado, y el daemon termina
escuchando esa interfaz en lugar del teclado real, con lo cual la tecla física nunca llega. Con
`[hotkey] enabled = false` el daemon no abre ningún dispositivo de entrada y el disparo lo hace
un atajo personalizado de GNOME que ejecuta `voxtype record toggle` (una pulsación empieza a
grabar, otra termina).

### Por qué la salida es modo clipboard y no modo type

Con un layout de teclado `us`, `dotool` no puede escribir acentos:

```
dotool: WARNING: impossible character for layout: ñ
```

El modo `type` traduce texto a eventos de teclado según el layout activo, así que el español con
acentos saldría incompleto o con caracteres equivocados. El modo `clipboard` copia el texto
Unicode exacto al portapapeles, y el hook se encarga de pegarlo. Además, el pegado es atómico:
no depende de la velocidad con que la aplicación procese los eventos de teclado.

En este setup `restore_clipboard = false` a propósito: así el texto queda disponible en el
portapapeles después de dictar (útil si el pegado falla en alguna aplicación; se pega a mano una
vez).

### Por qué el hook usa `dotool` con tubería

Dos motivos, los dos verificados contra el binario:

1. El modo `paste` de Voxtype **no acepta `dotool`** para mandar el acorde. Internamente solo
   prueba `wtype`, `eitype` o `ydotool`; los strings del binario lo dicen:
   `No keystroke tool available (tried wtype, eitype, ydotool)`. En GNOME, `wtype` no funciona
   porque Mutter tampoco implementa `zwp_virtual_keyboard_v1`, así que el modo `paste` no tiene
   por dónde mandar el acorde.
2. `dotool` lee sus comandos por **stdin**, no por argumentos. Un hook escrito como
   `dotool key ctrl+shift+v` falla con
   `dotool: there should be no arguments, commands are read from stdin`. La forma correcta es
   `echo 'key ctrl+shift+v' | dotool`.

`dotool` es apropiado para esto aunque no pueda escribir acentos: el acorde `ctrl+shift+v` no
depende del layout del teclado.

### Por qué la extensión lee por el bridge y no del socket directamente

Porque el socket entrega tramas binarias de 16 bytes en orden nativo, y un cliente tendría que
resolver por su cuenta el *framing* (lecturas parciales), la conversión de tipos y la
reconexión. El bridge ya hace todo eso y expone líneas de texto: la extensión solo parsea NDJSON
y se ocupa de dibujar. Eso mantiene el código de la extensión chico, que es importante porque
corre dentro del proceso del shell.

### Por qué el panel no roba el foco

Porque el pegado automático depende de que el foco siga en la aplicación donde estás dictando.
El panel se agrega con `Main.layoutManager.addChrome()` a la capa *chrome* del shell (encima de
las ventanas, fuera del listado de ventanas) y el actor es no reactivo, así que no captura clics
ni foco. Además, el panel no aparece en la lista de ventanas ni en el Alt+Tab.

### Por qué el icono de estado usa el PID y no el archivo de estado

Porque el archivo de estado `$XDG_RUNTIME_DIR/voxtype/state` **sobrevive** al daemon: si el
daemon se detiene, el archivo queda con el último valor. Para saber si el daemon está vivo, la
extensión lee el PID file `$XDG_RUNTIME_DIR/voxtype/pid` y comprueba que exista `/proc/<pid>`.
Solo si el proceso existe interpreta el contenido del archivo de estado.

---

## Ciclo de vida de la memoria

El motor corre en CPU (AVX-512) y **no usa GPU ni VRAM**, así que no compite con otras cargas de
GPU de la máquina.

Con `[parakeet] on_demand_loading = true`:

| Momento | Memoria |
|---|---|
| En reposo (daemon sin grabar) | ~6 MB (pico medido: 9,3 MB) |
| Al empezar a grabar | se carga el modelo: ~1,5 s de espera |
| Transcribiendo | modelo int8 en memoria (670 MB en disco) |
| Al terminar | el modelo se libera |

La transcripción en sí tarda alrededor de 0,1 s por frase. El efecto práctico es que la RAM sube
durante el dictado y vuelve después; para comprobarlo, `free -h` antes y después.

Si preferís menos latencia a cambio de RAM permanente, `on_demand_loading = false` deja el
modelo cargado de forma continua.

---

## Constantes de la extensión

Están todas al principio de `extension.js`. Se cambian editando el archivo y volviendo a cargar
la extensión (cerrando sesión, o probando con la shell anidada; ver
`docs/TROUBLESHOOTING.md`).

| Constante | Valor por defecto | Qué hace | Valores sugeridos |
|---|---|---|---|
| `HISTORY_FRAMES` | `6` | cuántos frames de 10 ms se reflejan desde el centro hacia los bordes | `1` = instantáneo puro; `6` = 60 ms de textura; `16` = 160 ms, más movimiento |
| `EDGE_FALLOFF` | `0.55` | cuánto baja la amplitud hacia los bordes del panel | `0` = todas las barras iguales (tipo medidor); `0.8` = pico concentrado en el centro |
| `RELEASE` | `0.72` | cuánto cae cada barra por tick cuando el audio baja | cercano a `1` = se apaga más lento; `0.6` = más seco |
| `SILENT_LEVEL` | `0.02` | por debajo de este nivel se dibuja la línea plana de reposo | subir si el ruido de fondo hace temblar la línea |
| `FLAT_LINE_H` | `3` | alto de la línea plana, en píxeles | `2` a `5` |
| `FLAT_LINE_ALPHA` | `0.35` | opacidad de la línea plana | `0.2` a `0.5` |
| `PANEL_W` | `340` | ancho del panel, en píxeles lógicos | según el monitor |
| `PANEL_H` | `64` | alto del panel, en píxeles lógicos | `48` a `96` |
| `BARS` | `48` | cantidad de barras de la onda | más barras = más fino el detalle |
| `BOTTOM_MARGIN` | `96` | distancia del panel al borde inferior de la pantalla | `40` a `160` |
| `TICK_MS` | `33` | cada cuánto se redibuja (33 ms = ~30 fps) | no bajar mucho: el panel no gasta repintados cuando está en reposo, pero el shell es un solo proceso |

El color de la onda y del icono sale de `org.gnome.desktop.interface accent-color`, con respaldo
azul si el esquema no existe.

---

## Notas de mantenimiento

- **`shell-version` en `metadata.json`.** GNOME compara solo el número mayor (el shell 51.x
  contra la entrada `"51"`). Si no coincide, la extensión queda en `OUT_OF_DATE` y no carga: se
  arregla agregando el número a la lista.
- **APIs internas del shell.** La extensión usa `Main.layoutManager`, `Main.panel`, `PanelMenu`,
  `PopupMenu` y `St`. Son las más estables, pero no hay garantía de compatibilidad entre
  versiones mayores: ya ocurrió con `affectsInputRegion`, eliminado en GNOME 50. Cuando pasa, la
  extensión queda en estado `ERROR` (no rompe la sesión) y la traza del journal dice archivo y
  línea.
- **Los binarios de Voxtype no se actualizan con `dnf`**, porque son standalone en
  `~/.local/bin`. Se actualizan con `./update-voxtype.sh` o bajando el release nuevo a mano y
  verificando `SHA256SUMS.txt`.
- **Nada depende de internet** para funcionar: el modelo está en disco y la transcripción es
  local. Dejar el setup sin actualizar no lo rompe.
