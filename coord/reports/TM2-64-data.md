# TM2-64 data: sandbox.edge "50 sequential runs" memory growth

Phase 1 (data collection only; the bound is unchanged). The instrumentation is in `trade-mcp/test/sandbox.edge.test.ts` and prints one `TM2-64-DATA {json}` line to stderr per execution of the test.

Sampling: `process.memoryUsage()` after every run, `gc()` after every 5th run (runs 5, 10, ..., 50), outside the timed region. gc costs about 100 ms total alone and 300-580 ms under load (10 calls). A gc after every run cost about 2 s (40 ms per call) and was dropped.

Fields: `delta` = end - base (the values the existing assertions use; base is taken after warm-up + gc, end after gc/sleep/gc). `slope` = mean(external, runs 26-50) - mean(external, runs 1-25) over all samples. `slope_postgc` uses only the post-gc samples (runs 5..25 vs 30..50). `max_ext` = largest per-run external value relative to base. All values in MB.

## Local Linux (x64, Node v24.22.2, 8 vCPU)

alone = `npx vitest run test/sandbox.edge.test.ts` (whole file, nothing else running). load = the same, with a second full `npx vitest run` started in parallel. bg = the TM2-64-DATA line printed by that parallel full-suite run.

| run | platform | Δexternal | ΔheapUsed | Δrss | ΔarrayBuffers | base ext | end ext | slope ext | slope_postgc ext | max_ext | run ms p50 | gc ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| alone1 | linux | -48.48 | -0.026 | 2.16 | 0 | 50.834 | 2.354 | -3.687 | 3.968 | 18.399 | 10 | 126 |
| alone2 | linux | -16.96 | -0.012 | -5.168 | 0 | 19.314 | 2.354 | -0.275 | 10.464 | 64.96 | 12.8 | 108 |
| alone3 | linux | -32.96 | -0.026 | 3.965 | 0 | 35.314 | 2.354 | 1.146 | -6.4 | 64 | 11.9 | 116 |
| alone4 | linux | -32.96 | -0.028 | 4.336 | 0 | 35.314 | 2.354 | -3.955 | -3.392 | 32 | 30.8 | 114 |
| alone5 | linux | -16 | 0.021 | 1.449 | 0 | 18.354 | 2.354 | -0.621 | 3.296 | 49.44 | 12.7 | 102 |
| load1 | linux | -49.919 | -0.047 | 4.656 | 0 | 52.274 | 2.354 | -7.776 | -6.976 | 32.48 | 33.9 | 314 |
| load2 | linux | -98.88 | -0.02 | 14.141 | 0 | 101.234 | 2.354 | -0.717 | 2.912 | -31.521 | 27.6 | 329 |
| load3 | linux | -32.96 | -0.042 | -1.297 | 0 | 35.314 | 2.354 | -4.07 | -0.672 | 33.919 | 43.5 | 350 |
| bg1 | linux | -32.96 | -0.026 | 10.32 | -0.96 | 35.314 | 2.354 | 0.134 | -22.88 | 49.919 | 31.8 | 352 |
| bg2 | linux | -81.919 | -0.024 | 8.785 | 0 | 84.274 | 2.354 | 4.403 | -10.176 | 0 | 31.8 | 280 |
| bg3 | linux | -32.96 | -0.043 | -0.434 | -0.96 | 35.314 | 2.354 | 1.51 | -3.2 | 49.919 | 52.3 | 580 |

All 8 local runs passed (44/44), and so did all 3 parallel full suites (2523 passed, 5 skipped).

### Observations
- `external` moves in steps of about 16 MB (15.04-16.96 MB). Each step looks like a QuickJS WASM memory whose backing store is released lazily: a forced `gc()` does not always free it at once.
- The **baseline** is noisy: base external ranged from 18.4 to 101.2 MB (1 to 6 unreleased steps), while **end** external was 2.354 MB in every run. So locally Δexternal is always ≤ 0, and the CI failure (`external growth 15.8 MB > 8 MB`) matches exactly one 16 MB step that was still alive at `end` but not at `base` (the reverse of what happens locally).
- The per-run series swings between about -100 and +65 MB relative to base. The non-gc samples are dominated by these 16 MB steps, so the all-sample slope is noisy (-7.8 to +4.4 MB healthy), and so is the post-gc slope (-22.9 to +10.5 MB healthy).
- heapUsed delta stays within ±0.05 MB. arrayBuffers delta is 0 or -0.96 MB.

Sample series (alone1, MB vs base):
`[-31.52,-14.56,2.4,1.44,16.48,-31.52,-15.52,-31.52,-14.56,-15.52,-31.52,-15.52,1.44,18.399,-32.48,-15.52,-15.04,1.919,-15.52,-31.52,-15.52,-15.52,1.44,16.48,-32.48,-31.52,-14.56,1.919,-14.56,-32.48,-31.52,-15.04,1.919,-15.52,1.44,-31.52,-15.04,1.919,-15.04,1.919,-31.52,-15.52,1.44,-31.52,-32,-31.52,-15.04,1.919,-31.52,-14.56]`

## Leak proof (local, run once, never committed)

A temporary module-level `const LEAK: Buffer[] = []` with `LEAK.push(Buffer.alloc(1024 * 1024, 1))` after each of the 50 runs; the test ran alone with `-t "50 sequential"` 3 times, then the change was reverted.

| run | platform | Δexternal | ΔheapUsed | Δrss | ΔarrayBuffers | base ext | end ext | slope ext | slope_postgc ext | max_ext | run ms p50 | gc ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| leak1 | linux | -15.925 | -0.697 | 58.621 | 48.081 | 68.279 | 52.354 | 23.621 | 25.574 | 49.035 | 46.7 | 396 |
| leak2 | linux | -16.885 | -0.723 | 59.957 | 50 | 69.239 | 52.354 | 27.328 | 21.415 | 43.075 | 40.6 | 323 |
| leak3 | linux | -15.925 | -0.72 | 61.227 | 50 | 68.279 | 52.354 | 22.904 | 21.798 | 49.035 | 48.1 | 502 |

All 3 runs failed, but on **rss growth** (61.5-64.2 MB > 32 MB). The **external** assertion did NOT catch the 50 MB leak: Δexternal was about -16 MB because the inflated baseline (68 MB) hid it.

Signals that do separate the leak from healthy runs (healthy → leak):
- end external (absolute, after gc): 2.354 → 52.354 MB
- ΔarrayBuffers: 0 / -0.96 → +48 to +50 MB (Buffers only; a WASM-memory leak would not show here)
- slope ext: -7.8..+4.4 → +22.9..+27.3 MB
- slope_postgc ext: -22.9..+10.5 → +21.4..+25.6 MB (healthy range too close for a tight bound)

## Still to collect
- At least 10 CI (GitHub runner) TM2-64-DATA lines from this draft PR.
- Local Windows numbers.
