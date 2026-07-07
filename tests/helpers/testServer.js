// Boots a real parse-server (with our cloud code and auth adapter) against a disposable
// in-memory MongoDB 8 (matching the live clusters), on an ephemeral port.
//
// Everything is loaded through Node's own require cache (createRequire) rather than Vite's
// transform pipeline, so that tests which monkey-patch shared modules (e.g. httpsRequest,
// to fake Firebase public keys) patch the same instance the server code sees.
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".."
);

const express = require(path.join(repoRoot, "node_modules", "express"));
const { ParseServer } = require(
    path.join(repoRoot, "node_modules", "parse-server")
);
const { MongoMemoryServer } = require(
    path.join(repoRoot, "node_modules", "mongodb-memory-server")
);
const BloomFirebaseAuthAdapter = require(
    path.join(repoRoot, "bloomFirebaseAuthAdapter.js")
);

export const APP_ID = "testAppId";
export const MASTER_KEY = "testMasterKey";
export const READ_ONLY_MASTER_KEY = "testReadOnlyKey";

// Returns the shared httpsRequest module (Node require cache instance) so tests can
// patch .get to fake the Firebase public-key fetch.
export function getHttpsRequestModule() {
    return require(path.join(repoRoot, "httpsRequest.js"));
}

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, "127.0.0.1", () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on("error", reject);
    });
}

export async function startTestServer({ schema, dbName = "test" } = {}) {
    // Make sure the email code takes its "pretend it succeeded" path.
    delete process.env.MAILGUN_API_KEY;

    const mongod = await MongoMemoryServer.create({
        binary: { version: "8.0.14" },
    });
    const port = await getFreePort();
    const serverURL = `http://127.0.0.1:${port}/parse`;

    const serverConfig = {
        databaseURI: mongod.getUri(dbName),
        cloud: path.join(repoRoot, "cloud", "main.js"),
        appId: APP_ID,
        masterKey: MASTER_KEY,
        readOnlyMasterKey: READ_ONLY_MASTER_KEY,
        serverURL,
        appName: "BloomLibrary.org tests",
        auth: { bloom: { module: BloomFirebaseAuthAdapter, enabled: true } },
        masterKeyIps: ["127.0.0.1", "::1"],
        enforcePrivateUsers: false,
        allowClientClassCreation: false,
        silent: true,
        logLevel: "error",
    };
    if (schema) {
        serverConfig.schema = schema;
    }

    const parseServer = new ParseServer(serverConfig);
    await parseServer.start();

    const app = express();
    app.use("/parse", parseServer.app);
    const httpServer = await new Promise((resolve, reject) => {
        const s = app.listen(port, "127.0.0.1", () => resolve(s));
        s.on("error", reject);
    });

    return {
        serverURL,
        async stop() {
            await new Promise((resolve) => httpServer.close(resolve));
            try {
                await parseServer.handleShutdown();
            } catch {
                // handleShutdown assumes subsystems (e.g. LiveQuery) we don't start;
                // the vitest fork exits anyway, so a partial shutdown is fine.
            }
            await mongod.stop();
        },
    };
}

// --- Small REST helpers (fetch is global on Node 22/24) ---

export function headers({
    master = false,
    readOnly = false,
    sessionToken,
} = {}) {
    const h = {
        "X-Parse-Application-Id": APP_ID,
        "Content-Type": "application/json",
    };
    if (master) h["X-Parse-Master-Key"] = MASTER_KEY;
    if (readOnly) h["X-Parse-Master-Key"] = READ_ONLY_MASTER_KEY;
    if (sessionToken) h["X-Parse-Session-Token"] = sessionToken;
    return h;
}

export async function rest(
    serverURL,
    method,
    pathname,
    { body, ...auth } = {}
) {
    const response = await fetch(serverURL + pathname, {
        method,
        headers: headers(auth),
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json;
    try {
        json = await response.json();
    } catch {
        json = undefined;
    }
    return { status: response.status, json };
}

export async function runCloudFunction(
    serverURL,
    name,
    params = {},
    auth = { master: true }
) {
    return rest(serverURL, "POST", `/functions/${name}`, {
        body: params,
        ...auth,
    });
}

// Creates a _User via the master key and returns { objectId, sessionToken, username }.
export async function createUser(serverURL, username, password = "secret123") {
    const { status, json } = await rest(serverURL, "POST", "/users", {
        body: { username, password, email: username },
        master: true,
    });
    if (status !== 201) {
        throw new Error(`createUser failed: ${status} ${JSON.stringify(json)}`);
    }
    return {
        objectId: json.objectId,
        sessionToken: json.sessionToken,
        username,
    };
}

// Polls until fn() is truthy or the timeout elapses (for fire-and-forget afterSave work).
export async function eventually(
    fn,
    { timeoutMs = 10000, intervalMs = 200 } = {}
) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const result = await fn();
        if (result) return result;
        if (Date.now() > deadline) {
            throw new Error(
                "eventually: condition not met within " + timeoutMs + "ms"
            );
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}
