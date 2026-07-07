// Boots bloom-parse-server against a disposable in-memory MongoDB (8.0.x, matching the live
// clusters) so you can verify the server runs and poke at it without installing MongoDB.
// The database starts empty and is thrown away on exit.
//
// Usage:
//   npm run smoke     (Ctrl+C to stop)
//
// Once it prints "bloom-parse-server running on port 1337", useful checks (PowerShell):
//
//   # server version
//   Invoke-RestMethod http://localhost:1337/parse/serverInfo -Headers @{
//       "X-Parse-Application-Id"="myAppId"; "X-Parse-Master-Key"="123" }
//
//   # create the schema / exercise the books cloud code
//   Invoke-RestMethod http://localhost:1337/parse/functions/setupTables -Method Post -Body "{}" -Headers @{
//       "X-Parse-Application-Id"="myAppId"; "X-Parse-Master-Key"="123"; "Content-Type"="application/json" }
//
//   # querying _User on email without the master key must NOT error (RestQuery patch)
//   Invoke-RestMethod 'http://localhost:1337/parse/classes/_User?where={"email":"x@example.com"}' -Headers @{
//       "X-Parse-Application-Id"="myAppId" }
//
//   # dashboard (user "master", password "123"): http://localhost:1337/dashboard
//
// Note: full-text search ($text on the "search" field) can NOT be tested here - our
// MongoStorageAdapter patch skips text-index creation, and a fresh database has no
// search_text index. Test search against the unittest Azure instance instead.

const path = require("path");
const { MongoMemoryServer } = require("mongodb-memory-server");

(async () => {
    console.log("[smoke] starting in-memory mongod (first run downloads the binary)...");
    const mongod = await MongoMemoryServer.create({
        binary: { version: "8.0.14" },
    });
    process.env.DATABASE_URI = mongod.getUri("dev");
    console.log("[smoke] mongod up at " + process.env.DATABASE_URI);
    require(path.join(__dirname, "..", "index.js"));
})().catch((e) => {
    console.error("[smoke] FAILED:", e);
    process.exit(1);
});
