#!/usr/bin/env python3
"""Small outbound-only metrics agent. Python 3.10+; see README.md."""
from __future__ import annotations

import argparse
import csv
import ipaddress
import json
import logging
import math
import os
import platform
import re
import signal
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any

import psutil

LOG = logging.getLogger("console-agent")
MIN_INTERVAL = 200
MAX_INTERVAL = 60_000


def valid_interval(value: Any) -> bool:
    return type(value) is int and MIN_INTERVAL <= value <= MAX_INTERVAL


def _windows_private(path: str) -> None:
    # Use SIDs, so this works on localized Windows installations. No secret is
    # passed to PowerShell; only the config path is placed in its environment.
    script = """
    $ErrorActionPreference = 'Stop'
    $acl = Get-Acl -LiteralPath $env:CONSOLE_AGENT_CONFIG
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $allowed = @($me, 'S-1-5-18', 'S-1-5-32-544')
    if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -notin $allowed) { exit 1 }
    foreach ($rule in $acl.Access) {
      $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $allowed) { exit 1 }
    }
    exit 0
    """
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            env={**os.environ, "CONSOLE_AGENT_CONFIG": os.path.abspath(path)},
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, timeout=10, check=False,
        )
        if result.returncode != 0:
            raise ValueError("config must have private Windows permissions")
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError("cannot verify private Windows config permissions") from None


@dataclass(frozen=True)
class Config:
    console_url: str
    node_id: str
    token: str = field(repr=False)
    interval_ms: int = 1000

    @classmethod
    def from_dict(cls, data: Any) -> "Config":
        if not isinstance(data, dict):
            raise ValueError("config must be a JSON object")
        url, node, token = (data.get(key) for key in ("consoleUrl", "nodeId", "token"))
        interval = data.get("intervalMs", 1000)
        if not isinstance(url, str) or not isinstance(node, str) or not isinstance(token, str):
            raise ValueError("config requires consoleUrl, nodeId, and token strings")
        try:
            parsed = urllib.parse.urlsplit(url)
            host, port = parsed.hostname, parsed.port
            local = bool(host and (host.lower() == "localhost" or ipaddress.ip_address(host).is_loopback))
        except ValueError:
            # A normal DNS hostname is allowed for HTTPS, but never for HTTP.
            try:
                parsed = urllib.parse.urlsplit(url)
                host, port = parsed.hostname, parsed.port
                local = bool(host and host.lower() == "localhost")
            except ValueError:
                raise ValueError("invalid consoleUrl") from None
        if (not host or parsed.username is not None or parsed.password is not None
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or parsed.scheme not in ("https", "http")
                or (parsed.scheme == "http" and not local)
                or any(c.isspace() or ord(c) < 32 for c in url)):
            raise ValueError("consoleUrl must be an HTTPS origin (HTTP only for loopback)")
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", node):
            raise ValueError("invalid nodeId")
        if not token or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError("token must be a nonempty printable ASCII string without whitespace")
        if not valid_interval(interval):
            raise ValueError("intervalMs must be an integer from 200 to 60000")
        return cls(url.rstrip("/"), node, token, interval)

    @classmethod
    def load(cls, path: str) -> "Config":
        try:
            if os.name == "nt":
                if os.path.islink(path):
                    raise ValueError("config must not be a symbolic link")
                _windows_private(path)
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            with os.fdopen(fd, "r", encoding="utf-8") as handle:
                info = os.fstat(handle.fileno())
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("config must be a regular file")
                if os.name != "nt" and (info.st_mode & 0o077 or info.st_uid not in (0, os.getuid())):
                    raise ValueError("config must be private: chmod 600 and own the file")
                data = json.loads(handle.read(65537))
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("cannot read valid private JSON config") from None
        return cls.from_dict(data)


