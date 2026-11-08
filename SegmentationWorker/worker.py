"""HTTP worker that runs automatic segmentation for VolumeRESTServiceJava.

    GET  /models               -> {"models": [{id, name, description, available, unavailableReason}]}
    POST /segment?model=<id>   body: the service's volume binary (as GET .../Volumes/{id}/binary)
                               -> uint32 N, N bytes of JSON {name, segments}, padding to 4 bytes, uint8 labels
    Errors are JSON {"error": "..."} with status 400 (unusable request) or 500.

Run: python worker.py [--host 127.0.0.1] [--port 54809]. Segmentations run one at a time.
"""

import argparse
import json
import logging
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from models import MODELS, ModelError
from volume_io import encode_labels, parse_volume

LOG = logging.getLogger("segmentation-worker")
MAX_BODY_BYTES = 4 * 1024**3

# Models use lots of memory (and the GPU); run one at a time.
_run_lock = threading.Lock()


class Handler(BaseHTTPRequestHandler):
    server_version = "SegmentationWorker/1.0"

    def do_GET(self):
        if urlparse(self.path).path == "/models":
            self._json(200, {"models": [m.describe() for m in MODELS.values()]})
        else:
            self._json(404, {"error": "Not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/segment":
            self._json(404, {"error": "Not found"})
            return
        model_id = (parse_qs(url.query).get("model") or [""])[0]
        model = MODELS.get(model_id)
        if model is None:
            self._json(400, {"error": f"Unknown model '{model_id}'"})
            return
        reason = model.unavailable_reason()
        if reason:
            self._json(400, {"error": f"{model.name} is unavailable: {reason}"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(400, {"error": "Send the volume binary as the request body"})
            return
        try:
            volume = parse_volume(self.rfile.read(length))
        except (ValueError, KeyError) as e:
            self._json(400, {"error": f"Malformed volume: {e}"})
            return

        try:
            with _run_lock:
                started = time.monotonic()
                LOG.info("Segmenting %s with %s", volume.stored.shape, model.id)
                name, segments, labels = model.segment(volume)
                LOG.info("%s finished in %.1f s", model.id, time.monotonic() - started)
        except ModelError as e:
            self._json(400, {"error": str(e)})
            return
        except Exception as e:  # noqa: BLE001 - reported to the client
            LOG.exception("Model %s failed", model.id)
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
            return
        if labels.shape != volume.stored.shape:
            self._json(500, {"error": f"Model returned shape {labels.shape}, expected {volume.stored.shape}"})
            return

        body = encode_labels(name, segments, labels)
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        LOG.info("%s - %s", self.address_string(), format % args)


def make_server(host: str, port: int) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=54809)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    server = make_server(args.host, args.port)
    for model in MODELS.values():
        status = "available" if model.unavailable_reason() is None else f"unavailable ({model.unavailable_reason()})"
        LOG.info("Model %s: %s", model.id, status)
    LOG.info("Listening on http://%s:%d", args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
