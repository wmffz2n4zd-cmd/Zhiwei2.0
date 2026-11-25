"""Bounded anonymous video evidence worker. Invoked by video-reader.js only.

Dependencies live in a separately pinned installation; no browser cookies,
plugins, user configuration, remote component installation or model URLs.
"""
import hashlib
import html
import ipaddress
import json
import math
import os
import pathlib
import re
import resource
import socket
import subprocess
import sys
import urllib.parse

MAX_VIDEO_BYTES = 100 * 1024 * 1024
MAX_SUBTITLE_BYTES = 2 * 1024 * 1024
MAX_SECONDS = 1200
HOST_SUFFIXES = ("youtube.com", "youtu.be", "googlevideo.com", "ytimg.com",
                 "youtube-nocookie.com", "youtubei.googleapis.com", "google.com",
                 "bilibili.com", "bilivideo.com", "bilivideo.cn", "hdslb.com",
                 "akamaized.net")


class VideoError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def canonical_url(value):
    if not isinstance(value, str) or len(value) > 2048 or re.search(r"[\x00-\x20\x7f]", value):
        raise VideoError("unsupported_url")
    u = urllib.parse.urlsplit(value)
    if u.scheme != "https" or u.username or u.password or u.port not in (None, 443):
        raise VideoError("unsupported_url")
    host = (u.hostname or "").lower()
    q = urllib.parse.parse_qs(u.query)
    ident = None
    if host in ("youtube.com", "www.youtube.com", "m.youtube.com"):
        if u.path == "/watch":
            ident = q.get("v", [""])[0]
        else:
            m = re.fullmatch(r"/(?:shorts|embed)/([A-Za-z0-9_-]{11})/?", u.path)
            if m:
                ident = m[1]
    elif host == "youtu.be":
        ident = u.path.strip("/")
    if ident and re.fullmatch(r"[A-Za-z0-9_-]{11}", ident):
        return {"url": "https://www.youtube.com/watch?v=" + ident, "platform": "youtube", "id": ident}
    if host in ("bilibili.com", "www.bilibili.com", "m.bilibili.com"):
        m = re.fullmatch(r"/video/(BV[A-Za-z0-9]{10}|av[0-9]{1,20})/?", u.path)
        if m:
            p = q.get("p", ["1"])[0]
            if not p.isdigit() or not 1 <= int(p) <= 1000:
                raise VideoError("unsupported_url")
            return {"url": "https://www.bilibili.com/video/" + m[1] + ("?p=" + str(int(p)) if int(p) != 1 else ""),
                    "platform": "bilibili", "id": m[1], "part": int(p)}
    raise VideoError("unsupported_url")


def allowed_host(host):
    h = str(host).lower().rstrip(".")
    return any(h == suffix or h.endswith("." + suffix) for suffix in HOST_SUFFIXES)


def public_ip(value):
    try:
        ip = ipaddress.ip_address(value)
        # Match the retrieval layer: exclude transition/mapped IPv6 too.
        return ip.is_global and not ip.is_multicast and not ip.is_unspecified and not (
            ip.version == 6 and (ip not in ipaddress.ip_network("2000::/3") or ip.ipv4_mapped
                                 or ip in ipaddress.ip_network("2001::/23")
                                 or ip in ipaddress.ip_network("2001:db8::/32")
                                 or ip in ipaddress.ip_network("2002::/16")
                                 or ip in ipaddress.ip_network("3fff::/16")))
    except ValueError:
        return False


def install_network_guard():
    """Guard actual connects, not just a preflight DNS lookup (rebinding-safe)."""
    real_resolve, real_connect, real_connect_ex = socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex

    def resolve(host, port, *args, **kwargs):
        if isinstance(host, bytes):
            host = host.decode("ascii")
        if not allowed_host(host):
            raise VideoError("network_host_refused")
        if port not in (80, 443, "80", "443"):
            raise VideoError("network_port_refused")
        answers = real_resolve(host, port, *args, **kwargs)
        if not answers or any(not public_ip(row[4][0]) for row in answers):
            raise VideoError("network_address_refused")
        return answers

    def check(address):
        if not isinstance(address, tuple) or len(address) < 2 or address[1] not in (80, 443) or not public_ip(address[0]):
            raise VideoError("network_address_refused")

    def connect(sock, address):
        check(address)
        return real_connect(sock, address)

    def connect_ex(sock, address):
        check(address)
        return real_connect_ex(sock, address)

    socket.getaddrinfo, socket.socket.connect, socket.socket.connect_ex = resolve, connect, connect_ex


