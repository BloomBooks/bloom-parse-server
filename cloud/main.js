/* eslint-disable no-undef */
require("./emails.js"); // allows email-specific could functions to be defined

// This function will call save on every book. This is useful for
// applying the functionality in beforeSaveBook to every book,
// particularly updating the tags and search fields.
Parse.Cloud.define("saveAllBooks", async (request) => {
    request.log.info("saveAllBooks - Starting.");
    // Query for all books
    var query = new Parse.Query("books");
    query.select("objectId");
    await query.each((book) => {
        book.set("updateSource", "saveAllBooks"); // very important so we don't add system:incoming tag
        try {
            return book.save(null, { useMasterKey: true });
        } catch (error) {
            request.log.error("saveAllBooks - book.save failed: " + error);
        }
    });
    request.log.info("saveAllBooks - Completed successfully.");
});

// A background job to populate usageCounts for languages.
// Also delete any unused language records (previously a separate job: removeUnusedLanguages).
// (tags processing was removed 4/2020 because we don't use the info)
//
// This is scheduled on Azure under bloom-library-maintenance-{prod|dev}-daily.
// You can also run it manually via REST:
// curl -X POST -H "X-Parse-Application-Id: <app ID>" -H "X-Parse-Master-Key: <master key>" -d "{}" https://bloom-parse-server-develop.azurewebsites.net/parse/jobs/updateLanguageRecords
Parse.Cloud.job("updateLanguageRecords", async (request) => {
    request.log.info("updateLanguageRecords - Starting.");

    const langCounts = {};
    const languagesToDelete = new Array();
    const languageIdsUsedByUncountedBooks = new Set();

    //Make and execute book query
    const bookQuery = new Parse.Query("books");
    bookQuery.limit(1000000); // Default is 100. We want all of them.
    bookQuery.select("langPointers", "inCirculation", "draft");
    const books = await bookQuery.find();
    books.forEach((book) => {
        const { langPointers, inCirculation, draft } = book.attributes;
        if (langPointers) {
            //Spin through each book's languages and increment usage count
            langPointers.forEach((langPtr) => {
                const id = langPtr.id;
                if (!(id in langCounts)) {
                    langCounts[id] = 0;
                }

                // We don't want out-of-circulation or draft books to
                // count toward our usage number, but we must not delete
                // a language record that is used by a book, even if all
                // the books that use it are drafts or out of circulation.
                // So we keep track of possible such languages to prevent
                // deleting them below.
                if (inCirculation === false || draft === true) {
                    languageIdsUsedByUncountedBooks.add(id);
                } else {
                    langCounts[id]++;
                }
            });
        }
    });

    const langQuery = new Parse.Query("language");
    langQuery.limit(1000000); // Default is 100. We want all of them.
    const languagesToUpdate = await langQuery.find();
    languagesToUpdate.forEach((language) => {
        const newUsageCount = langCounts[language.id] || 0;
        language.set("usageCount", newUsageCount);

        if (
            newUsageCount === 0 &&
            !languageIdsUsedByUncountedBooks.has(language.id)
        ) {
            languagesToDelete.push(language);
        }
    });

    // In theory, we could remove items in languagesToDelete from languagesToUpdate.
    // But there will be so few of them, it doesn't seem worth it.

    try {
        const successfulUpdates = await Parse.Object.saveAll(
            languagesToUpdate,
            {
                useMasterKey: true,
            }
        );
        request.log.info(
            `updateLanguageRecords - Updated usageCount for ${successfulUpdates.length} languages.`
        );

        if (languagesToDelete.length === 0) {
            request.log.info("updateLanguageRecords - Completed successfully.");
            request.message("Completed successfully.");
            return Promise.resolve();
        }

        const successfulDeletes = await Parse.Object.destroyAll(
            languagesToDelete,
            {
                useMasterKey: true,
            }
        );
        request.log.info(
            `updateLanguageRecords - Deleted ${
                successfulDeletes.length
            } languages which had no books: ${successfulDeletes.map((l) =>
                l.get("isoCode")
            )}`
        );
    } catch (error) {
        if (error.code === Parse.Error.AGGREGATE_ERROR) {
            error.errors.forEach((iError) => {
                request.log.error(
                    `Couldn't process ${iError.object.id} due to ${iError.message}`
                );
            });
            request.log.error(
                "updateLanguageRecords - Terminated unsuccessfully."
            );
            throw new Error("Terminated unsuccessfully.");
        } else {
            request.log.error(
                "updateLanguageRecords - Terminated unsuccessfully with error: " +
                    error
            );
            throw new Error("Terminated unsuccessfully with error: " + error);
        }
    }

    request.log.info("updateLanguageRecords - Completed successfully.");
    request.message("Completed successfully.");
});

