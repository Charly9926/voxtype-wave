# Instalación paso a paso

Hay dos caminos. El **A** es el instalador automático: hace todo lo que describe el camino
B, con las verificaciones incluidas. El **B** es el mismo procedimiento a mano, explicando
por qué cada paso y cómo comprobarlo; es el que conviene seguir si querés entender qué toca
cada pieza, o si el instalador falló en algo puntual.

En ambos casos, al final hay que **cerrar sesión y volver a entrar**.

---

## Camino A — instalador automático

```bash
git clone https://github.com/Charly9926/voxtype-wave.git
cd voxtype-wave
./install.sh
```


| Opción | Qué hace |
|---|---|
| `--no-model` | No descarga el modelo (670 MB); queda para hacerlo después a mano |
| `--hotkey '<Super><Shift>v'` | Usa otra tecla en vez de F9 |
| `--no-service` | No instala ni habilita el servicio systemd |
| `--yes` | Responde que sí a todo (no interactivo) |
| `--help` | Muestra la ayuda |

El script instala y verifica: `dotool`, el acceso a `/dev/uinput`, los binarios de Voxtype y
el bridge, el modelo, la configuración, el servicio de usuario y la extensión con su atajo.
Para el atajo usa `scripts/gnome-settings.py`, que **agrega** una entrada nueva sin pisar los
atajos personalizados que ya tengas.

Al terminar te va a pedir cerrar sesión. Después del login, la extensión queda habilitada y
podés probar F9.

---

## Camino B — paso a paso manual

Los pasos que usan rutas relativas al repositorio (`config/`, `extension/`, `scripts/`) se
ejecutan desde la carpeta donde lo clonaste. En los ejemplos esa carpeta se llama `$REPO`:
definila una vez y ajustala si lo clonaste en otro lado.

```bash
REPO="$HOME/voxtype-wave"
cd "$REPO"
```

### Paso 1 — Requisitos previos

Necesitás **GNOME Shell 50 en Wayland** (probado en Fedora 44 con GNOME 50.5; el
`metadata.json` de la extensión declara también 51 y 52), sesión de systemd de usuario,
`pipewire-alsa` (el daemon captura audio por ALSA sobre PipeWire), `wl-clipboard` y `curl`.

Comprobalo así:

```bash
# versión de GNOME y sesión
gnome-shell --version
echo "$XDG_SESSION_TYPE"          # tiene que decir: wayland

# paquetes (Fedora)
rpm -q pipewire-alsa wl-clipboard curl
```

Si falta alguno:

```bash
sudo dnf install pipewire-alsa wl-clipboard curl
```

`pipewire-alsa` es importante: sin él, el daemon no encuentra el dispositivo de audio y vas a
ver errores de "device not available".

### Paso 2 — Instalar dotool

`dotool` es el que manda el acorde de pegado (Ctrl+Shift+V) al portapapeles del sistema. Sin
él, el texto se transcribe y queda en el portapapeles, pero no aparece solo en el cursor.

**Fedora** (está en un COPR de terceros, es un paquete hoja):

```bash
sudo dnf copr enable smallcms/dotool
sudo dnf install dotool
```

**Arch:**

```bash
sudo pacman -S dotool
```

**Debian / Ubuntu** (no está empaquetado; se compila):

```bash
sudo apt install libxkbcommon-dev
git clone https://git.sr.ht/~geb/dotool
cd dotool && ./build.sh && sudo install -Dm755 dotool /usr/local/bin/dotool
```

Verificación:

```bash
command -v dotool
```

Tiene que imprimir la ruta del binario. Si no imprime nada, no quedó en el `PATH`.

### Paso 3 — Verificar el acceso a `/dev/uinput`

`dotool` escribe eventos de teclado a través de `/dev/uinput`. En muchos sistemas tu usuario
ya tiene permiso por una ACL de `uaccess`; en otros hace falta pertenecer al grupo `input`.

```bash
[ -w /dev/uinput ] && echo OK || echo FALTA
```

Si dice `FALTA`:

```bash
sudo usermod -aG input "$USER"
```