def clean_text(value, limit=1000):
    value = html.unescape(re.sub(r"<[^>]*>", "", str(value or "")))
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value).strip()[:limit]


def subtitle_cues(raw, ext, duration):
    """Parse downloaded cues only. Danmaku is never a subtitle track."""
    result = []

    def add(start, end, text):
        try:
            start, end = float(start), float(end)
        except (ValueError, TypeError):
            return
        text = clean_text(text, 1000)
        if text and math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration + 2:
            start, end = round(start, 3), round(min(end, duration), 3)
            if start < end:
                result.append({"start": start, "end": end, "text": text})

    if ext in ("json", "json3"):
        data = json.loads(raw)
        if isinstance(data.get("body"), list):
            for row in data["body"]:
                add(row.get("from"), row.get("to"), row.get("content"))
        else:
            for row in data.get("events", []):
                start = row.get("tStartMs", 0) / 1000
                add(start, start + row.get("dDurationMs", 0) / 1000, "".join(s.get("utf8", "") for s in row.get("segs", [])))
    else:
        def seconds(stamp):
            values = stamp.replace(",", ".").split(":")
            return sum(float(v) * (60 ** i) for i, v in enumerate(reversed(values)))
        for block in re.split(r"\r?\n\s*\r?\n", raw):
            lines = block.splitlines()
            for idx, line in enumerate(lines):
                match = re.match(r"((?:\d+:)?\d{2}:\d{2}[.,]\d+)\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d+)", line)
                if match:
                    add(seconds(match[1]), seconds(match[2]), "\n".join(lines[idx + 1:]))
                    break
    unique = {(r["start"], r["end"], r["text"]): r for r in result}
    return sorted(unique.values(), key=lambda r: (r["start"], r["end"]))[:2000]


def select_track(info):
    tracks = []
    for field, kind in (("subtitles", "human"), ("automatic_captions", "automatic")):
        for lang, rows in (info.get(field) or {}).items():
            if lang == "danmaku" or not re.match(r"^(?:zh|en)(?:[-_].*)?$", lang):
                continue
            for row in rows:
                if row.get("ext") in ("vtt", "srt", "json3", "json") and row.get("url"):
                    # Prefer original human Chinese, then English, then automatic.
                    score = (100 if kind == "human" else 0) + (10 if lang.startswith("zh") else 0) + {"vtt": 3, "json3": 2, "json": 2, "srt": 1}[row["ext"]]
                    tracks.append((score, {**row, "language": lang, "kind": kind}))
    return max(tracks, key=lambda x: x[0])[1] if tracks else None


class QuietLog:
    def debug(self, message): pass
    def warning(self, message): pass
    def error(self, message): pass


def require_public_metadata(info, platform):
    availability = info.get("availability")
    if availability not in (None, "public") or (info.get("age_limit") or 0) >= 18:
        raise VideoError("source_restricted")
    if platform == "youtube" and availability != "public":
        raise VideoError("source_restricted")


def fetch_bytes(ydl, url, maximum):
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password or not allowed_host(parsed.hostname):
        raise VideoError("network_url_refused")
    chunks, size = [], 0
    with ydl.urlopen(url) as response:
        while True:
            block = response.read(min(65536, maximum - size + 1))
            if not block:
                break
            size += len(block)
            if size > maximum:
                raise VideoError("media_too_large")
            chunks.append(block)
    return b"".join(chunks)


