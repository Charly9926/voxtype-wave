#!/usr/bin/env python3
"""GNOME settings that the voxtype-wave installer needs.

No PyGObject dependency: it uses the `gsettings` binary. It reads the user's real
state and is idempotent: it adds or updates *only* its own entries, without
clobbering the shortcuts or extensions you already have configured.

Usage:
    gnome-settings.py shortcut-set --name NAME --command CMD --binding KEY
    gnome-settings.py shortcut-remove --name NAME
    gnome-settings.py shortcut-show --name NAME
    gnome-settings.py extension-enable --uuid UUID
    gnome-settings.py extension-disable --uuid UUID
    gnome-settings.py extension-status --uuid UUID
    gnome-settings.py extension-disable-older --prefix PREFIX --keep UUID

`shortcut-show` and `extension-status` are read-only: they print state and are
meant for humans and for `--help`-style checks, not for the installer.

Tests: python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import argparse
import ast
import subprocess
import sys

MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys'
CUSTOM_SCHEMA = f'{MEDIA_KEYS}.custom-keybinding'
CUSTOM_BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings'
SHELL_SCHEMA = 'org.gnome.shell'


def _run(args):
    return subprocess.run(args, capture_output=True, text=True)


def gget(schema, key):
    """Return the raw gsettings value (quoted when it is a string)."""
    res = _run(['gsettings', 'get', schema, key])
    if res.returncode != 0:
        return None
    return res.stdout.strip()


def gset(schema, key, value):
    res = _run(['gsettings', 'set', schema, key, value])
    if res.returncode != 0:
        sys.exit(f'error: could not write {schema} {key}: {res.stderr.strip()}')
    return value


def greset(schema, key):
    _run(['gsettings', 'reset', schema, key])


def as_list(raw):
    """Convert the GVariant of a string array into a Python list."""
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
    """Serialize a list of strings into the `as` GVariant that gsettings expects."""
    quoted = ", ".join("'%s'" % item.replace("\\", "\\\\").replace("'", "\\'")
                       for item in items)
    return f'[{quoted}]'


def _slot_name(path):
    raw = gget(f'{CUSTOM_SCHEMA}:{path}', 'name')
    return raw.strip("'") if raw else ''


def _slot_command(path):
    raw = gget(f'{CUSTOM_SCHEMA}:{path}', 'command')
    return raw.strip("'") if raw else ''


def _find_slot(name):
    """Return the path of the shortcut with that name, or None."""
    for path in as_list(gget(MEDIA_KEYS, 'custom-keybindings')):
        if _slot_name(path) == name:
            return path
    return None


def _find_slot_by_command(substring):
    """Return the path of the shortcut whose command contains that text, or None.

    Used to adopt an already existing shortcut stored under a different name (for
    example one the user created by hand) instead of duplicating it.
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
    # If it does not exist under our name, adopt one that already points to the
    # same command (for example one created by hand under another name) so we do
    # not end up with a duplicate.
    if slot is None and args.match_command:
        slot = _find_slot_by_command(args.match_command)
        if slot is not None:
            adopted = _slot_name(slot)
    created = slot is None
    if created:
        slot = _free_slot()
    # Write the keys before registering the slot: if a write fails, the list
    # must not keep a path with empty values (a ghost shortcut in GNOME).
    schema = f'{CUSTOM_SCHEMA}:{slot}'
    if created:
        gset(schema, 'name', f"'{args.name}'")
        # Only a shortcut we create is kept off the lock screen; adopting an
        # existing one must not change the user's choice.
        gset(schema, 'enable-in-lockscreen', 'false')
    gset(schema, 'command', f"'{args.command}'")
    gset(schema, 'binding', f"'{args.binding}'")
    if created:
        paths.append(slot)
        gset(MEDIA_KEYS, 'custom-keybindings', as_variant(paths))
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


def cmd_extension_disable_older(args):
    """Leave only the current uuid enabled (installs that changed uuid)."""
    enabled = as_list(gget(SHELL_SCHEMA, 'enabled-extensions'))
    keep = [u for u in enabled if u == args.keep or not u.startswith(args.prefix)]
    removed = [u for u in enabled if u not in keep]
    if removed:
        gset(SHELL_SCHEMA, 'enabled-extensions', as_variant(keep))
        for uuid in removed:
            print(f'older extension disabled: {uuid}')
    else:
        print('no older extension enabled')
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
                   help='if no shortcut with that name exists, adopt the one '
                        'whose command contains this text (avoids duplicates)')
    p.set_defaults(func=cmd_shortcut_set)

    p = sub.add_parser('shortcut-remove')
    p.add_argument('--name', required=True)
    p.add_argument('--match-command', default=None,
                   help='if no shortcut with that name exists, remove the one '
                        'whose command contains this text')
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

    p = sub.add_parser('extension-disable-older')
    p.add_argument('--prefix', required=True,
                   help='uuid prefix of this extension series, e.g. voxtype-wave@')
    p.add_argument('--keep', required=True, help='the uuid to keep enabled')
    p.set_defaults(func=cmd_extension_disable_older)

    args = parser.parse_args()
    return args.func(args)


if __name__ == '__main__':
    sys.exit(main())
