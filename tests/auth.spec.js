// The Firebase auth adapter (bloomFirebaseAuthAdapter.js) and the bloomLink cloud function.
// We fake the Firebase side: generate an RSA keypair, serve its public key where the adapter
// fetches Google's certs, and sign tokens ourselves with the matching claims.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import {
    startTestServer,
    rest,
    runCloudFunction,
    createUser,
    getHttpsRequestModule,
} from "./helpers/testServer.js";

const require = createRequire(import.meta.url);
const jwt = require("jsonwebtoken");

const TOKEN_ISSUER = "https://securetoken.google.com/sil-bloomlibrary";

let server;
let privateKey;

function makeToken(email, overrides = {}) {
    return jwt.sign(
        {
            iss: TOKEN_ISSUER,
            email,
            email_verified: true,
            ...overrides,
        },
        privateKey,
        { algorithm: "RS256", expiresIn: "1h" }
    );
}

beforeAll(async () => {
    const pair = crypto.generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    privateKey = pair.privateKey;
    // The adapter fetches Google's current public keys via httpsRequest.get and tries each
    // value. Patch the shared module instance to return ours instead.
    getHttpsRequestModule().get = async () => ({ testKid: pair.publicKey });

    server = await startTestServer();
    await runCloudFunction(server.serverURL, "setupTables");
});

afterAll(async () => {
    if (server) await server.stop();
});

async function loginWithAuthData(id, token) {
    return rest(server.serverURL, "POST", "/users", {
        body: { authData: { bloom: { id, token } } },
    });
}

describe("bloom auth adapter", () => {
    it("signs up / logs in a user presenting a valid Firebase token", async () => {
        const email = "firebase-user@example.com";
        const { status, json } = await loginWithAuthData(
            email,
            makeToken(email)
        );
        expect(status).toBe(201);
        expect(json.sessionToken).toBeDefined();

        // Logging in again with a fresh token returns the same user
        const again = await loginWithAuthData(email, makeToken(email));
        expect(again.json.objectId).toBe(json.objectId);
    });

    it("rejects a token whose email doesn't match the claimed id", async () => {
        const { status } = await loginWithAuthData(
            "victim@example.com",
            makeToken("attacker@example.com")
        );
        expect(status).toBeGreaterThanOrEqual(400);
    });

    it("rejects a token from the wrong issuer", async () => {
        const email = "wrong-issuer@example.com";
        const { status } = await loginWithAuthData(
            email,
            makeToken(email, {
                iss: "https://securetoken.google.com/some-other-app",
            })
        );
        expect(status).toBeGreaterThanOrEqual(400);
    });

    it("rejects a token whose email is not verified", async () => {
        const email = "unverified@example.com";
        const { status } = await loginWithAuthData(
            email,
            makeToken(email, { email_verified: false })
        );
        expect(status).toBeGreaterThanOrEqual(400);
    });

    it("rejects a garbage token", async () => {
        const { status } = await loginWithAuthData(
            "garbage@example.com",
            "not.a.jwt"
        );
        expect(status).toBeGreaterThanOrEqual(400);
    });
});

describe("bloomLink", () => {
    it("adds authData to a pre-existing password user so Firebase login takes it over", async () => {
        const email = "legacy-user@example.com";
        await createUser(server.serverURL, email);

        const link = await runCloudFunction(
            server.serverURL,
            "bloomLink",
            { id: email, token: makeToken(email) },
            {} // no master key; called by the client after firebase login
        );
        expect(link.status).toBe(200);
        expect(link.json.result).toBe(
            "linked parse-server user by adding authData"
        );

        // Second call reports it's already linked
        const again = await runCloudFunction(server.serverURL, "bloomLink", {
            id: email,
            token: makeToken(email),
        });
        expect(again.json.result).toBe("existing authData");

        // And the user can now log in via the bloom authData path
        const login = await loginWithAuthData(email, makeToken(email));
        expect([200, 201]).toContain(login.status);
        expect(login.json.sessionToken).toBeDefined();
    });

    it("reports when there is no user to link", async () => {
        const { json } = await runCloudFunction(server.serverURL, "bloomLink", {
            id: "nobody@example.com",
            token: makeToken("nobody@example.com"),
        });
        expect(json.result).toBe("no existing user to link");
    });
});
