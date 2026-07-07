// The setupTables replacement: schema export -> definitions conversion, and booting
// parse-server with the generated definitions (defined schemas) on a fresh database.
import { describe, it, expect, afterAll } from "vitest";
import { createRequire } from "node:module";
import {
    startTestServer,
    rest,
    runCloudFunction,
} from "./helpers/testServer.js";

const require = createRequire(import.meta.url);
const {
    convertExportToDefinitions,
} = require("../scripts/schema-export-to-definitions.js");

describe("convertExportToDefinitions", () => {
    const sampleExport = {
        results: [
            {
                className: "_Session",
                fields: { objectId: { type: "String" } },
                classLevelPermissions: {},
            },
            {
                className: "_User",
                fields: {
                    objectId: { type: "String" },
                    createdAt: { type: "Date" },
                    username: { type: "String" },
                    email: { type: "String" },
                    authData: { type: "Object" },
                    administrator: { type: "Boolean" },
                },
                classLevelPermissions: { find: { "*": true }, update: {} },
                indexes: { _id_: { _id: 1 }, username_1: { username: 1 } },
            },
            {
                className: "books",
                fields: {
                    objectId: { type: "String" },
                    createdAt: { type: "Date" },
                    updatedAt: { type: "Date" },
                    ACL: { type: "ACL" },
                    title: { type: "String" },
                    uploader: { type: "Pointer", targetClass: "_User" },
                },
                classLevelPermissions: { find: { "*": true } },
                indexes: {
                    _id_: { _id: 1 },
                    search_text: { title: "text" },
                    _p_uploader_1__rperm_1: { _p_uploader: 1, _rperm: 1 },
                },
            },
        ],
    };

    it("excludes _Session, keeps _User and app classes, sorted by className", () => {
        const defs = convertExportToDefinitions(sampleExport);
        expect(defs.map((d) => d.className)).toEqual(["_User", "books"]);
    });

    it("strips built-in fields but keeps custom ones", () => {
        const defs = convertExportToDefinitions(sampleExport);
        const user = defs.find((d) => d.className === "_User");
        expect(Object.keys(user.fields)).toEqual(["administrator"]);
        const books = defs.find((d) => d.className === "books");
        expect(Object.keys(books.fields)).toEqual(["title", "uploader"]);
        expect(books.fields.uploader).toEqual({
            type: "Pointer",
            targetClass: "_User",
        });
    });

    it("keeps classLevelPermissions and omits indexes entirely", () => {
        const defs = convertExportToDefinitions(sampleExport);
        const books = defs.find((d) => d.className === "books");
        expect(books.classLevelPermissions).toEqual({ find: { "*": true } });
        expect(books.indexes).toBeUndefined();
    });
});

describe("booting with generated definitions (end to end)", () => {
    const servers = [];
    afterAll(async () => {
        for (const s of servers) await s.stop();
    });

    it("reproduces the setupTables schema on a fresh database and cloud code still works", async () => {
        // 1. A server the old way: setupTables creates the schema.
        const serverA = await startTestServer({ dbName: "old-way" });
        servers.push(serverA);
        await runCloudFunction(serverA.serverURL, "setupTables");
        const exportA = await rest(serverA.serverURL, "GET", "/schemas", {
            master: true,
        });
        expect(exportA.status).toBe(200);

        // 2. Convert the export, exactly as scripts/schema-export-to-definitions.js would.
        const definitions = convertExportToDefinitions(exportA.json);
        expect(definitions.map((d) => d.className)).toContain("books");

        // 3. A fresh server + fresh database, schema coming only from the definitions.
        const serverB = await startTestServer({
            dbName: "defined-schemas",
            schema: {
                definitions,
                strict: false,
                deleteExtraFields: false,
                recreateModifiedFields: false,
                lockSchemas: false,
                keepUnknownIndexes: true,
            },
        });
        servers.push(serverB);

        // Parity: every class setupTables made (minus _Session) exists with the same
        // custom fields.
        const exportB = await rest(serverB.serverURL, "GET", "/schemas", {
            master: true,
        });
        const classesB = Object.fromEntries(
            exportB.json.results.map((c) => [c.className, c])
        );
        for (const def of definitions) {
            const cloud = classesB[def.className];
            expect(cloud, `class ${def.className} should exist`).toBeDefined();
            for (const fieldName of Object.keys(def.fields)) {
                expect(
                    cloud.fields[fieldName],
                    `${def.className}.${fieldName} should exist`
                ).toMatchObject(def.fields[fieldName]);
            }
            // Security win: defined schemas force addField to {} on every managed class,
            // closing the "any client can add columns" hole regardless of what the export had.
            expect(cloud.classLevelPermissions.addField).toEqual({});
        }

        // The cloud code works against the migrated schema: create a book through the
        // whole beforeSave pipeline.
        const user = await rest(serverB.serverURL, "POST", "/users", {
            body: { username: "u@example.com", password: "secret123" },
            master: true,
        });
        const book = await rest(serverB.serverURL, "POST", "/classes/books", {
            body: {
                title: "Defined Schemas Book",
                bookInstanceId: "defined-1",
                uploader: {
                    __type: "Pointer",
                    className: "_User",
                    objectId: user.json.objectId,
                },
                tags: ["animals"],
            },
            master: true,
        });
        expect(book.status).toBe(201);
        const saved = await rest(
            serverB.serverURL,
            "GET",
            "/classes/books/" + book.json.objectId,
            { master: true }
        );
        expect(saved.json.tags).toEqual(["topic:animals"]);
        expect(saved.json.search).toBe("defined schemas book animals");
    }, 120000);
});
