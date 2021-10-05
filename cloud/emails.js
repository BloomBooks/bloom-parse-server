// This cloud function is called by the BloomLibrary client page when
// a user has filled out the form to report a concern about a book.
// We use their address as the from (via email provider) and use their message
// as part of the body. This goes into a template which adds other information
// about the book.

// Sample CURL
// curl -X POST -H "X-Parse-Application-Id: myAppId" -H "X-Parse-Master-Key: 123"
//  -d "message='i am concerned'&bookId='123'&bookTitle='flowers for foobar'"
//  http://localhost:1337/parse/functions/testBookSaved

// NOTE: the environment variable EMAIL_REPORT_BOOK_RECIPIENT must be set on the machine hosting the parse server.
// (this will often be the cloud servers where this is already set, but if you are running the parse server locally,
// you need to set it to the email address to which you want to send the email.)

Parse.Cloud.define("sendConcernEmail", function (request, response) {
    var bookId = request.params.bookId;
    var query = new Parse.Query("books");
    query.equalTo("objectId", bookId);
    query.include("uploader");
    query.find({
        success: function (results) {
            const bookJson = results[0]._toFullJSON();
            const dataForEmailClientJson = {
                from: request.params.fromAddress,
                to: process.env.EMAIL_REPORT_BOOK_RECIPIENT,
                subject: `[BloomLibrary] Book reported - ${getBookTitle(
                    bookJson
                )}`,
                template: "report-a-book",
            };

            sendEmailAboutBookAsync(dataForEmailClientJson, bookJson, {
                body: request.params.content,
            })
                .then(function () {
                    console.log("Sent Concern Email Successfully.");
                    response.success("Success");
                })
                .catch(function (error) {
                    console.log("Sending Concern Email Failed: " + error);
                    response.error("Sending Concern Email Failed: " + error);
                });
        },
        error: function (error) {
            console.log(
                "Error looking up book in sendConcernEmail with objectId " +
                    bookId +
                    ": " +
                    error
            );
            response.error(
                "Error looking up book in sendConcernEmail with objectId " +
                    bookId +
                    ": " +
                    error
            );
        },
    });
});

Parse.Cloud.define("testBookSaved", function (request, response) {
    var bookQuery = new Parse.Query("books");
    bookQuery.include("uploader");
    bookQuery.limit(1); //Note, the db we're testing on does need at least one book
    return bookQuery.find().then(function (books) {
        exports
            .sendBookSavedEmailAsync(books[0])
            .then(function (result) {
                console.log("test 'Announce Book Uploaded' completed.");
                response.success(result);
            })
            .catch(function (error) {
                console.log(
                    "ERROR: test 'Announce Book Uploaded' failed: " + error
                );
                response.error(
                    "ERROR: test 'Announce Book Uploaded' failed: " + error
                );
            });
    });
});

// Parse.Cloud.define("SendEmailOfBooksNewInLast24Hours", function(request, response) {
//     var bookQuery = new Parse.Query('books');
//     bookQuery.include('uploader');
//     var aDayAgo = new Date(new Date().getTime() - (24 * 60 * 60 * 1000));

//     bookQuery.greaterThanOrEqualTo("createdAt", sinceThen);

//     return bookQuery.find().then(function (books) {
//          TODO create a since body for the email out of all the books
//         });
// });

// This email is sent when a book is uploaded or created.
// It is sent to an internal address, set by environment variable EMAIL_BOOK_EVENT_RECIPIENT on the server.
exports.sendBookSavedEmailAsync = function (parseBook) {
    var bookId = parseBook.id;
    var query = new Parse.Query("books");
    query.equalTo("objectId", bookId);
    query.include("uploader");
    return query.find({
        success: function (results) {
            const bookJson = results[0]._toFullJSON();
            sendEmailAboutBookAsync(
                {
                    from: "Bloom Bot <bot@bloomlibrary.org>",
                    to: process.env.EMAIL_BOOK_EVENT_RECIPIENT,
                    subject: `[BloomLibrary] ${getBookUploader(
                        bookJson
                    )} added ${getBookTitle(bookJson)}`,
                    template: "announce-book-uploaded",
                },
                bookJson
            );
        },
    });
};

// This adds metadata about the book (such as title, etc.) and sends off the email.
// Any data beyond what can be determined from the book itself
// should be passed via additionalJsonForTemplate.
// parseBook should be a parse-server object (not just json).
function sendEmailAboutBookAsync(
    dataForEmailClientJson,
    parseBook,
    additionalJsonForEmailTemplate
) {
    return new Promise(function (resolve, reject) {
        try {
            // on the unit test server, we don't want to be sending emails, so we just don't set the needed environment variables.
            if (!process.env.MAILGUN_API_KEY) {
                console.log(
                    "MAILGUN_API_KEY environment variable not set, sendEmailAboutBookAsync() will just pretend it succeeded."
                );
                resolve("MAILGUN_API_KEY environment variable not set");
            }
            if (!dataForEmailClientJson.to) {
                console.log(
                    "to email address not set, sendEmailAboutBookAsync() will just pretend it succeeded."
                );
                resolve(
                    "to email address variable not set (check environment variable)"
                );
            }

            const bookJson = getTemplateDataFromBookAsJson(parseBook);
            const templateJson = {
                ...bookJson,
                ...additionalJsonForEmailTemplate,
            };

            const data = {
                "h:X-Mailgun-Variables": JSON.stringify(templateJson),
            };
            Object.assign(/*target=*/ data, /*source=*/ dataForEmailClientJson);

            const mailgun = require("mailgun-js");
            const mg = mailgun({
                apiKey: process.env.MAILGUN_API_KEY,
                domain: "bloomlibrary.org",
            });
            mg.messages().send(data, function (error, body) {
                if (error) {
                    console.error("error:");
                    console.error(error);
                    console.error("body:");
                    console.error(body);
                }
            });

            resolve();
        } catch (exception) {
            reject(exception);
        }
    });
}

function getTemplateDataFromBookAsJson(bookJson) {
    // Make sure we at least populate all the fields we want to send. Fill in with what we actually know.
    var templateDataFromBookAsJson = {
        title: "unknown title",
        copyright: "unknown copyright",
        license: "unknown license",
    };

    // Could do Object.assign(templateDataFromBookAsJson, bookJson) but that gives extra properties we don't need to send
    ["title", "copyright", "license"].forEach(function (property) {
        // Without this if, it will remove any properties from templateDataFromBookAsJson which aren't in bookJson.
        if (bookJson[property])
            templateDataFromBookAsJson[property] = bookJson[property];
    });

    templateDataFromBookAsJson["uploader"] = getBookUploader(bookJson);
    templateDataFromBookAsJson["url"] = getBookUrl(bookJson);

    return templateDataFromBookAsJson;
}

function getBookUrl(bookJson) {
    return "https://bloomlibrary.org/book/" + bookJson.objectId;
}

function getBookUploader(bookJson) {
    if (bookJson && bookJson.uploader && bookJson.uploader.username) {
        return bookJson.uploader.username;
    } else {
        // if you're getting this, make sure the query that got the book
        // did an "include('uploader')" so that it is part of the object
        return "unknown uploader";
    }
}

function getBookTitle(bookJson) {
    if (bookJson && bookJson.title) {
        return bookJson.title;
    } else {
        return "unknown title";
    }
}
