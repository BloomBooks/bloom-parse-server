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

#### develop branch

Changes pushed to the `develop` branch are deployed automatically — there is no staging slot for
these services. Both of the following redeploy directly when GitHub notifies them of a commit on
`develop`:

- bloom-parse-server-unittest
- bloom-parse-server-develop

To monitor a deployment: Azure portal (portal.azure.com; access granted by LTOps) → the app
service → Deployment Center → check the status column. Deployment and restart can take several
minutes, during which the service (dashboard and the library part of the website) is down or stale.

#### troubleshooting a failed deployment

The build runs `npm install` **on the app service itself**, which is slow and can be killed
mid-install (Kudu aborts any build step that produces no output for 60 seconds; the app setting
`SCM_COMMAND_IDLE_TIMEOUT` = `1800` raises that and should be set on every service).

An interrupted install can leave `node_modules` corrupted in a way `npm install` will NOT
self-heal: a package directory whose `package.json` survives but whose files are gone (a "husk").
Symptom: the app (or the `patch-package` postinstall during the next deploy) crashes with
`Cannot find module '...'` or `Please verify that the package.json has a valid "main" entry`,
even though the package's folder exists, and redeploying doesn't fix it. This happened 2026-07-07
(`isarray` husk broke every subsequent deploy).

Recovery:

1. Kudu console (`https://<app-service>.scm.azurewebsites.net` → Debug console → CMD):
   `cd C:\home\site\wwwroot` then `move node_modules node_modules.broken`
   (renaming is instant; deleting takes ages on these instances).
2. Deployment Center → Sync, and watch the log. The install truly completed only if you see
   the postinstall line `Applying patches... parse-server+<version>.patch ✔`.
3. Verify the site works, then delete `node_modules.broken` whenever convenient.

#### master branch

Production uses a staging slot with a manual swap. Once changes have been merged to the
`master` branch,

1. Go to the Azure portal (portal.azure.com). Access must be granted by LTOps.
2. Open the bloom-parse-server-production app service.
3. Open Deployment slots.
   - Note that steps 2 and 3 can be skipped by opening bloom-parse-server-production-staging directly.
4. Open "Deployment Center" for the staging app service.
5. Wait until your changes have been successfully deployed (check the status column).
6. Back in bloom-parse-server-production, click Swap.
7. Review settings changes to make sure no app service settings are getting changed accidentally.
8. Click Swap.
9. Deployment and restart of the service can take several minutes.
   - During this time, the dashboard and library part of the website will be down.

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

4. In the App Service's Deployment Center, point the app service at this github repository with the
   appropriate branch. A few minutes later, parse-server will be running.
   Note that Azure apparently does the `npm install` automatically, as needed.
   The app service automatically redeploys when github notifies it of a check-in on the branch it
   is watching.
   For production only, do this on a staging slot instead (bloom-parse-server-production-staging),
   which is then swapped with the live one. unittest and develop deploy directly with no slot.
   See the deployment section above for detailed steps.

5. We never touch the schema using the Parse Dashboard or letting queries automagically add classes or fields.
   Instead, we set up the schema using a Cloud Code function `setupTables`.
   If you haven't set up the database already, follow instructions shown above under "Setup or update the mongodb Schema".
   Use Azure:App Service:Log stream to monitor progress.
   Note: During one setup, I found this can be flaky, perhaps because I jumped the gun.
   So instead I did the curl post for `functions/testDB`, which worked.
   Then I tried `functions/setupTables` again, and this time it worked.

6. TODO: Backup, Logging setup.