// Makes new and updated books have the right search string and ACL.
Parse.Cloud.beforeSave("books", function (request) {
    const book = request.object;

    console.log("entering bloom-parse-server main.js beforeSave books");

    // The original purpose of the updateSource field was so we could set system:Incoming on every book
    // when it is uploaded or reuploaded from BloomDesktop without doing so for changes from the datagrid.
    //
    // Now, we also use it to set harvestState to "New" or "Updated" depending on if the book record is new.
    //
    // We also set lastUploaded for old (pre-4.7) BloomDesktops which don't set it themselves.
    let newUpdateSource = book.get("updateSource");
    // Apparently, "dirty" just means we provided it, regardless of whether or not it changed.
    // Careful not to use book.dirty("updateSource") which seems to always be true.
    if (!book.dirtyKeys().includes("updateSource")) {
        // For old BloomDesktops which didn't set the updateSource, we use this hack
        if (
            request.headers["user-agent"] &&
            request.headers["user-agent"].startsWith("RestSharp")
        ) {
            newUpdateSource = "BloomDesktop old";
            book.set("lastUploaded", {
                __type: "Date",
                iso: new Date().toISOString(),
            });
        }
        // direct change on the dashboard (either using "Browser" view or "API Console")
        else if (
            request.headers.referer &&
            request.headers.referer.indexOf("dashboard/apps/BloomLibrary.org") >
                -1
        ) {
            newUpdateSource = "parse dashboard";
        }
        // someone forgot to set updateSource
        else {
            newUpdateSource = "unknown";
        }
        book.set("updateSource", newUpdateSource);
    }
    // As of April 2020, BloomDesktop 4.7 now sets the updateSource to "BloomDesktop {version}".
    if (newUpdateSource.startsWith("BloomDesktop")) {
        // Change came from BloomDesktop upload (or reupload)
        book.addUnique("tags", "system:Incoming");
        if (book.isNew()) {
            book.set("harvestState", "New");
        } else {
            book.set("harvestState", "Updated");
        }

        // Prevent book uploads from overwriting certain fields changed by moderators
        if (request.original) {
            // These columns will not be overwritten unless the new book has truth-y values for them
            // For scalar columns (these are more straightforward than array columns)
            const scalarColumnsWithFallback = [
                "summary",
                "librarianNote",
                "publisher",
                "originalPublisher",
            ];
            scalarColumnsWithFallback.forEach((columnName) => {
                const newValue = book.get(columnName);
                const originalValue = request.original.get(columnName);
                if (!newValue && originalValue) {
                    book.set(columnName, originalValue);
                }
            });

            // These columns are array columns, for which we want to preserve all the pre-existing values
            //
            // tags - For now, we don't bother enforcing that the prefix part (before the colon) is unique (keep it simple for now).
            //        If this is determined to be a requirement, then additional code needs to be added to handle that.
            // bookshelves - We won't worry about the case where a moderator has deleted a bookshelf.
            const arrayColumnsToUnion = ["tags", "bookshelves"];
            arrayColumnsToUnion.forEach((columnName) => {
                const originalArrayValue = request.original.get(columnName);
                if (originalArrayValue && originalArrayValue.length >= 1) {
                    book.addAllUnique(columnName, originalArrayValue);
                }
            });

            // Features is able to be changed by moderators, but it's also computed by BloomDesktop. Even if it's empty, keep the BloomDesktop value.
            // My sense is that the auto-computed value is generally more likely to be correct than the value from the DB.
            // The user might've removed all the pages with that feature.
            //
            // langPointers can also be changed by moderators. But it's difficult to keep track of what languages a moderator removed
            // versus what is a newly added language. So for now, we'll live with not modifying langPointers.
        }
    }

    // Bloom 3.6 and earlier set the authors field, but apparently, because it
    // was null or undefined, parse.com didn't try to add it as a new field.
    // When we migrated from parse.com to parse server,
    // we started getting an error because uploading a book was trying to add
    // 'authors' as a new field, but it didn't have permission to do so.
    // In theory, we could just unset the field here:
    // request.object.unset("authors"),
    // but that doesn't prevent the column from being added, either.
    // Unfortunately, that means we simply had to add authors to the schema. (BL-4001)

    var tagsIncoming = book.get("tags");
    var search = (book.get("title") || "").toLowerCase();
    var index;
    const tagsOutput = [];
    if (tagsIncoming) {
        for (index = 0; index < tagsIncoming.length; ++index) {
            var tagName = tagsIncoming[index];
            var indexOfColon = tagName.indexOf(":");
            if (indexOfColon < 0) {
                // From older versions of Bloom, topics come in without the "topic:" prefix
                tagName = "topic:" + tagName;

                indexOfColon = "topic:".length - 1;
            }
            // In Mar 2020 we moved bookshelf tags to their own column so that we could do
            // regex on them without limiting what we could do with other tags
            if (tagName.indexOf("bookshelf") === 0) {
                // Note, we don't want to lose any bookshelves that we may have added by hand
                // using the web ui. But means that if you hand-edit the meta.json to have one
                // bookshelf, uploaded, realized a mistake, changed it and re-uploaded, well
                // now you would have both bookshelves.
                request.object.addUnique(
                    "bookshelves",
                    tagName.replace("bookshelf:", "")
                );
            }
            /* TODO: Mar 2020: we are leaving bookshelf:foobar tags in for now so that we don't have to go into
            the legacy angular code and adjust it to this new system. But once we retire that, we
            should uncomment this else block so that the bookshelf tag is stripped, then run SaveAllBooks()
            to remove it from all the records.
             else {*/
            tagsOutput.push(tagName);
            /* } */

            // We only want to put the relevant information from the tag into the search string.
            // i.e. for region:Asia, we only want Asia. We also exclude system tags.
            // Our current search doesn't handle multi-string searching, anyway, so even if you knew
            // to search for 'region:Asia' (which would never be obvious to the user), you would get
            // a union of 'region' results and 'Asia' results.
            // Other than 'system:', the prefixes are currently only used to separate out the labels
            // in the sidebar of the browse view.
            if (tagName.startsWith("system:")) continue;
            var tagNameForSearch = tagName.substr(indexOfColon + 1);
            search = search + " " + tagNameForSearch.toLowerCase();
        }
    }
    request.object.set("tags", tagsOutput);
    request.object.set("search", search);

    // Transfer bookLineage, which is a comma-separated string, into an array for better querying
    const bookLineage = book.get("bookLineage");
    let bookLineageArray = undefined;
    if (bookLineage) {
        bookLineageArray = bookLineage.split(",");
    }
    request.object.set("bookLineageArray", bookLineageArray);

    var creator = request.user;

    if (creator && request.object.isNew()) {
        // created normally, someone is logged in and we know who, restrict access
        var newACL = new Parse.ACL();
        // According to https://parse.com/questions/beforesave-user-set-permissions-for-self-and-administrators,
        // a user can always write their own object, so we don't need to permit that.
        newACL.setPublicReadAccess(true);
        newACL.setRoleWriteAccess("moderator", true); // allows moderators to delete
        newACL.setWriteAccess(creator, true);
        request.object.setACL(newACL);
    }
});

