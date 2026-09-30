#!/usr/bin/env python3
"""Ajustes de GNOME que necesita el instalador de voxtype-wave.

No depende de PyGObject: usa el binario `gsettings`. Toma el estado real del
usuario y es idempotente: agrega o actualiza *solo* lo suyo, sin pisar los
atajos ni las extensiones que ya tengas configurados.

Uso:
    gnome-settings.py shortcut-set --name NOMBRE --command CMD --binding TECLA
    gnome-settings.py shortcut-remove --name NOMBRE
    gnome-settings.py shortcut-show --name NOMBRE
    gnome-settings.py extension-enable --uuid UUID
    gnome-settings.py extension-disable --uuid UUID
    gnome-settings.py extension-status --uuid UUID
"""

import argparse
import ast
import subprocess
import sys

MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys'
CUSTOM_SCHEMA = f'{MEDIA_KEYS}.custom-keybinding'
CUSTOM_BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings'
SHELL_SCHEMA = 'org.gnome.shell'
EXT_SCHEMA = 'org.gnome.shell.extensions'


def _run(args):
    return subprocess.run(args, capture_output=True, text=True)


def gget(schema, key):
    """Devuelve el valor crudo de gsettings (con comillas si es string)."""
    res = _run(['gsettings', 'get', schema, key])
    if res.returncode != 0:
        return None
    return res.stdout.strip()


def gset(schema, key, value):
    res = _run(['gsettings', 'set', schema, key, value])
    if res.returncode != 0:
        sys.exit(f'error: no pude escribir {schema} {key}: {res.stderr.strip()}')
    return value


def greset(schema, key):
    _run(['gsettings', 'reset', schema, key])


def as_list(raw):
    """Convierte el GVariant de un array de strings a lista de Python."""
    if raw is None:
        return []
    text = raw.strip()
    if text.startswith('@as '):
        text = text[4:].strip()
    try:
        value = ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return []
    if isinstance(value, str):
        return [value]
    return [str(item) for item in value]


def as_variant(items):
    """Serializa una lista de strings al GVariant `as` que espera gsettings."""
    quoted = ", ".join("'%s'" % item.replace("'", "\\'") for item in items)
    return f'[{quoted}]'


def _slot_name(path):
    raw = gget(f'{CUSTOM_SCHEMA}:{path}', 'name')
    return raw.strip("'") if raw else ''


def _slot_command(path):
    raw = gget(f'{CUSTOM_SCHEMA}:{path}', 'command')
    return raw.strip("'") if raw else ''


def _find_slot(name):
    """Devuelve la ruta del atajo con ese nombre, o None."""
    for path in as_list(gget(MEDIA_KEYS, 'custom-keybindings')):
        if _slot_name(path) == name:
            return path
    return None


def _find_slot_by_command(substring):
    """Devuelve la ruta del atajo cuyo comando contenga ese texto, o None.

    Sirve para adoptar un atajo ya existente con otro nombre (por ejemplo uno
    que el usuario creó a mano como "Dictado (toggle)") en vez de duplicarlo.
    """
    for path in as_list(gget(MEDIA_KEYS, 'custom-keybindings')):
        if substring in _slot_command(path):
            return path
    return None


def _free_slot():
    used = {p.rstrip('/').rsplit('/', 1)[-1]
            for p in as_list(gget(MEDIA_KEYS, 'custom-keybindings'))}
    index = 0
    while f'custom{index}' in used:
        index += 1
    return f'{CUSTOM_BASE}/custom{index}/'


def cmd_shortcut_set(args):
    paths = as_list(gget(MEDIA_KEYS, 'custom-keybindings'))
    slot = _find_slot(args.name)
    adopted = None
    # Si no existe con nuestro nombre, adoptamos uno que ya apunte al mismo
    # comando (por ejemplo uno creado a mano con otro nombre) para no duplicar.
    if slot is None and args.match_command:
        slot = _find_slot_by_command(args.match_command)
        if slot is not None:
            adopted = _slot_name(slot)
    created = slot is None
    if created:
        slot = _free_slot()
        paths.append(slot)
    gset(MEDIA_KEYS, 'custom-keybindings', as_variant(paths))
    schema = f'{CUSTOM_SCHEMA}:{slot}'
    if created:
        gset(schema, 'name', f"'{args.name}'")
    gset(schema, 'command', f"'{args.command}'")
    gset(schema, 'binding', f"'{args.binding}'")
    gset(schema, 'enable-in-lockscreen', 'false')
    if created:
        state = 'created'
    elif adopted:
        state = f'adopted existing shortcut "{adopted}" (name kept)'
    else:
        state = 'updated'
    print(f'{state}: {args.binding} -> {args.command}  ({slot})')
    return 0


