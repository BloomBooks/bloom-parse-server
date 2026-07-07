// Converts a parse-server schema export (GET /parse/schemas with the master key) into a
// definitions file for parse-server's built-in schema migrations ("defined schemas") —
// the supported replacement for the setupTables cloud function. See UPGRADE-PLAN.md 10.
//
// Usage:
//   node scripts/schema-export-to-definitions.js schema/prod.json schema/definitions.json
//
// Deliberate policy choices (see UPGRADE-PLAN.md for the reasoning):
//
// - _Session is excluded: parse-server manages it.
// - _User and _Role are included so their classLevelPermissions are managed; their
//   built-in fields (username, email, authData, ...) are stripped because parse-server
//   owns those.
// - classLevelPermissions are carried over verbatim (defined schemas force addField to {}).
// - INDEXES ARE NOT MANAGED. The exported index metadata uses raw Mongo key names
//   (_p_uploader, _rperm, _created_at) that cannot be fed back through the schema API, and
//   the books search_text text index is the known minefield behind our
//   MongoStorageAdapter patch. Index management stays manual, exactly as it was under
//   setupTables. This REQUIRES schemaOptions.keepUnknownIndexes: true at the server
//   (index.js sets it), otherwise defined schemas would DELETE every index it doesn't know.

const fs = require("fs");

// Built-in fields parse-server owns; never include them in definitions.
const DEFAULT_FIELDS = ["objectId", "createdAt", "updatedAt", "ACL"];
const CLASS_DEFAULT_FIELDS = {
    _User: ["username", "password", "email", "emailVerified", "authData"],
    _Role: ["name", "users", "roles"],
};

const EXCLUDED_CLASSES = ["_Session"];

function convertExportToDefinitions(exportJson) {
    const classes = exportJson.results || exportJson;
    if (!Array.isArray(classes)) {
        throw new Error(
            "Expected a schema export: { results: [ { className, ... } ] }"
        );
    }
    return classes
        .filter((c) => !EXCLUDED_CLASSES.includes(c.className))
        .sort((a, b) => a.className.localeCompare(b.className))
        .map((c) => {
            const skip = [
                ...DEFAULT_FIELDS,
                ...(CLASS_DEFAULT_FIELDS[c.className] || []),
            ];
            const fields = {};
            for (const name of Object.keys(c.fields).sort()) {
                if (!skip.includes(name)) {
                    fields[name] = c.fields[name];
                }
            }
            return {
                className: c.className,
                fields,
                classLevelPermissions: c.classLevelPermissions,
                // no "indexes" on purpose; see header comment
            };
        });
}

module.exports = { convertExportToDefinitions };

if (require.main === module) {
    const [inputPath, outputPath] = process.argv.slice(2);
    if (!inputPath || !outputPath) {
        console.error(
            "usage: node scripts/schema-export-to-definitions.js <schema-export.json> <definitions.json>"
        );
        process.exit(1);
    }
    const exportJson = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const definitions = convertExportToDefinitions(exportJson);
    fs.writeFileSync(outputPath, JSON.stringify(definitions, null, 2) + "\n");
    console.log(
        `Wrote ${definitions.length} class definitions (${definitions
            .map((d) => d.className)
            .join(", ")}) to ${outputPath}`
    );
}
