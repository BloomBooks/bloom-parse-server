// The books beforeSave/afterSave cloud code — the business logic BloomDesktop and
// bloomlibrary.org depend on.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    startTestServer,
    rest,
    runCloudFunction,
    createUser,
    eventually,
} from "./helpers/testServer.js";

let server;
let uploader; // a test user whose pointer satisfies basicBookValidationRules

function uploaderPointer() {
    return {
        __type: "Pointer",
        className: "_User",
        objectId: uploader.objectId,
    };
}

let bookCounter = 0;
function newBookData(extra = {}) {
    ++bookCounter;
    return {
        title: "Test Book " + bookCounter,
        bookInstanceId: "instance-" + bookCounter,
        uploader: uploaderPointer(),
        ...extra,
    };
}

async function createBook(data, auth = { master: true }) {
    return rest(server.serverURL, "POST", "/classes/books", {
        body: data,
        ...auth,
    });
}

async function getBook(objectId) {
    const { json } = await rest(
        server.serverURL,
        "GET",
        "/classes/books/" + objectId,
        {
            master: true,
        }
    );
    return json;
}

beforeAll(async () => {
    server = await startTestServer();
    await runCloudFunction(server.serverURL, "setupTables");
    uploader = await createUser(server.serverURL, "uploader@example.com");
});

afterAll(async () => {
    if (server) await server.stop();
});

describe("books beforeSave: validation", () => {
    it("rejects a book with no title/bookInstanceId/uploader", async () => {
        const { status } = await createBook({ title: "only a title" });
        expect(status).toBeGreaterThanOrEqual(400);
    });
});

describe("books beforeSave: tags and search", () => {
    it("prefixes bare tags with topic: and builds the search string", async () => {
        const { status, json } = await createBook(
            newBookData({
                title: "Dogs and Cats",
                tags: ["animals", "region:Asia"],
            })
        );
        expect(status).toBe(201);
        const book = await getBook(json.objectId);
        expect(book.tags).toEqual(["topic:animals", "region:Asia"]);
        // search = lowercased title plus tag values (not prefixes), lowercased
        expect(book.search).toBe("dogs and cats animals asia");
    });

    it("excludes system: tags from the search string", async () => {
        const { json } = await createBook(
            newBookData({
                title: "SysTag",
                tags: ["system:Incoming", "topic:Health"],
            })
        );
        const book = await getBook(json.objectId);
        expect(book.tags).toEqual(["system:Incoming", "topic:Health"]);
        expect(book.search).toBe("systag health");
    });
});

describe("books beforeSave: updateSource and harvestState", () => {
    it("sets updateSource to 'unknown' when the client didn't provide one", async () => {
        const { json } = await createBook(newBookData());
        const book = await getBook(json.objectId);
        expect(book.updateSource).toBe("unknown");
        expect(book.tags).not.toContain("system:Incoming");
        expect(book.harvestState).toBeUndefined();
    });

    it("marks new BloomDesktop uploads with system:Incoming and harvestState New", async () => {
        const { json } = await createBook(
            newBookData({
                updateSource: "BloomDesktop 6.2",
                tags: ["topic:Math"],
            })
        );
        const book = await getBook(json.objectId);
        expect(book.tags).toContain("system:Incoming");
        expect(book.tags).toContain("topic:Math");
        expect(book.harvestState).toBe("New");
    });

    it("marks BloomDesktop re-uploads with harvestState Updated", async () => {
        const { json } = await createBook(
            newBookData({ updateSource: "BloomDesktop 6.2" })
        );
        const update = await rest(
            server.serverURL,
            "PUT",
            "/classes/books/" + json.objectId,
            {
                body: { updateSource: "BloomDesktop 6.2", title: "changed" },
                master: true,
            }
        );
        expect(update.status).toBe(200);
        const book = await getBook(json.objectId);
        expect(book.harvestState).toBe("Updated");
    });
});

describe("books beforeSave: moderator-edited fields survive re-upload", () => {
    it("keeps scalar fields the moderator set when the re-upload sends empty ones, and unions tags", async () => {
        // Original upload from BloomDesktop
        const { json } = await createBook(
            newBookData({
                updateSource: "BloomDesktop 6.2",
                tags: ["topic:Animals"],
            })
        );
        // Moderator improves metadata (e.g. via the dashboard)
        await rest(server.serverURL, "PUT", "/classes/books/" + json.objectId, {
            body: {
                updateSource: "moderator edit",
                summary: "A lovely summary",
                librarianNote: "checked",
                tags: ["topic:Animals", "list:favorites"],
            },
            master: true,
        });
        // Re-upload from BloomDesktop with empty summary and only its own tags
        await rest(server.serverURL, "PUT", "/classes/books/" + json.objectId, {
            body: {
                updateSource: "BloomDesktop 6.2",
                summary: "",
                tags: ["topic:Animals"],
            },
            master: true,
        });
        const book = await getBook(json.objectId);
        expect(book.summary).toBe("A lovely summary");
        expect(book.librarianNote).toBe("checked");
        expect(book.tags).toContain("list:favorites");
        expect(book.tags).toContain("topic:Animals");
        expect(book.tags).toContain("system:Incoming");
    });
});

describe("books beforeSave: derived fields", () => {
    it("converts bookLineage CSV to bookLineageArray", async () => {
        const { json } = await createBook(
            newBookData({ bookLineage: "aaa,bbb,ccc" })
        );
        const book = await getBook(json.objectId);
        expect(book.bookLineageArray).toEqual(["aaa", "bbb", "ccc"]);
    });

    it("computes hasBloomPub from show.bloomReader (harvester yes -> true)", async () => {
        const { json } = await createBook(
            newBookData({ show: { bloomReader: { harvester: true } } })
        );
        expect((await getBook(json.objectId)).hasBloomPub).toBe(true);
    });

    it("computes hasBloomPub with user opinion overriding harvester", async () => {
        const { json } = await createBook(
            newBookData({
                show: { bloomReader: { harvester: true, user: false } },
            })
        );
        expect((await getBook(json.objectId)).hasBloomPub).toBe(false);
    });

    it("sets hasBloomPub false when there is no show field", async () => {
        const { json } = await createBook(newBookData());
        expect((await getBook(json.objectId)).hasBloomPub).toBe(false);
    });
});

describe("books beforeSave: ACL", () => {
    it("gives a logged-in creator's book public read, creator write, and moderator role write", async () => {
        const { status, json } = await createBook(newBookData(), {
            sessionToken: uploader.sessionToken,
        });
        expect(status).toBe(201);
        const book = await getBook(json.objectId);
        expect(book.ACL).toEqual({
            "*": { read: true },
            [uploader.objectId]: { write: true },
            "role:moderator": { write: true },
        });
    });
});

describe("books afterSave: tag records", () => {
    it("creates missing tag records for the book's tags", async () => {
        await createBook(newBookData({ tags: ["topic:BrandNewTopic"] }));
        // Tag creation is fire-and-forget inside afterSave; poll for it.
        const found = await eventually(async () => {
            const where = encodeURIComponent(
                JSON.stringify({ name: "topic:BrandNewTopic" })
            );
            const { json } = await rest(
                server.serverURL,
                "GET",
                `/classes/tag?where=${where}`,
                {
                    master: true,
                }
            );
            return json.results.length === 1 ? json.results[0] : null;
        });
        expect(found.name).toBe("topic:BrandNewTopic");
    });
});
