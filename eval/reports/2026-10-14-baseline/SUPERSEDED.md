# Superseded

These reports use the **v1 scoring** of commit 28a202c: any line overlap between a retrieved chunk and the expected range counted as found, every expected item was required, and the fixture snapshot id was not checked.

The Codex C3 review showed this overstates retrieval. Do not compare these numbers with v2 reports or quote them as current results.

Current results use scoring `anchor-line/required-groups v2` and live in `eval/reports/2026-10-14-v2-baseline/` and `eval/reports/2026-10-14-v2-tuned/`. Those were measured on the same snapshots, the same indexes and the same tuning parameters, with no re-tuning.

This directory is kept for history.
