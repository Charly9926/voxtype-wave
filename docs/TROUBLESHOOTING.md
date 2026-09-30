# Solución de problemas

Este documento cubre los fallos conocidos del setup de dictado por voz, que está formado por
tres piezas:

- el daemon `voxtype` (binario standalone en `~/.local/bin/voxtype`), corriendo como servicio
  de usuario systemd;
- `voxtype-audio-bridge` (binario standalone en `~/.local/bin/voxtype-audio-bridge`), que
  convierte el socket de audio del daemon en NDJSON;
- la extensión de GNOME Shell `voxtype-wave@cmj_pc`, que dibuja la onda y el icono de estado.

Nada de esto depende de internet ni de servicios externos: el audio se captura y se transcribe
en la máquina. Casi todos los problemas se diagnostican mirando el journal y el estado de la
extensión.

Si es la primera vez que lo instalás, ver `docs/INSTALL.md`.

---

## No aparece la onda

**Causa probable.** El panel flotante se dibuja **solo mientras se está grabando**: el daemon
emite tramas de audio únicamente durante la grabación. Si no estás grabando, no hay nada que
mostrar. Las otras causas son que el daemon no esté corriendo, que falte el binario
`voxtype-audio-bridge`, o que la extensión no esté cargada.

**Diagnóstico.**

```bash
# 1. ¿el daemon está vivo?
systemctl --user status voxtype --no-pager

# 2. ¿el bridge existe y es ejecutable?
ls -l ~/.local/bin/voxtype-audio-bridge

# 3. ¿la extensión está cargada?
gnome-extensions info voxtype-wave@cmj_pc

# 4. ¿llegan tramas desde el daemon? (dictá mientras corre)
~/.local/bin/voxtype-audio-bridge
```

El comando 4 es el más directo: si dictás y no aparecen líneas `{"peak":...}`, el problema está
en el daemon (ver "El daemon no arranca"). Si esas líneas aparecen y la onda sigue sin verse, el
problema está en la extensión (ver "La extensión aparece con error / no carga").

**Solución.**

- Si falta el bridge, reinstalá los binarios con `./install.sh` o copiá `voxtype-audio-bridge`
  del release a `~/.local/bin/` con permisos de ejecución.
- Si la extensión está en `ERROR` o `OUT_OF_DATE`, seguí esa sección.
- Tené en cuenta que el archivo de estado `$XDG_RUNTIME_DIR/voxtype/state` **sobrevive** al
  daemon. La extensión no lo usa para saber si el daemon vive: mira el PID file
  `$XDG_RUNTIME_DIR/voxtype/pid` y comprueba que exista `/proc/<pid>`.

---

## El texto no se pega

**Causa probable.** En orden de frecuencia:

1. `dotool` no está instalado o no puede escribir en `/dev/uinput`.
2. El hook `post_output_command` está mal escrito: `dotool` lee sus comandos por **stdin**, no
   por argumentos.
3. `wl-copy` falla porque el servicio no tiene `WAYLAND_DISPLAY`.
4. Se está usando el modo `paste` de Voxtype, que no acepta `dotool` para mandar el acorde.

**Diagnóstico.**

```bash
# ¿dotool está instalado y puede escribir en uinput?
command -v dotool && [ -w /dev/uinput ] && echo "uinput OK" || echo "sin acceso a /dev/uinput"

# ¿el portapapeles funciona?
printf 'prueba' | wl-copy && wl-paste

# ¿el hook está bien escrito?
grep post_output_command ~/.config/voxtype/config.toml

# ¿qué dice el daemon?
journalctl --user -u voxtype -n 50 --no-pager
```

**Solución.**

- **Permisos de `dotool`:** `sudo usermod -aG input "$USER"` y cerrar sesión. La regla udev de
  `/dev/uinput` la trae el paquete `dotool`. Nota de seguridad: pertenecer al grupo `input`
  permite leer todo el teclado de la máquina. Si el sistema ya le da acceso a `/dev/uinput` al
  usuario activo por ACL (`uaccess`), el grupo no hace falta; el listener evdev de Voxtype está
  desactivado en este setup, así que el grupo solo se necesita para `dotool`.
- **Hook correcto:**
  ```toml
  post_output_command = "sleep 0.2; echo 'key ctrl+shift+v' | dotool"
  ```
  Sin la tubería, el hook falla con
  `dotool: there should be no arguments, commands are read from stdin`.
- **El modo `paste` no sirve en GNOME.** Internamente Voxtype solo prueba `wtype`, `eitype` o
  `ydotool` para mandar el acorde; los strings del binario lo dicen:
  `No keystroke tool available (tried wtype, eitype, ydotool)`. `dotool` no está en esa lista, y
  `wtype` no funciona porque Mutter no implementa `zwp_virtual_keyboard_v1`. La combinación que
  funciona es modo clipboard más el hook con `dotool`:
  ```toml
  [output]
  mode = "clipboard"
  restore_clipboard = false
  post_output_command = "sleep 0.2; echo 'key ctrl+shift+v' | dotool"
  ```
