# PB-4 report
Changed: `deploy/docker-compose.yml` and `deploy/.env.example` paper-bot defaults: SYMBOLS=BTCUSD,ETHUSD, INTERVAL_SEC=300 (comment: >= candle period so ticks align to candle close). FAST/SLOW/ALLOW_SHORT untouched.

Startup validation: paper-bot/paper_bot/config.py only requires INTERVAL_SEC >= 1, so 300 passes.

Tests (`uv run --with pytest --with pyyaml --with bcrypt pytest -q deploy/`): 359 passed, 4 skipped, 5 failed. Tests not edited. Pinned old defaults (deploy/test_pb2_edge.py):
- test_strategy_env_var_has_default[INTERVAL_SEC-60]
- test_strategy_env_var_has_default[SYMBOLS-BTCUSD]
- test_env_example_strategy_values_match_compose_defaults[INTERVAL_SEC-60]
- test_env_example_strategy_values_match_compose_defaults[SYMBOLS-BTCUSD]
- test_compose_config_resolves_paper_bot_defaults
These need their expected values updated (SYMBOLS BTCUSD,ETHUSD; INTERVAL_SEC 300) in a follow-up.
