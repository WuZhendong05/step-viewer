"""Tests for the taskId resolver and task-driven /__cad/* reads (server.py).

Covers the deterministic taskId -> uploads/<taskId> mapping: format validation,
containment in the uploads root, 404 for missing tasks, and catalog/asset reads
driven purely by ?task= + relative file (no absolute path in the request).
"""

import http.client
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from server_py import backend as backend_mod  # noqa: E402
from server_py import server as server_mod  # noqa: E402

_STEP_BYTES = b"ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n"


class TaskResolveTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_root = os.environ.get("VIEWER_UPLOAD_ROOT")
        os.environ["VIEWER_UPLOAD_ROOT"] = self._tmp.name
        self._task_id = backend_mod._new_task_id()
        self._task_dir = os.path.join(self._tmp.name, self._task_id)
        os.makedirs(self._task_dir)
        with open(os.path.join(self._task_dir, "part.step"), "wb") as handle:
            handle.write(_STEP_BYTES)
        server_mod._Ctx.backend = backend_mod.LocalAssetBackend()
        server_mod._Ctx.dist_root = self._tmp.name
        self._server = server_mod.ThreadingHTTPServer(("127.0.0.1", 0), server_mod.Handler)
        self._port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def tearDown(self):
        self._server.shutdown()
        self._server.server_close()
        if self._old_root is None:
            os.environ.pop("VIEWER_UPLOAD_ROOT", None)
        else:
            os.environ["VIEWER_UPLOAD_ROOT"] = self._old_root
        self._tmp.cleanup()

    def _get(self, path):
        conn = http.client.HTTPConnection("127.0.0.1", self._port, timeout=10)
        conn.request("GET", path)
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    # --- unit: _resolve_task_dir ---
    def test_resolve_valid_task(self):
        self.assertEqual(server_mod._resolve_task_dir(self._task_id), self._task_dir)

    def test_resolve_bad_format_is_forbidden(self):
        for bad in ("", "../etc", "abc", "20260821", "20260821_115310_bd87a6/../x", "..\\..\\windows"):
            with self.assertRaises(backend_mod.ForbiddenAssetError):
                server_mod._resolve_task_dir(bad)

    def test_resolve_missing_task_raises_not_found(self):
        with self.assertRaises(FileNotFoundError):
            server_mod._resolve_task_dir(backend_mod._new_task_id())

    # --- HTTP: resolver endpoint ---
    def test_resolve_http_ok(self):
        status, data = self._get(f"/__cad/resolve?task={self._task_id}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["dir"], self._task_dir)

    def test_resolve_http_bad_format_forbidden(self):
        status, _ = self._get("/__cad/resolve?task=../../etc")
        self.assertEqual(status, 403)

    def test_resolve_http_missing_task_404(self):
        status, _ = self._get(f"/__cad/resolve?task={backend_mod._new_task_id()}")
        self.assertEqual(status, 400)  # FileNotFoundError -> generic 400

    # --- HTTP: task-driven reads (no absolute path in the request) ---
    def test_catalog_via_task_with_relative_file(self):
        status, data = self._get(f"/__cad/catalog?task={self._task_id}&file=part.step")
        self.assertEqual(status, 200)
        cat = json.loads(data)
        served = cat["entries"][0]["file"].replace("\\", "/")
        self.assertTrue(served.endswith(f"{self._task_id}/part.step"), served)
        self.assertTrue(served.startswith(self._task_dir.replace("\\", "/")), served)

    def test_asset_via_task_with_relative_file(self):
        status, data = self._get(f"/__cad/asset?task={self._task_id}&file=part.step")
        self.assertEqual(status, 200)
        self.assertEqual(data, _STEP_BYTES)

    def test_asset_via_task_missing_file_404(self):
        status, _ = self._get(f"/__cad/asset?task={self._task_id}&file=nope.step")
        self.assertEqual(status, 404)

    def test_asset_via_task_traversal_rejected(self):
        # Even a valid task must not serve a relative file that escapes the task dir.
        status, _ = self._get(f"/__cad/asset?task={self._task_id}&file=..%2F..%2Fsecret.step")
        self.assertEqual(status, 403)  # ForbiddenAssetError (escape rejected)


if __name__ == "__main__":
    unittest.main()
