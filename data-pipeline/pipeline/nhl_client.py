"""Minimal, dependency-free client for the community-documented NHL endpoints.

Design:
- Every response is cached to disk (one gzip JSON file per URL hash) so a full
  11-season build is re-runnable offline and the NHL is hit once per URL.
- Rate limited to one request per REQUEST_MIN_INTERVAL_S.
- Retries with exponential backoff on 429/5xx and network errors.
- No silent failures: every failure raises a typed exception with context.

Thread safety: NhlClient is NOT thread-safe (shared last-request timestamp and
cache writes). Use one instance per thread, or run single-threaded (default).
"""
from __future__ import annotations

import gzip
import hashlib
import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import config


class FetchError(RuntimeError):
    """Raised when a URL cannot be fetched after all retries."""


class SchemaError(KeyError):
    """Raised when a response lacks a key path the pipeline depends on."""


def need(obj: Any, path: str) -> Any:
    """Return obj[path] following dotted keys / [int] indexes, or raise SchemaError.

    Example: need(pbp, "plays[0].periodDescriptor.number")
    O(len(path)).
    """
    cur = obj
    walked = ""
    for token in path.replace("[", ".[").split("."):
        if not token:
            continue
        walked = f"{walked}.{token}" if walked else token
        if token.startswith("["):
            idx = int(token[1:-1])
            if not isinstance(cur, list) or idx >= len(cur):
                raise SchemaError(f"missing index at '{walked}'")
            cur = cur[idx]
        else:
            if not isinstance(cur, dict) or token not in cur:
                raise SchemaError(f"missing key at '{walked}'")
            cur = cur[token]
    return cur


def opt(obj: Any, path: str, default: Any = None) -> Any:
    """Like need() but returns default for genuinely optional fields."""
    try:
        return need(obj, path)
    except SchemaError:
        return default


@dataclass
class NhlClient:
    cache_dir: Path = config.CACHE_DIR
    min_interval_s: float = config.REQUEST_MIN_INTERVAL_S
    offline: bool = False
    sleep: Callable[[float], None] = time.sleep
    opener: Callable[..., Any] = urllib.request.urlopen
    _last_request_at: float = field(default=0.0, init=False)

    def _cache_path(self, url: str) -> Path:
        digest = hashlib.sha256(url.encode("utf-8")).hexdigest()[:24]
        return self.cache_dir / digest[:2] / f"{digest}.json.gz"   # 2-char fan-out keeps dirs small

    def get_json(self, url: str) -> Any:
        """Fetch URL as JSON, using the disk cache first. Raises FetchError."""
        path = self._cache_path(url)
        if path.exists():
            try:
                with gzip.open(path, "rt", encoding="utf-8") as fh:
                    return json.load(fh)["body"]
            except (json.JSONDecodeError, KeyError, OSError, EOFError) as exc:
                raise FetchError(f"corrupt cache file {path} for {url}: {exc}") from exc
        if self.offline:
            raise FetchError(f"offline mode and no cache for {url}")
        body = self._fetch_with_retries(url)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            json.dump({"url": url, "body": body}, fh)
        tmp.replace(path)  # atomic on POSIX and Windows (same volume)
        return body

    def _fetch_with_retries(self, url: str) -> Any:
        last_error: Exception | None = None
        for attempt in range(config.MAX_RETRIES):
            self._respect_rate_limit()
            try:
                req = urllib.request.Request(url, headers={"User-Agent": config.USER_AGENT})
                with self.opener(req, timeout=config.REQUEST_TIMEOUT_S) as resp:
                    raw = resp.read()
                return json.loads(raw.decode("utf-8"))
            except urllib.error.HTTPError as exc:
                if exc.code not in config.RETRYABLE_HTTP:
                    raise FetchError(f"HTTP {exc.code} for {url}") from exc
                last_error = exc
            except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
                last_error = exc
            except json.JSONDecodeError as exc:
                raise FetchError(f"non-JSON response from {url}: {exc}") from exc
            self.sleep(config.BACKOFF_BASE_S * (2 ** attempt))
        raise FetchError(f"gave up after {config.MAX_RETRIES} attempts: {url} ({last_error})")

    def _respect_rate_limit(self) -> None:
        wait = self.min_interval_s - (time.monotonic() - self._last_request_at)
        if wait > 0:
            self.sleep(wait)
        self._last_request_at = time.monotonic()

    # Convenience wrappers -------------------------------------------------
    def pbp(self, game_id: int) -> Any:
        return self.get_json(config.WEB_BASE + config.PBP_PATH.format(game_id=game_id))

    def score_by_date(self, date: str) -> Any:
        return self.get_json(config.WEB_BASE + config.SCORE_BY_DATE_PATH.format(date=date))

    def shifts(self, game_id: int) -> Any:
        return self.get_json(config.STATS_BASE + config.SHIFTS_PATH.format(game_id=game_id))

    def games_for_season(self, season: str, game_type: int) -> Any:
        return self.get_json(
            config.STATS_BASE + config.GAMES_BY_SEASON_PATH.format(season=season, game_type=game_type)
        )
