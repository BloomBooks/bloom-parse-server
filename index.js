var express = require("express");
var ParseServer = require("parse-server").ParseServer;
var path = require("path");
var ParseDashboard = require("parse-dashboard");
var BloomFirebaseAuthAdapter = require("./bloomFirebaseAuthAdapter");

var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;

if (!databaseUri) {
    console.log("DATABASE_URI not specified, falling back to localhost.");
}

var serverUrl = process.env.SERVER_URL || "http://localhost:1337/parse";

var serverConfig = {
    databaseURI: databaseUri || "mongodb://localhost:27017/dev",
    cloud: process.env.CLOUD_CODE_MAIN || __dirname + "/cloud/main.js",
    appId: process.env.APP_ID || "myAppId",
    masterKey: process.env.MASTER_KEY || "123",
    serverURL: serverUrl,

    appName: process.env.APP_NAME || "BloomLibrary.org",

    auth: { bloom: BloomFirebaseAuthAdapter },

    allowClientClassCreation: false,
};
var api = new ParseServer(serverConfig);
// Client-keys like the javascript key or the .NET key are not necessary with parse-server
// If you wish you require them, you can set them as options in the initialization above:
// javascriptKey, restAPIKey, dotNetKey, clientKey

// Because we are running this on Azure, for some reason, it cannot determine the connection is secure even if it is.
// I tried setting trustProxy to true instead, but that still didn't work.
// Setting this to true mirrors the way it is handled in https://github.com/Azure/parse-server-example (as of 12/7/16).
var allowInsecureHTTP = true;
var dashboard = new ParseDashboard(
    {
        allowInsecureHTTP: allowInsecureHTTP,
        apps: [
            {
                appId: serverConfig.appId,
                serverURL: serverConfig.serverURL,
                masterKey: serverConfig.masterKey,
                appName: serverConfig.appName,
                production: serverConfig.serverURL.includes("production"),
            },
        ],
        users: [
            {
                user: serverConfig.appId,
                pass: serverConfig.masterKey,
            },
        ],
    },
    { allowInsecureHTTP: allowInsecureHTTP }
);

var app = express();

// Serve the Parse API on the /parse URL prefix
var mountPath = process.env.PARSE_MOUNT || "/parse";
app.use(mountPath, api);

app.use("/dashboard", dashboard);

var port = process.env.PORT || 1337;
var httpServer = require("http").createServer(app);
httpServer.listen(port, function () {
    console.log("bloom-parse-server running on port " + port + ".");
});
