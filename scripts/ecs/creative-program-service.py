"""Manage a socket-activated, offline Chromium worker on the Linux host."""
import argparse
import grp
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess


def systemctl(*arguments, check=True):
    return subprocess.run(["systemctl", *arguments], check=check, capture_output=True, text=True)


def mount_source(value, directory=False):
    path = Path(value).resolve(strict=True)
    if not re.fullmatch(r"/[a-zA-Z0-9./_+-]+", str(path)) or not (
        path.is_dir() if directory else path.is_file()
    ):
        raise ValueError(f"Invalid runtime dependency: {path}")
    return path


def names(args):
    if not re.fullmatch(r"zhiwei-creative(?:-[a-z0-9][a-z0-9-]{0,19})?", args.name):
        raise ValueError("Invalid worker unit name")
    unit_dir = Path("/etc/systemd/system" if args.persistent else "/run/systemd/system")
    files_dir = Path("/var/lib" if args.persistent else "/run") / (args.name + "-root")
    return unit_dir, files_dir, Path("/run") / args.name / "program.sock"


def unit_text(args, jail, socket):
    group = grp.getgrnam(args.client_group).gr_name
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", group):
        raise ValueError("Invalid client group")
    node = mount_source(args.node)
    chrome = mount_source(args.browser)
    playwright = mount_source(Path(args.dependencies) / "playwright-core", directory=True)
    worker = mount_source(Path(args.source) / "src/creative-program-runner.js")
    worker_user = "zwcp" + hashlib.sha256(args.name.encode()).hexdigest()[:12]
    bindings = {
        "/usr": "/usr", "/etc/fonts": "/etc/fonts", str(node): "/app/node",
        str(chrome.parent): "/app/chrome", str(playwright): "/app/node_modules/playwright-core",
        str(worker): "/app/src/creative-program-runner.js",
    }
    if Path("/etc/ld.so.cache").is_file():
        bindings["/etc/ld.so.cache"] = "/etc/ld.so.cache"
    mounts = "\n".join("BindReadOnlyPaths=" + src + ":" + dest for src, dest in bindings.items())
    service = f"""[Unit]
Description=Offline browser for one Zhiwei work

[Service]
ExecStart=/app/node /app/src/creative-program-runner.js --worker
WorkingDirectory=/app
Environment=CREATIVE_PROGRAM_BROWSER=/app/chrome/{chrome.name} HOME=/tmp TMPDIR=/tmp LANG=C.UTF-8
StandardInput=socket
StandardOutput=inherit
StandardError=journal
DynamicUser=yes
User={worker_user}
RootDirectory={jail}
MountAPIVFS=yes
{mounts}
TemporaryFileSystem=/tmp:rw,nosuid,nodev,noexec,size=128M,mode=1777
TemporaryFileSystem=/run:ro,nosuid,nodev,noexec,size=1M
PrivateNetwork=yes
PrivateIPC=yes
RestrictAddressFamilies=AF_UNIX
PrivateDevices=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
ProtectSystem=strict
ReadWritePaths=/tmp
ProtectHome=yes
ProtectProc=invisible
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
UMask=0077
MemoryMax=480M
MemorySwapMax=0
TasksMax=256
CPUQuota=100%
RuntimeMaxSec=40
TimeoutStopSec=2
KillMode=control-group
"""
    listener = f"""[Unit]
Description=Accept private Zhiwei browser jobs

[Socket]
ListenStream={socket}
Accept=yes
SocketUser=root
SocketGroup={group}
SocketMode=0660
DirectoryMode=0755
MaxConnections=1
RemoveOnStop=yes

[Install]
WantedBy=sockets.target
"""
    return {args.name + "@.service": service, args.name + ".socket": listener}, bindings


def remove_units(args, unit_dir, jail, socket, units):
    # Both the unit files and jail must belong to this particular installation.
    record = json.loads((jail / ".installation").read_text())
    if record["name"] != args.name or set(record["units"]) != set(units):
        raise ValueError("Worker installation record does not match")
    for name, digest in record["units"].items():
        if hashlib.sha256((unit_dir / name).read_bytes()).hexdigest() != digest:
            raise ValueError(f"Unit was edited since installation: {name}")
    listener = args.name + ".socket"
    systemctl("stop", listener)
    if args.persistent:
        systemctl("disable", listener)
    # A stopped listener may still have an accepted connection.
    systemctl("stop", args.name + "@*.service")
    for name in units:
        (unit_dir / name).unlink()
    systemctl("daemon-reload")
    shutil.rmtree(jail)
    if socket.parent.exists():
        socket.parent.rmdir()


def manage(args):
    if os.geteuid() != 0:
        raise PermissionError("system unit setup requires root")
    unit_dir, jail, socket = names(args)
    units = (args.name + "@.service", args.name + ".socket")
    if args.action == "stop":
        remove_units(args, unit_dir, jail, socket, units)
        return {"removed": True}
    config, bindings = unit_text(args, jail, socket)
    if jail.exists() or socket.parent.exists() or any(
        (Path(folder) / name).exists()
        for folder in ("/run/systemd/system", "/etc/systemd/system", "/usr/lib/systemd/system")
        for name in units
    ):
        raise FileExistsError("The selected unit, jail, or listener directory already exists")
    created = []
    jail.mkdir(mode=0o755)
    try:
        for child in ["tmp", "dev", "proc", "sys", "run", "home", "app/src", "app/node_modules"]:
            (jail / child).mkdir(parents=True, exist_ok=True)
        for src, dest in bindings.items():
            entry = jail / dest.lstrip("/")
            entry.parent.mkdir(parents=True, exist_ok=True)
            if Path(src).is_dir():
                entry.mkdir(exist_ok=True)
            else:
                entry.touch()
        for child in ("bin", "sbin", "lib", "lib64"):
            target = Path("/") / child
            if target.is_symlink():
                (jail / child).symlink_to(os.readlink(target))
        (jail / "app/package.json").write_text('{"type":"module"}\n')
        marker = jail / ".zhiwei-offline-worker"
        marker.touch(mode=0o444)
        for name, content in config.items():
            path = unit_dir / name
            with path.open("x") as stream:
                created.append(path)
                stream.write(content)
        (jail / ".installation").write_text(json.dumps({
            "name": args.name, "units": {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in created},
        }))
        systemctl("daemon-reload")
        if args.persistent:
            systemctl("enable", args.name + ".socket")
        systemctl("start", args.name + ".socket")
        if not socket.is_socket():
            raise RuntimeError("Worker socket failed to start")
    except BaseException:
        if len(created) == len(units):
            systemctl("stop", args.name + ".socket", check=False)
            if args.persistent:
                systemctl("disable", args.name + ".socket", check=False)
        for path in created:
            path.unlink()
        systemctl("daemon-reload")
        shutil.rmtree(jail)
        if socket.parent.exists():
            socket.parent.rmdir()
        raise
    return {"socket": str(socket), "root": str(jail)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    for action in ("start", "stop"):
        command = commands.add_parser(action)
        command.add_argument("--name", default="zhiwei-creative")
        command.add_argument("--persistent", action="store_true")
        if action == "start":
            for option in ("source", "node", "dependencies", "browser"):
                command.add_argument("--" + option, required=True)
            command.add_argument("--client-group", default="zhiwei")
    print(json.dumps(manage(parser.parse_args())))
