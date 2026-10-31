# Console metrics agent

An outbound Python 3.10+ agent for Linux and Windows. It sends CPU, memory,
mounted disk usage, network rates, uptime, and optional NVIDIA GPU metrics to
your console. It needs no listening port, host name, or IP address. A console
node ID and its bearer token identify the node. This folder does not install
anything remotely or modify existing services.

Install Python and create a dedicated virtual environment:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r agent/requirements.txt
```

Create a private JSON file, for example `/etc/console-agent/config.json`:

```json
{
  "consoleUrl": "https://console.example.com",
  "nodeId": "REPLACE_WITH_NODE_ID",
  "token": "REPLACE_WITH_NODE_TOKEN",
  "intervalMs": 1000
}
```

Replace the placeholders with the node registration values from your console.
The URL must be an HTTPS origin with no path, credentials, query, or fragment.
HTTP is accepted only for literal loopback addresses and `localhost`, for local
testing. TLS certificates are verified; redirects are rejected and environment
proxy settings are ignored. The token is read only from the config file, never
from command arguments or environment variables. Treat the JSON file as a
secret. The initial `intervalMs` defaults to 1000 and must be an integer from
200 to 60000. Changes to the file require restarting the agent.

On Linux, make the file owned by the account running the agent (or root), with
mode `0600`. Protect the parent directory too:

```sh
chmod 700 /etc/console-agent
chmod 600 /etc/console-agent/config.json
.venv/bin/python agent/agent.py --config /etc/console-agent/config.json
```

An optional new systemd service can run under a dedicated account. Place the
code and virtual environment under `/opt/console-agent`, and give the service
account read access to its private config. Create the account and directories
as appropriate for your distribution. Example `/etc/systemd/system/console-agent.service`:

```ini
[Unit]
Description=Console metrics agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=console-agent
Group=console-agent
WorkingDirectory=/opt/console-agent
ExecStart=/opt/console-agent/.venv/bin/python /opt/console-agent/agent/agent.py --config /etc/console-agent/config.json
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
```

After reviewing the new unit, start it with `sudo systemctl daemon-reload` and
`sudo systemctl enable --now console-agent`. Inspect status with
`sudo systemctl status console-agent` or `sudo journalctl -u console-agent`.

On Windows, use PowerShell and a dedicated folder, for example
`C:\ConsoleAgent`. Install dependencies and create the configuration:

```powershell
Set-Location C:\ConsoleAgent
py -3 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r .\agent\requirements.txt
# Save the JSON above as C:\ConsoleAgent\config.json, then restrict its ACL:
$account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
icacls .\config.json /inheritance:r
icacls .\config.json /grant:r "${account}:(R)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)'
.\.venv\Scripts\python.exe .\agent\agent.py --config C:\ConsoleAgent\config.json
```

Remove any pre-existing explicit grants for other users before starting. The
agent checks the owner and rejects allow rules for anyone except the running
account, SYSTEM, and Administrators. Keep the directory private too. Windows
PowerShell is used only to verify the file ACL. For startup, create a new Task
Scheduler task that runs under that same account, selects **Run whether user
is logged on or not**, triggers **At startup**, and uses the absolute venv
`python.exe` path as its program. Set arguments to
`C:\ConsoleAgent\agent\agent.py --config C:\ConsoleAgent\config.json` and start
in `C:\ConsoleAgent`. Configure the task to restart on failure and avoid a
parallel second instance. Do not put the bearer token in task arguments.

The agent samples CPU/memory/network independently of HTTP. Only the newest
pending sample is kept during connection failures; memory usage remains bounded
and historical samples are not replayed. Failed requests reconnect with an
interruptible exponential delay from 0.5 seconds up to 30 seconds. HTTP has a
five-second timeout. Successful responses may set the next target interval via
`{"intervalMs":200}` (200–60000 ms). Every sample's `intervalMs` is the actual
elapsed sampling duration; `timestamp` is Unix milliseconds. CPU and network
baselines are primed before the first transmitted sample. Missing measurements
are `null`; absent/unavailable disks and GPUs are empty arrays. Interface
changes or counter resets produce null rates until a fresh baseline is ready.
Loopback traffic is excluded. Real measured zero activity is still zero.

NVIDIA support requires `nvidia-smi` on PATH and permission to query the driver.
It runs at most once every two seconds with a 1.5-second process timeout; missing
or unsupported fields remain null. Disk enumeration runs every 30 seconds on a
separate worker. Disk/GPU snapshots expire if their workers stop completing, so
the fast sampler does not publish stale data indefinitely. Ctrl+C, SIGTERM, or
stopping the service ends the agent. A blocked disk syscall cannot hold shutdown.

Run the tests from the repository root:

```sh
.venv/bin/python -m unittest discover -s agent/tests -v
```

Dependencies: [psutil on PyPI](https://pypi.org/project/psutil/7.2.2/).
