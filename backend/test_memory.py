from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sources.memory import MiloMemory, MemoryStoreError


class MiloMemoryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.memory = MiloMemory(Path(self.temporary_directory.name) / "memory.sqlite3")

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_remember_is_local_deduplicated_and_searchable(self) -> None:
        first = self.memory.remember("  I like chai  ")
        duplicate = self.memory.remember("i LIKE chai")

        self.assertFalse(first["already_saved"])
        self.assertTrue(duplicate["already_saved"])
        self.assertEqual(first["id"], duplicate["id"])
        self.assertEqual(self.memory.recall("chai")[0]["fact"], "I like chai")

    def test_forget_requires_a_unique_match_and_removes_only_that_fact(self) -> None:
        self.memory.remember("My favorite song is Shape of You")
        self.memory.remember("My favorite song is Perfect")

        ambiguous = self.memory.forget("favorite song")
        forgotten = self.memory.forget("Shape of You")
        remaining = self.memory.recall()

        self.assertFalse(ambiguous["deleted"])
        self.assertTrue(forgotten["deleted"])
        self.assertEqual(len(remaining), 1)
        self.assertEqual(remaining[0]["fact"], "My favorite song is Perfect")

    def test_rejects_sensitive_or_oversized_memory(self) -> None:
        for fact in (
            "My password is secret",
            "My salary is $50,000",
            "I have asthma",
            "मेरा वेतन 50000 है",
        ):
            with self.subTest(fact=fact), self.assertRaises(MemoryStoreError):
                self.memory.remember(fact)
        with self.assertRaises(MemoryStoreError):
            self.memory.remember("x" * 501)
        self.assertEqual(self.memory.recall(), [])


if __name__ == "__main__":
    unittest.main()
