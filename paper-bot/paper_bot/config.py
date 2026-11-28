import os
from dataclasses import dataclass

RES_SEC = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
           "2h": 7200, "4h": 14400, "6h": 21600, "1d": 86400}


def _b(v: str) -> bool:
    return v.strip().lower() in ("1", "true", "yes")


@dataclass(frozen=True)
class Config:
    symbols: tuple = ("BTCUSD", "ETHUSD")
    resolution: str = "5m"
    interval_sec: int = 300
    fast: int = 20
    slow: int = 50
    allow_short: bool = True
    notional: float = 1000.0
    capital: float = 10000.0
    fee: float = 0.0005
    slippage: float = 0.0002
    base_url: str = "https://api.india.delta.exchange"
    data_dir: str = "/data"
    port: int = 8090
    align_delay: int = 5  # seconds after a candle boundary before acting

    def __post_init__(self):
        if self.resolution not in RES_SEC:
            raise ValueError(f"invalid RESOLUTION {self.resolution!r}; valid values: {', '.join(RES_SEC)}")

    def validate(self) -> "Config":
        """Startup validation (called from from_env; direct construction stays permissive for tests)."""
        bad = []
        if not self.symbols:
            bad.append("SYMBOLS must not be empty")
        if self.fast < 1:
            bad.append(f"FAST={self.fast} must be >= 1")
        if self.slow < 2:
            bad.append(f"SLOW={self.slow} must be >= 2")
        if self.fast >= self.slow:
            bad.append(f"FAST={self.fast} must be < SLOW={self.slow}")
        if not self.notional > 0:
            bad.append(f"NOTIONAL_USD={self.notional} must be > 0")
        if not self.capital > 0:
            bad.append(f"START_CAPITAL_USD={self.capital} must be > 0")
        if self.interval_sec < 1:
            bad.append(f"INTERVAL_SEC={self.interval_sec} must be >= 1")
        for name, v in (("TAKER_FEE", self.fee), ("SLIPPAGE", self.slippage)):
            if not 0 <= v < 0.1:
                bad.append(f"{name}={v} must be in [0, 0.1)")
        if bad:
            raise ValueError("invalid config: " + "; ".join(bad))
        return self

    @property
    def period(self) -> int:
        return RES_SEC[self.resolution]

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "paper.db")

    @classmethod
    def from_env(cls, e=os.environ) -> "Config":
        d = cls()
        g = e.get
        return cls(
            symbols=tuple(s.strip() for s in g("SYMBOLS", ",".join(d.symbols)).split(",") if s.strip()),
            resolution=g("RESOLUTION", d.resolution), interval_sec=int(g("INTERVAL_SEC", d.interval_sec)),
            fast=int(g("FAST", d.fast)), slow=int(g("SLOW", d.slow)),
            allow_short=_b(g("ALLOW_SHORT", "true")), notional=float(g("NOTIONAL_USD", d.notional)),
            capital=float(g("START_CAPITAL_USD", d.capital)), fee=float(g("TAKER_FEE", d.fee)),
            slippage=float(g("SLIPPAGE", d.slippage)),
            base_url=g("DELTA_BASE_URL", d.base_url).rstrip("/"), data_dir=g("DATA_DIR", d.data_dir)).validate()