Parse.Cloud.afterSave("books", async (request) => {
    // We no longer wish to automatically create bookshelves.
    // It is too easy for a user (or even us mistakenly) to create them.

    // Now that we have saved the book, see if there are any new tags we need to create in the tag table.
    var book = request.object;
    var Tag = Parse.Object.extend("tag");
    book.get("tags").forEach(async (name) => {
        const query = new Parse.Query(Tag);
        query.equalTo("name", name);

        try {
            const count = await query.count();
            if (count == 0) {
                // We have a tag on this book which doesn't exist in the tag table. Create it.
                var tag = new Tag();
                tag.set("name", name);
                await tag.save(null, { useMasterKey: true });
            }
        } catch (error) {
            // I'm not sure it is the right thing to do, but these errors
            // were getting ignored previously, so when I refactored the code,
            // I made it do the same.
            request.log.error(
                "afterSave - books, tag processing failed: " + error
            );
        }
    });

    // Send email if this book didn't exist before
    try {
        // this seemed to work locally, but not on the azure production server,
        // and has been the subject of many bug reports over the years
        //          objectExisted = request.object.existed();
        // so we are working around it this way:
        var createdAt = request.object.get("createdAt");
        var updatedAt = request.object.get("updatedAt");
        var objectExisted = createdAt.getTime() != updatedAt.getTime();

        console.log(
            "afterSave email handling request.object.existed():" +
                request.object.existed()
        );
        console.log(
            "afterSave email handling createdAt:" +
                createdAt +
                " updatedAt:" +
                updatedAt +
                " objectExisted:" +
                objectExisted
        );
        if (!objectExisted) {
            var emailer = require("./emails.js");
            await emailer.sendEmailAboutNewBookAsync(book);
            request.log.info("Book saved email notice sent successfully.");
        }
    } catch (error) {
        request.log.error(
            "ERROR: Book saved but sending notice email failed: " + error
        );
    }
});

