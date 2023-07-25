/* eslint-disable no-undef */

// This is just a little utility function used to set the langTag on the show field for epub and pdfs.
// It is intended as a one-off run to fix up existing books. Starting July 2023, the harvester sets this
// for every book it processes, using the actual contentLanguage1 in the dom.
Parse.Cloud.define("setArtifactLangTags", async (request) => {
    request.log.info("setArtifactLangTags - Starting.");

    const dryRun = request.params.dryrun;
    if (dryRun === "true" || dryRun === true) {
        request.log.info("setArtifactLangTags - Dry run only.");
    }

    // Query for all books
    var query = new Parse.Query("books");
    query.select("title", "allTitles", "show");
    await query.each((book) => {
        book.set("updateSource", "setArtifactLangTags"); // very important that we don't leave updateSource unset so we don't add system:incoming tag

        const allTitlesJson = book.get("allTitles"); // allTitles is a string field
        const title = book.get("title");

        if (!allTitlesJson || !title) {
            request.log.info(
                `setArtifactLangTags found missing allTitles or title for book \`${book.id}\` with title \`${title}\` and allTitles \`${allTitlesJson}\`.`
            );
            return; // continue
        }

        // Parse the JSON string to a JavaScript object
        const allTitles = JSON.parse(allTitlesJson);

        const languageTags = getKeysByValue(allTitles, title);
        if (languageTags.length > 1) {
            request.log.info(
                `setArtifactLangTags found multiple languageTags for book \`${book.id}\` with title \`${title}\` and allTitles \`${allTitlesJson}\`.`
            );
            return; // continue
        } else if (languageTags.length === 0) {
            request.log.info(
                `setArtifactLangTags failed to find a languageTag for book \`${book.id}\` with title \`${title}\` and allTitles \`${allTitlesJson}\`.`
            );
            return; // continue
        } else {
            if (dryRun) {
                request.log.info(
                    `setArtifactLangTags setting show langTag to \`${languageTags[0]}\` for book \`${book.id}\` with title \`${title}\` and allTitles \`${allTitlesJson}\`.`
                );
            }

            let show = book.get("show");
            //console.log("show before: " + JSON.stringify(show));

            ["epub", "pdf"].forEach((artifactType) => {
                if (!show) show = {};
                if (!show[artifactType]) show[artifactType] = {};

                show[artifactType].langTag = languageTags[0];
            });
            //console.log("show after: " + JSON.stringify(show));

            book.set("show", show);
        }

        try {
            if (!dryRun) {
                return book.save(null, { useMasterKey: true });
            }
        } catch (error) {
            request.log.error(
                "setArtifactLangTags - book.save failed: " + error
            );
        }
    });
    request.log.info("setArtifactLangTags - Completed successfully.");
});

// Define a function that returns array of keys by value
function getKeysByValue(object, value) {
    return Object.keys(object).filter((key) => object[key] === value);
}