- **Verificación directa del inyector**, con el cursor en un campo de texto:
  ```bash
  echo type "prueba ñ á é í" | dotool
  ```
  En un layout `us` los acentos van a dar aviso (ver "Acentos o caracteres raros"); eso no impide
  que el acorde `ctrl+shift+v` funcione.
- Si el acorde no entra en alguna aplicación concreta (por ejemplo un editor donde
  `ctrl+shift+v` significa otra cosa), probá `ctrl+v` en el hook.

---

## No pasa nada al apretar F9

**Causa probable.** El atajo personalizado de GNOME no existe, apunta a un comando equivocado, o
el daemon no está corriendo. Los atajos de GNOME deben usar la **ruta absoluta** del binario,
porque no heredan el `PATH` de la shell.

**Diagnóstico.**

```bash
# ¿existe el atajo y a qué apunta?
S=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding
B=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom2/
gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings
gsettings get "$S:$B" name
gsettings get "$S:$B" command
gsettings get "$S:$B" binding

# ¿el daemon responde al comando del atajo?
voxtype record toggle
```

Si el daemon no corre, `record toggle` responde `Error: Voxtype daemon is not running.`

**Solución.**

- Recrear el atajo con `./install.sh`, o a mano en Configuración → Teclado → Ver y personalizar
  atajos → Atajos personalizados: nombre libre, comando
  `/home/<usuario>/.local/bin/voxtype record toggle`, tecla F9.
- Si el daemon no está corriendo, ver la sección siguiente.
- Si F9 lo captura otra aplicación, cambiá la tecla del atajo (y, si querés, la del indicador de
  estado no cambia: el icono de la barra es independiente).

---

## La extensión aparece con error / no carga

**Diagnóstico.**

```bash
gnome-extensions info voxtype-wave@cmj_pc
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

El campo `State` puede ser:

| Estado | Significado | Qué hacer |
|---|---|---|
| `ENABLED` | cargada y funcionando | nada |
| `OUT_OF_DATE` | GNOME cambió de versión mayor y el `metadata.json` no la declara | ver "Después de actualizar GNOME" |
| `ERROR` | falló al cargar: la traza del journal indica archivo y línea | leer la traza y corregir la API |

**Caso conocido (GNOME 50).** En GNOME 50, `Main.layoutManager.addChrome()` acepta **solo**
`trackFullscreen` y `affectsStruts`. El parámetro `affectsInputRegion` existía en versiones
anteriores y fue eliminado:

```
Error: Unrecognized parameter "affectsInputRegion"
  addChrome@resource:///org/gnome/shell/ui/layout.js
  _buildWavePanel@file:///.../voxtype-wave@cmj_pc/extension.js