class LatestSample:
    """Exactly one pending sample; slow transport replaces older pending work."""
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._sample: dict | None = None
        self._closed = False

    def put(self, sample: dict) -> None:
        with self._condition:
            if not self._closed:
                self._sample = sample
                self._condition.notify()

    def get(self) -> dict | None:
        with self._condition:
            self._condition.wait_for(lambda: self._closed or self._sample is not None)
            if self._closed:
                return None
            sample, self._sample = self._sample, None
            return sample

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._sample = None
            self._condition.notify_all()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Transport:
    def __init__(self, config: Config, timeout: float = 5.0) -> None:
        self.config = config
        self.timeout = timeout
        # Ignore proxy environment variables: bearer credentials go directly to
        # the configured console. urllib's default TLS verification stays on.
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def send(self, sample: dict) -> int | None:
        capabilities = "cpu,memory,disk,network" + (",gpu" if sample["gpus"] else "")
        request = urllib.request.Request(
            f"{self.config.console_url}/api/ingest/{self.config.node_id}",
            data=json.dumps(sample, allow_nan=False, separators=(",", ":")).encode("utf-8"),
            headers={"Authorization": f"Bearer {self.config.token}",
                     "Content-Type": "application/json", "User-Agent": "ConsoleAgent/1",
                     "X-Agent-Platform": platform.system(), "X-Agent-Capabilities": capabilities},
            method="POST",
        )
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except urllib.error.HTTPError as error:
            error.close()
            raise OSError("ingestion failed") from None
        with response:
            if not 200 <= response.status < 300:
                raise OSError("ingestion failed")
            try:
                data = json.loads(response.read(4097))
            except (ValueError, UnicodeError):
                return None
            interval = data.get("intervalMs") if isinstance(data, dict) else None
            return interval if valid_interval(interval) else None


def number(value: Any) -> float | None:
    try:
        result = float(value)
        return result if math.isfinite(result) and result >= 0 else None
    except (TypeError, ValueError):
        return None


