import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from unittest.mock import patch

import sys

spec = importlib.util.spec_from_file_location("metrics_agent", Path(__file__).parents[1] / "agent.py")
agent = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = agent
spec.loader.exec_module(agent)


class ConfigTests(unittest.TestCase):
    def config(self, **overrides):
        return agent.Config.from_dict({"consoleUrl": "https://console.example", "nodeId": "node-1",
                                       "token": "private-test-token", **overrides})

    def test_https_and_literal_loopback_only(self):
        for origin in ("https://example.com", "http://localhost:1234", "http://127.0.0.1:1234", "http://[::1]:1234"):
            self.assertTrue(self.config(consoleUrl=origin))
        for origin in ("http://example.com", "http://localhost.example", "http://10.0.0.1", "ftp://example.com",
                       "https://user:pass@example.com", "https://example.com/path", "https://example.com?key=value",
                       "https://example.com/#x", "https://example.com:invalid", "https://example.com\n"):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                self.config(consoleUrl=origin)

    def test_invalid_values_and_secret_repr(self):
        for key, value in (("nodeId", "../other"), ("token", "secret\nInjected: header"), ("intervalMs", True),
                           ("intervalMs", 199), ("intervalMs", 60001), ("intervalMs", 1000.0)):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.config(**{key: value})
        self.assertNotIn("private-test-token", repr(self.config()))
        self.assertEqual(self.config().interval_ms, 1000)

    @unittest.skipIf(os.name == "nt", "POSIX mode checks")
    def test_private_config_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"consoleUrl": "https://example.com", "nodeId": "n", "token": "secret"}))
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "private"):
                agent.Config.load(str(path))
            path.chmod(0o600)
            self.assertEqual(agent.Config.load(str(path)).node_id, "n")
            link = Path(directory) / "link.json"
            link.symlink_to(path)
            with self.assertRaises(ValueError):
                agent.Config.load(str(link))


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.reply = {"intervalMs": 200}
        self.redirect = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                owner.requests.append((self.path, dict(self.headers), json.loads(body)))
                self.send_response(302 if owner.redirect else 201)
                if owner.redirect:
                    self.send_header("Location", f"http://127.0.0.1:{owner.server.server_port}/stolen")
                self.end_headers()
                self.wfile.write(json.dumps(owner.reply).encode())

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        config = agent.Config.from_dict({"consoleUrl": f"http://127.0.0.1:{self.server.server_port}",
                                         "nodeId": "n", "token": "private-test-token"})
        self.transport = agent.Transport(config)
        self.sample = {"timestamp": 123, "intervalMs": 1000, "cpuPct": None, "memory": None,
                       "network": None, "disks": [], "gpus": [], "uptimeSec": None}

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_auth_wire_shape_and_interval(self):
        self.assertEqual(self.transport.send(self.sample), 200)
        path, headers, body = self.requests[0]
        self.assertEqual(path, "/api/ingest/n")
        self.assertEqual(headers["Authorization"], "Bearer private-test-token")
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertEqual(headers["X-Agent-Capabilities"], "cpu,memory,disk,network")
        self.assertIn("X-Agent-Platform", headers)
        self.assertEqual(body, self.sample)
        for invalid in (True, 199, 60001, "200", None, 200.5):
            self.reply = {"intervalMs": invalid}
            self.assertIsNone(self.transport.send(self.sample))
        self.reply = {"intervalMs": 60000}
        self.assertEqual(self.transport.send(self.sample), 60000)

    def test_never_follow_redirect_even_same_origin(self):
        self.redirect = True
        with self.assertRaises(OSError):
            self.transport.send(self.sample)
        self.assertEqual(len(self.requests), 1)