```

La solución es pasar solo esos dos parámetros. Un error de carga **no rompe la sesión**: la
extensión queda en estado `ERROR` y el escritorio sigue funcionando.

**Editar la extensión exige cerrar sesión.** GNOME cachea el módulo ES, así que al recargar
aparece:

```
A different version was loaded previously. You need to log out for changes to take effect.
```

Para probar cambios sin cerrar sesión:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Eso abre una shell de GNOME dentro de una ventana, que carga las mismas extensiones desde el
mismo directorio. Dos advertencias: en esa sesión anidada no corre el servicio de atajos, así
que **F9 no funciona** y la grabación se dispara con `voxtype record toggle` desde otra
terminal; y para salir se cierra la ventana o se pulsa Ctrl+C.

**Red de seguridad de GNOME.** Si el shell se cae con extensiones habilitadas, al siguiente
login GNOME las desactiva (archivo `gnome-shell-disable-extensions` en el runtime dir). Es
decir: una extensión rota no deja el escritorio inutilizable de forma permanente.

---

## El daemon no arranca

**Diagnóstico.**

```bash
systemctl --user status voxtype --no-pager
journalctl --user -u voxtype -f
systemctl --user show-environment | grep WAYLAND_DISPLAY
```

**Causas y soluciones.**

- **Falta `WAYLAND_DISPLAY`.** En modo clipboard, Voxtype llama a `wl-copy`, que necesita esa
  variable. Si no aparece en el entorno del gestor de systemd, agregá un drop-in:
  ```bash
  mkdir -p ~/.config/systemd/user/voxtype.service.d
  printf '[Service]\nEnvironment=WAYLAND_DISPLAY=wayland-0\n' > ~/.config/systemd/user/voxtype.service.d/wayland.conf
  systemctl --user daemon-reload
  systemctl --user restart voxtype
  ```
- **PID file de un daemon anterior.** Si antes lo corriste a mano y quedó un PID file, el
  arranque lo detecta y lo limpia solo (`Removing stale pid file`). No requiere acción.
- **Arrancarlo con `voxtype daemon -v`.** Eso falla: `-v` es un flag **global** y va antes del
  subcomando. El error es `unexpected argument '-v' found`. La forma correcta es:
  ```bash
  voxtype -v daemon
  ```
- **Config o modelo faltantes.** Chequeo general:
  ```bash
  voxtype setup check
  ```
- La unidad es de usuario: `~/.config/systemd/user/voxtype.service`, con
  `PartOf=graphical-session.target` y `Environment=XDG_RUNTIME_DIR=%t`. Para que arranque al
  iniciar sesión: `systemctl --user enable voxtype`.

---

## El dictado tarda o la RAM sube

**Qué es esperable (no es un problema).**

- La primera frase de cada dictado tarda alrededor de **1,5 s**: el modelo se carga bajo demanda
  (`on_demand_loading = true`) y se libera al terminar.
- La transcripción en sí tarda alrededor de **0,1 s** por frase.
- El daemon ocupa **~6 MB en reposo** (pico medido: 9,3 MB). El modelo int8 ocupa 670 MB en
  disco y solo está en memoria mientras dictás.
- El motor corre en **CPU con AVX-512 y no usa GPU ni VRAM**, así que no compite con otras
  cargas de GPU.

**Diagnóstico.**

```bash
free -h                                        # antes y después de dictar
grep on_demand_loading ~/.config/voxtype/config.toml
journalctl --user -u voxtype -n 30 --no-pager  # buscar la carga del modelo
```

**Solución.**

- Si la RAM no vuelve después de dictar, confirmá que la config tenga
  `[parakeet] on_demand_loading = true`.
- Si preferís menos latencia a cambio de RAM permanente, poné `on_demand_loading = false`: el
  modelo queda cargado (los 670 MB dejan de liberarse).

---

## Acentos o caracteres raros

**Causa.** Con un layout de teclado `us`, `dotool` no puede escribir acentos:

```
dotool: WARNING: impossible character for layout: ñ
dotool: WARNING: impossible character for layout: á
```

Por eso este setup **pega** el texto (Unicode exacto a través del portapapeles) en lugar de
escribirlo con eventos de teclado. `dotool` se usa solo para mandar el acorde `ctrl+shift+v`, que
no depende del layout.

**Diagnóstico.**

```bash
localectl status | grep -i layout
echo type "prueba ñ á é í" | dotool
```

**Solución.**

- Mantené `[output] mode = "clipboard"` más el hook con `dotool`: es lo que evita el problema.
- Si el pegado no entra en una aplicación concreta, probá `ctrl+v` en lugar de `ctrl+shift+v`.
- No intentes resolverlo con `mode = "type"`: escribiría sin acentos o con caracteres
  equivocados, porque traduce texto a teclas según el layout activo.

---

## Después de actualizar GNOME

Una actualización mayor de GNOME puede dejar la extensión en dos estados distintos:

- **`State: OUT_OF_DATE`.** Es el campo `shell-version` de `metadata.json`. GNOME compara solo
  el número mayor (el shell 51.x contra la entrada `"51"`). Solución: agregar el número nuevo a
  la lista del campo.
- **`State: ERROR`.** Cambió una API interna del shell. La traza del journal indica el archivo y
  la línea exactos.

```bash
gnome-extensions info voxtype-wave@cmj_pc
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

Las actualizaciones normales de Fedora (kernel, Mesa, PipeWire, systemd, drivers) no afectan a
la extensión, que vive en `~/.local` y no depende de paquetes del sistema más allá del propio
GNOME Shell.

**Los binarios de Voxtype no se actualizan con `dnf`:** son standalone en `~/.local/bin`. Se
actualizan con `./update-voxtype.sh` o bajando el release nuevo a mano y verificando
`SHA256SUMS.txt`.

---

## Diagnóstico en 30 segundos

```bash
# 1. ¿el daemon vive y está sano?
systemctl --user status voxtype --no-pager

# 2. ¿la extensión está cargada?
gnome-extensions info voxtype-wave@cmj_pc

# 3. ¿salen tramas de audio? (dictá mientras corre)
~/.local/bin/voxtype-audio-bridge

# 4. ¿hay errores del shell?
journalctl --user -b -g voxtype-wave --no-pager | tail -30
```

Comandos extra según el síntoma:

```bash
voxtype setup check                         # dependencias y configuración
journalctl --user -u voxtype -f             # daemon en vivo
echo type "prueba ñ á é í" | dotool         # inyector de texto directo
free -h                                     # la RAM debe volver tras dictar
```

---

## Cómo reportar un problema

Pegá en el issue, en este orden:

1. Versión del sistema: `uname -r` y `rpm -E %fedora`.
2. Versión de GNOME: `gnome-shell --version`.
3. Estado de la extensión: `gnome-extensions info voxtype-wave@cmj_pc`.
4. Errores del shell filtrados:
   ```bash
   journalctl --user -b -g voxtype-wave --no-pager | tail -30
   ```
5. Si el problema es el daemon:
   ```bash
   systemctl --user status voxtype --no-pager
   ```
6. Si el problema es la transcripción o la salida del texto:
   ```bash
   journalctl --user -u voxtype -n 50 --no-pager
   ```
7. Qué aplicación tenía el foco, qué hiciste y qué esperabas que pasara.
