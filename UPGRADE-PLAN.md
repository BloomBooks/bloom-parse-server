# Dependency Modernization Plan

_Prepared 2026-07-06. Research verified against parse-server 9.9.0 source, npm registry, and upstream
issue trackers on that date; citations are included so findings can be re-checked later._

## 1. Summary

This repo is pinned to `parse-server@7.0.0-alpha.1` — a pre-release from late 2023 — with three
`patch-package` hacks against parse-server internals. The `engines` field allows only Node 16 and 18,
both of which are past end-of-life (Node 20 also reached EOL in April 2026). `parse-dashboard` is four
major versions behind, and `mailgun-js` has been deprecated for years (there is a note in
`package.json` to that effect).

This document describes what it takes to bring everything up to date, in two selectable tracks:

- **Track A — Full modernization** (§6): everything current, deprecated packages replaced,
  `setupTables` retired in favor of parse-server defined schemas, an automated test harness added.
- **Track B — Minimal keep-the-lights-on** (§7): only the changes that are forced by moving to a
  supported parse-server and Node runtime.

Both tracks are documented because a **Supabase migration is planned** (see `supabase/` docs) but its
timing is uncertain. Whichever track is chosen, this upgrade keeps the service on supported,
security-patched software until that migration lands — or in case it never does.

### The headline numbers

