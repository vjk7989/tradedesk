"""Empty alpha-factor registry shim: every alpha_id is unknown (KeyError)."""
from __future__ import annotations


class _EmptyRegistry:
    def get(self, alpha_id):
        raise KeyError(alpha_id)


def get_default_registry():
    return _EmptyRegistry()
