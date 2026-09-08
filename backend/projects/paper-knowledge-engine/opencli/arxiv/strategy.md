# arXiv harvest adapter strategy

Strategy: `PUBLIC_API`

Contract: `stable`

Evidence:

- Observed endpoints: `https://export.arxiv.org/api/query` (default) and `https://arxiv.org/api/query`, both returning Atom XML.
- Authentication: none.
- Required fields: title, abstract, arXiv ID/version, published, updated, categories, and PDF link.
- Date handling: arXiv supports `submittedDate` filtering and `lastUpdatedDate` sorting; updated-channel filtering is performed locally using Atom `updated`. `max-results` bounds both scanned entries and returned candidates. If an updated scan reaches that bound before the lower date boundary, it returns the bounded in-window candidates and emits a `discovery-scan-truncated` warning instead of aborting the whole run.
- Retry-After handling: only nonblank, finite, nonnegative numeric delay-seconds are accepted; HTTP-date values are not parsed.
- Browser bridge: not required. The adapter is metadata-only and does not download PDFs.

The Builder's `src/pdf-store.ts` owns PDF download, validation, hashing, formal classification, and SQLite state. This adapter never writes PDF files.

The maintained adapter is TypeScript. Bun.build generates ESM JavaScript under the project-configured temp root; discovery uses the isolated profile and exact project dependency (1.8.6). Invalid XML/non-Atom responses fail rather than masquerading as empty result sets. Bun fetch request timeouts and retry limits are supplied by the parent's runtime policy. Installation/runtime integrity and lease behavior are documented in README.md beside these sources.
