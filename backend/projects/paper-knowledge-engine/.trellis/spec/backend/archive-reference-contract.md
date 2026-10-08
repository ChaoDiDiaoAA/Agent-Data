# Archive reference contract

## 1. Scope / Trigger

This contract covers Markdown and MinerU structured-content resource handling in
`src/shared/archive-references.ts` and `src/shared/archive-v2.ts`, consumed by
MinerU normalization, Archive writing, and Archive verification. It exists to
prevent prose examples and footnotes from becoming filesystem reads.

## 2. Signatures

- `archiveReferences(fullMarkdown, contentList, contextMarkdown?)` returns the
  normalized local resource paths that must exist in the MinerU output tree.
- `rewriteArchiveReferences(fullMarkdown, contentList, assetPaths,
  contextMarkdown?)` rewrites only the resources accepted by discovery.
- `isFootnoteReferenceLabel(label)` is the shared predicate for CommonMark
  footnote labels.
- `isLikelyCitationParenthesizedProse(text, matchIndex, destination)` is the
  shared predicate for citation prose such as `[41](Transformer-based)`.

## 3. Contracts

- A normal reference definition such as `[figure]: assets/figure.jpg` is a
  resource only when an explicit reference uses that label.
- A bracket-colon line such as `[Trajectory Log]: trajectory\_text` is prose
  unless an explicit reference or image shortcut uses its label. Rewriting
  must not validate or normalize inactive definitions.
- A footnote definition such as `[^2]: ‘US‘ tabs ...` is prose. Labels whose
  trimmed value starts with `^` must be excluded from both discovery and
  rewriting, even when the footnote is cited.
- Discovery and rewriting must use the same notation and placeholder rules;
  every discovered local resource must resolve inside the current output tree.
- A numeric citation followed by one bare lexical term, such as
  `[41](Transformer-based)`, is parenthesized prose. It must be ignored by
  discovery and rewriting; paths, extensions, and image links remain strict.

## 4. Validation & Error Matrix

| Input | Outcome |
| --- | --- |
| `[^1][^2]` plus `[^2]: prose` | Ignore the prose definition |
| `[41](Transformer-based)` in an architecture sentence | Ignore the prose term |
| `[Trajectory Log]: trajectory\_text` with no reference use | Leave the prose unchanged |
| Active `[figure][img]` plus `[img]: assets/figure.jpg` | Require and rewrite the asset |
| Missing active local resource | Fail closed with the missing path |
| Remote URL, MinerU truncation, or approved extractor placeholder | Ignore as a local resource |
| Absolute, traversal, or unsafe local path | Reject before Archive installation |

## 5. Good / Base / Bad Cases

- Good: a footnote references a workbook sheet name such as `‘US‘` and the
  normalizer completes without trying to copy a file named `‘US‘`.
- Good: a paper writes `PatchTST [41](Transformer-based)` and the normalizer
  does not try to copy a file named `Transformer-based`.
- Good: a prompt template contains `[Trajectory Log]: trajectory\_text` and
  the rewrite pass leaves it unchanged.
- Base: a real Markdown image or active reference definition is copied under
  `assets/` and rewritten to its normalized destination.
- Bad: discovery ignores a false positive but the rewrite pass scans the same
  footnote again and calls `normalizeArchivePath` or `realpath` on its prose.

## 6. Tests Required

- `tests/archive-v2.test.ts` must assert that footnote discovery and rewriting
  return the original prose unchanged while ordinary reference assets remain
  strict.
- `tests/mineru-local-result.test.ts` must normalize the same footnote shape
  through the real MinerU artifact seam and assert no `assets/‘US‘` file is
  created.
- Both test suites must cover citation labels followed by bare prose terms and
  keep a real path such as `[41](assets/model.bin)` strict.
- The real MinerU normalization seam must cover an inactive bracket-colon line
  whose token contains a backslash escape.
- When a production diagnostic tree is available, rerun its normalization
  fixture and verify the resulting resource list contains images only, with no
  footnote tokens.

## 7. Wrong vs Correct

### Wrong

Treat every active `[label]: first-token` definition as an Archive path. A
footnote citation then turns prose such as `‘US‘ tabs ...` into a missing file.
Treat every `[number](bare-word)` sequence as a local link. A citation such as
`[41](Transformer-based)` then turns an architecture label into a missing file.
Rewrite every bracket-colon line as a resource definition. Prompt text such as
`[Trajectory Log]: trajectory\_text` then reaches POSIX path validation and
fails before the Archive can be written.

### Correct

Share `isFootnoteReferenceLabel` between discovery and rewriting, exclude
footnote definitions before resolving destinations, and keep strict validation
for all other active local references. Apply the same narrow citation-prose
predicate to both passes while retaining strict validation for paths,
extensions, and image links. Rewrite only active definitions (including image
shortcuts); leave inactive bracket-colon prose unchanged.
