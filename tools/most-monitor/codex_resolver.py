"""Resolve an installed Codex desktop CLI across automatic app updates."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess
import time
import tomllib

FLAGS = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
VERSION_TIMEOUT_SECONDS = 2
VERSION_SCAN_TIMEOUT_SECONDS = 8
_VERSION = re.compile(r'(?<![0-9])v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?')


class CodexBinaryMissing(Exception):
    """No configured or discoverable Codex executable is available."""


def _version_key(value: str):
    match = _VERSION.search(value)
    if not match:
        return None
    major, minor, patch = (int(match.group(i)) for i in (1, 2, 3))
    prerelease = match.group(4)
    if prerelease is None:
        return major, minor, patch, (1, ())
    identifiers = []
    for part in prerelease.split('.'):
        identifiers.append((0, int(part)) if part.isdigit() else (1, part.lower()))
    return major, minor, patch, (0, tuple(identifiers))


def _valid_path(value):
    if not isinstance(value, str) or not value.strip():
        return None
    candidate = Path(os.path.expandvars(os.path.expanduser(value.strip())))
    try:
        if not candidate.is_absolute() or not candidate.is_file():
            return None
        if os.name == 'nt' and candidate.suffix.lower() != '.exe':
            return None
        return candidate.resolve()
    except (OSError, RuntimeError):
        return None


def _configured_path(config_path: Path):
    """Extract only CODEX_CLI_PATH; do not parse unrelated TOML secrets."""
    section = ''
    legacy = None
    try:
        for line in config_path.read_text(encoding='utf-8').splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith('#'):
                continue
            match = re.fullmatch(r'\[([^]]+)\]\s*(?:#.*)?', stripped)
            if match:
                section = match.group(1).strip()
                continue
            if section not in ('', 'mcp_servers.node_repl.env'):
                continue
            match = re.match(r'^\s*CODEX_CLI_PATH\s*=\s*(.*?)\s*(?:#.*)?$', line)
            if match:
                try:
                    value = tomllib.loads('CODEX_CLI_PATH = ' + match.group(1)).get('CODEX_CLI_PATH')
                except (ValueError, TypeError):
                    return None
                if isinstance(value, str) and value.strip():
                    if section == 'mcp_servers.node_repl.env':
                        return value
                    legacy = value
                elif section == 'mcp_servers.node_repl.env':
                    return None
    except (OSError, UnicodeError):
        return None
    return legacy


def _reported_version(candidate: Path, timeout: float = VERSION_TIMEOUT_SECONDS):
    try:
        result = subprocess.run(
            [str(candidate), '--version'], capture_output=True, text=True,
            encoding='utf-8', errors='replace', timeout=timeout,
            check=False, creationflags=FLAGS,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    return _version_key((result.stdout or '') + '\n' + (result.stderr or ''))


def resolve_codex_path(config_path: Path | str | None = None,
                       local_appdata: Path | str | None = None,
                       explicit_path: str | None = None,
                       env_path: str | None = None) -> Path:
    """Prefer configured paths, then choose the highest-version installed CLI.

    No lookup is cached. Version checks are bounded to two seconds per binary
    and eight seconds total, leaving room for the collector's RPC deadline.
    """
    configured_env = env_path if env_path is not None else os.environ.get('CODEX_CLI_PATH')
    candidates = [configured_env]
    config_path = Path(config_path) if config_path is not None else Path.home() / '.codex' / 'config.toml'
    candidates.append(_configured_path(config_path))
    candidates.append(explicit_path)
    for value in candidates:
        valid = _valid_path(value)
        if valid:
            return valid

    appdata_value = str(local_appdata) if local_appdata is not None else os.environ.get('LOCALAPPDATA')
    if appdata_value:
        root = Path(appdata_value)
    else:
        root = Path.home() / 'AppData' / 'Local'
    try:
        candidates = sorted((root / 'OpenAI' / 'Codex' / 'bin').glob('*/codex.exe'))
    except OSError:
        candidates = []
    available = []
    deadline = time.monotonic() + VERSION_SCAN_TIMEOUT_SECONDS
    for candidate in candidates:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            if not candidate.is_file():
                continue
        except OSError:
            continue
        version = _reported_version(candidate, timeout=min(VERSION_TIMEOUT_SECONDS, remaining))
        if version is not None:
            available.append((version, str(candidate).casefold(), candidate))
    if not available:
        raise CodexBinaryMissing('binary_missing')
    return max(available, key=lambda item: (item[0], item[1]))[2].resolve()
