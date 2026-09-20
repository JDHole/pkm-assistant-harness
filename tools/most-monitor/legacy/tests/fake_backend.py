# -*- coding: utf-8 -*-
"""
Fake backend do testu most.py - udaje ChatMocka na potrzeby test_most.py.
Uzycie: python fake_backend.py <port>

Env FAKE_MODE:
  (brak / "200")   -> normalny 200: stream=true -> SSE echo (kilka chunkow + [DONE]),
                       stream=false/brak -> JSON echo {"echo": <body>}.
  "400"            -> /v1/chat/completions odpowiada 400 (symulacja martwego modelu PING_MODEL).
  "overload_n"     -> pierwsze FAKE_OVERLOAD_N POST-ow zwraca 200 + text/event-stream z
                       body "data: {\"error\": {...overloaded...}}\n\ndata: [DONE]\n\n";
                       kolejne POST-y zachowuja sie jak w trybie normalnym (200 echo).
  "overload_always"-> KAZDY POST zwraca ten sam error-stream co overload_n.
  "bad_model"      -> 200 + SSE, pierwsza linia data: {"error": {"message": "Invalid model: nope"}}
                       (blad NIE-przejsciowy - nie zawiera slow z listy transient).
  "http503"        -> czysty HTTP 503 + JSON error body.

Kazde odebrane body POST-a trafia rowniez do last_body.json w tym samym katalogu
co ten skrypt (do asercji w testach). GET /fake/count -> {"posts": n} - licznik
odebranych POST-ow /v1/chat/completions (do asercji liczby prob w testach retry).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from aiohttp import web

LAST_BODY_PATH = Path(__file__).with_name("last_body.json")

OVERLOAD_CHUNK = (
    b'data: {"error": {"message": "Our servers are currently overloaded. '
    b'Please try again later."}}\n\ndata: [DONE]\n\n'
)
BAD_MODEL_CHUNK = b'data: {"error": {"message": "Invalid model: nope"}}\n\ndata: [DONE]\n\n'

POST_COUNT = {"n": 0}


async def handle_models(request: web.Request) -> web.Response:
    return web.json_response({"object": "list", "data": [{"id": "x"}]})


async def handle_count(request: web.Request) -> web.Response:
    return web.json_response({"posts": POST_COUNT["n"]})


def _normal_response(parsed) -> web.StreamResponse | web.Response:
    stream = bool(isinstance(parsed, dict) and parsed.get("stream"))
    if stream:
        body = (
            b'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n'
            b'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
            b"data: [DONE]\n\n"
        )
        return web.Response(body=body, content_type="text/event-stream")
    return web.json_response({"echo": parsed})


async def handle_completions(request: web.Request) -> web.Response:
    raw = await request.read()
    try:
        parsed = json.loads(raw) if raw else None
    except (json.JSONDecodeError, ValueError):
        parsed = None
    LAST_BODY_PATH.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")

    mode = os.environ.get("FAKE_MODE") or "200"
    POST_COUNT["n"] += 1
    this_call = POST_COUNT["n"]

    if mode == "400":
        return web.json_response(
            {"error": {"message": "fake: model nie istnieje", "type": "invalid_request_error"}},
            status=400,
        )
    if mode == "http503":
        return web.json_response(
            {"error": {"message": "fake: backend padl", "type": "server_error"}},
            status=503,
        )
    if mode == "bad_model":
        return web.Response(body=BAD_MODEL_CHUNK, content_type="text/event-stream")
    if mode == "overload_always":
        return web.Response(body=OVERLOAD_CHUNK, content_type="text/event-stream")
    if mode == "overload_n":
        n = int(os.environ.get("FAKE_OVERLOAD_N", "0"))
        if this_call <= n:
            return web.Response(body=OVERLOAD_CHUNK, content_type="text/event-stream")
        return _normal_response(parsed)

    return _normal_response(parsed)


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 1245
    app = web.Application()
    app.router.add_get("/v1/models", handle_models)
    app.router.add_get("/fake/count", handle_count)
    app.router.add_post("/v1/chat/completions", handle_completions)
    web.run_app(app, host="127.0.0.1", port=port, print=None)
    return 0


if __name__ == "__main__":
    sys.exit(main())
