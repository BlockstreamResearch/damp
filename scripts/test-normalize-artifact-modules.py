#!/usr/bin/env python3
"""The normalizer accepts ordering changes, never arbitrary generated drift."""
import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('normalizer', pathlib.Path(__file__).with_name('normalize-artifact-modules.py'))
normalizer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(normalizer)


class CanonicalModules(unittest.TestCase):
    def test_order_and_idempotence(self):
        a = '#[rustfmt::skip]\npub mod a;\n'
        z = '#[rustfmt::skip]\npub mod z;\n'
        expected = normalizer.HEADER + a + z
        self.assertEqual(normalizer.canonicalize(normalizer.HEADER + z + a), expected)
        self.assertEqual(normalizer.canonicalize(expected), expected)

    def test_unexpected_content_rejected(self):
        for source in ('', normalizer.HEADER, normalizer.HEADER + 'pub mod a;\n',
                       normalizer.HEADER + '#[rustfmt::skip]\npub mod a;\n// extra\n'):
            with self.assertRaises(ValueError):
                normalizer.canonicalize(source)

    def test_duplicates_rejected(self):
        with self.assertRaises(ValueError):
            normalizer.canonicalize(normalizer.HEADER + '#[rustfmt::skip]\npub mod a;\n' * 2)

    def test_changed_module_remains_visible(self):
        a = normalizer.canonicalize(normalizer.HEADER + '#[rustfmt::skip]\npub mod a;\n')
        b = normalizer.canonicalize(normalizer.HEADER + '#[rustfmt::skip]\npub mod b;\n')
        self.assertNotEqual(a, b)


if __name__ == '__main__':
    unittest.main()
