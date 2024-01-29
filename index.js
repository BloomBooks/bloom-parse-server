import express from "express";
import { ParseServer } from "parse-server";
import http from "http";
import ParseDashboard from "parse-dashboard";
import BloomFirebaseAuthAdapter from "./bloomFirebaseAuthAdapter.js";

const databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;

if (!databaseUri) {
    console.log("DATABASE_URI not specified, falling back to localhost.");
}

const serverConfig = {
    databaseURI: databaseUri || "mongodb://localhost:27017/dev",
    cloud: function () {
        import("./cloud/main.js");
    },
    appId: process.env.APP_ID || "myAppId",
    masterKey: process.env.MASTER_KEY || "123",
    readOnlyMasterKey: process.env.READ_ONLY_MASTER_KEY || "ro",
    serverURL: process.env.SERVER_URL || "http://localhost:1337/parse",

    appName: process.env.APP_NAME || "BloomLibrary.org",

    auth: { bloom: { module: BloomFirebaseAuthAdapter, enabled: true } },

    allowClientClassCreation: false,
};

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
await server.start();
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
const httpServer = http.createServer(app);
httpServer.listen(port, function () {
    console.log("bloom-parse-server running on port " + port + ".");
});
