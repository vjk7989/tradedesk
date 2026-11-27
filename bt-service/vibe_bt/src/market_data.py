"""Fiat-pair canonicalisation, extracted from Vibe-Trading src/market_data.py."""
from __future__ import annotations

import re

FIAT_CODES = frozenset(
    {
        "USD", "EUR", "GBP", "JPY", "CHF", "CNY", "CNH", "HKD", "AUD", "NZD",
        "CAD", "KRW", "INR", "SGD", "SEK", "NOK", "DKK", "MXN", "BRL", "ZAR",
        "TRY", "RUB", "PLN", "THB", "MYR", "IDR", "PHP", "VND", "ILS", "AED",
        "SAR", "EGP", "CZK", "HUF", "RON", "CLP", "COP", "PEN", "TWD", "CUP",
    }
)

#: Yahoo-served FX pair symbol forms, canonicalized to ``XXXYYY=X``.
_FX_PAIR_RE = re.compile(r"^(?P<base>[A-Z]{3})(?:/)?(?P<quote>[A-Z]{3})$", re.IGNORECASE)


def canonical_fx_pair(value: str) -> str | None:
    """Return a Yahoo FX pair in canonical ``XXXYYY=X`` form, or ``None``.

    Recognizes ``GBP/USD``, ``GBPUSD`` and ``GBPUSD=X`` (both legs must be
    fiat codes — ``ETH/USD`` and ``XAU/USD`` are not FX pairs) and returns
    the canonical spelling the market-data fetch layer serves directly.
    """
    clean = str(value or "").strip().upper()
    if clean.endswith("=X"):
        clean = clean[:-2]
    matched = _FX_PAIR_RE.fullmatch(clean)
    if not matched:
        return None
    base, quote = matched.group("base"), matched.group("quote")
    if base not in FIAT_CODES or quote not in FIAT_CODES:
        return None
    return f"{base}{quote}=X"