class SamplingTests(unittest.TestCase):
    def setUp(self):
        self.sampler = agent.Sampler()
        self.counters = {"eth0": SimpleNamespace(bytes_recv=1000, bytes_sent=500),
                         "lo": SimpleNamespace(bytes_recv=50000, bytes_sent=50000)}
        self.patches = [patch.object(agent.psutil, "net_io_counters", side_effect=lambda **kw: self.counters),
                        patch.object(agent.psutil, "net_if_stats", return_value={}),
                        patch.object(agent.psutil, "net_if_addrs", return_value={})]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def test_baseline_delta_loopback_reset_and_missing(self):
        self.assertEqual(self.sampler.network(10), {"rxBytesPerSec": None, "txBytesPerSec": None})
        self.counters = {"eth0": SimpleNamespace(bytes_recv=1200, bytes_sent=600),
                         "lo": SimpleNamespace(bytes_recv=999999, bytes_sent=999999)}
        self.assertEqual(self.sampler.network(12), {"rxBytesPerSec": 100, "txBytesPerSec": 50})
        self.counters = {"eth0": SimpleNamespace(bytes_recv=5, bytes_sent=None)}
        self.assertEqual(self.sampler.network(13), {"rxBytesPerSec": None, "txBytesPerSec": None})
        self.counters = {}
        self.assertIsNone(self.sampler.network(14))

    def test_new_interface_does_not_count_since_boot(self):
        self.sampler.network(10)
        self.counters["eth1"] = SimpleNamespace(bytes_recv=9999999, bytes_sent=9999999)
        self.assertEqual(self.sampler.network(11), {"rxBytesPerSec": None, "txBytesPerSec": None})

    def test_failures_are_null_cpu_warmup_and_unique_timestamps(self):
        with patch.object(agent.psutil, "virtual_memory", side_effect=OSError), \
                patch.object(agent.psutil, "boot_time", side_effect=OSError), \
                patch.object(agent.psutil, "cpu_percent", return_value=42), \
                patch.object(agent.time, "time", return_value=100):
            first = self.sampler.sample(235, [], [])
            second = self.sampler.sample(240, [], [])
        self.assertIsNone(first["cpuPct"])
        self.assertIsNone(first["memory"])
        self.assertIsNone(first["uptimeSec"])
        self.assertEqual(second["cpuPct"], 42)
        self.assertGreater(second["timestamp"], first["timestamp"])
        self.assertEqual(first["intervalMs"], 235)

    def test_gpu_unavailable_fields_are_null(self):
        output = "GPU-1, Example GPU, [N/A], 2, 10, [Not Supported]\n"
        with patch.object(agent.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout=output)):
            gpu = agent.read_gpus()[0]
        self.assertIsNone(gpu["utilizationPct"])
        self.assertIsNone(gpu["temperatureC"])
        self.assertEqual(gpu["memoryUsedBytes"], 2 * 1024 * 1024)


class ConcurrencyTests(unittest.TestCase):
    def config(self):
        return agent.Config("https://example.com", "node", "secret", 200)

    def test_latest_wins_and_close_unblocks(self):
        queue = agent.LatestSample()
        for timestamp in range(1000):
            queue.put({"timestamp": timestamp})
        self.assertEqual(queue.get(), {"timestamp": 999})
        result = []
        thread = threading.Thread(target=lambda: result.append(queue.get()))
        thread.start()
        queue.close()
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, [None])

    def test_slow_transport_drops_old_samples_without_duplicates(self):
        worker = agent.Agent(self.config())
        started, release = threading.Event(), threading.Event()
        sent = []

        def send(sample):
            sent.append(sample["timestamp"])
            if len(sent) == 1:
                started.set()
                release.wait(2)
            else:
                worker.shutdown()
            return 400

        worker.transport.send = send
        thread = threading.Thread(target=worker._send)
        thread.start()
        worker.pending.put({"timestamp": 1})
        self.assertTrue(started.wait(1))
        for timestamp in range(2, 100):
            worker.pending.put({"timestamp": timestamp})
        release.set()
        thread.join(2)
        worker.shutdown()
        self.assertFalse(thread.is_alive())
        self.assertEqual(sent, [1, 99])
        self.assertEqual(worker._interval, 400)

    def test_failure_does_not_log_secret_or_retry_old_sample(self):
        worker = agent.Agent(self.config())
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        agent.LOG.addHandler(handler)
        self.addCleanup(agent.LOG.removeHandler, handler)

        def fail(sample):
            worker.shutdown()
            raise RuntimeError("secret")

        worker.transport.send = fail
        worker.pending.put({"timestamp": 1})
        worker._send()
        self.assertNotIn("secret", stream.getvalue())
        self.assertIn("reconnecting", stream.getvalue())

    def test_sampling_continues_while_gpu_and_disk_and_http_block(self):
        worker = agent.Agent(self.config())
        sampled = []
        blocking = threading.Event()
        original = agent.Sampler.sample

        def sample(sampler, interval, disks, gpus):
            value = original(sampler, interval, disks, gpus)
            sampled.append(value)
            if len(sampled) >= 4:
                worker.shutdown()
                blocking.set()
            return value

        with patch.object(agent, "read_disks", side_effect=lambda: blocking.wait(2) or []), \
                patch.object(agent, "read_gpus", side_effect=lambda: blocking.wait(2) or []), \
                patch.object(agent.Sampler, "sample", sample), \
                patch.object(worker.transport, "send", side_effect=lambda value: blocking.wait(2) and None):
            thread = threading.Thread(target=worker.run)
            thread.start()
            thread.join(3)
            worker.shutdown()
            blocking.set()
            thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertGreaterEqual(len(sampled), 4)
        for value in sampled[1:]:
            self.assertGreaterEqual(value["intervalMs"], 180)
            self.assertLess(value["intervalMs"], 1000)


if __name__ == "__main__":
    unittest.main()
