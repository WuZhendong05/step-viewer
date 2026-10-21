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
from http.server import BaseHTTPRequestHandler
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from server_py import api_server  # noqa: E402

API_KEY = "test-secret-key"
_BOUNDARY = "----step-viewer-test-boundary-7d1f2a"
STEP_DOC = b"ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"


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


class _StepHost(BaseHTTPRequestHandler):
    """A local stand-in for the business system's file host.

    The class attributes are the knobs each test flips; ``seen`` records every
    request line so a test can PROVE that a rejected download never moved a byte
    (``["HEAD /big.step"]`` with no GET). HTTP/1.0 on purpose: with ``omit_length``
    the response is close-delimited, which is how the streaming size cap gets
    exercised against a server that withholds Content-Length.
    """

    protocol_version = "HTTP/1.0"
    payload = STEP_DOC
    status = 200
    location = ""
    content_disposition = ""
    omit_length = False
    seen: list = []

    @classmethod
    def reset(cls):
        cls.payload = STEP_DOC
        cls.status = 200
        cls.location = ""
        cls.content_disposition = ""
        cls.omit_length = False
        cls.seen = []

    def log_message(self, *args):
        pass

    def _respond(self, with_body):
        type(self).seen.append(f"{self.command} {self.path}")
        if type(self).location:
            self.send_response(302)
            self.send_header("location", type(self).location)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self.send_response(type(self).status)
        if type(self).status == 200:
            self.send_header("content-type", "application/octet-stream")
            if type(self).content_disposition:
                self.send_header("content-disposition", type(self).content_disposition)
            if not type(self).omit_length:
                self.send_header("content-length", str(len(type(self).payload)))
        else:
            self.send_header("content-length", "0")
        self.end_headers()
        if with_body:
            self.wfile.write(type(self).payload)

    def do_HEAD(self):
        self._respond(False)

    def do_GET(self):
        self._respond(True)


