# voxtype-wave

## Quick start (English)

Push-to-talk dictation for **GNOME Shell on Wayland**, with a floating audio-waveform
OSD, built on [Voxtype](https://github.com/peteonrails/voxtype). Press F9, speak, press
F9 again: the text is pasted at the cursor, and a waveform panel appears at the bottom
of the screen while you talk.

Requirements: GNOME Shell 50 on Wayland (tested on Fedora 44 / GNOME 50.5), `pipewire-alsa`,
`wl-clipboard`, `dotool`, `curl`, and ~700 MB of disk for the model.

```bash
git clone https://github.com/Charly9926/voxtype-wave.git
cd voxtype-wave
./install.sh
```

Log out and back in when the script asks. Spanish docs below.

---

## Qué es y qué problema resuelve

Es un setup completo de dictado por voz para **GNOME Shell en Wayland**: apretás una tecla,
hablás, y el texto aparece solo en el cursor. Todo el reconocimiento de voz corre local en
tu máquina, sin internet y sin GPU.

El motor es [Voxtype](https://github.com/peteonrails/voxtype) (MIT, de Peter Jackson), un
daemon de dictado push-to-talk que ya trae su propio OSD con onda de audio. El problema es
que **ese OSD no funciona en GNOME**: sus dos frontends (`voxtype-osd-gtk4` y
`voxtype-osd-quickshell`) necesitan el protocolo `wlr-layer-shell`, que Mutter no
implementa. Está reportado upstream en el issue
[#807](https://github.com/peteonrails/voxtype/issues/807), y fue reproducido exactamente en
Fedora 44 + GNOME 50.5 + voxtype 1.1.0. Instalar `gtk4-layer-shell` no ayuda: lo que falta
es el protocolo en el compositor, no la librería.

Este repo resuelve eso con una **extensión de GNOME Shell** propia que dibuja el panel en la
capa *chrome* del shell, con las mismas tramas de audio que emite el daemon. Al dibujar ahí:

- queda por encima de las ventanas y no aparece en el listado de ventanas;
- **no roba el foco**, que es lo crítico: el texto se pega en el cursor, así que el foco
  tiene que seguir donde estabas escribiendo.

Si usás **Hyprland, Sway o KDE, este repo no te hace falta**: ahí el OSD de Voxtype funciona
tal cual (Omarchy ya lo trae integrado con Quickshell).

## Cómo se ve en uso

1. Apretás **F9**. Suena un pitido, aparece el panel con la onda abajo al centro de la
   pantalla y el icono de la barra superior se pone rojo.
2. Hablás. Mientras callás el panel queda **plano** (una línea fina); cuando hablás, la onda
   crece desde el centro y se apaga al callar.
3. Apretás **F9** de nuevo. El icono pasa a ámbar mientras transcribe, y el texto se pega en
   el cursor donde estuvieras escribiendo. El panel se desvanece solo.

El **icono de la barra superior** muestra el estado: listo, grabando o transcribiendo. Con
clic izquierdo se abre un menú con el estado actual y las opciones de **iniciar, detener y
reiniciar el daemon**, así no hace falta abrir una terminal para administrarlo.

## Requisitos

- **GNOME Shell 50 en Wayland** (probado en Fedora 44 con GNOME 50.5; el `metadata.json`
  declara también 51 y 52; la extensión usa APIs internas del shell).
- Sesión de systemd de usuario (lo estándar en GNOME).
- `pipewire-alsa` (el daemon captura audio por ALSA sobre PipeWire).
- `wl-clipboard` (el texto se entrega por portapapeles).
- `dotool` (manda el acorde de pegado).
- `curl` (descargas).
- ~700 MB de disco para el modelo.

En algunos sistemas, además, tu usuario tiene que pertenecer al grupo `input` para que
`dotool` pueda escribir en `/dev/uinput` y reiniciar sesión. El instalador lo verifica solo.

## Instalación rápida


```bash
git clone https://github.com/Charly9926/voxtype-wave.git
cd voxtype-wave
./install.sh
```

Los mensajes del script están en inglés; esta documentación está en español. Opciones:

| Opción | Qué hace |
|---|---|
| `--no-model` | No descarga el modelo (670 MB); lo bajás después a mano |
| `--hotkey '<Super><Shift>v'` | Usa otra tecla en vez de F9 |
| `--no-service` | No instala ni habilita el servicio systemd |
| `--yes` | Responde que sí a todo (no interactivo) |
| `--help` | Muestra la ayuda |

Al terminar, el script pide **cerrar sesión y volver a entrar**: es para que GNOME cargue la
extensión nueva y, si hizo falta, para que tome efecto el grupo `input`. Deja la extensión ya
habilitada para el siguiente login.

## Instalación manual (resumen)

Si preferís hacerlo a mano, o querés entender qué toca cada pieza. El detalle fino, con la
verificación de cada paso, está en [docs/INSTALL.md](docs/INSTALL.md).

1. **Requisitos y `dotool`.** Comprobá GNOME/Wayland, `pipewire-alsa` y `wl-clipboard`, e
   instalá `dotool` (Fedora: COPR `smallcms/dotool`; Arch: `pacman -S dotool`; Debian/Ubuntu:
   compilar desde <https://git.sr.ht/~geb/dotool>).
2. **Acceso a `/dev/uinput`.** Verificá con `[ -w /dev/uinput ]`. Si falta, agregá tu usuario
   al grupo `input` y reiniciá sesión.
3. **Binarios de Voxtype.** Bajá del release v1.1.0 el binario del daemon (variante según tu
   CPU) y el bridge de audio, verificá el `SHA256SUMS.txt` publicado y copialos a
   `~/.local/bin/`.
4. **Modelo.** `voxtype setup --download --model parakeet-tdt-0.6b-v3-int8` (~670 MB).
5. **Config.** Copiá `config/voxtype-config.toml` a `~/.config/voxtype/config.toml` y validala.
6. **Servicio.** `voxtype setup systemd` y `systemctl --user enable --now voxtype`.
7. **Extensión y atajo.** Copiá los 3 archivos de `extension/` a
   `~/.local/share/gnome-shell/extensions/voxtype-wave@cmj_pc/` y creá el atajo de GNOME que
   llama a `~/.local/bin/voxtype record toggle`. Después: cerrar sesión, volver a entrar y
   habilitar la extensión.

## Uso

- **F9** empieza a grabar. **F9** otra vez termina y pega el texto en el cursor.
- La **onda** aparece abajo al centro del monitor donde tengas el puntero. En silencio queda
  plana; con voz, se mueve.
- El **icono de la barra** muestra listo / grabando / transcribiendo, y su menú permite
  iniciar, detener y reiniciar el daemon.

El atajo es un atajo personalizado de GNOME, no un atajo del compositor: funciona en
cualquier aplicación y en cualquier monitor.

## Consumo de memoria y rendimiento

Números medidos en la máquina del autor, no estimados:

| Momento | Memoria |
|---|---|
| Daemon en reposo | **~6 MB** |
| Modelo int8 en disco | **670 MB** |
| Durante el dictado | el modelo cargado (~1,5 s para cargar, se libera al terminar) |

- Transcripción de una frase: **~0,1 s**.
- **No usa GPU ni VRAM**: la inferencia corre en CPU con AVX-512.
- El modelo se carga al apretar F9 y se libera al terminar de transcribir
  (`on_demand_loading`), así que en reposo el consumo es el del daemon solo.

Esto es lo que hace que conviva bien con cargas de trabajo locales pesadas (por ejemplo,
entrenar o correr modelos en la misma máquina): no ocupa VRAM y no retiene el modelo en
memoria entre dictados.

## Personalización

**La tecla.** Es un atajo personalizado de GNOME, así que se cambia desde la interfaz
(Configuración → Teclado → Ver y personalizar atajos → Atajos personalizados) o pasando
`--hotkey` al instalador. El comando asociado es:

```
~/.local/bin/voxtype record toggle
```

**El panel de la onda.** Las constantes están al principio de `extension.js`:

| Constante | Qué controla |
|---|---|
| `HISTORY_FRAMES` | Cuántos frames de 10 ms se reflejan desde el centro. `1` = instantáneo puro, `6` = 60 ms (por defecto, algo de textura), `16` = 160 ms (más movimiento) |
| `EDGE_FALLOFF` | Cuánto baja la amplitud hacia los bordes. `0` = todas las barras iguales, `0.8` = pico concentrado en el centro |
| `RELEASE` | Velocidad de caída cuando el audio baja. Más cerca de `1` = más lento |
| `SILENT_LEVEL` | Umbral por debajo del cual se dibuja la línea plana de reposo |
| `PANEL_W`, `PANEL_H` | Tamaño del panel |
| `BARS` | Cantidad de barras |
| `BOTTOM_MARGIN` | Distancia al borde inferior de la pantalla |

El color de la onda y del icono sale del color de acento de tu tema de GNOME
(`org.gnome.desktop.interface accent-color`).

## Actualizar

Los binarios de Voxtype son *standalone* en `~/.local/bin`, así que **no se actualizan con
`dnf`**. Para bajarlos de nuevo desde el último release, con verificación de integridad:

```bash
./update-voxtype.sh
```

## Desinstalar

```bash
./uninstall.sh
```

Quita la extensión, el atajo de GNOME y el servicio. Con `--purge` además borra los
binarios, la configuración y los modelos:

```bash
./uninstall.sh --purge
```

## Limitaciones y notas honestas

- **Solo GNOME Shell en Wayland.** En Hyprland, Sway o KDE no uses este repo: el OSD de
  Voxtype funciona nativamente ahí.
- **El grupo `input`.** En sistemas sin ACL de `uaccess` sobre `/dev/uinput`, `dotool`
  necesita que tu usuario esté en el grupo `input` (junto con la regla udev que trae su
  paquete) y un reinicio de sesión. Tené en cuenta el costo: ese grupo **permite leer todo el
  teclado**, no solo la tecla de dictado.
- **Los binarios no se actualizan con `dnf`** porque no vienen de un repositorio de la
  distribución. Usá `./update-voxtype.sh`. La contracara es que tampoco se rompen solos con
  una actualización del sistema.
- **Ocupa ~700 MB de disco** por el modelo.
- **La extensión usa APIs internas del shell**, que GNOME no garantiza entre versiones
  mayores. Está **probada en GNOME 50** (Fedora 44 / GNOME 50.5) y el `metadata.json` declara
  también 51 y 52 para que un salto de versión no la bloquee de entrada; si alguna API
  cambia, la extensión queda en estado ERROR (sin romper la sesión) y suele ser cuestión de
  ajustar una línea (ver [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)).
- **El uuid de la extensión es `voxtype-wave@cmj_pc`**. Si lo renombrás, tenés que cambiar
  también la carpeta de instalación y el campo `uuid` de `metadata.json`, porque GNOME exige
  que coincidan.

## Estructura del repo

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
docs/INSTALL.md
docs/TROUBLESHOOTING.md
docs/HOW-IT-WORKS.md
```

La plantilla `config/voxtype-config.toml` se instala en `~/.config/voxtype/config.toml` y es
la que define el comportamiento: motor `parakeet` con el modelo int8 y carga bajo demanda, el
hotkey interno de Voxtype desactivado (el atajo lo maneja GNOME), salida por portapapeles con
pegado automático vía `dotool`, OSD propio desactivado (lo reemplaza la extensión),
notificaciones de escritorio apagadas, pitidos activados y detección de voz con el backend
`energy`.

## Créditos y licencias

- **[Voxtype](https://github.com/peteonrails/voxtype)** — Peter Jackson, licencia MIT. Es el
  daemon que hace la captura de audio, la transcripción y la inserción de texto.
- **dotool** — geb, licencia GPL3. <https://git.sr.ht/~geb/dotool>
- **Modelo NVIDIA Parakeet TDT 0.6B v3** — NVIDIA, licencia CC-BY-4.0. Multilingüe con
  autodetección de idioma (25 idiomas europeos, incluye español).
- **Inspiración** — Omarchy, que integra Voxtype con su OSD de Quickshell en Hyprland.
- **Autor de este repo** — cmj_pc. Licencia: MIT (ver `LICENSE`).

Este repositorio **no redistribuye** los binarios de Voxtype, el modelo ni `dotool`: el
instalador los descarga desde sus fuentes originales y quedan sujetos a sus propias
licencias (MIT, GPL3 y CC-BY-4.0 respectivamente).
