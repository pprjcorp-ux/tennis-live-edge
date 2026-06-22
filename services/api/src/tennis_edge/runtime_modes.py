from __future__ import annotations


OFFLINE_PROVIDER_MODES = frozenset({"sample", "replay"})


def uses_offline_provider_fixtures(data_mode: str) -> bool:
    """Return true when providers must not spend quota or open live sockets."""
    return data_mode in OFFLINE_PROVIDER_MODES