def cmd_shortcut_remove(args):
    paths = as_list(gget(MEDIA_KEYS, 'custom-keybindings'))
    slot = _find_slot(args.name)
    if slot is None and args.match_command:
        slot = _find_slot_by_command(args.match_command)
        if slot is not None:
            print(f'found shortcut "{_slot_name(slot)}" by command')
    if slot is None:
        print(f'shortcut "{args.name}" not found (nothing to do)')
        return 0
    schema = f'{CUSTOM_SCHEMA}:{slot}'
    for key in ('name', 'command', 'binding', 'enable-in-lockscreen'):
        greset(schema, key)
    gset(MEDIA_KEYS, 'custom-keybindings',
         as_variant([p for p in paths if p != slot]))
    print(f'removed shortcut "{args.name}" ({slot})')
    return 0


def cmd_shortcut_show(args):
    slot = _find_slot(args.name)
    if slot is None and args.match_command:
        slot = _find_slot_by_command(args.match_command)
    if slot is None:
        print(f'shortcut "{args.name}": not configured')
        return 1
    print(f'name:    {_slot_name(slot)}')
    print(f'binding: {gget(f"{CUSTOM_SCHEMA}:{slot}", "binding")}')
    print(f'command: {gget(f"{CUSTOM_SCHEMA}:{slot}", "command")}')
    print(f'slot:    {slot}')
    return 0


def cmd_extension_enable(args):
    enabled = as_list(gget(SHELL_SCHEMA, 'enabled-extensions'))
    disabled = as_list(gget(SHELL_SCHEMA, 'disabled-extensions'))
    if args.uuid not in enabled:
        enabled.append(args.uuid)
        gset(SHELL_SCHEMA, 'enabled-extensions', as_variant(enabled))
    if args.uuid in disabled:
        gset(SHELL_SCHEMA, 'disabled-extensions',
             as_variant([u for u in disabled if u != args.uuid]))
    print(f'extension {args.uuid} will be enabled at next login')
    return 0


def cmd_extension_disable(args):
    enabled = as_list(gget(SHELL_SCHEMA, 'enabled-extensions'))
    if args.uuid in enabled:
        gset(SHELL_SCHEMA, 'enabled-extensions',
             as_variant([u for u in enabled if u != args.uuid]))
        print(f'extension {args.uuid} removed from enabled-extensions')
    else:
        print(f'extension {args.uuid} was not in enabled-extensions')
    return 0


def cmd_extension_status(args):
    enabled = as_list(gget(SHELL_SCHEMA, 'enabled-extensions'))
    print('enabled' if args.uuid in enabled else 'not enabled')
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('shortcut-set')
    p.add_argument('--name', required=True)
    p.add_argument('--command', required=True)
    p.add_argument('--binding', required=True)
    p.add_argument('--match-command', default=None,
                   help='si no existe un atajo con ese nombre, adoptar el que '
                        'tenga este texto en su comando (evita duplicados)')
    p.set_defaults(func=cmd_shortcut_set)

    p = sub.add_parser('shortcut-remove')
    p.add_argument('--name', required=True)
    p.add_argument('--match-command', default=None,
                   help='si no existe un atajo con ese nombre, borrar el que '
                        'tenga este texto en su comando')
    p.set_defaults(func=cmd_shortcut_remove)

    p = sub.add_parser('shortcut-show')
    p.add_argument('--name', required=True)
    p.add_argument('--match-command', default=None)
    p.set_defaults(func=cmd_shortcut_show)

    p = sub.add_parser('extension-enable')
    p.add_argument('--uuid', required=True)
    p.set_defaults(func=cmd_extension_enable)

    p = sub.add_parser('extension-disable')
    p.add_argument('--uuid', required=True)
    p.set_defaults(func=cmd_extension_disable)

    p = sub.add_parser('extension-status')
    p.add_argument('--uuid', required=True)
    p.set_defaults(func=cmd_extension_status)

    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
