import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server import ImageCatalog


class DirectoryBrowseTests(unittest.TestCase):
    def test_browse_counts_direct_images_without_building_image_index(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "child").mkdir()
            for name in ["1.PNG", "2.jpg", "3.webp", "notes.txt"]:
                (root / name).write_bytes(b"test")
            (root / "child" / "nested.png").write_bytes(b"test")
            (root / "linked.png").symlink_to(root / "1.PNG")
            catalog = ImageCatalog(root)
            with patch.object(catalog, "directory_index", side_effect=AssertionError("Full image scan")):
                data = catalog.browse("root")
            self.assertEqual(data["current"]["imageCount"], 3)
            self.assertEqual([entry["name"] for entry in data["directories"]], ["child"])

    def test_refresh_invalidates_old_index_without_rebuilding_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "1.png").write_bytes(b"test")
            catalog = ImageCatalog(root)
            catalog.directory_index("root")
            self.assertIn("root", catalog._index_cache)
            with patch.object(catalog, "directory_index", side_effect=AssertionError("Full image scan")):
                data = catalog.browse("root", refresh=True)
            self.assertEqual(data["current"]["imageCount"], 1)
            self.assertNotIn("root", catalog._index_cache)


if __name__ == "__main__":
    unittest.main()
