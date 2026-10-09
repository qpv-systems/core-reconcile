# Changelog

Versions follow Semantic Versioning. During the initial `0.x` series, minor releases may include API changes; patch releases contain compatible fixes.

## 0.1.0 — 2026-10-09

Initial package release:

- Generic one-to-one reconciliation with stable and composite identifiers.
- Alternative identifiers with duplicate and conflict detection in the in-memory API.
- Exact primitive comparisons and decimal-string comparisons with explicit tolerances.
- Structured outcomes, discrepancy reasons, source row references, and summaries.
- Explicit incomplete-source, missing-value, and business-deferral policies.
- Optional signed aggregates by currency, record type, and business date.
- Sorted streaming and caller-provided partition processing.
- Driver-independent database cursor and batch adapters.
- Optional Node-only `.xlsx` reader with disk-backed shared strings and configurable resource budgets.
- ESM exports, TypeScript declarations, MIT license, and package regression tests.

This entry documents the source version. It does not indicate publication to the npm registry.
