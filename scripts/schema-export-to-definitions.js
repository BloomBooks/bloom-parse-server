// Converts a parse-server schema export (GET /parse/schemas with the master key) into a
// definitions file for parse-server's built-in schema migrations ("defined schemas") —
// the supported replacement for the setupTables cloud function. See UPGRADE-PLAN.md 10.
//
// Usage:
//   node scripts/schema-export-to-definitions.js schema/prod.json schema/definitions.json [clp-overrides.json]
//
// The optional third argument is a CLP-overrides file (gitignored, like everything under
// schema/): { "<className>": { "<operation>": <permissions object>, ... }, ... }.
// Each listed operation REPLACES the exported one; unlisted operations pass through
// unchanged. Use it to harden permissions relative to what the live export contains, so
// the hardened values are re-applied at every boot instead of drifting in the dashboard.
// A class named in the overrides but missing from the export is an error (catches typos).
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

function convertExportToDefinitions(exportJson, clpOverrides = {}) {
    const classes = exportJson.results || exportJson;
    if (!Array.isArray(classes)) {
        throw new Error(
            "Expected a schema export: { results: [ { className, ... } ] }"
        );
    }
    const classNames = classes.map((c) => c.className);
    for (const overrideClass of Object.keys(clpOverrides)) {
        if (!classNames.includes(overrideClass)) {
            throw new Error(
                `CLP override for "${overrideClass}" matches no class in the export ` +
                    "(typo, or the class was removed?)"
            );
        }
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
                classLevelPermissions: {
                    ...c.classLevelPermissions,
                    ...(clpOverrides[c.className] || {}),
                },
                // no "indexes" on purpose; see header comment
            };
        });
}

module.exports = { convertExportToDefinitions };

if (require.main === module) {
    const [inputPath, outputPath, overridesPath] = process.argv.slice(2);
    if (!inputPath || !outputPath) {
        console.error(
            "usage: node scripts/schema-export-to-definitions.js <schema-export.json> <definitions.json> [clp-overrides.json]"
        );
        process.exit(1);
    }
    const exportJson = JSON.parse(fs.readFileSync(inputPath, "utf8"));
    const clpOverrides = overridesPath
        ? JSON.parse(fs.readFileSync(overridesPath, "utf8"))
        : {};
    const definitions = convertExportToDefinitions(exportJson, clpOverrides);
    fs.writeFileSync(outputPath, JSON.stringify(definitions, null, 2) + "\n");
    const overrideNote = overridesPath
        ? ` with CLP overrides for ${Object.keys(clpOverrides).join(", ")}`
        : "";
    console.log(
        `Wrote ${definitions.length} class definitions (${definitions
            .map((d) => d.className)
            .join(", ")}) to ${outputPath}${overrideNote}`
    );
}
