#!/usr/bin/env python3
"""Upload a private file to RCloud with Python 3.10+ (standard library only)."""
import argparse
import json
import os
from pathlib import Path
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a Bearer token to a redirected destination.


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--url", default="https://s.irin.im", help="RCloud origin")
    parser.add_argument("--folder", help="Existing folder UUID; default: root")
    args = parser.parse_args()
    origin = args.url.rstrip("/")
    parsed = urlsplit(origin)
    if (parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1"))) or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
        parser.error("--url must be an HTTPS origin (local HTTP is allowed for development)")
    token = os.environ.get("RCLOUD_TOKEN", "")
    if not token:
        parser.error("Set RCLOUD_TOKEN in the environment first")
    opener = build_opener(NoRedirect())

    def call(path, method="GET", body=None, retry=False):
        binary = isinstance(body, bytes)
        payload = body if binary or body is None else json.dumps(body).encode()
        headers = {"Authorization": "Bearer " + token}
        if body is not None:
            headers["Content-Type"] = "application/octet-stream" if binary else "application/json"
        if binary:
            headers["X-File-Size"] = str(len(body))
        for attempt in range(3 if retry else 1):
            try:
                req = Request(origin + "/api/v1" + path, data=payload, headers=headers, method=method)
                with opener.open(req, timeout=300) as response:
                    return json.load(response)["data"]
            except HTTPError as error:
                if retry and attempt < 2 and (error.code in (423, 429) or error.code >= 500):
                    error.close()
                    time.sleep(2 ** (attempt + 1))
                    continue
                try:
                    message = json.loads(error.read()).get("error", {}).get("message", error.reason)
                except (ValueError, AttributeError):
                    message = error.reason
                finally:
                    error.close()
                raise ApiError(error.code, message) from None
            except (URLError, TimeoutError):
                if not retry or attempt == 2:
                    raise RuntimeError("Network request failed; check the origin and connection") from None
                time.sleep(2 ** (attempt + 1))

    session = None
    try:
        with args.file.open("rb") as source:
            stat = os.fstat(source.fileno())
            size = stat.st_size
            if size == 0:
                query = {"name": args.file.name}
                if args.folder:
                    query["folder_id"] = args.folder
                result = call("/files?" + urlencode(query), "POST", b"")
            else:
                session = call("/uploads", "POST", {"name": args.file.name, "size": size, "folder_id": args.folder})
                transferred = 0
                part = 1
                while transferred < size:
                    chunk = source.read(min(session["partSize"], size - transferred))
                    if not chunk:
                        raise RuntimeError("The source file changed during upload")
                    call(f'/uploads/{session["id"]}/parts/{part}', "PUT", chunk, retry=True)
                    transferred += len(chunk)
                    part += 1
                    print(f"\r{transferred}/{size} bytes", end="", file=sys.stderr, flush=True)
                current = os.fstat(source.fileno())
                if current.st_mtime_ns != stat.st_mtime_ns or current.st_size != size:
                    raise RuntimeError("The source file changed during upload")
                try:
                    result = call(f'/uploads/{session["id"]}/complete', "POST", retry=True)
                except (ApiError, RuntimeError):
                    # Completion can succeed even if its response is lost.
                    result = call(f'/files/{session["fileId"]}', retry=True)
                    if not isinstance(result, dict) or (
                        result.get("id") != session["fileId"]
                        or result.get("status") != "ready"
                        or result.get("size") != size
                        or result.get("version") != 1
                    ):
                        raise RuntimeError("Cannot confirm completion: the file no longer matches this upload")
                session = None
                print(file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (Exception, KeyboardInterrupt):
        if session:
            try:
                call(f'/uploads/{session["id"]}', "DELETE")
            except Exception:
                print("Upload cleanup was not confirmed; unfinished sessions expire after 24 hours.", file=sys.stderr)
        raise


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
