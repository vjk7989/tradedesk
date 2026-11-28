import math
import os
from dataclasses import dataclass, field

RES_SEC = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
           "2h": 7200, "4h": 14400, "6h": 21600, "1d": 86400}


EXECUTIONS = ("sim", "openalgo")


def parse_contract_sizes(raw: str) -> tuple:
    """'BTCUSD:0.001,ETHUSD:0.01' -> (('BTCUSD', 0.001), ('ETHUSD', 0.01)). ValueError on any malformed entry."""
    out, seen = [], set()
    for part in raw.split(","):
        if not part.strip():
            continue
        sym, sep, size = part.partition(":")
        sym = sym.strip()
        try:
            v = float(size)
        except ValueError:
            v = float("nan")
        if not sep or not sym or not math.isfinite(v) or v <= 0 or sym in seen:
            raise ValueError(f"invalid config: CONTRACT_SIZES entry {part.strip()!r} must be SYMBOL:size "
                             "(size > 0, each symbol once)")
        seen.add(sym)
        out.append((sym, v))
    return tuple(out)


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
    # TM2-77: optional execution through OpenAlgo's analyzer (sandbox). "sim" (default) is the local simulation.
    execution: str = "sim"
    openalgo_url: str = ""
    openalgo_api_key: str = field(default="", repr=False)  # secret: never in repr/logs/DB/dashboard
    contract_sizes: tuple = ()  # ((SYMBOL, units per contract), ...)
    openalgo_symbol_suffix: str = "FUT"  # OpenAlgo symbol = bot symbol + suffix (perpetual, per trade-mcp docs)
    openalgo_timeout: float = 10.0

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
        if self.execution not in EXECUTIONS:
            bad.append(f"EXECUTION={self.execution!r} must be one of {', '.join(EXECUTIONS)}")
        elif self.execution == "openalgo":
            bad.extend(self.openalgo_problems())
        if bad:
            raise ValueError("invalid config: " + "; ".join(bad))
        return self

    def openalgo_problems(self) -> list:
        """Problems that make EXECUTION=openalgo unsafe to start. Never includes the API key."""
        bad = []
        if not self.openalgo_url.startswith(("http://", "https://")) or not self.openalgo_url.split("//", 1)[1]:
            bad.append("OPENALGO_URL is required in openalgo mode and must start with http:// or https://")
        k = self.openalgo_api_key
        if not k or k != k.strip() or any(ord(c) < 33 or ord(c) == 127 for c in k):
            bad.append("OPENALGO_API_KEY is required in openalgo mode (no whitespace or control characters)")
        elif len(k) < 16:
            bad.append("OPENALGO_API_KEY is too short (minimum 16 characters)")
        if not 0 < self.openalgo_timeout <= 60:
            bad.append(f"OPENALGO_TIMEOUT={self.openalgo_timeout} must be in (0, 60]")
        sizes = dict(self.contract_sizes)
        for sym in self.symbols:
            if sym not in sizes:
                bad.append(f"CONTRACT_SIZES has no size for {sym} (symbols without a size are refused)")
        for sym, v in self.contract_sizes:
            if not (isinstance(v, (int, float)) and math.isfinite(v) and v > 0):
                bad.append(f"CONTRACT_SIZES size for {sym} must be > 0")
        return bad

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
            base_url=g("DELTA_BASE_URL", d.base_url).rstrip("/"), data_dir=g("DATA_DIR", d.data_dir),
            **cls._openalgo_env(g)).validate()

    @staticmethod
    def _openalgo_env(g) -> dict:
        """EXECUTION / OPENALGO_* / CONTRACT_SIZES. Empty in sim mode: those vars are not even parsed there."""
        ex = g("EXECUTION", "sim").strip().lower()
        if ex != "openalgo":
            return {"execution": ex} if ex != "sim" else {}
        try:
            timeout = float(g("OPENALGO_TIMEOUT", "10"))
        except ValueError:
            raise ValueError("invalid config: OPENALGO_TIMEOUT must be a number") from None
        return dict(execution=ex, openalgo_url=g("OPENALGO_URL", "").strip().rstrip("/"),
                    openalgo_api_key=g("OPENALGO_API_KEY", ""),
                    contract_sizes=parse_contract_sizes(g("CONTRACT_SIZES", "")),
                    openalgo_symbol_suffix=g("OPENALGO_SYMBOL_SUFFIX", "FUT").strip(), openalgo_timeout=timeout)
