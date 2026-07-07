// Server plumbing: boot, schema bootstrap, master keys, and the RestQuery patch
// that keeps _User.email queryable (see patches/parse-server.txt).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    startTestServer,
    rest,
    runCloudFunction,
    createUser,
} from "./helpers/testServer.js";

let server;

beforeAll(async () => {
    server = await startTestServer();
});

afterAll(async () => {
    if (server) await server.stop();
});

describe("server basics", () => {
    it("answers serverInfo with the expected parse-server version", async () => {
        const { status, json } = await rest(server.serverURL, "GET", "/serverInfo", {
            master: true,
        });
        expect(status).toBe(200);
        expect(json.parseServerVersion).toBe("8.6.84");
    });

    it("runs setupTables to completion (exercises all cloud beforeSave/afterSave hooks)", async () => {
        const { status, json } = await runCloudFunction(server.serverURL, "setupTables");
        expect(status).toBe(200);
        expect(json.result).toBe("setupTables ran to completion.");

        // Classes exist now
        const books = await rest(server.serverURL, "GET", "/classes/books", { master: true });
        expect(books.status).toBe(200);
        const version = await rest(server.serverURL, "GET", "/classes/version", {
            master: true,
        });
        expect(version.status).toBe(200);
        expect(version.json.results[0].minDesktopVersion).toBe("2.0");
    });

    it("accepts the read-only master key for reads but not writes", async () => {
        const read = await rest(server.serverURL, "GET", "/classes/version", {
            readOnly: true,
        });
        expect(read.status).toBe(200);

        const write = await rest(server.serverURL, "POST", "/classes/version", {
            body: { minDesktopVersion: "9.9" },
            readOnly: true,
        });
        expect(write.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects writes to a nonexistent class without master key (allowClientClassCreation)", async () => {
        const { status } = await rest(server.serverURL, "POST", "/classes/notARealClass", {
            body: { foo: 1 },
        });
        expect(status).toBeGreaterThanOrEqual(400);
    });
});

describe("the _User email-query patch (RestQuery.js)", () => {
    it("allows querying _User on email without the master key", async () => {
        await createUser(server.serverURL, "emailquery@example.com");

        const where = encodeURIComponent(JSON.stringify({ email: "emailquery@example.com" }));
        const { status, json } = await rest(server.serverURL, "GET", `/classes/_User?where=${where}`);
        // Without the patch this is a 400 with Parse error 102
        // ("This user is not allowed to query email on class _User").
        expect(status).toBe(200);
        expect(json.results).toHaveLength(1);
    });

    it("still strips email values from responses to non-master clients", async () => {
        const { status, json } = await rest(server.serverURL, "GET", "/classes/_User");
        expect(status).toBe(200);
        expect(json.results.length).toBeGreaterThan(0);
        for (const user of json.results) {
            expect(user.email).toBeUndefined();
        }

        // ...but the master key still sees it
        const asMaster = await rest(server.serverURL, "GET", "/classes/_User", {
            master: true,
        });
        expect(asMaster.json.results.some((u) => u.email)).toBe(true);
    });
});
