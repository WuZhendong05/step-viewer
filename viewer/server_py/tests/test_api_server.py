"""Tests for the standalone CAD upload API (server_py.api_server).

These exercise the real HTTP surface: start the api_server on an ephemeral port
in a background thread, then drive it with http.client (auth, multipart upload,
status polling, error branches).
"""

import concurrent.futures
import http.client
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from server_py import api_server  # noqa: E402

API_KEY = "test-secret-key"
_BOUNDARY = "----step-viewer-test-boundary-7d1f2a"


def _multipart(*fields):
    """fields: (name, filename|None, data_bytes, content_type|None)."""
    chunks = []
    for name, filename, data, ctype in fields:
        chunks.append(f"--{_BOUNDARY}".encode())
        disposition = f'Content-Disposition: form-data; name="{name}"'
        if filename:
            disposition += f'; filename="{filename}"'
        chunks.append(disposition.encode())
        if ctype:
            chunks.append(f"Content-Type: {ctype}".encode())
        chunks.append(b"")
        chunks.append(data)
    chunks.append(f"--{_BOUNDARY}--".encode())
    chunks.append(b"")
    return b"\r\n".join(chunks)


class ApiServerTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._old_upload_root = os.environ.get("VIEWER_UPLOAD_ROOT")
        os.environ["VIEWER_UPLOAD_ROOT"] = self._tmp.name
        api_server._Ctx.api_key = API_KEY
        api_server._Ctx.viewer_base_url = ""
        api_server._Ctx.viewer_host = "127.0.0.1"
        api_server._Ctx.viewer_port = 3245
        api_server._Ctx.prewarm_url = "http://127.0.0.1:3245"  # absolute: Request() rejects relative URLs
        self._server = api_server.ThreadingHTTPServer(("127.0.0.1", 0), api_server.Handler)
        self._port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def tearDown(self):
        self._server.shutdown()
        self._server.server_close()
        if self._old_upload_root is None:
            os.environ.pop("VIEWER_UPLOAD_ROOT", None)
        else:
            os.environ["VIEWER_UPLOAD_ROOT"] = self._old_upload_root
        self._tmp.cleanup()

    def _request(self, method, path, body=b"", headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", self._port, timeout=10)
        conn.request(method, path, body=body, headers=dict(headers or {}))
        resp = conn.getresponse()
        data = resp.read()
        conn.close()
        return resp.status, data

    def _auth(self):
        return {"Authorization": f"Bearer {API_KEY}"}

    def _submit(self, *fields):
        body = _multipart(*fields)
        headers = {**self._auth(),
                   "Content-Type": f"multipart/form-data; boundary={_BOUNDARY}"}
        return self._request("POST", "/api/v1/jobs", body=body, headers=headers)

    def _poll(self, job_id, attempts=50):
        for _ in range(attempts):
            status, data = self._request("GET", f"/api/v1/jobs/{job_id}", headers=self._auth())
            self.assertEqual(status, 200)
            job = json.loads(data)
            if job["status"] != "received":
                return job
            time.sleep(0.02)
        self.fail(f"job {job_id} never left 'received'")

    # --- health / auth ---
    def test_healthz_is_open(self):
        status, data = self._request("GET", "/healthz")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(data)["ok"])

    def test_api_requires_auth(self):
        status, _ = self._request("GET", "/api/v1/jobs/whatever")
        self.assertEqual(status, 401)
        body = _multipart(("step", "a.step", b"x", None))
        status, _ = self._request("POST", "/api/v1/jobs", body=body,
                                  headers={"Content-Type": f"multipart/form-data; boundary={_BOUNDARY}"})
        self.assertEqual(status, 401)

    def test_wrong_key_rejected(self):
        status, _ = self._request("GET", "/api/v1/jobs/whatever",
                                  headers={"Authorization": "Bearer wrong"})
        self.assertEqual(status, 401)

    def test_x_api_key_accepted(self):
        status, data = self._request("GET", "/api/v1/jobs/whatever",
                                     headers={"X-API-Key": API_KEY})
        self.assertEqual(status, 404)  # authenticated; just not found

    # --- upload / landing ---
    def test_upload_lands_step_and_features_then_landed(self):
        step_bytes = b"ISO-10303-21;\nHEADER;\nENDSEC;\nEND-ISO-10303-21;\n"
        # features is a TEXT field (no filename): the JSON string itself.
        status, data = self._submit(
            ("step", "part.step", step_bytes, "application/octet-stream"),
            ("features", None, b'{"code":200,"partType":"rectangular_part"}', None),
        )
        self.assertEqual(status, 202)
        job_id = json.loads(data)["jobId"]

        job = self._poll(job_id)
        self.assertEqual(job["status"], "landed")
        self.assertIsNone(job["error"])
        result = job["result"]
        self.assertEqual(result["taskId"], job_id)
        self.assertEqual(result["file"], "part.step")
        self.assertIn(job_id, result["viewerUrl"])
        self.assertIn("?task=", result["viewerUrl"])
        self.assertIn("file=part.step", result["viewerUrl"])
        self.assertIn("features=", result["viewerUrl"])
        # The share URL must NEVER contain an absolute local path (taskId-only).
        self.assertIn("?task=", result["viewerUrl"])
        self.assertNotIn("dir=", result["viewerUrl"])
        rest = result["viewerUrl"].split("://", 1)[-1]  # after the scheme
        self.assertNotRegex(rest, r"[A-Za-z]:[\\/]")  # no drive-letter path
        self.assertNotIn("/D:/", result["viewerUrl"])

        task_dir = os.path.join(self._tmp.name, job_id)
        self.assertTrue(os.path.isdir(task_dir))
        files = sorted(os.listdir(task_dir))
        self.assertIn("part.step", files)
        self.assertTrue(any("特征识别" in name for name in files), files)
        with open(os.path.join(task_dir, [f for f in files if "特征识别" in f][0]), encoding="utf-8") as handle:
            self.assertEqual(json.loads(handle.read())["partType"], "rectangular_part")

    def test_features_text_field_with_filename_is_also_accepted(self):
        # Backward-compatible: a file part (with filename) is tolerated too.
        status, data = self._submit(
            ("step", "part.step", b"ISO-10303-21;", None),
            ("features", "features.json", b'{"code":200,"partType":"rectangular_part"}', "application/json"),
        )
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed")
        self.assertNotEqual(job["result"]["features"], "")

    def test_upload_without_features(self):
        step_bytes = b"ISO-10303-21;\nEND-ISO-10303-21;\n"
        status, data = self._submit(("step", "plain.step", step_bytes, None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed")
        self.assertEqual(job["result"]["features"], "")
        self.assertNotIn("features=", job["result"]["viewerUrl"])

    # --- validation errors ---
    def test_missing_step_is_400(self):
        status, _ = self._submit()
        self.assertEqual(status, 400)

    def test_wrong_extension_is_400(self):
        status, _ = self._submit(("step", "part.txt", b"x", None))
        self.assertEqual(status, 400)

    def test_invalid_features_json_is_400(self):
        status, _ = self._submit(
            ("step", "part.step", b"ISO-10303-21;", None),
            ("features", None, b"{not json", None),
        )
        self.assertEqual(status, 400)

    def test_features_json_with_utf8_bom_is_accepted(self):
        # Windows tools often write JSON with a leading UTF-8 BOM; the API must
        # tolerate it (utf-8-sig) and land a clean (BOM-free) file.
        bom = b"\xef\xbb\xbf"
        status, data = self._submit(
            ("step", "part.step", b"ISO-10303-21;", None),
            ("features", None, bom + b'{"code":200,"partType":"rectangular_part"}', None),
        )
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed")
        task_dir = os.path.join(self._tmp.name, job["jobId"])
        features_path = os.path.join(task_dir, "part.特征识别.json")
        with open(features_path, "rb") as handle:
            raw = handle.read()
        self.assertFalse(raw.startswith(bom), "landed features file must not keep the BOM")
        self.assertEqual(json.loads(raw.decode("utf-8"))["partType"], "rectangular_part")

    def test_not_multipart_is_400(self):
        status, _ = self._request("POST", "/api/v1/jobs", body=b"step=hello",
                                  headers={"Content-Type": "application/x-www-form-urlencoded",
                                           **self._auth()})
        self.assertEqual(status, 400)

    def test_unknown_job_is_404(self):
        status, _ = self._request("GET", "/api/v1/jobs/does-not-exist", headers=self._auth())
        self.assertEqual(status, 404)

    def test_job_persists_to_disk_and_recovers_after_restart(self):
        # Job records must survive a server restart via uploads/<jobId>/job.json.
        status, data = self._submit(("step", "part.step", b"ISO-10303-21;", None))
        self.assertEqual(status, 202)
        job_id = json.loads(data)["jobId"]
        job = self._poll(job_id)
        self.assertEqual(job["status"], "landed")

        job_file = os.path.join(self._tmp.name, job_id, "job.json")
        self.assertTrue(os.path.isfile(job_file), "job.json must be persisted")
        with open(job_file, encoding="utf-8") as handle:
            self.assertEqual(json.loads(handle.read())["jobId"], job_id)

        # Simulate a restart: a brand-new store must recover the job from disk.
        fresh_store = api_server._JobStore()
        recovered = fresh_store.get(job_id)
        self.assertIsNotNone(recovered)
        self.assertEqual(recovered["status"], "landed")
        self.assertEqual(recovered["result"]["taskId"], job_id)

    # --- prewarm ---
    def test_prewarm_payload_ok(self):
        self.assertTrue(api_server._prewarm_payload_ok({"ok": True, "state": "ready"}))
        self.assertFalse(api_server._prewarm_payload_ok({"ok": False, "error": "boom"}))
        self.assertFalse(api_server._prewarm_payload_ok({"state": "needs-build"}))
        self.assertFalse(api_server._prewarm_payload_ok(None))

    def test_prewarm_job_marks_ready_on_success(self):
        job_id = api_server._JOBS.create()["jobId"]
        with mock.patch("urllib.request.urlopen") as urlopen:
            resp = mock.Mock()
            resp.read.return_value = b'{"ok":true,"state":"ready"}'
            urlopen.return_value.__enter__.return_value = resp
            api_server._prewarm_job(job_id, "part.step")
        self.assertEqual(api_server._JOBS.get(job_id)["prewarm"], "ready")

    def test_prewarm_job_marks_failed_on_build_error(self):
        job_id = api_server._JOBS.create()["jobId"]
        with mock.patch("urllib.request.urlopen") as urlopen:
            resp = mock.Mock()
            resp.read.return_value = b'{"ok":false,"error":"cadgen failed"}'
            urlopen.return_value.__enter__.return_value = resp
            api_server._prewarm_job(job_id, "part.step")
        self.assertEqual(api_server._JOBS.get(job_id)["prewarm"], "failed")

    def test_prewarm_job_marks_failed_on_network_error(self):
        job_id = api_server._JOBS.create()["jobId"]
        with mock.patch("urllib.request.urlopen", side_effect=OSError("conn refused")):
            api_server._prewarm_job(job_id, "part.step")
        self.assertEqual(api_server._JOBS.get(job_id)["prewarm"], "failed")

    def test_land_job_submits_prewarm_when_executor_configured(self):
        api_server._Ctx.prewarm_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            status, data = self._submit(("step", "part.step", b"ISO-10303-21;", None))
            self.assertEqual(status, 202)
            job_id = json.loads(data)["jobId"]
            self._poll(job_id)
            # No real viewer is reachable: the prewarm thread should end at "failed",
            # which proves the submit path fired without breaking the job.
            for _ in range(20):
                if api_server._JOBS.get(job_id)["prewarm"] not in ("queued", "running"):
                    break
                time.sleep(0.05)
            job = api_server._JOBS.get(job_id)
            self.assertEqual(job["status"], "landed")  # job unaffected
            self.assertEqual(job["prewarm"], "failed")
        finally:
            api_server._Ctx.prewarm_executor.shutdown(wait=False)
            api_server._Ctx.prewarm_executor = None

    # --- advertised viewer authority ---
    def test_viewer_authority_prefers_base_url(self):
        api_server._Ctx.viewer_base_url = "http://192.168.1.10:4321"
        self.assertEqual(api_server._viewer_authority(), "192.168.1.10:4321")
        api_server._Ctx.viewer_base_url = ""
        api_server._Ctx.viewer_host = "10.0.0.5"
        api_server._Ctx.viewer_port = 3456
        self.assertEqual(api_server._viewer_authority(), "10.0.0.5:3456")


if __name__ == "__main__":
    unittest.main()
