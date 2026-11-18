#!/usr/bin/env python3
"""Tests for scripts/gnome-settings.py.

The helper only shells out to `gsettings`, so a fake that keeps a dict of
(schema, key) -> raw GVariant value is enough to test the risky parts: the
GVariant quoting, creating/adopting/removing shortcuts and the extension list.

Run: python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import contextlib
import importlib.util
import io
import pathlib
import unittest

HELPER = pathlib.Path(__file__).with_name('gnome-settings.py')
MEDIA = 'org.gnome.settings-daemon.plugins.media-keys'
CUSTOM = f'{MEDIA}.custom-keybinding'
BASE = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings'
SHELL = 'org.gnome.shell'


class Result:
    def __init__(self, code=0, out=''):
        self.returncode = code
        self.stdout = out
        self.stderr = ''


def load_helper():
    spec = importlib.util.spec_from_file_location('gnome_settings', HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ns(**kw):
    return type('Args', (), kw)()


class GnomeSettingsTest(unittest.TestCase):
    def setUp(self):
        self.mod = load_helper()
        self.store = {}
        self.mod._run = self.fake_run

    def fake_run(self, args):
        if args[:2] == ['gsettings', 'get']:
            return Result(0, self.store.get((args[2], args[3]), ''))
        if args[:2] == ['gsettings', 'set']:
            self.store[(args[2], args[3])] = args[4]
            return Result(0, '')
        if args[:2] == ['gsettings', 'reset']:
            self.store.pop((args[2], args[3]), None)
            return Result(0, '')
        return Result(1, '')

    # -- GVariant quoting ---------------------------------------------------
    def test_variant_round_trip(self):
        for items in ([], ['voxtype record toggle'], ["a'b"], ['a\\b'], ['x@y', 'z']):
            self.assertEqual(self.mod.as_list(self.mod.as_variant(items)), items)

    def test_variant_escapes_quotes_and_backslashes(self):
        self.assertEqual(self.mod.as_variant(["it's", 'a\\b']), "['it\\'s', 'a\\\\b']")

    # -- shortcuts ----------------------------------------------------------
    def shortcut(self, name='Voxtype dictation (toggle)', command='voxtype record toggle',
                 binding='F9', match_command=None):
        return ns(name=name, command=command, binding=binding, match_command=match_command)

    def paths(self):
        return self.mod.as_list(self.store.get((MEDIA, 'custom-keybindings'), '[]'))

    def test_set_creates_one_slot(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.mod.cmd_shortcut_set(self.shortcut())
        self.assertEqual(self.paths(), [f'{BASE}/custom0/'])
        self.assertEqual(self.store[(f'{CUSTOM}:{BASE}/custom0/', 'name')],
                         "'Voxtype dictation (toggle)'")
        self.assertEqual(self.store[(f'{CUSTOM}:{BASE}/custom0/', 'binding')], "'F9'")
        self.assertEqual(self.store[(f'{CUSTOM}:{BASE}/custom0/', 'enable-in-lockscreen')],
                         'false')

    def test_second_run_does_not_duplicate(self):
        with contextlib.redirect_stdout(io.StringIO()):
            self.mod.cmd_shortcut_set(self.shortcut())
            self.mod.cmd_shortcut_set(self.shortcut(binding='F10'))
        self.assertEqual(self.paths(), [f'{BASE}/custom0/'])
        self.assertEqual(self.store[(f'{CUSTOM}:{BASE}/custom0/', 'binding')], "'F10'")

    def test_adopts_existing_slot_by_command(self):
        slot = f'{BASE}/custom7/'
        self.store[(MEDIA, 'custom-keybindings')] = f"['{slot}']"
        self.store[(f'{CUSTOM}:{slot}', 'name')] = "'My own shortcut'"
        self.store[(f'{CUSTOM}:{slot}', 'command')] = "'voxtype record toggle'"
        self.store[(f'{CUSTOM}:{slot}', 'enable-in-lockscreen')] = 'true'
        with contextlib.redirect_stdout(io.StringIO()):
            self.mod.cmd_shortcut_set(self.shortcut(match_command='voxtype record toggle'))
        self.assertEqual(self.paths(), [slot])
        self.assertEqual(self.store[(f'{CUSTOM}:{slot}', 'name')], "'My own shortcut'")
        self.assertEqual(self.store[(f'{CUSTOM}:{slot}', 'binding')], "'F9'")
        # Adopting must not change the user's lock-screen preference.
        self.assertEqual(self.store[(f'{CUSTOM}:{slot}', 'enable-in-lockscreen')], 'true')

    def test_remove_leaves_other_shortcuts(self):
        other, mine = f'{BASE}/custom0/', f'{BASE}/custom1/'
        self.store[(MEDIA, 'custom-keybindings')] = f"['{other}', '{mine}']"
        self.store[(f'{CUSTOM}:{mine}', 'name')] = "'Voxtype dictation (toggle)'"
        with contextlib.redirect_stdout(io.StringIO()):
            self.mod.cmd_shortcut_remove(self.shortcut(match_command=None))
        self.assertEqual(self.paths(), [other])

    # -- extensions ---------------------------------------------------------
    def test_enable_is_idempotent(self):
        uuid = 'voxtype-wave@charly9926.github.io'
        with contextlib.redirect_stdout(io.StringIO()):
            self.mod.cmd_extension_enable(ns(uuid=uuid))
            self.mod.cmd_extension_enable(ns(uuid=uuid))
        self.assertEqual(self.mod.as_list(self.store[(SHELL, 'enabled-extensions')]), [uuid])

    def test_disable_older_keeps_current_and_unrelated(self):
        current = 'voxtype-wave@charly9926.github.io'
        self.store[(SHELL, 'enabled-extensions')] = (
            "['other@x', 'voxtype-wave@cmj_pc', "
            f"'{current}']")
        with contextlib.redirect_stdout(io.StringIO()):
            self.mod.cmd_extension_disable_older(
                ns(prefix='voxtype-wave@', keep=current))
        self.assertEqual(self.mod.as_list(self.store[(SHELL, 'enabled-extensions')]),
                         ['other@x', current])


if __name__ == '__main__':
    unittest.main()