def read_gpus() -> list[dict]:
    try:
        result = subprocess.run(
            ["nvidia-smi", "--query-gpu=uuid,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            encoding="utf-8", errors="replace", timeout=1.5, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode:
            return []
        gpus = []
        for row in csv.reader(result.stdout.splitlines(), skipinitialspace=True):
            if len(row) != 6:
                continue
            gpu_id, name, utilization, used, total, temperature = (x.strip() for x in row)
            used_value, total_value = number(used), number(total)
            if total_value == 0:
                total_value = None
            utilization_value = number(utilization)
            gpus.append({"id": gpu_id, "name": name,
                         "utilizationPct": utilization_value if utilization_value is None or utilization_value <= 100 else None,
                         "memoryUsedBytes": None if used_value is None else int(used_value * 1024 * 1024),
                         "memoryTotalBytes": None if total_value is None else int(total_value * 1024 * 1024),
                         "temperatureC": number(temperature)})
        return gpus[:32]
    except (OSError, subprocess.TimeoutExpired):
        return []


def read_disks() -> list[dict]:
    disks, seen = [], set()
    try:
        partitions = psutil.disk_partitions(all=False)
    except (OSError, psutil.Error):
        return []
    for partition in partitions:
        if (partition.mountpoint in seen or "cdrom" in partition.opts
                or not 0 < len(partition.mountpoint) <= 256):
            continue
        seen.add(partition.mountpoint)
        try:
            usage = psutil.disk_usage(partition.mountpoint)
            disks.append({"mount": partition.mountpoint, "usedBytes": usage.used, "totalBytes": usage.total})
        except (OSError, psutil.Error):
            continue
    return disks[:64]


class Sampler:
    def __init__(self) -> None:
        self._network: dict = {}
        self._network_time: float | None = None
        self._cpu_ready = False
        self._last_timestamp = 0

    def network(self, now: float) -> dict | None:
        try:
            counters = psutil.net_io_counters(pernic=True, nowrap=True)
            stats = psutil.net_if_stats()
            addresses = psutil.net_if_addrs()
            current = {}
            for name, counter in counters.items():
                flags = getattr(stats.get(name), "flags", "")
                loopback = "loopback" in flags or name.lower() in ("lo", "lo0") or "loopback" in name.lower()
                for address in addresses.get(name, []):
                    try:
                        if ipaddress.ip_address(address.address.split("%")[0]).is_loopback:
                            loopback = True
                    except ValueError:
                        pass
                if not loopback:
                    current[name] = counter
        except (OSError, psutil.Error, AttributeError):
            self._network, self._network_time = {}, None
            return None
        previous, previous_time = self._network, self._network_time
        self._network, self._network_time = current, now
        if not current:
            return None
        result = {"rxBytesPerSec": None, "txBytesPerSec": None}
        if previous_time is None or now <= previous_time:
            return result
        # New, removed, or reset interfaces require a fresh baseline. Never turn
        # cumulative bytes since boot into a rate, or a missing counter into 0.
        if current.keys() != previous.keys():
            return result
        for field, attribute in (("rxBytesPerSec", "bytes_recv"), ("txBytesPerSec", "bytes_sent")):
            deltas = []
            for name, counter in current.items():
                value, old = getattr(counter, attribute, None), getattr(previous[name], attribute, None)
                if value is None or old is None or value < old:
                    break
                deltas.append(value - old)
            else:
                result[field] = sum(deltas) / (now - previous_time)
        return result

    def sample(self, interval_ms: int, disks: list, gpus: list) -> dict:
        now = time.monotonic()
        try:
            cpu = psutil.cpu_percent(interval=None)
            cpu = number(cpu) if self._cpu_ready else None
            self._cpu_ready = True
        except (OSError, psutil.Error):
            cpu, self._cpu_ready = None, False
        try:
            memory = psutil.virtual_memory()
            memory = {"usedBytes": memory.total - memory.available, "totalBytes": memory.total}
        except (OSError, psutil.Error):
            memory = None
        try:
            uptime = max(0, time.time() - psutil.boot_time())
        except (OSError, psutil.Error):
            uptime = None
        timestamp = max(self._last_timestamp + 1, int(time.time() * 1000))
        self._last_timestamp = timestamp
        return {"timestamp": timestamp, "intervalMs": interval_ms, "cpuPct": cpu,
                "memory": memory, "disks": disks, "network": self.network(now),
                "gpus": gpus, "uptimeSec": uptime}


class Agent:
    def __init__(self, config: Config) -> None:
        self.stop = threading.Event()
        self.pending = LatestSample()
        self.transport = Transport(config)
        self._interval = config.interval_ms
        self._lock = threading.Lock()
        self._cache = {"disks": ([], 0.0), "gpus": ([], 0.0)}

    def _slow(self, key: str, reader, seconds: float) -> None:
        while not self.stop.is_set():
            started = time.monotonic()
            value = reader()
            with self._lock:
                self._cache[key] = (value, time.monotonic())
            self.stop.wait(max(0, seconds - (time.monotonic() - started)))

    def _send(self) -> None:
        failures = 0
        while not self.stop.is_set():
            sample = self.pending.get()
            if sample is None:
                break
            try:
                interval = self.transport.send(sample)
                if interval is not None:
                    with self._lock:
                        self._interval = interval
                failures = 0
            except Exception:
                # Never stringify transport errors: they may contain credentials
                # or content from a malicious HTTP response. Do not retry samples.
                failures += 1
                delay = min(30.0, 0.5 * (2 ** min(failures - 1, 6)))
                LOG.warning("Console connection failed; reconnecting in %.1fs", delay)
                self.stop.wait(delay)

    def shutdown(self, *_args) -> None:
        self.stop.set()
        self.pending.close()

    def run(self) -> None:
        workers = [threading.Thread(target=self._send, daemon=True),
                   threading.Thread(target=self._slow, args=("gpus", read_gpus, 2.0), daemon=True),
                   threading.Thread(target=self._slow, args=("disks", read_disks, 30.0), daemon=True)]
        for worker in workers:
            worker.start()
        sampler = Sampler()
        # Prime CPU/network in this same sampling thread, then measure elapsed
        # time across each wait. CPU percent's first call is not a measurement.
        sampler.sample(1, [], [])
        previous = time.monotonic()
        try:
            while not self.stop.is_set():
                with self._lock:
                    interval = self._interval
                if self.stop.wait(max(0, previous + interval / 1000 - time.monotonic())):
                    break
                now = time.monotonic()
                elapsed = max(1, round((now - previous) * 1000))
                previous = now
                with self._lock:
                    disks, disk_time = self._cache["disks"]
                    gpus, gpu_time = self._cache["gpus"]
                self.pending.put(sampler.sample(elapsed, disks if now - disk_time <= 90 else [],
                                                gpus if now - gpu_time <= 6 else []))
        finally:
            self.shutdown()
            # A stuck disk syscall cannot delay process exit. HTTP has its own
            # finite timeout; all workers are daemon threads.
            deadline = time.monotonic() + 6
            for worker in workers:
                worker.join(timeout=max(0, deadline - time.monotonic()))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, help="path to a private JSON configuration file")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = Config.load(args.config)
    except ValueError as error:
        LOG.error("%s", error)
        return 2
    agent = Agent(config)
    signal.signal(signal.SIGINT, agent.shutdown)
    signal.signal(signal.SIGTERM, agent.shutdown)
    agent.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