class ApiServerTest(unittest.TestCase):
    def setUp(self):
        # ignore_cleanup_errors: on Windows the temp tree can still be held by an
        # indexer/AV (or, in a sandbox, by a file-op interposer) when cleanup runs —
        # a leftover temp dir must not fail an otherwise green test.
        self._tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
        self._old_upload_root = os.environ.get("VIEWER_UPLOAD_ROOT")
        os.environ["VIEWER_UPLOAD_ROOT"] = self._tmp.name
        api_server._Ctx.api_key = API_KEY
        api_server._Ctx.viewer_base_url = ""
        api_server._Ctx.viewer_host = "127.0.0.1"
        api_server._Ctx.viewer_port = 3245
        api_server._Ctx.prewarm_url = "http://127.0.0.1:3245"  # absolute: Request() rejects relative URLs
        self._old_url_rules = api_server._Ctx.url_allow_rules
        self._old_url_timeout = api_server._Ctx.url_timeout
        self._old_max_upload = api_server._Ctx.max_upload_bytes
        # stepUrl is opt-in in production; tests opt in for loopback unless they say otherwise.
        api_server._Ctx.url_allow_rules = api_server.parse_allow_rules("127.0.0.0/8")
        api_server._Ctx.url_timeout = 5
        _StepHost.reset()
        self._file_host = api_server.ThreadingHTTPServer(("127.0.0.1", 0), _StepHost)
        threading.Thread(target=self._file_host.serve_forever, daemon=True).start()
        self._url_base = f"http://127.0.0.1:{self._file_host.server_address[1]}"
        self._server = api_server.ThreadingHTTPServer(("127.0.0.1", 0), api_server.Handler)
        self._port = self._server.server_address[1]
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def tearDown(self):
        api_server._Ctx.url_allow_rules = self._old_url_rules
        api_server._Ctx.url_timeout = self._old_url_timeout
        api_server._Ctx.max_upload_bytes = self._old_max_upload
        self._file_host.shutdown()
        self._file_host.server_close()
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

    def _poll(self, job_id, attempts=200):
        """Wait for a TERMINAL status.

        'fetching' is deliberately not terminal: it means the download is still in
        flight, not that the job is done.
        """
        for _ in range(attempts):
            status, data = self._request("GET", f"/api/v1/jobs/{job_id}", headers=self._auth())
            self.assertEqual(status, 200)
            job = json.loads(data)
            if job["status"] in ("landed", "failed"):
                return job
            time.sleep(0.02)
        self.fail(f"job {job_id} never reached a terminal status")

    def _set_url_allow(self, spec):
        api_server._Ctx.url_allow_rules = api_server.parse_allow_rules(spec)

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

    # --- step / stepUrl: the 二选一 contract ---
    def test_both_step_and_stepurl_is_400(self):
        status, data = self._submit(
            ("step", "part.step", STEP_DOC, None),
            ("stepUrl", None, f"{self._url_base}/part.step".encode(), None),
        )
        self.assertEqual(status, 400)
        self.assertIn("both were provided", json.loads(data)["error"])

    def test_neither_source_is_400(self):
        status, data = self._submit(("features", None, b'{"code":200}', None))
        self.assertEqual(status, 400)
        error = json.loads(data)["error"]
        self.assertIn("'step'", error)
        self.assertIn("'stepUrl'", error)

    def test_url_in_the_step_row_is_400(self):
        # A URL sent as a TEXT 'step' row is a caller bug, not a quiet feature: it
        # must fail loudly and point at the right field.
        status, data = self._submit(("step", None, f"{self._url_base}/part.step".encode(), None))
        self.assertEqual(status, 400)
        self.assertIn("stepUrl", json.loads(data)["error"])

    def test_empty_step_row_is_400(self):
        status, data = self._submit(("step", "", b"", None))
        self.assertEqual(status, 400)
        self.assertIn("empty", json.loads(data)["error"])

    # --- stepUrl: download path ---
    def test_stepurl_downloads_and_lands(self):
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/part.step".encode(), None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed", job.get("error"))
        self.assertEqual(job["result"]["file"], "part.step")
        self.assertEqual(job["source"]["mode"], "url")
        task_dir = os.path.join(self._tmp.name, job["jobId"])
        with open(os.path.join(task_dir, "part.step"), "rb") as handle:
            self.assertEqual(handle.read(), STEP_DOC)
        self.assertEqual([n for n in os.listdir(task_dir) if n.startswith(".tmp-fetch-")], [],
                         "the fetch temp file must not survive landing")

    def test_stepurl_lands_features_sidecar_too(self):
        status, data = self._submit(
            ("stepUrl", None, f"{self._url_base}/part.step".encode(), None),
            ("features", None, b'{"code":200,"partType":"rectangular_part"}', None),
        )
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed", job.get("error"))
        self.assertEqual(job["result"]["features"], "part.特征识别.json")
        self.assertIn("features=", job["result"]["viewerUrl"])

    def test_stepurl_name_resolution(self):
        # 1) an explicit stepName wins when the URL carries no usable file name
        status, data = self._submit(
            ("stepUrl", None, f"{self._url_base}/download".encode(), None),
            ("stepName", None, b"JTZH.01.01-03.step", None),
        )
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed", job.get("error"))
        self.assertEqual(job["result"]["file"], "JTZH.01.01-03.step")

        # 2) Content-Disposition rescues a nameless URL
        _StepHost.content_disposition = 'attachment; filename="from-header.step"'
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/download".encode(), None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed", job.get("error"))
        self.assertEqual(job["result"]["file"], "from-header.step")

        # 3) nothing to name it with: a failed job that says exactly what to add
        _StepHost.content_disposition = ""
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/download".encode(), None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "failed")
        self.assertIn("url_name_unknown", job["error"])
        self.assertIn("stepName", job["error"])

    def test_stepurl_bad_stepname_is_400(self):
        status, data = self._submit(
            ("stepUrl", None, f"{self._url_base}/part.step".encode(), None),
            ("stepName", None, b"part.txt", None),
        )
        self.assertEqual(status, 400)
        self.assertIn("Only .step/.stp", json.loads(data)["error"])

    def test_stepurl_remote_404_is_a_failed_job_not_a_400(self):
        # Caller mistake -> 400; anything the remote controls -> failed job. Keeping
        # those two channels apart is what makes the status codes trustworthy.
        _StepHost.status = 404
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/missing.step".encode(), None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "failed")
        self.assertIn("url_http_error", job["error"])
        self.assertIn("404", job["error"])

    # --- stepUrl: gating and limits ---
    def test_url_landing_name_helper(self):
        oss = ("https://yhd-service-partfiltering.oss-cn-guangzhou.aliyuncs.com/parts/f8bce4db/"
               "0a31fd0647fa4299a8af7b2c8b87b5bd/3d/0a31fd0647fa4299a8af7b2c8b87b5bd.step")
        self.assertEqual(api_server._url_landing_name(oss, "", ""),
                         "0a31fd0647fa4299a8af7b2c8b87b5bd.step")
        self.assertEqual(api_server._url_landing_name(oss, "", "JTZH.01.01-03.step"),
                         "JTZH.01.01-03.step")
        self.assertEqual(api_server._url_landing_name("https://h/download", "from-header.step", ""),
                         "from-header.step")
        with self.assertRaises(api_server._UrlFetchError) as ctx:
            api_server._url_landing_name("https://h/download", "", "")
        self.assertEqual(ctx.exception.code, "url_name_unknown")

    def test_parse_allow_rules_and_host_matching(self):
        rules = api_server.parse_allow_rules(" *.aliyuncs.com , files.corp.local , 10.20.0.0/16 ,, ")
        self.assertEqual(rules[0], ("host", "aliyuncs.com"))
        self.assertEqual(rules[1], ("host", "files.corp.local"))
        self.assertEqual(rules[2][0], "cidr")
        self.assertTrue(api_server._host_rule_match(
            "yhd-service-partfiltering.oss-cn-guangzhou.aliyuncs.com", "aliyuncs.com"))
        self.assertTrue(api_server._host_rule_match("aliyuncs.com", "aliyuncs.com"))
        self.assertFalse(api_server._host_rule_match("evil-aliyuncs.com", "aliyuncs.com"))
        with self.assertRaises(ValueError):
            api_server.parse_allow_rules("10.0.0.0/99")

    def test_redact_url_strips_query_and_userinfo(self):
        self.assertEqual(
            api_server._redact_url("https://b.oss-cn-guangzhou.aliyuncs.com/a/b.step?sig=x&e=1"),
            "https://b.oss-cn-guangzhou.aliyuncs.com/a/b.step")
        self.assertEqual(api_server._redact_url("http://u:p@host:8080/x.step?t=1"),
                         "http://host:8080/x.step")

    def test_sample_oss_host_passes_the_intended_allowlist(self):
        self._set_url_allow("*.aliyuncs.com")
        api_server._check_url("https://yhd-service-partfiltering.oss-cn-guangzhou.aliyuncs.com/"
                              "parts/f8bce4db/0a31fd0647fa4299a8af7b2c8b87b5bd/3d/"
                              "0a31fd0647fa4299a8af7b2c8b87b5bd.step")

    def test_stepurl_disabled_by_default_is_400(self):
        self._set_url_allow("")
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/part.step".encode(), None))
        self.assertEqual(status, 400)
        self.assertIn("url_fetch_disabled", json.loads(data)["error"])

    def test_stepurl_other_host_is_400(self):
        self._set_url_allow("files.corp.local,10.20.0.0/16")
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/part.step".encode(), None))
        self.assertEqual(status, 400)
        self.assertIn("url_host_not_allowed", json.loads(data)["error"])
        self.assertEqual(_StepHost.seen, [], "a rejected host must never be contacted")

    def test_stepurl_scheme_and_userinfo_are_400(self):
        for url in ("file:///D:/secret.step", "ftp://127.0.0.1/part.step",
                    "http://user:pw@127.0.0.1/part.step"):
            status, data = self._submit(("stepUrl", None, url.encode(), None))
            self.assertEqual(status, 400, url)
            self.assertTrue(json.loads(data)["error"].startswith("url_"), url)
        self.assertEqual(_StepHost.seen, [], "no request may leave the process for these")

    def test_stepurl_oversize_is_rejected_before_any_download(self):
        # The cap applies to the request body too, so it stays well above the ~175-byte
        # multipart envelope and well below the served payload.
        api_server._Ctx.max_upload_bytes = 400
        _StepHost.payload = STEP_DOC * 10
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/big.step".encode(), None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "failed")
        self.assertIn("url_too_large", job["error"])
        # Proof the body never moved: the HEAD pre-check alone rejected it.
        self.assertEqual(_StepHost.seen, ["HEAD /big.step"])

    def test_stepurl_streaming_cap_when_length_is_withheld(self):
        # Content-Length is a remote CLAIM. With it withheld the cap must still hold
        # while streaming, and the half-written temp file must be cleaned up.
        api_server._Ctx.max_upload_bytes = 400
        _StepHost.omit_length = True
        _StepHost.payload = STEP_DOC * 10
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/stream.step".encode(), None))
        self.assertEqual(status, 202)
        job_id = json.loads(data)["jobId"]
        job = self._poll(job_id)
        self.assertEqual(job["status"], "failed")
        self.assertIn("url_too_large", job["error"])
        task_dir = os.path.join(self._tmp.name, job_id)
        self.assertEqual([n for n in os.listdir(task_dir) if n.startswith(".tmp-fetch-")], [])

    def test_stepurl_redirect_off_the_allowlist_is_refused(self):
        _StepHost.location = "http://169.254.169.254/latest/meta-data/"
        status, data = self._submit(("stepUrl", None, f"{self._url_base}/part.step".encode(), None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "failed")
        self.assertIn("url_host_not_allowed", job["error"])
        self.assertEqual([s for s in _StepHost.seen if "meta-data" in s], [],
                         "the redirect target must never be followed")

    def test_stepurl_query_is_redacted_in_the_persisted_record(self):
        secret = "SECRET-SIGNATURE-abc123"
        status, data = self._submit(
            ("stepUrl", None, f"{self._url_base}/part.step?X-Amz-Signature={secret}".encode(), None))
        self.assertEqual(status, 202)
        job_id = json.loads(data)["jobId"]
        job = self._poll(job_id)
        self.assertEqual(job["status"], "landed", job.get("error"))
        self.assertEqual(job["source"]["url"], f"{self._url_base}/part.step")
        with open(os.path.join(self._tmp.name, job_id, "job.json"), encoding="utf-8") as handle:
            raw = handle.read()
        self.assertNotIn(secret, raw, "a signed URL's query must never reach disk")
        # The download itself still used the full URL — only the record is stripped.
        self.assertIn(f"GET /part.step?X-Amz-Signature={secret}", _StepHost.seen)

    def test_file_stream_path_is_unaffected_by_the_url_feature(self):
        # The regression that matters most: the pre-existing multipart contract.
        status, data = self._submit(("step", "part.step", STEP_DOC, None))
        self.assertEqual(status, 202)
        job = self._poll(json.loads(data)["jobId"])
        self.assertEqual(job["status"], "landed", job.get("error"))
        self.assertEqual(job["source"]["mode"], "file")
        self.assertEqual(_StepHost.seen, [], "a file upload must never touch the network")

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