y **cerrá sesión y volvé a entrar** (no alcanza con `newgrp`, porque el daemon se inicia con
la sesión). Después del login, comprobá que el grupo esté activo:

```bash
id | tr ',' '\n' | grep input
```

Nota de seguridad: el grupo `input` permite leer **todo** el teclado, no solo la tecla de
dictado. Es el mismo requisito que tienen otras herramientas de este tipo.

### Paso 4 — Descargar los binarios de Voxtype y el bridge

Voxtype se distribuye con binarios standalone por release. Hay que bajar dos: el daemon (en la
variante que corresponda a tu CPU) y el bridge de audio, que convierte el socket de audio del
daemon en NDJSON para que lo lea la extensión.

Las variantes publicadas en el release v1.1.0 son:

| Arquitectura | Variante | Archivo |
|---|---|---|
| x86_64 con AVX-512 | `onnx-avx512` | `voxtype-1.1.0-linux-x86_64-onnx-avx512` |
| x86_64 sin AVX-512 | `onnx-avx2` | `voxtype-1.1.0-linux-x86_64-onnx-avx2` |
| aarch64 | `onnx` | `voxtype-1.1.0-linux-aarch64-onnx` |

El bridge se llama `voxtype-1.1.0-linux-<arquitectura>-audio-bridge`.

Este bloque elige la variante sola, baja todo y **verifica la integridad** contra el
`SHA256SUMS.txt` publicado antes de instalar:

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

# integridad: cada archivo debe decir OK
grep -E "$bin|$bridge" SHA256SUMS.txt | sha256sum -c -
```

Si alguna línea no dice `OK`, no sigas: volvé a descargar el archivo.

Instalación:

```bash
install -Dm755 "$bin" ~/.local/bin/voxtype
install -Dm755 "$bridge" ~/.local/bin/voxtype-audio-bridge

voxtype --version
```

Tiene que imprimir `voxtype 1.1.0`. `~/.local/bin` suele estar en el `PATH` en Fedora; si
`voxtype --version` no se encuentra, usá la ruta completa `~/.local/bin/voxtype` o agregá esa
carpeta a tu `PATH`.

Volvé a la raíz del repositorio antes de seguir (el paso anterior te dejó en `~/Downloads`):

```bash
cd "$REPO"
```

### Paso 5 — Descargar el modelo

```bash
voxtype setup --download --model parakeet-tdt-0.6b-v3-int8
```

Son ~670 MB y quedan en `~/.local/share/voxtype/models/`.

Por qué la variante **int8** y no la de precisión completa: el modelo fp32 ocupa 2,5 GB,
mientras que el int8 ocupa 670 MB, y este último además se acelera por hardware si tu CPU
tiene `avx512_vnni` (comprobalo con `grep -qm1 avx512_vnni /proc/cpuinfo && echo si`). Con la
carga bajo demanda que trae la configuración, el modelo se carga al apretar la tecla y se
libera al terminar, así que en reposo no ocupa memoria. Si preferís máxima precisión, existe
`parakeet-tdt-0.6b-v3` (2,5 GB); se cambia con una línea en el archivo de configuración.

### Paso 6 — Instalar la configuración

```bash
cd "$REPO"
mkdir -p ~/.config/voxtype
cp config/voxtype-config.toml ~/.config/voxtype/config.toml
```

Validación (si hay algo mal escrito, Voxtype avisa y descarta esa sección):

```bash
voxtype config 2>&1 | grep -i warn || echo OK
```

La plantilla ya trae lo necesario para este setup: motor `parakeet` con el modelo int8 y carga
bajo demanda, el hotkey interno de Voxtype desactivado (el atajo lo maneja GNOME), salida por
portapapeles con pegado automático vía `dotool`, el OSD propio desactivado (lo reemplaza la
extensión), notificaciones de escritorio apagadas, pitidos activados y detección de voz con el
backend `energy`.

### Paso 7 — Servicio de usuario systemd

Así el daemon arranca solo en cada inicio de sesión, sin abrir una terminal:

```bash
voxtype setup systemd
systemctl --user enable --now voxtype
systemctl --user status voxtype --no-pager
```

En el estado tenés que ver `Active: active (running)` y, en reposo, un consumo de memoria de
unos pocos MB.

**Si el pegado no funciona**, revisá que el servicio herede `WAYLAND_DISPLAY`: el modo de
salida usa `wl-copy`, que lo necesita para hablar con el compositor.

```bash
systemctl --user show-environment | grep WAYLAND_DISPLAY
```

Si no imprime nada, agregá una gota (drop-in) al servicio:

```bash
mkdir -p ~/.config/systemd/user/voxtype.service.d
printf '[Service]\nEnvironment=WAYLAND_DISPLAY=wayland-0\n' > ~/.config/systemd/user/voxtype.service.d/wayland.conf
systemctl --user daemon-reload
systemctl --user restart voxtype
```

### Paso 8 — Instalar la extensión y crear el atajo

La extensión es la que dibuja la onda. Son tres archivos:

```bash
cd "$REPO"
mkdir -p ~/.local/share/gnome-shell/extensions/voxtype-wave@cmj_pc
cp extension/extension.js extension/metadata.json extension/stylesheet.css \
   ~/.local/share/gnome-shell/extensions/voxtype-wave@cmj_pc/