| Component | Current | Target | Jump |
| --- | --- | --- | --- |
| parse-server | 7.0.0-alpha.1 | **8.6.84** (revised from 9.9.0 — see decision #2) | 1+ major (and off a pre-release) |
| Node.js | 18.x (16 allowed) | **22 LTS** | 2 LTS lines; 16/18/20 are all EOL |
| parse-dashboard | 5.3.0 | 9.1.1 | 4 majors |
| express | 4.18.2 | ^5.2.1 | 1 major (parse-server 8+ is Express 5 internally) |
| mailgun-js (deprecated) | 0.22.0 | mailgun.js 13.2.0 | package replacement |
| eslint / prettier | 8.38.0 / 2.8.7 | 10.x (flat config) / 3.x | dev-tooling refresh |
| axios | ^1.7.7 | latest 1.x (1.18+) | minor bumps only |
| jsonwebtoken | 9.0.2 | 9.0.3 | patch |
| patch-package | 8.0.0 | keep | still needed (see §5) |
| MongoDB (Atlas) | **8.x (current live version)** | no change | 8.6.84 requires ≥8.0.4 on the 8.x line ✓ |

## 2. Decisions log

All decisions below were made by Andrew on **2026-07-06** while preparing this document.

1. **Document both tracks.** Because the Supabase migration timing is uncertain, this doc describes
   both a full modernization and a minimal upgrade, so the team can choose when scheduling the work.
2. **Target parse-server 9.9.0** (latest stable). Rejected: 8.6.x — it already forces the two hard
   parts (Express 5, Node bump) while reaching EOL sooner; 7.5.4 — buys almost nothing.
   **REVISED during Phase 1 (2026-07-06): ship 8.6.84 instead.** `npm audit` revealed that
   parse-server 9.9.0 stable carries 9 security advisories (including two high-severity DoS issues
   reachable on our public REST API: GHSA-38m6-82c8-4xfm pre-auth header-regex backtracking, and
   GHSA-cgxm-vr2f-6fj8 deeply-nested query operators) whose fixes exist only in 9.9.1-alpha
   pre-releases — pinning an alpha is exactly the situation this upgrade exists to escape.
   8.6.84 is the fully patched, actively maintained previous-major stable; all our 9.x migration
   work (Express 5, Node 22, patch shapes) carries over, and the later 8.6.x → 9.x bump is cheap
   once a patched 9.x stable ships (every 9-only breaking change is unused or already satisfied
   here). Rejected: staying on 9.9.0 (accepts two public DoS highs); pinning 9.9.1-alpha.13
   (repeats the alpha-pin mistake).
3. **MongoDB 8 is the target — it's what the live Atlas clusters run** (confirmed 2026-07-06).
   Not a blocker for any parse-server version considered (8.6.84 requires ≥6.0.19/7.0.16/8.0.4;
   9.x requires ≥7.0.16). All local development and testing should use a MongoDB 8.0.x binary to
   match production — the smoke validation used 8.0.14 via mongodb-memory-server.
4. **Add automated tests** and **retire `setupTables`** in favor of parse-server's built-in defined
   schemas (`schema.definitions` config). See §9 and §10.
   *Revised 2026-07-06: the vitest harness is deferred — the Phase 1 upgrade deploys to
   unittest/develop first, validated by the smoke checks and manual Azure flows. Build the harness
   later, at latest alongside the defined-schemas work (§10), where a fast local iteration loop
   against disposable MongoDB 8 databases matters most.*
5. **Keep the email-query patch, re-based** onto 9.9.0. This preserves today's exact behavior:
   clients can *query* on `_User.email` but email values are still stripped from responses.
   Rejected alternatives:
   - `protectedFields: { _User: { '*': [] } }` config (no patch needed, fully supported) — but it
     would also make email *readable* by anyone, since `enforcePrivateUsers: false` leaves `_User`
     rows publicly readable. A real privacy regression.
   - A cloud function that looks up users by email under `useMasterKey` — the fully supported,
     no-patch path, but it requires changes to the clients (bloomlibrary.org / BloomDesktop) that
     query by email today. Worth reconsidering during the Supabase migration.
6. **Node 22 LTS — specifically `22.22.2`.** The Azure Windows App Service platform (portal listing
   as of 2026-06-23) offers Node up to 22.22.2 and **does not offer Node 24 at all**, so 22 is the
   only line that satisfies parse-server 9.9.0 (`>=20.19 <21 || >=22.13 <23 || >=24.11 <25`) — note
   22.5.1 does *not* satisfy it. See §8 Phase 0 item 3 for the exact-pin vs `~22` caveat.
7. **vitest** as the test framework (team preference), with `mongodb-memory-server` for an ephemeral
   database. (Upstream parse-server-example uses jasmine; we deliberately deviate.)
8. **Deployment pipeline stays on Kudu for this upgrade.** Migration to GitHub Actions is documented
   as recommended follow-up work (§12), not part of this effort.
9. **ESM conversion is in scope, as its own late phase** (§11). The Feb 2023 failure now has a
   plausible diagnosis and the Node 22 bump likely removes the blocker; a cheap feasibility spike
   will confirm before committing.
10. **npm audit posture (added during Phase 1, 2026-07-06).** Original state: 35 vulnerabilities.
    After `npm audit fix`, patch-package 8.0.1, the 8.6.84 move, and three npm `overrides`
    (`@parse/push-adapter` 8.4.0 — parse-server 8.x pins 6.x whose node-gcm/node-apn chain carries
    critical `request`/`form-data` and high `node-forge` advisories in push code we never use;
    `ws` ^8.21.0; `uuid` ^11.1.1): **11 remain (3 high, 8 moderate, 0 critical), all with no
    upstream fix available**, in two buckets we accept and document:
    - `lodash` (direct dep of parse-server 8; advisories affect ALL released versions, no fix
      exists; parse-server 9 dropped lodash — goes away at the future 9.x bump);
    - parse-dashboard's prebuilt bundle (`markdown-it`/`linkify-it` high, `react-router` moderate —
      npm overrides can't change prebuilt bundle code; dashboard sits behind master-key login);
    - plus moderates with no fixed release (`follow-redirects`) or in unused subsystems
      (`@apollo/server` 4 — GraphQL unused; google-cloud chain under firebase-admin — push unused).
    Re-check `npm audit` at each future dependency bump; drop the overrides when parse-server
    updates its own pins.
11. **Selective re-alignment with upstream `parse-server-example`, staying JavaScript.** Upstream is
    now TypeScript + ESM + jasmine + Docker + semantic-release. We use it as a reference blueprint
    (ESM, index/config structure, test layout, CI ideas) but skip TypeScript, Docker, and
    semantic-release — converting 1000+ lines of cloud code to TS is poor ROI ahead of a possible
    Supabase migration. No git-level merge with upstream.

## 3. Current state

### Runtime and deployment

- **Azure App Service (Windows) + iisnode** (`web.config`). Node version comes from the
  `WEBSITE_NODE_DEFAULT_VERSION` app setting — confirmed **18.12.1 in all environments**
  (2026-07-06), not marked as a deployment-slot setting.
- Three services, all deployed by Deployment Center sync ("App Service Build Service" / Kudu):
  `bloom-parse-server-unittest` and `-develop` redeploy **directly** on pushes to the `develop`
  branch (no staging slot); `-production` deploys from `master` to a staging slot
  (`-production-staging`) followed by a manual swap.
- Each service is backed by its own MongoDB Atlas cluster.
- `postinstall` runs `patch-package`, applying `patches/parse-server+7.0.0-alpha.1.patch`.

### Code

- `index.js` uses the modern `new ParseServer(config)` + `server.start()` pattern and mounts
  `server.app` plus parse-dashboard on a host express app. Notable config: `enforcePrivateUsers:
  false`, `allowClientClassCreation: false`, `masterKeyIps` (from `PARSE_SERVER_MASTER_KEY_IPS`),
  `readOnlyMasterKey`, and a custom Firebase auth adapter
  (`auth: { bloom: { module: BloomFirebaseAuthAdapter, enabled: true } }`).
- Cloud code (`cloud/main.js`, `emails.js`, `utility.js`) is already in modern async style — no
  legacy `response.success` callbacks, no `Parse.Cloud.httpRequest`, no LiveQuery/push/file adapters.
- **No automated tests and no CI.** Validation today is manual: local runs plus deploying to the
  unittest instance.
- `setupTables` (cloud/main.js) creates classes/fields by saving and deleting dummy objects. Per its
  own July 2025 comment, practice has drifted to manual dashboard edits and running it against live
  is likely unsafe. Per-environment schema snapshots live in the private repo
  [BloomBooks/bloom-parser-server-schema](https://github.com/BloomBooks/bloom-parser-server-schema).

## 4. What breaks between 7.0.0-alpha.1 and 9.9.0

From the release notes ([8.0.0](https://github.com/parse-community/parse-server/releases/tag/8.0.0),
[9.0.0](https://github.com/parse-community/parse-server/releases/tag/9.0.0)) and the 7.0.0 changelog,
filtered to what affects *this* repo:

**Affects us:**

- **Node floor**: 9.9.0 requires ≥20.19 / ≥22.13 / ≥24.11 → forces the Node 22 move (decision #6).
- **MongoDB floor**: satisfied — live clusters run MongoDB 8 (decision #3).
- **Express 4 → 5** (in 8.0.0): parse-server's release notes recommend hosts mount it in an
  Express 5 app. Our host routes are trivial, so bumping `express` to ^5 is low-effort. The main
  Express 5 breaking changes (route syntax, removed APIs) don't appear in `index.js`.
- **`encodeParseObjectInCloudFunction`** is always-on in 9.x: Parse.Objects passed to/returned from
  cloud functions are real `Parse.Object` instances. Our cloud functions mostly take plain params,
  but this needs regression testing (§9).
- **Stricter authData validation at login**
  ([GHSA-pfj7-wv7c-22pr](https://github.com/parse-community/parse-server/pull/10246)) and
  `allowExpiredAuthDataToken: false` (default since 7.0) — the Bloom Firebase login flow must be
  regression-tested, including what happens when a client reuses cached authData with an expired
  token.
- **Uncaught exceptions exit the process** (since 7.0) — confirm iisnode restarts the process
  cleanly (it should; that's its job).
- **Parse JS SDK is now v8** (bundled): no impact found in our cloud code, but it rides along with
  the upgrade.

**Does not affect us** (verified unused in this repo): PagesRouter/PublicAPIRouter, GraphQL /
Apollo 5 / introspection changes, path-to-regexp v8 syntax for cloud routes and rate limits,
LiveQuery `fields`→`keys`, push notifications, file adapters, `allowPublicExplain`,
username-in-verification-emails.

**Pre-empt future breakage (10.0 deprecations)** by setting these explicitly in `serverConfig`:
`readOnlyMasterKeyIps: ['0.0.0.0/0', '::/0']` (DEPPS15 flips the default to localhost-only),
and be aware of DEPPS21–23 (`protectedFieldsOwnerExempt` etc.) documented in
[DEPRECATIONS.md](https://github.com/parse-community/parse-server/blob/alpha/DEPRECATIONS.md).

## 5. The three patches: dispositions

Documented in `patches/parse-server.txt`; patch file `patches/parse-server+7.0.0-alpha.1.patch`.

### 5.1 `middlewares.js` (master key rejected, clientIp undefined) — **DROP; fix config instead**

Root cause found: this was a config-spelling problem all along. parse-server's `getBlockList`
special-cases the allow-all spellings `0.0.0.0/0`, `0.0.0.0`, `::/0`, and `::` — but **not `::0`**.
The actual value in every environment is confirmed to be `0.0.0.0/0,::0` (Phase 0, 2026-07-06) —
exactly the unrecognized spelling. Behind iisnode, `req.ip` is `undefined` (named-pipe transport),
and since `::0` never set the allow-all-IPv6 flag, the check failed. With
`masterKeyIps: ['0.0.0.0/0', '::/0']`, an undefined client IP passes in every version from
7.0.0-alpha.1 through 9.9.0 (verified in source).

**Action:** change the `PARSE_SERVER_MASTER_KEY_IPS` app setting from `0.0.0.0/0,::0` to
`0.0.0.0/0,::/0` in all three Azure services, drop this patch. Also set
`readOnlyMasterKeyIps: ['0.0.0.0/0', '::/0']` explicitly (see §4). If we ever want *real* IP
restriction behind Azure's front end, the parent express app needs `app.set('trust proxy', ...)`
(sub-apps inherit it) so `req.ip` derives from `X-Forwarded-For`.

### 5.2 `RestQuery.js` (allow querying on `_User.email`) — **KEEP, re-based** (decision #5)

The `denyProtectedFields()` check still exists in 9.9.0 and has been hardened (it now also blocks
*sorting* by protected fields). The default protection comes from
`protectedFields: { _User: { '*': ['email'] } }` in
[Options/Definitions.js](https://github.com/parse-community/parse-server/blob/release/src/Options/Definitions.js).
Re-author the same skip in `_UnsafeRestQuery.prototype.execute` against the 9.9.0 `lib/` output.
The rejected no-patch alternatives (and why) are recorded in decision #5.

### 5.3 `MongoStorageAdapter.js` (text-index no-op) — **CARRY FORWARD, regenerated**

The code path is byte-for-byte unchanged in 9.9.0 (long-standing upstream issue
[#5084](https://github.com/parse-community/parse-server/issues/5084)). Root cause, now understood:
our actual `search_text` Mongo text index does not include the `search` field in its weights, so the
`_SCHEMA` metadata entry has no `search` key; parse-server's guard falls through and it tries to
create the index, which throws `"Index search_text exists, cannot update."` (Parse error 102 — the
code only catches raw Mongo error 85).

**Action:** regenerate the same 3-line no-op patch against 9.9.0. **Proper-fix alternatives** to
evaluate when convenient (either would let us drop the patch):

- Fix the `books` class `_SCHEMA` `_metadata.indexes.search_text` entry to include `search: 'text'`
  so the guard's early-return triggers. Risk: parse-server can rewrite this metadata from the real
  indexes later.
- Rebuild the Mongo text index with `search` in its weights. Cleanest, but changes full-text ranking
  behavior and needs testing against real queries.

The defined-schemas work (§10) is a natural venue for the proper fix, since schema definitions can
declare indexes.

### Verified non-issues

- **Custom Firebase auth adapter**: the module-style `{ validateAppId, validateAuthData }` interface
  is a first-class path in 9.9.0 (`loadAuthAdapter` copies those functions onto the adapter; the
  new-style `validateSetUp/validateLogin/validateUpdate` trio is optional).
  `enableInsecureAuthAdapters` (default `false` in 9.x) only gates *built-in* adapters — our custom
  adapter fully verifies the Firebase JWT server-side and is unaffected. **No changes needed.**
- **parse-dashboard 5.3.0 → 9.1.1**: the `apps` / `users` (incl. `readOnly`) / `trustProxy` config
  and express mounting are unchanged across 6/7/8/9. Only the Node floor changed.

## 6. Track A — Full modernization

Everything in Track B (§7), plus:

| Item | Work |
| --- | --- |
| parse-dashboard → 9.1.1 | Version bump only; config unchanged (§5, non-issues). Verify login + read-only user on unittest. |
| mailgun-js → mailgun.js 13.x | Rewrite the send call in `cloud/emails.js` (~15 lines): `new Mailgun(FormData)` (Node's built-in FormData), `mailgun.client({ username: 'api', key: MAILGUN_API_KEY })`, `await mg.messages.create('bloomlibrary.org', data)` — the domain moves from client config to the call; promise instead of callback. `h:X-Mailgun-Variables` headers pass through unchanged. Remove the deprecation note from package.json. |
| eslint 8 → 10 | Move `.eslintrc.json` to flat `eslint.config.js`; drop `@babel/eslint-parser` (plain CJS/ESM needs no babel parser now). |
| prettier 2 → 3 | Reformat; the notable default change is `trailingComma: "all"`. |
| axios | Routine bump to latest 1.x. |
| setupTables → defined schemas | §10. |
| Test harness | §9. |
| ESM conversion | §11 (late phase, after everything above is stable). |

## 7. Track B — Minimal keep-the-lights-on

The forced core only:

1. parse-server 7.0.0-alpha.1 → 9.9.0.
2. Node 22 (engines + `WEBSITE_NODE_DEFAULT_VERSION` on all app services: unittest, develop,
   production, and the production staging slot).
3. express → ^5 (recommended pairing with parse-server 8+; trivial here).
4. Patch triage per §5 (drop one, re-base two).
5. Azure app-setting fix: `PARSE_SERVER_MASTER_KEY_IPS` → `0.0.0.0/0,::/0`.
6. `readOnlyMasterKeyIps` added to `serverConfig` (future-proofing, §4).

**Deferred, with the risk carried:**

- parse-dashboard stays at 5.3.0 — old React tooling, unpatched CVEs in its dependency tree, and a
  risk it misbehaves against a 9.x server (it predates several API changes).
- mailgun-js stays — deprecated, unmaintained, and its transitive deps carry known vulnerabilities.
- No tests — every future change, including the eventual Supabase cutover prep, keeps relying on
  manual validation against Azure instances.
- setupTables stays in its current "probably unsafe to run" limbo; schema drift continues to be
  managed by hand.
- eslint/prettier stay on EOL majors (annoyance, not risk).

## 8. Upgrade sequence (either track)

### Phase 0 — Pre-flight ✅ COMPLETE (verified by Andrew, 2026-07-06)

1. ✅ **MongoDB version verified** — live clusters run MongoDB 8, above every parse-server floor
   in play (8.6.84: ≥8.0.4 on the 8.x line; 9.x: ≥7.0.16).
2. ✅ **`PARSE_SERVER_MASTER_KEY_IPS` is `0.0.0.0/0,::0` in every environment** — this confirms the
   §5.1 root cause exactly: `::0` is the one allow-all spelling parse-server does *not* recognize.
   The fix (change `::0` → `::/0`) applies to all environments.
3. ✅ **Node version chosen: `22.22.2`** (from the portal's availability list; satisfies
   `>=22.13 <23`). Caveat for the future: Azure keeps only the latest two minor builds per line, so
   an exact pin can eventually reference a removed build. If that ever bites, switch to Microsoft's
   tilde syntax (`~22`), which tracks the latest available 22.x automatically.
4. ✅ **Schema snapshots refreshed** — exported for all three environments into three files under
   `schema/` in this repo. They are **gitignored deliberately**: they may expose details of our
   setup (CLPs, field inventory) that could aid an attacker, so they stay local/private until that
   concern is evaluated. (The private repo
   [BloomBooks/bloom-parser-server-schema](https://github.com/BloomBooks/bloom-parser-server-schema)
   remains the shareable home for schema history.)
5. ✅ **`WEBSITE_NODE_DEFAULT_VERSION` is 18.12.1 in all environments and is _not_ marked as a
   deployment-slot setting.** For **production** (the only service with a staging slot) that's
   good news: non-slot settings travel *with* a swap, so the rollout can set `22.22.2` on the
   staging slot only, deploy and verify there, and the swap moves code + Node version to
   production atomically — and a swap-back reverts both together. For **unittest and develop**
   (no slots, direct deploy from `develop`), the settings must simply be changed on the app
   service *before* the branch merge that triggers the deploy.

### Phase 1 — Local upgrade

1. Branch from `develop`. Update `package.json` (see §1 table; engines → `>=22 <23`).
2. Delete the old patch; `npm install`; re-author the two surviving patches (§5.2, §5.3) against
   `node_modules/parse-server/lib/` and regenerate with `npx patch-package parse-server`.
3. Update `serverConfig` in `index.js`: add `readOnlyMasterKeyIps`; keep everything else as-is
   (`server.start().then(...)` pattern stays — see §13).
4. Track A: mailgun.js rewrite, eslint/prettier updates.
5. Update README (Node version, any changed steps) and `patches/parse-server.txt` (new dispositions).

### Phase 2 — Local validation

1. Run against a local mongod (8.0.x to match production): server boots, dashboard loads,
   `functions/testDB`-style smoke checks.
2. Track A: run the new vitest suite (§9).
3. Manual checks: create/query a book with the master key; full-text search on `search` (exercises
   the §5.3 patch); query `_User` by email without master key (exercises §5.2); a Firebase login
   round-trip if credentials are available locally.

### Phase 3 — unittest instance

1. On **bloom-parse-server-unittest** first (no staging slot — it deploys directly from `develop`):
   set `WEBSITE_NODE_DEFAULT_VERSION` to `22.22.2` and fix the `PARSE_SERVER_MASTER_KEY_IPS`
   spelling (`0.0.0.0/0,::/0`) **before** merging anything to `develop`.
2. Deploy the branch there. Note that merging to `develop` deploys to **both** unittest and the
   develop service at once (both watch that branch), so to test on unittest alone first, point its
   Deployment Center at the upgrade branch temporarily — and remember the develop service's app
   settings (step 1) must be fixed before the actual merge.
3. Run BloomDesktop and bloomlibrary.org test flows against it: upload a book, moderator edits,
   search, login, `sendConcernEmail`, run both jobs from the dashboard.
4. This is also when the ESM feasibility spike (§11) can piggyback, since the Node version is now 22.

### Phase 4 — develop, then production

1. Set `WEBSITE_NODE_DEFAULT_VERSION=22.22.2` and the fixed `PARSE_SERVER_MASTER_KEY_IPS` on the
   **bloom-parse-server-develop** app service (no staging slot), then merge to `develop` — the
   service redeploys automatically. **Rollback** on develop = revert the merge commit (redeploys
   the old code) and restore the two app settings.
2. Watch logs (App Service Log stream) for the first hours; the failure modes to watch for are master
   key rejections (§5.1 territory), text-index errors (§5.3), and login failures (authData changes).
3. For `master` → production: set the two app settings on the **production staging slot**, let it
   deploy, verify, then swap. Because they are not slot settings (Phase 0 item 5), the swap carries
   code and settings to production together, and **rollback** = swap back, which reverts both
   atomically.

## 9. Test harness (Track A — deferred; see decision #4)

Not a gate for the initial unittest/develop/production deploys; build before or alongside the
defined-schemas migration (§10).

**Stack:** vitest + `mongodb-memory-server` (spins up a real mongod per run; pin its binary to
8.0.x to match production). A `spec/` or `tests/` directory, `npm test` script, and a helper that
boots ParseServer on an ephemeral port with `cloud/main.js` loaded — upstream parse-server-example's
`spec/` is the structural reference.

**What to cover (in priority order):**

1. Server boots and answers a basic query (catches config/option regressions across upgrades).
2. `books` beforeSave behaviors: tag normalization and `system:Incoming`, `search` string building,
   `bookLineage` → `bookLineageArray`, `hasBloomPub`, moderator-field protection on re-upload, ACLs.
3. `books` afterSave: tag record creation; new-book email path with mailgun mocked.
4. Auth: `bloomLink` and the Firebase adapter with `jsonwebtoken` fed by a locally generated keypair
   (mock the Google public-key fetch in `httpsRequest.js`).
5. Master key / read-only master key acceptance (guards the §5.1 config fix).
6. Query `_User` by email without master key succeeds *and* email is absent from the response
   (guards the §5.2 patch across future re-bases).
7. Full-text search on `search` (guards the §5.3 patch).

Also keep a short **manual Azure checklist** in the README for phases 3–4: dashboard login (both
users), BloomDesktop upload, bloomlibrary.org browse/search, both jobs, concern email.

## 10. setupTables → defined schemas (Track A)

Replace the dummy-object-saving `setupTables` cloud function with parse-server's supported
[defined schemas](https://docs.parseplatform.org/defined-schema/guide/) (`schema` server option):

1. ✅ Live schema already exported from all three environments (Phase 0 item 4) into gitignored
   files under `schema/`. Reconcile these against the snapshots in the private schema repo — the
   July 2025 comment in main.js warns things have drifted; the live export is the source of truth.
2. Author `schema.definitions` (likely a `schema.js` the private repo's per-environment data can feed)
   including CLPs and indexes — which setupTables never handled.
3. Roll out with the safe flags first: `strict: false`, `deleteExtraFields: false`,
   `recreateModifiedFields: false`. Watch startup logs on unittest; tighten later and consider
   `lockSchemas: true` to end ad-hoc dashboard edits.
4. The `search_text` index is the natural place to apply the §5.3 proper fix (declare the index with
   `search` in it, or at least reconcile the metadata).
5. Once parity is confirmed on all environments, delete `setupTables` from `cloud/main.js` and update
   the README instructions that reference it.

This also directly serves the Supabase plan: `supabase/overview.md` maps "setupTables → SQL
migrations", and a reconciled, declarative schema is a far better migration input than the drifted
function.

## 11. ESM conversion (late phase)

**Why it failed in Feb 2023** (the index.js comment): iisnode loads the entry script by `require()`
from its interceptor shim. `require()` of an ES module was a hard `ERR_REQUIRE_ESM` error on every
Node version available then — which is exactly why it worked locally (`node index.js` uses the ESM
loader directly) but failed only on Azure. Not a mystery, and not our bug.

**Why it should work now:** Node ≥22.12 supports `require()` of ES modules natively, and the upgrade
puts us on 22.14+.

**Plan:**

1. **Feasibility spike** (piggybacks on Phase 3): deploy a trivial `"type": "module"` hello-world to
   the unittest service on Node 22. If it serves requests, the blocker is gone. Cost: an hour.
2. If green: after the dependency upgrade has soaked in production, convert `index.js`,
   `bloomFirebaseAuthAdapter.js`, `httpsRequest.js`, and the cloud code to ESM in a separate PR,
   using upstream parse-server-example's `index.ts`/`config.ts` structure as the blueprint (minus
   TypeScript, per decision #11). parse-server loads ESM cloud code via dynamic `import()`.
3. If red: document the observed error in this file and defer; nothing else in this plan depends on it.

## 12. Follow-up: CI/CD modernization (documented only — decision #8)

The current Kudu "App Service Build Service" sync still works but is legacy; Microsoft's current
recommendation for GitHub-sourced deploys is GitHub Actions, and once vitest exists, CI gating is the
natural next step. Recommended future shape:

1. Workflow on push to `develop`/`master`: `actions/setup-node` (22.x) → `npm ci` → lint → vitest.
2. Auth to Azure via **OIDC federated credentials** (`azure/login` + an Entra service principal — no
   long-lived secrets in GitHub). Simpler alternative: a publish-profile secret (fine for a small
   team, but it's a rotatable credential).
3. Deploy with `azure/webapps-deploy@v3`. For unittest/develop, deploy straight to the app service
   (they have no slots); for production, deploy with `slot-name: staging`. Windows App Services
   are fully supported.
4. Production's manual portal slot swap stays exactly as it is today (optionally automated later
   with `az webapp deployment slot swap`).

Until then, note that Kudu builds run on the App Service itself and nothing gates a deploy — tests
are a local-only tool.

## 13. Risks and open questions

- **No tests at the starting line.** The riskiest step (the parse-server bump itself) is validated
  manually unless Track A's harness is built *first* — worth considering building §9 against the
  current alpha before upgrading, so behavior changes are visible in the diff of test results.
- **iisnode is essentially unmaintained.** It works, but it's legacy; a future move to Linux App
  Service (plain `node` hosting, no `web.config`) would retire it. Out of scope here.
- **`await server.start()` flakiness (2023 note in index.js).** Keep the `.then()` pattern during the
  upgrade; the ESM/spike phase is the right time to re-test the modern pattern, since the cause was
  likely the same iisnode/Node-version vintage.
- **Expired cached authData**: `allowExpiredAuthDataToken` defaults to `false` since 7.0 — confirm
  BloomDesktop/bloomlibrary.org login sessions survive (they should re-present a fresh Firebase
  token, but verify).
- ~~Slot-sticky app settings~~ **Resolved** (Phase 0 item 5): `WEBSITE_NODE_DEFAULT_VERSION` is not
  a slot setting anywhere, so on production (the only service with a slot) it swaps with the app —
  set it on staging, verify, swap; swap-back
  rolls it back.
- **Gitignored schema exports in `schema/`**: kept out of git pending a review of whether publishing
  CLP/field details in a public repo is a security exposure. Decide their long-term home (likely the
  private schema repo) before the §10 work bakes them into config.
- **Supabase interplay**: nothing here conflicts with the migration plan; §10 actively helps it. The
  `bookDeletion` tombstone / `afterDelete` work in `supabase/parse-server-prep.md` is separate and
  can land before or after this upgrade.

## 14. Reference: key sources

- parse-server releases: [8.0.0](https://github.com/parse-community/parse-server/releases/tag/8.0.0),
  [9.0.0](https://github.com/parse-community/parse-server/releases/tag/9.0.0);
  [DEPRECATIONS.md](https://github.com/parse-community/parse-server/blob/alpha/DEPRECATIONS.md)
- masterKeyIps behavior: [middlewares.js source](https://github.com/parse-community/parse-server/blob/release/src/middlewares.js),
  advisory [GHSA-vm5r-c87r-pf6x](https://github.com/parse-community/parse-server/security/advisories/GHSA-vm5r-c87r-pf6x),
  discussion [#8872](https://github.com/parse-community/parse-server/issues/8872)
- Text index bug: [#5084](https://github.com/parse-community/parse-server/issues/5084)
- Auth adapters: [Adapters/Auth/index.js](https://github.com/parse-community/parse-server/blob/release/src/Adapters/Auth/index.js),
  authData validation fix [#10246](https://github.com/parse-community/parse-server/pull/10246)
- parse-dashboard releases: [6.0.0](https://github.com/parse-community/parse-dashboard/releases/tag/6.0.0),
  [7.0.0](https://github.com/parse-community/parse-dashboard/releases/tag/7.0.0),
  [9.0.0](https://github.com/parse-community/parse-dashboard/releases/tag/9.0.0)
- [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5.html)
- [mailgun.js README](https://github.com/mailgun/mailgun.js/blob/master/README.md)
- [Defined schemas guide](https://docs.parseplatform.org/defined-schema/guide/)
- Upstream blueprint: [parse-server-example](https://github.com/parse-community/parse-server-example)
