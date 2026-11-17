import http.client
import json
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from server import CatalogError, ImageCatalog, build_server


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


class PDFTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temporary.name)
        cls.pdf = b"%PDF-1.4\nPDF range test\n%%EOF\n"
        cls.name = "论文 2.PDF"
        for name in [cls.name, "论文 10.pdf"]:
            (cls.root / name).write_bytes(cls.pdf)
        (cls.root / "image.png").write_bytes(b"image")
        (cls.root / "child").mkdir()
        (cls.root / "child" / "nested.pdf").write_bytes(cls.pdf)
        (cls.root / "linked.pdf").symlink_to(cls.root / cls.name)
        cls.catalog = ImageCatalog(cls.root)
        cls.url = f"/pdf/root/{cls.catalog.encode_id(cls.name)}"
        cls.server = build_server("127.0.0.1", 0, cls.catalog)
        cls.server.RequestHandlerClass.log_message = lambda *args: None
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.temporary.cleanup()

    def request(self, path, method="GET", headers=None):
        with closing(http.client.HTTPConnection(*self.server.server_address, timeout=5)) as connection:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()

    def test_pdf_listing_is_explicit_natural_sorted_and_nonrecursive(self):
        status, _, body = self.request("/api/browse?kind=pdf")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual([file["name"] for file in data["pdfs"]], [self.name, "论文 10.pdf"])
        self.assertEqual([item["name"] for item in data["directories"]], ["child"])
        self.assertEqual(data["current"]["imageCount"], 1)
        self.assertEqual(json.loads(self.request("/api/browse")[2])["pdfs"], [])

    def test_pdf_is_served_inline_with_head_support(self):
        status, headers, body = self.request(self.url)
        self.assertEqual(status, 200)
        self.assertEqual(body, self.pdf)
        self.assertEqual(headers["Content-Type"], "application/pdf")
        self.assertEqual(headers["Accept-Ranges"], "bytes")
        self.assertTrue(headers["Content-Disposition"].startswith("inline; filename*=UTF-8''"))
        status, headers, body = self.request(self.url, "HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(int(headers["Content-Length"]), len(self.pdf))
        self.assertEqual(body, b"")

    def test_pdf_ranges_return_exact_bytes(self):
        for value, start, end in [("bytes=1-5", 1, 5), ("bytes=7-", 7, len(self.pdf) - 1),
                                  ("bytes=-6", len(self.pdf) - 6, len(self.pdf) - 1),
                                  ("bytes=0-99999", 0, len(self.pdf) - 1)]:
            with self.subTest(range=value):
                status, headers, body = self.request(self.url, headers={"Range": value})
                self.assertEqual(status, 206)
                self.assertEqual(body, self.pdf[start:end + 1])
                self.assertEqual(headers["Content-Range"], f"bytes {start}-{end}/{len(self.pdf)}")
                self.assertEqual(int(headers["Content-Length"]), len(body))

    def test_unsatisfiable_ranges_are_rejected(self):
        for value in ["bytes=99999-", "bytes=5-1", "bytes=-0", "bytes=-"]:
            with self.subTest(range=value):
                status, headers, body = self.request(self.url, headers={"Range": value})
                self.assertEqual(status, 416)
                self.assertEqual(headers["Content-Range"], f"bytes */{len(self.pdf)}")
                self.assertEqual(body, b"")

    def test_pdf_endpoint_rejects_other_formats_symlinks_and_path_escape(self):
        for name in ["image.png", "linked.pdf", "missing.pdf", "../outside.pdf", "/etc/passwd"]:
            with self.subTest(name=name):
                status, _, _ = self.request(f"/pdf/root/{self.catalog.encode_id(name)}")
                self.assertEqual(status, 404)
        with self.assertRaises(CatalogError):
            self.catalog.resolve_pdf(self.catalog.encode_id(".."), self.catalog.encode_id(self.name))
        status, _, _ = self.request(f"/media/root/{self.catalog.encode_id(self.name)}")
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
