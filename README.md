# bloom-parse-server

This is the database backend for bloomlibrary.org, using the [parse-server](https://github.com/parse-community/parse-server) module.

Here is the full [Parse Server guide](http://docs.parseplatform.org/parse-server/guide/).

### Set Up For Local Development

1. Make sure you have Node 22 (or 24; see the engines field in package.json).

   `node --version`

1. Clone this repo and go into its directory, and install or update the dependencies (use npm, _not_ yarn):

   `npm install`

1. Install mongodb server (version 8.0.x, to match the live clusters)

1. Give mongodb a blank directory to work with (create it first if it doesn't exist), and run it:

   `path/to/mongod.exe --dbpath c:\temp\mongodata`

1. Start up this server:

   `npm start`

   Or, to debug, open bloom-parse-server in vscode, F5 (Debug: Launch via NPM). Note that this sets the masterKey to "123", via an environment variable.

1. Setup or update the schema:

   ```
   curl -X POST -H "X-Parse-Application-Id: myAppId" -H "X-Parse-Master-Key: 123" -d "{}" http://localhost:1337/parse/functions/setupTables
   ```

   You should get

   `{"result":"SetupTables ran to completion."}`

   and see the tables in the dashboard.

   But see notes on the `setupTables` function in `cloud/main.js` before running on a live database.

1. Run Parse Dashboard:

   Go to [http://localhost:1337/dashboard](http://localhost:1337/dashboard)

   You will be required to log in.

   For write access:

   - username = "master"
   - password = the master key ("123")

   For read-only access:

   - username = "readonly"
   - password = the read-only master key ("ro")

### Dashboard

See above for setting up the dashboard locally.

Public dashboards:

- Production: [https://parsedashboard.bloomlibrary.org](https://parsedashboard.bloomlibrary.org)
- Development: [https://dev-parsedashboard.bloomlibrary.org](https://dev-parsedashboard.bloomlibrary.org)

You will be required to log in.

For write access:

- username = "master"
- password = the master key

For read-only access:

- username = "readonly"
- password = the read-only master key

### Sample Queries

```
curl -X POST \
  -H "X-Parse-Application-Id: myAppId" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:1337/parse/functions/hello
```

### Deployment

Notes below on Azure Setup are relevant to deployment, but I wanted to separate out the exact steps a developer would go through to deploy changes.

Deployments are built by GitHub Actions (`.github/workflows/deploy.yml`): the workflow runs
`npm ci` + lint on a Windows runner, packages the app **with node_modules included**, and pushes
the prebuilt zip to the app service. The app service never runs npm, so deploy downtime is only
the zip-extract + iisnode restart, and there is no on-box install to fail or corrupt.

Requirements for the pipeline (one-time setup):

- Repository secrets holding each service's publish profile (portal → app service →
  "Download publish profile"): `AZURE_WEBAPP_PUBLISH_PROFILE_UNITTEST`,
  `AZURE_WEBAPP_PUBLISH_PROFILE_DEVELOP`, and `AZURE_WEBAPP_PUBLISH_PROFILE_PRODUCTION_STAGING`
  (that last one is the **staging slot's** profile, not the production app's).
- The old Deployment Center GitHub sync must be **disconnected on each service BEFORE its first
  pipeline deploy** (portal → app service → Deployment Center → Disconnect). While it is
  connected, Kudu keeps a "deployment branch" setting that makes every zip deploy fail with
  `ChangeSetId(develop) does not match ...` — and it would double-deploy on each push besides.
- `iisnode.yml` (in the repo) pins the node.exe the app runs under; keep it in sync with the
  `WEBSITE_NODE_DEFAULT_VERSION` app setting when upgrading Node.
- App settings on every service (and the production staging slot):
  - `WEBSITE_RUN_FROM_PACKAGE` = `1` — the app runs directly from a read-only mount of the
    deployed zip. No extraction into wwwroot (extraction is slow and has failed outright on
    our small instances), and cutover is atomic.
  - `PARSE_SERVER_LOGS_FOLDER` = `C:\home\LogFiles\parse-server` — with wwwroot read-only,
    parse-server can't write its default `./logs` folder. (iisnode's own logs are similarly
    redirected by `logDirectory` in iisnode.yml.)

A one-off deploy of any single service can be run from the GitHub Actions tab
("build-and-deploy" → Run workflow → pick the target).

#### develop branch

Changes pushed to the `develop` branch are deployed automatically by the workflow — there is no
staging slot for these services; both go live as soon as their deploy job finishes:

- bloom-parse-server-unittest
- bloom-parse-server-develop

To monitor: the workflow run in the GitHub Actions tab. Downtime per service is brief (extract +
restart), during which the dashboard and the library part of the website are down or stale.

#### master branch

Production uses a staging slot with a manual swap. Once changes have been merged to the
`master` branch, the workflow deploys them to the staging slot; then:

1. Go to the Azure portal (portal.azure.com). Access must be granted by LTOps.
2. Wait for the "build-and-deploy" workflow run on `master` to finish (GitHub Actions tab).
3. Open the bloom-parse-server-production app service and click Swap.
4. Review settings changes to make sure no app service settings are getting changed accidentally.
5. Click Swap.
6. The swap takes a couple of minutes; the site stays up (that is the point of the slot).

#### modifying the schema

Once the changes have been deployed, you can run the setupTables function in main.js to modify the schema. See notes there.

### Azure Setup

We are running three different services:

- bloom-parse-server-unittest
- bloom-parse-server-develop
- bloom-parse-server-production

Each is backed by a single mongodb at mongodb.com. This is how they were made:

1. Create the mongodb on mongodb.com, making sure to select Azure and the same data center. Failing to do this increases response times.
2. In Azure, create a new "Web App" App Service
3. In Azure:App Service:Application Settings:App Settings, create these settings:

   - DATABASE_URI

     - mongodb+srv://account:password@something.mongodb.net/database?retryWrites=true&w=majority

   - APP_ID

     - you make this up.

   - MASTER_KEY

     - you make this up

   - SERVER_URL

     - https://[azure app service name].azurewebsites.net/parse

       - Note: Don't leave off that /parse in the SERVER_URL!

   - MAILGUN_API_KEY

     - mailgun.com "Sending API key" with description "parse-server"

   - EMAIL_BOOK_EVENT_RECIPIENT

     - the email address to receive new book notifications

   - EMAIL_REPORT_BOOK_RECIPIENT

     - the email address to receive book concern reports from bloomlibrary.org users

   - publicServerURL

     - probably obsolete now that we don't use the built-in email feature; currently the same as SERVER_URL

   - PARSE_SERVER_MASTER_KEY_IPS

     - "0.0.0.0/0,::/0" to allow master-key use from anywhere.
     - Note: it must be `::/0`, not `::0`; parse-server does not recognize `::0` as allow-all
       (see UPGRADE-PLAN.md 5.1 — this once broke master-key access entirely).

   - WEBSITE_NODE_DEFAULT_VERSION

     - the Node version the app service runs (22.22.2 as of July 2026).
     - Not marked as a deployment-slot setting, so it travels with a slot swap.

4. Deployments come from the GitHub Actions workflow (see the Deployment section above): download
   the service's publish profile, add it as the corresponding repository secret, and add the
   service to `.github/workflows/deploy.yml`. Do NOT connect the App Service's Deployment Center
   to the repository — that legacy path builds on the app service itself and conflicts with the
   workflow. For production only, the workflow targets a staging slot
   (bloom-parse-server-production-staging), which is then swapped with the live one; unittest and
   develop deploy directly with no slot.

5. We never touch the schema using the Parse Dashboard or letting queries automagically add classes or fields.
   Instead, we set up the schema using a Cloud Code function `setupTables`.
   If you haven't set up the database already, follow instructions shown above under "Setup or update the mongodb Schema".
   Use Azure:App Service:Log stream to monitor progress.
   Note: During one setup, I found this can be flaky, perhaps because I jumped the gun.
   So instead I did the curl post for `functions/testDB`, which worked.
   Then I tried `functions/setupTables` again, and this time it worked.

6. TODO: Backup, Logging setup.
