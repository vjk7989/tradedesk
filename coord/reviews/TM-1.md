# TM-1 review

## Code review (Sonnet)

Verdict: approve (minor notes only). Tests not run by reviewer.

1. india_equity.py:82-89, low: validation uses isinstance(int, float); numpy ints (np.int64) are rejected although floats pass. Acceptable (JSON costs are native); optionally use numbers.Real. Validation runs even for CNC/1D runs, so a bad key fails every run; consistent with "invalid -> ValueError".
2. india_equity.py:140, ok: MIS is decided by self.mis = intraday and resolve_product(config,"india_equity")=="MIS", the same source used for STT and square-off. Composite (composite.py:53) builds IndiaEquityEngine(config) with the shared config, so product_by_market["india_equity"] and in_mis_stamp_duty both apply to the sub-engine. 1D+MIS stays at 0.00015 (tested).
3. test_tm1_mis_stamp.py, low: no composite-run test proving product_by_market-driven MIS picks the new rate. Suggest one IndiaEquityEngine({"interval":"5m","product_by_market":{"india_equity":"MIS"}}) assertion.
4. test_tm1_mis_stamp.py:41-55, ok: hand-computed round trip checked (exch 7.425/7.4547, gst 1.3815/1.387026, stt 62.75, stamp 7.5) and is not tautological. bool/str values: bool explicitly rejected, str rejected by type check; bad cases not parametrized for True/"x" (nit).
5. Docs, nit: ADR-13 "MIS stamp duty uses the delivery rate" is now stale; out of scope for this PR, follow up.
