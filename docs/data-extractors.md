# Custom data extractors

Run **Create Data Extractor** to create an editable script and save it as `name.rbextract.json`. Select **Custom Extractor** in the Query Results export menu or run **Export with Data Extractor** and choose a completed result. Review the output and destination before saving. The result stays in the database workbench and the extractor uses its captured rows, including the currently captured page if the result is paged.

```json
{
  "version": 1,
  "name": "Account metrics",
  "extension": "txt",
  "header": ["Schema ", {"meta": "source.schema"}, "\n",
    {"columns": {"template": [{"meta": "column.name"}, " (", {"meta": "column.kind"}, ")"], "separator": " | "}}, "\n"
  ],
  "row": [{"cell": "account_id", "as": "json"}, "\t", {"cell": "amount"}, "\n"],
  "footer": ["Total ", {"aggregate": {"operation": "sum", "cell": "amount"}}, "\n"]
}
```

| Instruction | Where | Value |
| --- | --- | --- |
| A JSON string | Any template | Literal text |
| `{"cell": selector}` | `row` | A cell selected by its unique displayed name or 1-based column position |
| `{"meta": "source.schema"}` | Any template | `source.schema`, `source.table`, `source.rowCount`, or `source.partial`. Mixed or unavailable origins are `null` |
| `{"meta": "row.number"}` | `row` | The original 1-based row position in the captured result |
| `{"columns": {"template": [...], "separator": " | "}}` | `header` | One fragment per captured column. Inside it, use `column.name`, `column.ordinal`, `column.kind`, `column.protocolType`, `column.schema`, `column.table`, and `column.originalName` with `meta` |
| `{"meta": "rows.emitted"}` | `footer` | The number of rows retained by the filter |
| `{"aggregate": {"operation": "count", "cell": selector}}` | `footer` | Count of non-NULL values in retained rows. `sum` returns an exact decimal string for observed integer and decimal columns, or `null` when every retained value is NULL |

Add an optional top-level `filter` such as `{"cell": "department", "equals": "monitors"}` to keep rows with an exact type and value match. The optional `as` property on `cell`, `meta`, or `aggregate` accepts `raw`, `json`, `csv`, `tsv`, `xml`, and `base64`. `raw` renders SQL NULL as empty text. `json` emits `null` and preserves driver-supplied integer, decimal, and hexadecimal strings. The CSV and TSV encodings protect spreadsheet formula prefixes.

Choose `txt`, `csv`, `tsv`, `jsonl`, `ndjson`, `md`, `xml`, `html`, or `sql` as the output extension. Scripts are restricted to literals, result metadata, captured values, and the documented operations. The extractor itself has no API for filesystem access, database queries, network requests, or subprocesses.

Rocketbrain processes one row or output chunk at a time. It accepts up to 64 KiB of script text, 256 columns, 5,000 captured rows, 256 KiB per output chunk, and 32 MiB total. The preview shows the first 8 KiB and the checksum of the entire output. A saved copy must match that checksum, the source result must remain current, and the destination filename must be new.