def frames_from_file(video_path, output, tool_root, at_seconds=None, count=4):
    """Only local ISO-BMFF input; no downloader/URL/playlist path reaches ffmpeg."""
    with video_path.open("rb") as handle:
        magic = handle.read(12)
    if video_path.stat().st_size > MAX_VIDEO_BYTES or magic[4:8] != b"ftyp":
        raise VideoError("invalid_video_file")
    tools = pathlib.Path(tool_root).resolve()
    library = str(tools / "usr/lib/x86_64-linux-gnu")
    env = {"PATH": "/usr/bin:/bin", "LD_LIBRARY_PATH": library + ":" + library + "/pulseaudio", "HOME": str(output)}
    probe = subprocess.run([str(tools / "usr/bin/ffprobe"), "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov",
                            "-show_entries", "format=duration:stream=codec_type,width,height", "-of", "json", str(video_path)],
                           env=env, capture_output=True, timeout=15, check=False)
    if probe.returncode or len(probe.stdout) > 65536:
        raise VideoError("video_probe_failed")
    metadata = json.loads(probe.stdout)
    duration = float(metadata.get("format", {}).get("duration", 0))
    streams = [x for x in metadata.get("streams", []) if x.get("codec_type") == "video"]
    if not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS or not streams:
        raise VideoError("video_out_of_range")
    if any(x.get("width", 0) > 4096 or x.get("height", 0) > 4096 for x in streams):
        raise VideoError("video_dimensions_exceeded")
    if at_seconds is not None:
        if not isinstance(at_seconds, (int, float)) or not math.isfinite(at_seconds) or not 0 <= at_seconds < duration:
            raise VideoError("time_out_of_range")
        stamps = sorted(set(round(max(0, min(duration - 0.05, at_seconds + offset)), 3) for offset in (-1, 0, 1)))
    else:
        stamps = [round(duration * (i + 0.5) / count, 3) for i in range(count)]
    frames = []
    for idx, stamp in enumerate(stamps):
        target = output / ("frame-" + str(idx) + ".jpg")
        process = subprocess.run([str(tools / "usr/bin/ffmpeg"), "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
                                  "-protocol_whitelist", "file", "-format_whitelist", "mov", "-ss", str(stamp), "-i", str(video_path),
                                  "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=w=1024:h=1024:force_original_aspect_ratio=decrease",
                                  "-threads", "1", "-q:v", "3", "-y", str(target)], env=env, capture_output=True, timeout=25)
        if process.returncode or not target.exists() or not 4 <= target.stat().st_size <= 2 * 1024 * 1024:
            raise VideoError("frame_decode_failed")
        data = target.read_bytes()
        if data[:3] != b"\xff\xd8\xff":
            raise VideoError("frame_decode_failed")
        frames.append({"file": target.name, "timestamp": stamp, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return duration, frames


def run(request):
    dependency_root = pathlib.Path(request["dependencyRoot"]).resolve()
    output = pathlib.Path(request["outputDir"]).resolve()
    if not output.is_dir() or output.is_symlink():
        raise VideoError("invalid_output")
    sys.path.insert(0, str(dependency_root / "lib"))
    import yt_dlp
    if request.get("mode") == "dependencies":
        import importlib.metadata
        import yt_dlp_ejs
        library = str(dependency_root / "ffmpeg-root/usr/lib/x86_64-linux-gnu")
        env = {"PATH": "/usr/bin:/bin", "HOME": str(output), "LD_LIBRARY_PATH": library + ":" + library + "/pulseaudio"}
        versions = {"ytDlp": yt_dlp.version.__version__, "ejs": importlib.metadata.version("yt-dlp-ejs")}
        for name, command in (("ffmpeg", [str(dependency_root / "ffmpeg-root/usr/bin/ffmpeg"), "-version"]),
                              ("ffprobe", [str(dependency_root / "ffmpeg-root/usr/bin/ffprobe"), "-version"]),
                              ("node", [request["nodePath"], "--version"])):
            process = subprocess.run(command, env=env, text=True, capture_output=True, timeout=5)
            if process.returncode or not process.stdout:
                raise VideoError("dependency_unavailable")
            versions[name] = process.stdout.splitlines()[0][:150]
        return {"version": 1, "status": "ready", "versions": versions}
    source = canonical_url(request.get("url"))
    install_network_guard()
    options = {"quiet": True, "no_warnings": True, "logger": QuietLog(), "socket_timeout": 10, "retries": 0, "extractor_retries": 0,
               "noplaylist": True, "skip_download": True, "cachedir": False, "proxy": "", "cookiefile": None,
               "js_runtimes": {"node": {"path": request["nodePath"]}}, "remote_components": [], "extract_flat": False,
               "playlist_items": str(source.get("part", 1)), "allow_unplayable_formats": False}
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(source["url"], download=False)
        if info.get("_type") in ("playlist", "multi_video"):
            entries = list(info.get("entries") or [])
            if len(entries) != 1:
                raise VideoError("unsupported_playlist")
            info = entries[0]
        require_public_metadata(info, source["platform"])
        duration = float(info.get("duration") or 0)
        if info.get("is_live") or not math.isfinite(duration) or not 0 < duration <= MAX_SECONDS:
            raise VideoError("video_out_of_range")
        track = select_track(info)
        signature = {"id": str(info.get("id")), "title": clean_text(info.get("title"), 300), "duration": duration,
                     "timestamp": info.get("timestamp"), "modified": info.get("modified_timestamp"),
                     "track": {k: track[k] for k in ("language", "kind", "ext")} if track else None}
        version = hashlib.sha256(json.dumps(signature, sort_keys=True).encode()).hexdigest()
        result = {"version": 1, "status": "available", "source": source, "title": signature["title"], "duration": duration,
                  "metadataVersion": version, "sourceAccess": "anonymous_public", "subtitles": [], "frames": [], "errors": []}
        if request.get("mode") == "probe":
            return result
        if track:
            try:
                raw = fetch_bytes(ydl, track["url"], MAX_SUBTITLE_BYTES).decode("utf-8-sig")
                result["subtitles"] = subtitle_cues(raw, track["ext"], duration)
                result["subtitleTrack"] = {"kind": track["kind"], "language": track["language"]}
            except Exception:
                result["errors"].append("subtitles_unavailable")
        else:
            result["errors"].append("no_supported_subtitles")
        formats = [f for f in info.get("formats", []) if f.get("ext") == "mp4" and f.get("vcodec") not in (None, "none")
                   and f.get("protocol") in ("http", "https") and 0 < (f.get("height") or 0) <= 720
                   and (f.get("filesize") or f.get("filesize_approx") or 0) <= MAX_VIDEO_BYTES]
        formats.sort(key=lambda f: (abs((f.get("height") or 0) - 360), f.get("filesize") or MAX_VIDEO_BYTES))
        video = output / "input.mp4"
        try:
            if not formats:
                raise VideoError("no_supported_video_stream")
            video.write_bytes(fetch_bytes(ydl, formats[0]["url"], MAX_VIDEO_BYTES))
            actual_duration, result["frames"] = frames_from_file(video, output, dependency_root / "ffmpeg-root", request.get("atSeconds"))
            if abs(actual_duration - duration) > max(2, duration * 0.01):
                raise VideoError("video_duration_mismatch")
        except VideoError as exc:
            result["frames"] = []
            result["errors"].append(exc.code)
        except Exception:
            result["frames"] = []
            result["errors"].append("frames_unavailable")
        finally:
            video.unlink(missing_ok=True)
        result["status"] = "ok" if result["subtitles"] and result["frames"] else "partial" if result["subtitles"] or result["frames"] else "unavailable"
        result["coverage"] = {"frameTimestamps": [f["timestamp"] for f in result["frames"]],
                              "subtitleRanges": [[c["start"], c["end"]] for c in result["subtitles"]],
                              "audioTranscribed": False, "completeViewing": False}
        return result


def safe_failure(exc):
    if isinstance(exc, VideoError):
        return exc.code
    text = str(exc).lower()
    if any(x in text for x in ("sign in", "not a bot", "captcha", "http error 403", "http error 412", "http error 429", "login", "private video", "members-only")):
        return "source_restricted"
    if "unavailable" in text or "not found" in text or "http error 404" in text:
        return "source_unavailable"
    return "source_fetch_failed"


if __name__ == "__main__":
    try:
        # The parent owns wall-clock cancellation and kills this process group.
        resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_VIDEO_BYTES + 1024 * 1024, MAX_VIDEO_BYTES + 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
        payload = sys.stdin.buffer.read(16385)
        if len(payload) > 16384:
            raise VideoError("request_too_large")
        result = run(json.loads(payload))
    except Exception as error:
        code = safe_failure(error)
        result = {"version": 1, "status": "restricted" if code == "source_restricted" else "unavailable", "errors": [code], "subtitles": [], "frames": []}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
