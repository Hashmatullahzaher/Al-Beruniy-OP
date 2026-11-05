# V1 reporting 0060: reversal confidentiality

Migration `0060_v1_reversal_confidentiality`, checksum `e1142a9451f8da44301fb22e5806ed1a9ba5d893865ccc11a1081d4f1d0ba6fe`.

## The defect

0057 treated every reversal as readable. For a reversal of a source the reader may not open, a report-only reader received:

- the `RV-` reference;
- the reversed journal's id as the source id, and a link to the reversals page;
- on journal detail, the free-text reason, which can name a person or a payment.

No amount, balance or source record id was wrong or exposed. It was found after 0057 reached production, by comparing a report-only reader with a full reader over the real API. Production held no journals at that point, so nothing was exposed.

## The rule

A reversal is as confidential as the journal it reverses.

- `report_source_readable` no longer names `REVERSAL`, so on its own a reversal is refused.
- `report_journal_reference` and `report_journal_source` decide through `report_effective_source_type`, which treats a reversal as the source it reverses.
- `finance_journal_detail` gives the reason only to a reader who may read that source.
- The reversal workspace masks the reference and reason of a completed reversal in the same way.

A restricted reader still sees the amounts, the date, the accounts and the generic "Reversal" label. No balance changes.

Reversal requests keep their reason for people holding the reversal workflow permissions, because they need it to decide.

## Scope

No table, no row and no journal. Five functions are restated, each keeping its owner, grants and signature.
