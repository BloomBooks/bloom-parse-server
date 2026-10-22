# Switching book search from `$text` to Atlas Search (sketch)

Status: idea only, not scheduled. Prompted by an Atlas email (Oct 2026) recommending `$search` over `$text`.

## Today

- BloomLibrary2 (`LibraryQueryHooks.ts`) sends `where.search = { $text: { $search: { $term } } }` and orders by `$score`.
- MongoDB ignores the field name and uses the `books.search_text` text index: title/allTitles (100), keywords (90),
  summary/tags/bookshelves/publisher/originalPublisher/credits/copyright/country (50). `default_language: english`.
- The `search` field built in `cloud/main.js` is not in that index. See UPGRADE-PLAN.md §5.3 for the related patch.

## Why switch

Speed is not the reason: book volume is small and `$text` is fine. The gains are search quality: typo tolerance,
partial-word/prefix matching, and non-English-friendly analysis instead of English stemming and stop words for every book.
There is no extra Atlas charge if search runs on the existing cluster nodes. Dedicated Search Nodes are optional and paid.

## What it would take

1. **Atlas Search index** on `books` mirroring the weights above (as score boosts), with a language-neutral analyzer.
2. **Cloud function** `searchBooks` (Parse has no `$search` in normal queries, and `/aggregate` needs the master key):
   - `aggregate([{ $search: ... }, { $limit: N }, { $project: { _id, score } }])` with `useMasterKey` → ids + scores.
   - Run the existing Parse query (filters, ACL, includes, keys) with `objectId: { $in: ids }` added.
   - Sort by score; handle skip/limit and count.
   Parse passes `$search` through aggregate unchanged since parse-server PR #7237 (2021), and 8.6.84 does too.
3. **BloomLibrary2**: call `searchBooks` when there are free-text terms instead of putting `$text` in `where`.
4. **Later**: drop `search_text` and our `createTextIndexesIfNeeded` patch once nothing uses `$text`.

Rough size: a few days, mostly testing ranking and paging against real searches.

## Before starting

- Confirm the live index definition (`db.books.getIndexes()`); the weights above come from our docs.
- Check the cluster tier's search index limits.