// This function is used to set up the fields used in the bloom library.
// Adding something here should be the ONLY way fields and classes are added to parse.com.
// After adding one, it is recommended that you first deploy the modified cloud code
// to a test project, run it, and verify that the result are as expected.
// Then try on the bloomlibrarysandbox (where you should also develop and test the
// functionality that uses the new fields).
// Finally deploy and run on the live database.
// For more information about deploying, see the main README.md.
//
// Currently this will not delete fields or tables; if you want to do that it will have to be
// by hand.
//
// Run this function from a command line like this (with the appropriate keys for the application inserted)
// curl -X POST -H "X-Parse-Application-Id: <App ID>" -H "X-Parse-Master-Key: <Master Key>" https://bloom-parse-server-production.azurewebsites.net/parse/functions/setupTables/
//
// Alternatively, you can use the parse server's dashboard's API Console to run the function:
// parsedashboard.bloomlibrary.org or dev-parsedashboard.bloomlibrary.org.
// Go to the API Console. type=POST, endpoint="functions/setupTables", useMasterKey=yes. Click Send Query.
//
// NOTE: There is reason to believe that using this function to add columns of type Object does not work
// and that they must be added manually (in the dashboard) instead.
Parse.Cloud.define("setupTables", async () => {
    // Required BloomLibrary classes/fields
    // Note: code below currently requires that 'books' is first.
    // Current code supports only String, Boolean, Number, Date, Array, Pointer<_User/Book/appDetailsInLanguage>,
    // and Relation<books/appDetailsInLanguage>.
    // It would be easy to generalize the pointer/relation code provided we can organize so that classes that are
    // the target of relations or pointers occur before the fields targeting them.
    // This is because the way we 'create' a field is to create an instance of the class that has that field.
    // These instances can also be conveniently used as targets when creating instances of classes
    // that refer to them.
    console.log("bloom-parse-server main.js define setupTables function");
    var classes = [
        {
            name: "version",
            fields: [{ name: "minDesktopVersion", type: "String" }],
        },
        {
            name: "books",
            fields: [
                { name: "allTitles", type: "String" },
                // For why the 'authors' field is needed, see http://issues.bloomlibrary.org/youtrack/issue/BL-4001
                { name: "authors", type: "Array" },
                { name: "baseUrl", type: "String" },
                { name: "bookInstanceId", type: "String" },
                { name: "bookLineage", type: "String" },
                { name: "bookOrder", type: "String" },
                { name: "bookletMakingIsAppropriate", type: "Boolean" },
                // In Mar 2020 we moved the bookshelf: tag to this column. Currently incoming books still have
                // the bookshelf: tag, and then beforeSave() takes them out of tags and pushes them in to this
                // array.
                { name: "bookshelves", type: "Array" },
                { name: "copyright", type: "String" },
                { name: "credits", type: "String" },
                { name: "currentTool", type: "String" },
                { name: "downloadCount", type: "Number" },
                { name: "downloadSource", type: "String" },
                { name: "experimental", type: "Boolean" },
                { name: "folio", type: "Boolean" },
                { name: "formatVersion", type: "String" },
                { name: "inCirculation", type: "Boolean" },
                { name: "draft", type: "Boolean" },
                { name: "isbn", type: "String" },
                { name: "keywords", type: "Array" },
                { name: "keywordStems", type: "Array" },
                { name: "langPointers", type: "Array" },
                { name: "languages", type: "Array" },
                { name: "librarianNote", type: "String" },
                { name: "license", type: "String" },
                { name: "licenseNotes", type: "String" },
                { name: "pageCount", type: "Number" },
                { name: "readerToolsAvailable", type: "Boolean" },
                { name: "search", type: "String" },
                { name: "show", type: "Object" },
                { name: "suitableForMakingShells", type: "Boolean" },
                { name: "suitableForVernacularLibrary", type: "Boolean" },
                { name: "summary", type: "String" },
                { name: "tags", type: "Array" },
                { name: "thumbnail", type: "String" },
                { name: "title", type: "String" },
                { name: "originalTitle", type: "String" },
                { name: "tools", type: "Array" },
                { name: "updateSource", type: "String" },
                { name: "uploader", type: "Pointer<_User>" },
                { name: "lastUploaded", type: "Date" },
                { name: "leveledReaderLevel", type: "Number" },
                { name: "country", type: "String" },
                { name: "province", type: "String" },
                { name: "district", type: "String" },
                { name: "features", type: "Array" },
                // Name of the organization or entity that published this book.  It may be null if self-published.
                { name: "publisher", type: "String" },
                // When people make derivative works, that work is no longer "published" by the people who made
                // the shell book. So "publisher" might become empty, or might get a new organization. But we still
                // want to be able to acknowledge what org gave us this shellbook, and list it on their page
                // (indicating that this is a derived book that they are not responsible for). So ideally new
                // shellbooks that have a "publisher" also have that same value in "originalPublisher".
                // "originalPublisher" will never be cleared by BloomDesktop.
                { name: "originalPublisher", type: "String" },
                // This is a "perceptual hash" (http://phash.org/) of the image in the first bloom-imageContainer
                // we find on the first page after any xmatter pages. We use this to suggest which books are
                // probably related to each other. This allows us to link, for example, books that are translations
                // of each other.  (https://www.nuget.org/packages/Shipwreck.Phash/ is used to calculate the phash.)
                { name: "phashOfFirstContentImage", type: "String" },
                // This is the name of the branding project assigned to the book. "Default" means that
                // there isn't any specific branding project assigned to the book.
                { name: "brandingProjectName", type: "String" },
                // BloomDesktop creates bookLineage as a comma-separated string.
                // But we need it to be an array for more complex querying.
                // So beforeSave on books converts it to an array in this field.
                { name: "bookLineageArray", type: "Array" },
                // Fields required by Harvester
                { name: "harvestState", type: "String" },
                { name: "harvesterId", type: "String" },
                { name: "harvesterMajorVersion", type: "Number" },
                { name: "harvesterMinorVersion", type: "Number" },
                { name: "harvestStartedAt", type: "Date" },
                { name: "harvestLog", type: "Array" },
                // End fields required by Harvester
                { name: "internetLimits", type: "Object" },
                { name: "importedBookSourceUrl", type: "String" },
                // Fields required by RoseGarden
                { name: "importerName", type: "String" },
                { name: "importerMajorVersion", type: "Number" },
                { name: "importerMinorVersion", type: "Number" },
                // End fields required by RoseGarden
            ],
        },
        {
            name: "bookshelf",
            fields: [
                { name: "englishName", type: "String" },
                { name: "key", type: "String" },
                { name: "logoUrl", type: "String" },
                { name: "normallyVisible", type: "Boolean" },
                { name: "owner", type: "Pointer<_User>" },
                { name: "category", type: "String" },
            ],
        },
        {
            name: "downloadHistory",
            fields: [
                { name: "bookId", type: "String" },
                { name: "userIp", type: "String" },
            ],
        },
        {
            name: "language",
            fields: [
                { name: "ethnologueCode", type: "String" },
                { name: "isoCode", type: "String" },
                { name: "name", type: "String" },
                { name: "englishName", type: "String" },
                //Usage count determined daily per Parse.com job
                { name: "usageCount", type: "Number" },
            ],
        },
        {
            name: "tag",
            fields: [
                { name: "name", type: "String" },
                //Usage count determined daily per Parse.com job
                { name: "usageCount", type: "Number" },
            ],
        },
        {
            name: "relatedBooks",
            fields: [{ name: "books", type: "Array" }],
        },
        {
            name: "appDetailsInLanguage",
            fields: [
                { name: "androidStoreLanguageIso", type: "String" },
                { name: "title", type: "String" },
                { name: "shortDescription", type: "String" },
                { name: "fullDescription", type: "String" },
            ],
        },
        {
            name: "appSpecification",
            fields: [
                { name: "bookVernacularLanguageIso", type: "String" },
                { name: "defaultStoreLanguageIso", type: "String" },
                { name: "buildEngineJobId", type: "String" },
                { name: "colorScheme", type: "String" },
                { name: "icon1024x1024", type: "String" },
                { name: "featureGraphic1024x500", type: "String" },
                { name: "details", type: "Relation<appDetailsInLanguage>" },
                { name: "owner", type: "Pointer<_User>" },
                { name: "packageName", type: "String" },
            ],
        },
        {
            // must come after the classes it references
            name: "booksInApp",
            fields: [
                { name: "app", type: "Pointer<appSpecification>" },
                { name: "book", type: "Pointer<books>" },
                { name: "index", type: "Integer" },
            ],
        },
        // rebrand is explained in BL-10865.
        { name: "rebrand", type: "Boolean" },
    ];

    var ic = 0;
    var aUser = null;
    var aBook = null;
    var anApp = null;
    // If we're updating a 'live' table, typically we will have locked it down so
    // only with the master key can we add fields or classes.
    //Parse.Cloud.useMasterKey();

    var doOne = async () => {
        var className = classes[ic].name;
        var parseClass = Parse.Object.extend(className);
        var instance = new parseClass();
        var fields = classes[ic].fields;
        for (var ifld = 0; ifld < fields.length; ifld++) {
            var fieldName = fields[ifld].name;
            var fieldType = fields[ifld].type;
            switch (fieldType) {
                case "String":
                    instance.set(fieldName, "someString");
                    break;
                case "Date":
                    instance.set(fieldName, {
                        __type: "Date",
                        iso: "2015-02-15T00:00:00.000Z",
                    });
                    break;
                case "Boolean":
                    instance.set(fieldName, true);
                    break;
                case "Number":
                    instance.set(fieldName, 1);
                    break;
                case "Array":
                    instance.set(fieldName, ["one", "two"]);
                    break;
                case "Pointer<_User>":
                    instance.set(fieldName, aUser);
                    break;
                case "Pointer<books>":
                    // This and next could be generalized if we get a couple more. User would remain special.
                    instance.set(fieldName, aBook);
                    break;
                case "Pointer<appSpecification>":
                    instance.set(fieldName, anApp);
                    break;

                // It appears this is not used, so we're commenting it out for now. We're not sure if or how it was used previously.
                // case "Relation<books>":
                //     // This and next could be generalized if we have other kinds of relation one day.
                //     var target = aBook;
                //     var relation = instance.relation(fieldName);
                //     relation.add(target);
                //     break;
            }
        }
        const newObj = await instance.save(null, {
            useMasterKey: true,
        });

        // remember the new object so we can destroy it later, or use it as a relation target.
        classes[ic].parseObject = newObj;
        // if the class is one of the ones we reference in pointers or relations,
        // remember the appropriate instance for use in creating a sample.
        if (classes[ic].name == "books") {
            aBook = newObj;
        }
        ic++;
        if (ic < classes.length) {
            await doOne(); // recursive call to the main method to loop
        } else {
            // Start a new recursive iteration to delete the objects we don't need.
            ic = 0;
            await deleteOne();
        }
    };
    var deleteOne = async () => {
        // Now we're done, the class and fields must exist; we don't actually want the instances
        var newObj = classes[ic].parseObject;
        await newObj.destroy({
            useMasterKey: true,
        });

        ic++;
        if (ic < classes.length) {
            await deleteOne(); // recursive loop
        } else {
            await cleanup();
        }
    };
    var cleanup = async () => {
        // We've done the main job...now some details.
        var versionType = Parse.Object.extend("version");
        var query = new Parse.Query("version");
        const results = await query.find();

        var version;
        if (results.length >= 1) {
            // updating an existing project, already has version table and instance
            version = results[0];
        } else {
            version = new versionType();
        }
        version.set("minDesktopVersion", "2.0");
        await version.save(null, {
            useMasterKey: true,
        });

        // Finally destroy the spurious user we made.
        await aUser.destroy({
            useMasterKey: true,
        });
    };
    // Create a user, temporarily, which we will delete later.
    // While debugging I got tired of having to manually remove previous "temporary" users,
    // hence each is now unique.
    var rand = parseInt(Math.random() * 10000, 10);
    const newUser = await Parse.User.signUp(
        "zzDummyUserForSetupTables" + rand,
        "unprotected",
        { administrator: false }
    );
    aUser = newUser;
    await doOne(); // start the recursion.

    return "setupTables ran to completion.";
});

