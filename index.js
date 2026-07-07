// Feb 2023, we tried to upgrade this project to be of type "module" and use import/export instead of require.
// It worked locally, but when we deployed to a real server, the parse server failed to start.
// I never could determine why. So I punted and reverted to using require.
const express = require("express");
const ParseServer = require("parse-server").ParseServer;
const ParseDashboard = require("parse-dashboard");
const BloomFirebaseAuthAdapter = require("./bloomFirebaseAuthAdapter");

const databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;

if (!databaseUri) {
    console.log("DATABASE_URI not specified, falling back to localhost.");
}

const serverConfig = {
    // Somehow, node 18 causes localhost to try to resolve as IPv6 here which can break things.
    // Using 127.0.0.1 instead works around that.
    databaseURI: databaseUri || "mongodb://127.0.0.1:27017/dev",
    cloud: process.env.CLOUD_CODE_MAIN || __dirname + "/cloud/main.js",
    appId: process.env.APP_ID || "myAppId",
    masterKey: process.env.MASTER_KEY || "123",
    readOnlyMasterKey: process.env.READ_ONLY_MASTER_KEY || "ro",
    serverURL: process.env.SERVER_URL || "http://localhost:1337/parse",

    appName: process.env.APP_NAME || "BloomLibrary.org",

    auth: { bloom: { module: BloomFirebaseAuthAdapter, enabled: true } },

    masterKeyIps: process.env.PARSE_SERVER_MASTER_KEY_IPS
        ? process.env.PARSE_SERVER_MASTER_KEY_IPS.split(",")
        : ["127.0.0.1", "::1"],

    // NOTE for the future parse-server 9.x upgrade: add
    //     readOnlyMasterKeyIps: ["0.0.0.0/0", "::/0"],
    // The option doesn't exist in 8.x (the server rejects it as an invalid key). In 9.x the
    // read-only master key (used by the dashboard's readonly user, from any IP) gets its own
    // IP allowlist, and parse-server 10 will default it to localhost-only (DEPPS15).
    // Note: "::/0" is the spelling parse-server recognizes as allow-all-IPv6; "::0" is NOT
    // (see UPGRADE-PLAN.md 5.1).

    enforcePrivateUsers: false,
    allowClientClassCreation: false,
};

// Opt-in schema management via parse-server's built-in "defined schemas" — the supported
// replacement for the setupTables cloud function (see UPGRADE-PLAN.md 10).
// To enable: generate schema/definitions.json from a live schema export using
// scripts/schema-export-to-definitions.js, and set USE_DEFINED_SCHEMAS=true.
// The flags below are the safe ones: only ADD missing classes/fields and apply CLPs;
// never delete or rewrite fields, and never touch indexes (keepUnknownIndexes), which
// remain manually managed just as they were under setupTables.
if (process.env.USE_DEFINED_SCHEMAS === "true") {
    // Deliberately let this throw if the file is missing: a deploy that asks for defined
    // schemas but has no definitions is misconfigured and should fail loudly.
    const definitions = require("./schema/definitions.json");
    serverConfig.schema = {
        definitions,
        strict: false,
        deleteExtraFields: false,
        recreateModifiedFields: false,
        lockSchemas: false,
        keepUnknownIndexes: true,
    };
    console.log(
        `Defined schemas enabled: managing ${definitions.length} classes from schema/definitions.json`
    );
}

const dashboard = new ParseDashboard({
    apps: [
        {
            appId: serverConfig.appId,
            serverURL: serverConfig.serverURL,
            masterKey: serverConfig.masterKey,
            readOnlyMasterKey: serverConfig.readOnlyMasterKey,
            appName: serverConfig.appName,
            production: serverConfig.serverURL.includes("production"),
        },
    ],
    trustProxy: 1,
    users: [
        {
            user: serverConfig.appId,
            pass: serverConfig.masterKey,
        },
        {
            user: "master",
            pass: serverConfig.masterKey,
        },
        {
            user: "readonly",
            pass: serverConfig.readOnlyMasterKey,
            readOnly: true,
        },
    ],
});

const app = express();

// Serve the Parse API on the /parse URL prefix
const mountPath = process.env.PARSE_MOUNT || "/parse";
const server = new ParseServer(serverConfig);
// For an unknown reason, when deployed on a real server, await server.start() causes the server to never successfully start.
server.start().then(() => {
    app.use(mountPath, server.app);

    // The main thing here is the google-site-verification meta tag.
    // This lets us access the site on the Google Search Console.
    app.get("/", function (req, res) {
        res.status(200).send(
            "<html>" +
                '<head><meta name="google-site-verification" content="dm8VsqC5uw-fikoD-4ZxYbPfzV-qYyrPCJq7aIgvlJo" /></head>' +
                '<body><a href="https://bloomlibrary.org">Bloom Library</a></body>' +
                "</html>"
        );
    });

    app.use("/dashboard", dashboard);

    const port = process.env.PORT || 1337;
    const httpServer = require("http").createServer(app);
    httpServer.listen(port, function () {
        console.log("bloom-parse-server running on port " + port + ".");
    });
});
