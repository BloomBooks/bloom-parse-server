// This is just a little utility function used to set the langTag on the show field for epub and pdfs.
// It is intended as a one-off run to fix up existing books. Starting July 2023, the harvester sets this
// for every book it processes, using the actual contentLanguage1 in the dom.
// eslint-disable-next-line no-undef
Parse.Cloud.define("setArtifactLangTags", async (request) => {
    request.log.info("setArtifactLangTags - Starting.");

    const dryRun = request.params.dryrun === "true" || request.params.dryrun === true;
    if (dryRun) {
        request.log.info("setArtifactLangTags - Dry run only.");
    }

    // eslint-disable-next-line no-undef
    var query = new Parse.Query("books");
    // Query for all books whose most recent update wasn't to run this utility.
    query.notEqualTo("updateSource", "setArtifactLangTags");
    query.select("title", "allTitles", "show");
    await query.each((book) => {
        book.set("updateSource", "setArtifactLangTags"); // very important that we don't leave updateSource unset so we don't add system:incoming tag

        let allTitlesJson = book.get("allTitles"); // allTitles is a string field
        let title = book.get("title");

        if (!allTitlesJson || !title || allTitlesJson === "{}") {
            request.log.info(
                `setArtifactLangTags found missing allTitles or title for book \`${book.id}\` with title \`${title}\` and allTitles \`${allTitlesJson}\`.`
            );
            return; // continue
        }

        // Trust me; it's worth the slight loss of integrity to not have to deal with these special characters
        // which are not handled consistently in our data (actual new line, escaped new line, quotes).
        allTitlesJson = allTitlesJson
            .replace(/\r/g, "")
            .replace(/\n/g, "")
            .replace(/\\n/g, "")
            // quote will be escaped in json
            .replace(/\\"/g, "")
            // sigh; even one of these...
            .replace(/<br \/>/, "");
        title = title
            .replace(/\r/g, "")
            .replace(/\n/g, "")
            .replace(/\\n/g, "")
            // if quote is escaped in title, it looks like \\"
            .replace(/\\\\"/g, "")
            // but most are not escaped
            .replace(/"/g, "")
            .trim();

        // Parse the JSON string to a JavaScript object
        let allTitles;
        try {
            allTitles = JSON.parse(allTitlesJson);
        } catch (e) {
            request.log.error(
                `setArtifactLangTags failed to parse allTitlesJson for book \`${book.id}\` with title \`${title}\` and allTitles \`${allTitlesJson}\`.`
            );
            return; // continue
        }

        const allTitlesKeys = Object.keys(allTitles);
        if (allTitlesKeys.length === 1) {
            // Only one entry in allTitles; take the easy, quick out and use it.
            setShowLangTag(book, allTitlesKeys[0], dryRun, request);
        } else {
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
                setShowLangTag(book, languageTags[0], dryRun, request);
            }
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

function setShowLangTag(book, langTag, dryRun, request) {
    if (dryRun) {
        request.log.info(
            `setArtifactLangTags setting show langTag to \`${langTag}\` for book ` +
                `\`${book.id}\` with title \`${book.get("title")}\` ` +
                `and allTitles \`${book.get("allTitles")}\`.`
        );
    }

    let show = book.get("show");
    //request.log.info("show before: " + JSON.stringify(show));

    ["epub", "pdf"].forEach((artifactType) => {
        if (!show) show = {};
        if (!show[artifactType]) show[artifactType] = {};

        show[artifactType].langTag = langTag;
    });
    //request.log.info("show after: " + JSON.stringify(show));

    // In theory, we shouldn't have to switch for dryRun here, but something was causing strange behavior on the real server.
    // And my only theory is that it is trying to keep all these changes in memory.
    if (!dryRun) {
        book.set("show", show);
    }
}

// Define a function that returns array of keys by value
function getKeysByValue(object, value) {
    return Object.keys(object).filter((key) => object[key].trim() === value);
}