// This function expects to be passed params containing an id and JWT token
// from a successful firebase login. It looks for a parse-server identity whose
// username is that same ID. If it finds one without authData (which is how it links
// to the Firebase identity), it creates the authData.
// Otherwise, it does nothing...
// If there is no corresponding parse-server user, the client will
// subsequently call a POST to users which will create the parse-server user with authData.
// If there is a corresponding parse-server user with authData, the POST to users
// will log them in.
Parse.Cloud.define("bloomLink", async (request) => {
    let user;
    var id = request.params.id;
    //console.log(" bloomLink with request: " + JSON.stringify(request));
    const query = new Parse.Query("User");
    query.equalTo("username", id);
    const results = await query.find({ useMasterKey: true });
    if (results.length == 0) {
        // No existing user. Nothing to do.
        return "no existing user to link";
    } else {
        user = results[0];
    }

    // The following code saves authData corresponding to the current token.
    //console.log("bloomLink got user " + JSON.stringify(user));
    const token = request.params.token;
    // Note: at one point I set the id field from user.username. That ought to be
    // the same as id, since we searched for and if necessary created a user with that
    // username. In fact, however, it was always undefined.
    const authData = { bloom: { id: id, token: token } };
    // console.log("bloomLink authdata from params: " + JSON.stringify(authData));

    // console.log(
    //     "bloomLink authdata from user: " + JSON.stringify(user.authData)
    // );

    if (!user.get("authData")) {
        // console.log(
        //     "bloomLink setting user authdata to " + JSON.stringify(authData)
        // );
        user.set("authData", authData, { useMasterKey: true });
        await user.save(null, { useMasterKey: true });

        // console.log("bloomLink saved user: " + JSON.stringify(user));
        return "linked parse-server user by adding authData";
    } else {
        // console.log(
        //     "bloomLink found existing authData: " +
        //         JSON.stringify(user.authData)
        // );
        return "existing authData";
    }
});
