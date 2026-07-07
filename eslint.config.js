// eslint 9+ "flat" config, replacing .eslintrc.json.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
    {
        ignores: ["node_modules/", "schema/", "logs/"],
    },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "commonjs",
            globals: {
                ...globals.node,
                Parse: "readonly",
            },
        },
    },
    {
        // Legacy standalone CLI scripts (not loaded by the server). Their exported
        // stub functions keep named-but-unused parameters as documentation.
        files: ["cloud/BatchOperations/**/*.js"],
        rules: {
            "no-unused-vars": ["error", { args: "none" }],
        },
    },
];