```

El nombre de la carpeta **tiene que coincidir** con el campo `uuid` de `metadata.json`
(`voxtype-wave@cmj_pc`): si renombrás uno, cambiá el otro.

Ahora el atajo. El comando es siempre el mismo:

```
~/.local/bin/voxtype record toggle
```

**Opción simple, por interfaz:** Configuración → Teclado → Ver y personalizar atajos →
Atajos personalizados → `+`. Nombre `Dictado (toggle)`, el comando de arriba, y cuando pida la
tecla apretá **F9**.

**Opción por consola.** Cuidado: la lista de atajos personalizados es una sola, así que hay que
**agregar** la entrada nueva sin borrar las que ya tenías. Primero mirá qué tenés:

```bash
gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings
```

Supongamos que la lista que devuelve incluye `custom0`. Entonces creás el nuevo como `custom2`
y después publicás la lista **completa** (las viejas más la nueva):

```bash
S=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding
B=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/

gsettings set "$S:$B" name 'Dictado (toggle)'
gsettings set "$S:$B" command "$HOME/.local/bin/voxtype record toggle"
gsettings set "$S:$B" binding 'F9'

gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings \
  "['/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/', '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/']"
```

La última línea es la crítica: tiene que listar **todas** las entradas que querés conservar. Si
te equivocás ahí, perdés los otros atajos personalizados (se vuelven a crear desde la interfaz).
El instalador del repo evita este riesgo usando `scripts/gnome-settings.py`, que lee la lista
actual y le agrega la entrada nueva.

### Paso 9 — Cerrar sesión, habilitar y probar

Cerrá sesión y volvé a entrar. Es necesario por dos motivos: GNOME no carga extensiones nuevas
en caliente, y si tuviste que agregarte al grupo `input`, el cambio recién ahí toma efecto.

Después habilitá la extensión. Por interfaz: aplicación **Extensiones** → **Voxtype Waveform** →
interruptor. Por consola:

```bash
gnome-extensions enable voxtype-wave@cmj_pc
```

Prueba:

1. Poné el cursor en un campo de texto cualquiera.
2. Apretá **F9**: tiene que sonar el pitido, aparecer la onda abajo al centro y ponerse rojo el
   icono de la barra superior.
3. Hablá unos segundos.
4. Apretá **F9** otra vez: el icono pasa a ámbar un instante y el texto aparece pegado en el
   cursor.

---

## Verificación final

```bash
# la extensión: tiene que decir Enabled: Yes y State: ACTIVE (o ENABLED)
gnome-extensions info voxtype-wave@cmj_pc

# el daemon: Active: active (running)
systemctl --user status voxtype --no-pager

# errores de la extensión en esta sesión (no debería imprimir nada)
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

## Si algo no funciona

Ver [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md).
