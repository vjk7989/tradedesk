# Shims and provenance

Copied from Vibe-Trading (MIT, see LICENSE / NOTICE in this directory), commit e0f285f:
- `agent/backtest/` -> `vibe_bt/backtest/` (imports rewritten `backtest.*` -> `vibe_bt.backtest.*`, `src.*` -> `vibe_bt.src.*`, including string module paths in registry.py / base.py / fundamentals_loader.py).
- `agent/src/quantlib/{impact,options,risk}.py` -> `vibe_bt/src/quantlib/` (verbatim; package `__init__` is empty).

Removed loaders (need agent-side modules not copied): `loaders/longbridge.py`, `loaders/gildata_loader.py`, `loaders/gildata_codes.py`. The registry skips modules that fail to import.

Shims (all under `vibe_bt/src/` unless noted):
1. `config/accessor.py` - replaces pydantic `EnvConfig`. `get_env_config().data.<field>` reads env var `<FIELD>` (empty string if unset; `ccxt_exchange` defaults to "binance"; `vibe_trading_data_cache` parsed as bool). Also `get_env_value`.
2. `data_gateway/reads.py` - replaces the gateway (pooling, timeouts, caching). `loader_read`, `managed_reader` are identity decorators; `availability_probe` returns False on TimeoutError/OSError.
3. `factors/registry.py` - empty registry; `get_default_registry().get(id)` always raises KeyError (runner logs and skips unknown alpha_ids).
4. `tools/path_utils.py` - `safe_run_dir` only rejects UNC paths and resolves; the allowed-run-roots whitelist is NOT enforced (the service wrapper must confine run dirs itself).
5. `market_data.py` - only `FIAT_CODES` and `canonical_fx_pair` extracted from agent `src/market_data.py`.
6. `backtest/loaders/rsshub_events.py` - `defusedxml` replaced by stdlib `xml.etree.ElementTree` and a local `DefusedXmlException` stub (no XXE hardening; only parses a configured RSSHub feed).

Not copied: the broker SDK connectors (`src.trading.*`; only lazily imported in india_broker_loader), `src.br_data` (lazy, b3 loader only), `src.config.writer/paths/gildata_features`, data_gateway service/scheduling, all agent/LLM/provider code.

7. `backtest/loaders/local_loader.py` - `_CONFIG_PATH` honours env `BT_LOCAL_DATA_CONFIG` (path to the data-bridge config.yaml) so the child process of `bt_service.run_backtest` can use a non-default local-source config (used by tests).

8. `backtest/runner.py` `_validate_signal_engine_source` - local hardening vs upstream: new `_reject_dunder_escapes` rejects names `__builtins__`, `__import__`, `__loader__`, `__spec__`, `builtins`, `vars`, `locals`, `globals`, `breakpoint`, dunder attributes other than `__init__`/`__name__`/`__len__`/`__getitem__`, and string subscripts with dunder keys. `bt_service/_child.py` additionally installs a `sys.addaudithook` sandbox (blocks process spawn/exec/kill, ctypes (only when signal_engine.py is on the stack, since platformdirs/yfinance use ctypes), rmtree, and fs mutation or writes outside run_dir; sockets and reads allowed).

9. Local additions (not upstream): `backtest/loaders/openalgo_loader.py` (OpenAlgo `/api/v1/history`; env `OPENALGO_URL`, `OPENALGO_API_KEY`; `_fetch_one` raises NoAvailableSourceError, `fetch` logs it and skips the symbol so the runner falls back); `loaders/registry.py` registers it and puts `openalgo` first in the `india_equity` and `crypto` chains (it skips symbols it does not map, so others fall through); `engines/_market_hooks.py` `_MARKET_PATTERNS` routes `SYMBOL@CRYPTO` to `crypto` and `SYMBOL@NSE|BSE|NFO|BFO|CDS|BCD|MCX` to `india_equity` (NFO/MCX derivatives therefore run under the india_equity engine). `bt_service/_child.py` redirects the yfinance cache to `<run_dir>/.cache` and `bt_service/runner.py` sets `XDG_CACHE_HOME` there.
