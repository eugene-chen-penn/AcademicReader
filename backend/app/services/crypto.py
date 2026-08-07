"""API key encryption at rest using Fernet (symmetric, authenticated).

The Fernet key itself lives at ``<data_dir>/secret.key`` with 0600 permissions,
generated on first use and reused thereafter. ``data_dir`` defaults to
``backend/data`` (the real runtime location) but is overridable so tests can
point at an isolated temp directory instead of touching the real one.
"""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data"


def _key_path(data_dir: Path) -> Path:
    return data_dir / "secret.key"


def _load_or_create_key(data_dir: Path) -> bytes:
    data_dir.mkdir(parents=True, exist_ok=True)
    key_path = _key_path(data_dir)
    if key_path.exists():
        return key_path.read_bytes()
    key = Fernet.generate_key()
    key_path.write_bytes(key)
    os.chmod(key_path, 0o600)
    return key


def get_fernet(data_dir: Path | None = None) -> Fernet:
    return Fernet(_load_or_create_key(data_dir or DEFAULT_DATA_DIR))


def encrypt(plaintext: str, data_dir: Path | None = None) -> str:
    return get_fernet(data_dir).encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt(ciphertext: str, data_dir: Path | None = None) -> str:
    return get_fernet(data_dir).decrypt(ciphertext.encode("ascii")).decode("utf-8")
