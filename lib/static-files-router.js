/**
 * Data of a static resource.
 * @typedef {{type: string, file: Object, provider: UIComponent }} StaticResource
 */

/**
 * Process a HTTP request that requests a static file.
 * @param request {Object} HTTP request to be processed
 * @param response {Object} HTTP response to be served
 */
var route;

(function () {
    var log = new Log("static-file-router");
    var constants = require("constants.js").constants;
    /** @type {UtilsModule} */
    var Utils = require("utils.js");

    /**
     * Splits a full file name to its name and extension.
     * @param fullFileName {string} file name to be split e.g. foo.txt
     * @return {{name: string, extension: string}} splited parts
     */
    function splitFileName(fullFileName) {
        var index = fullFileName.lastIndexOf(".");
        return {name: fullFileName.substr(0, index), extension: fullFileName.substr(index + 1)}
    }

    function nthIndexOf(str, pat, n) {
        // Adopted from https://stackoverflow.com/a/14482123/1577286
        var strLength = str.length, i = -1;
        while (n-- && (i++ < strLength)) {
            i = str.indexOf(pat, i);
        }
        return i;
    }

    /**
     * Returns the hash code of the specified string.
     * @param str {string} string to be converted
     * @returns {string} hash code
     */
    function hashCode(str) {
        // Adopted from https://stackoverflow.com/a/7616484/1577286
        var strLength = str.length;
        if (strLength == 0) {
            return "0";
        }
        var hash = 0, chr;
        for (var i = 0; i < strLength; i++) {
            chr = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0; // Convert to 32bit integer
        }
        return hash.toString();
    }

    /**
     * Closes the specified file without throwing any exceptions.
     * @param file {Object} file to be closed
     */
    function closeQuietly(file) {
        try {
            file.close();
        } catch (e) {
            log.error(e);
        }
    }

    /**
     * Initializes and returns the LESS compiler.
     * @param lookupTable {LookupTable} lookup table
     * @returns {Object} LESS compiler
     */
    function getLessCompiler(lookupTable) {
        var less = require(constants.MODULE_LESS).less;
        // Adopted from https://github.com/less/less.js/blob/v1.7.5/lib/less/rhino.js#L89
        less.Parser.fileLoader = function (file, currentFileInfo, callback, env) {
            var lessFilePath, lessFile;
            if (currentFileInfo && currentFileInfo.currentDirectory && (file.charAt(0) != "/")) {
                // File path does not start with '/', indicates a relative path.
                lessFilePath = less.modules.path.join(currentFileInfo.currentDirectory, file);
                lessFile = new File(lessFilePath);
            }
            if (/{{.+}}/.test(file)) {
                // File path has '{{uiComponentFullName}}'.
                var startIndex = file.indexOf("{{");
                var endIndex = file.indexOf("}}", (startIndex + 2));
                var uiComponentFullName = file.substr((startIndex + 2), (endIndex - 2));
                var uiComponent = lookupTable.uiComponents[uiComponentFullName];
                if (!uiComponent) {
                    callback({
                        type: 'UI Component',
                        message: "UI Component '" + uiComponentFullName
                                 + "' mentioned in file '" + file + "' cannot be found."
                    });
                    return;
                }
                var relativePath = constants.DIRECTORY_APP_UNIT_PUBLIC + file.substr(endIndex + 2);
                lessFile = Utils.getFileInUiComponent(uiComponent, relativePath, lookupTable);
                if (!lessFile) {
                    callback({
                        type: 'File',
                        message: "File '" + relativePath + "' cannot be found in UI Component '"
                                 + uiComponent.fullName + "'."
                    });
                    return;
                }
                lessFilePath = lessFile.getPath();
            }
            if (!lessFilePath) {
                lessFilePath = file;
                lessFile = new File(file);
            }

            var path = less.modules.path.dirname(lessFilePath);
            var newFileInfo = {
                currentDirectory: path,
                filename: lessFilePath
            };
            if (currentFileInfo) {
                newFileInfo.entryPath = currentFileInfo.entryPath;
                newFileInfo.rootpath = currentFileInfo.rootpath;
                newFileInfo.rootFilename = currentFileInfo.rootFilename;
                newFileInfo.relativeUrls = currentFileInfo.relativeUrls;
            } else {
                newFileInfo.entryPath = path;
                newFileInfo.rootpath = less.rootpath || path;
                newFileInfo.rootFilename = lessFilePath;
                newFileInfo.relativeUrls = env.relativeUrls;
            }
            var j = file.lastIndexOf('/');
            if (newFileInfo.relativeUrls && !/^(?:[a-z-]+:|\/)/.test(file) && j != -1) {
                var relativeSubDirectory = file.slice(0, j + 1);
                // append (sub|sup) directory  path of imported file
                newFileInfo.rootpath = newFileInfo.rootpath + relativeSubDirectory;
            }

            var data = null;
            try {
                lessFile.open('r');
                data = lessFile.readAll();
            } catch (e) {
                log.error("", e);
                callback({
                    type: 'File',
                    message: "Cannot read '" + lessFilePath + "' file."
                });
                return;
            } finally {
                closeQuietly(lessFile);
            }

            try {
                callback(null, data, lessFilePath, newFileInfo, {lastModified: 0});
            } catch (e) {
                callback(e, null, lessFilePath);
            }
        };

        // TODO: implement a proper caching mechanism for 'less'
        return less;
    }

    /**
     * Parses the specifies LESS resource.
     * @param lessResource {StaticResource} LESS resource to be parse
     * @param lessCompiler {Object} LESS compiler
     * @param isCachingEnabled {boolean} whether caching is enabled or not
     * @return {{success: boolean, message: string, cssFile: Object}} LESS parsing result
     */
    function parseLessResource(lessResource, lessCompiler, isCachingEnabled) {
        var lessFile = lessResource.file;
        var uiComponent = lessResource.provider;
        // cached CSS file name pattern: {uiComponentFullName}_{cssFileName}.css
        var cachedFilePath = [constants.DIRECTORY_CACHE, "/", uiComponent.fullName, "_",
                              splitFileName(lessFile.getName()).name, ".css"].join("");
        var cachedFile = new File(cachedFilePath);
        var rv = {success: true, message: "Success", cssFile: cachedFile};

        if (isCachingEnabled && cachedFile.isExists() &&
            (parseInt(cachedFile.getLastModified()) > parseInt(lessFile.getLastModified()))) {
            // Caching is enabled AND cached file exists AND cached file is newer than the less
            // file. Hence just return the cached file.
            return rv;
        }

        // Adopted from https://github.com/less/less.js/blob/v1.7.5/lib/less/rhino.js#L149
        var options = {
            depends: false,
            compress: false,
            cleancss: false,
            max_line_len: -1.0,
            optimization: 1.0,
            silent: false,
            verbose: false,
            lint: false,
            paths: [],
            color: true,
            strictImports: false,
            rootpath: "",
            relativeUrls: false,
            ieCompat: true,
            strictMath: false,
            strictUnits: false,
            filename: lessFile.getPath()
        };
        var lessParser = lessCompiler.Parser(options);
        var lessCode;
        try {
            lessFile.open("r");
            lessCode = lessFile.readAll();
        } catch (e) {
            rv.success = false;
            rv.message = "Cannot read LESS file '" + options.filename + ".";
            rv.cssFile = null;
            log.error(e);
            return rv;
        } finally {
            closeQuietly(lessFile);
        }

        var callback = function (error, root) {
            if (error) {
                // something went wrong when processing the LESS file
                rv.success = false;
                rv.message = "Failed to process '" + lessFile.getPath() + "' file due to '"
                             + error.message + "' happened in file '" + error.filename
                             + "' at line " + error.line + ".";
                rv.cssFile = null;
                return;
            }

            var result = root.toCSS(options);
            try {
                cachedFile.open("w");
                cachedFile.write(result);
            } catch (e) {
                rv.success = false;
                rv.message = "Cannot write to cached CSS file '" + cachedFilePath + ".";
                rv.cssFile = null;
                //log.error(e);
            } finally {
                closeQuietly(cachedFile);
            }
        };
        lessParser.parse(lessCode, callback, {globalVars: {}});

        return rv;
    }

    /**
     * Returns resources in the specified URIs.
     * @param requestedResourcesUris {String[]} resource URIs
     * @param lookupTable {LookupTable} lookup table
     * @param utils {UtilsModule} utils module
     * @return {{success: boolean, status: number, message: string, resources: StaticResource[],
     *     hashCode: string}} resources data
     */
    function getResourcesData(requestedResourcesUris, lookupTable, utils) {
        var rv = {success: true, status: 0, message: "Success", resources: null, hashCode: null};
        /** @type {StaticResource[]} */
        var requestedResources = [];
        var hashCodeBuffer = [];

        var uiComponentPublicDirectory = constants.DIRECTORY_APP_UNIT_PUBLIC;
        var numberOfRequestedResourcesUris = requestedResourcesUris.length;
        var uiComponents = lookupTable.uiComponents;
        var getFileInUiComponent = utils.getFileInUiComponent;
        for (var i = 0; i < numberOfRequestedResourcesUris; i++) {
            var requestedResourceUri = requestedResourcesUris[i];
            if (requestedResourceUri.length == 0) {
                // ignore
                continue;
            }

            var parts = requestedResourceUri.split("/");
            var numberOfParts = parts.length;
            switch (numberOfParts) {
                case 0:
                case 1:
                    // An invalid resource URI.
                    rv.success = false;
                    rv.status = 400;
                    rv.message = "Requested resource URI '" + requestedResourceUri + "' is invalid.";
                    return rv;
                case 2:
                    // An invalid resource URI. parts = [{uiComponentFullName}, {fileName}]
                    rv.success = false;
                    rv.status = 400;
                    rv.message = "Request resource URI '" + requestedResourceUri + "' is invalid. "
                                 + "Uncategorized resources inside the 'public' directory of "
                                 + "an UI Component are restricted.";
                    return rv;
                default:
                    // requestedResource = {uiComponentFullName}/{sub-directory}/{+filePath}
                    // For valid URIs : parts.length >= 3
                    // parts = ["uiComponentFullName", "sub-directory", ... ]
                    hashCodeBuffer.push(requestedResourceUri);
            }

            var uiComponentFullName = parts[0];
            var uiComponent = uiComponents[uiComponentFullName];
            if (!uiComponent) {
                rv.success = false;
                rv.status = 404;
                rv.message = "Requested UI Component '" + uiComponentFullName + "' does not exists.";
                return rv;
            }

            var resourceType = splitFileName(parts[numberOfParts - 1]).extension;
            var relativeFilePath = uiComponentPublicDirectory
                                   + requestedResourceUri.substr(uiComponentFullName.length);
            var resourceFile = getFileInUiComponent(uiComponent, relativeFilePath, lookupTable);
            if (resourceFile) {
                requestedResources.push({
                    type: resourceType,
                    file: resourceFile,
                    provider: uiComponent
                });
            } else {
                // Requested file either does not exists or it is a directory.
                rv.success = false;
                rv.status = 404;
                rv.message = "Requested resource '" + relativeFilePath
                             + "' does not exists in UI Component '" + uiComponent.fullName
                             + "' or its parents " + stringify(uiComponent.parents) + ".";
                return rv;
            }
        }

        rv.hashCode = hashCode(hashCodeBuffer.join(","));
        rv.resources = requestedResources;
        return rv;
    }

    /**
     * Returns the combined file for the specified resources.
     * @param requestedResources {StaticResource[]} resources
     * @param hashCode {string} hash code of the resources
     * @return {Object} combined file
     */
    function getCombinedFile(requestedResources, hashCode) {
        var firstResourceType = requestedResources[0].type;
        var extension = (firstResourceType == "less") ? "css" : firstResourceType;
        return new File(constants.DIRECTORY_CACHE + "/" + hashCode + "." + extension);
    }

    /**
     * Updates the combined file of the specified resources.
     * @param combinedFile {Object} combined file
     * @param requestedResources {StaticResource[]} resources
     * @param isCachingEnabled {boolean} whether caching is enabled or not
     * @param lookupTable {LookupTable} lookup table
     * @return {{success: boolean, message: string}} combined file updating result
     */
    function updateCombinedFile(combinedFile, requestedResources, isCachingEnabled, lookupTable) {
        var rv = {success: true, message: "Success"};
        try {
            combinedFile.open('w');
        } catch (e) {
            rv.success = false;
            rv.message = "Cannot open cache file '" + combinedFile.getPath() + "' for writing.";
            log.error(e);
            return rv;
        }

        var lessCompiler;
        var numberOfRequestedResources = requestedResources.length;
        for (var i = 0; i < numberOfRequestedResources; i++) {
            var processingResource = requestedResources[i];
            var processingFile;
            if (processingResource.type == "less") {
                if (!lessCompiler) {
                    lessCompiler = getLessCompiler(lookupTable)
                }
                var lessRenderingResult = parseLessResource(processingResource, lessCompiler,
                                                            isCachingEnabled);
                if (!lessRenderingResult.success) {
                    rv.success = false;
                    rv.message = lessRenderingResult.message;
                    closeQuietly(combinedFile);
                    combinedFile.del();
                    return rv;
                }
                processingFile = lessRenderingResult.cssFile;
            } else {
                processingFile = processingResource.file;
            }

            var inputStream;
            try {
                inputStream = processingFile.getStream();
            } catch (e) {
                rv.success = false;
                rv.message = "Cannot open file '" + processingFile.getPath() + " for reading.";
                log.error(e);
                closeQuietly(processingFile);
                return rv;
            }
            try {
                combinedFile.write(inputStream);
            } catch (e) {
                rv.success = false;
                rv.message = "Cannot write to cache file '" + combinedFile.getPath() + ".";
                log.error(e);
                closeQuietly(combinedFile);
                return rv;
            }
        }

        closeQuietly(combinedFile);
        return rv;
    }

    /**
     *
     * @param request {Object} HTTP response
     * @returns {number} milliseconds from epoch
     */
    function getIfModifiedSinceDate(request) {
        var httpDateStr = request.getHeader("If-Modified-Since");
        return new Date(httpDateStr).getTime();
    }

    /**
     *
     * @param file {Object} file
     * @returns {string} HTTP-date
     */
    function getLastModifiedDate(file) {
        var utcMilliseconds = parseInt(file.getLastModified());
        return new Date(utcMilliseconds).toUTCString();
    }

    /**
     * Sets necessary HTTP headers in the specified HTTP response.
     * @param file {Object} file which will be served in the HTTP response.
     * @param mimeType {string} MIME type of the file
     * @param response {Object} HTTP response
     */
    function setResponseHeaders(file, mimeType, response) {
        response.addHeader("Content-type", mimeType);
        response.addHeader("Cache-Control", "public,max-age=12960000");
        response.addHeader("Last-Modified", getLastModifiedDate(file));
    }

    /**
     * Sends the specified file via the response.
     * @param file {Object} file to be served
     * @param response {Object} HTTP response
     */
    function serveFile(file, response) {
        // TODO: use Tomcat file serving mechanism
        print(file.getStream());
        closeQuietly(file);
    }

    route = function (request, response) {
        var appConfigs = Utils.getAppConfigurations();
        /** @type {LookupTable} */
        var lookupTable = Utils.getLookupTable(appConfigs);

        // URI = /{appName}/public/[{uiComponentFullName}/{resourceType}/{+filePath},...]
        var uri = decodeURIComponent(request.getRequestURI());
        var rawResourcesString = uri.substr(nthIndexOf(uri, "/", 3) + 1);
        if (rawResourcesString.length == 0) {
            // An invalid URI.
            var msg = "Request URI '" + uri + "' is invalid.";
            log.warn(msg);
            response.sendError(400, msg);
            return;
        }

        // separate resources
        var resourcesString = rawResourcesString.split(constants.COMBINED_RESOURCES_URL_TAIL)[0];
        var requestedResourcesUris = resourcesString.split(constants.COMBINED_RESOURCES_SEPARATOR);
        if (requestedResourcesUris.length == 0) {
            // An invalid URI.
            var msg = "Request URI '" + uri + "' is invalid.";
            log.warn(msg);
            response.sendError(400, msg);
            return;
        }

        // get resources data
        var resourcesData = getResourcesData(requestedResourcesUris, lookupTable, Utils);
        if (!resourcesData.success) {
            log.warn(resourcesData.message);
            response.sendError(resourcesData.status, resourcesData.message);
            return;
        }

        var requestedResources = resourcesData.resources;
        var numberOfRequestedResources = requestedResources.length;
        if (numberOfRequestedResources == 0) {
            // An invalid URI.
            var msg = "Request URI '" + uri + "' is invalid.";
            log.warn(msg);
            response.sendError(400, msg);
            return;
        }

        var noCacheParam = Utils.parseBoolean(request.getParameter("nocache"), false);
        var cachingEnabledConfig = Utils.parseBoolean(appConfigs[constants.APP_CONF_CACHE_ENABLED]);
        var isCachingEnabled = (!noCacheParam && cachingEnabledConfig);

        if (numberOfRequestedResources == 1) {
            // only one file
            var resource = requestedResources[0];
            var servingFile;
            if (resource.type == "less") {
                var lessRenderingResult = parseLessResource(resource, getLessCompiler(lookupTable),
                                                            isCachingEnabled);
                if (!lessRenderingResult.success) {
                    log.error(lessRenderingResult.message);
                    response.sendError(500, lessRenderingResult.message);
                    return;
                }
                servingFile = lessRenderingResult.cssFile;
            } else {
                servingFile = resource.file;
            }
            if (parseInt(servingFile.getLastModified()) <= getIfModifiedSinceDate(request)) {
                // Requested file has not changed since last serve.
                response.status = 304;
                return;
            }
            setResponseHeaders(servingFile, servingFile.getContentType(), response);
            serveFile(servingFile, response);
            return;
        }

        // many files
        var cachedFile = getCombinedFile(requestedResources, resourcesData.hashCode);
        var cachedFileLMD = parseInt(cachedFile.getLastModified());
        var updateCachedFile;
        if (isCachingEnabled) {
            for (var i = 0; i < numberOfRequestedResources; i++) {
                if (cachedFileLMD < parseInt(requestedResources[i].file.getLastModified())) {
                    updateCachedFile = true;
                    break;
                }
            }
        } else {
            updateCachedFile = true;
        }

        if (updateCachedFile) {
            var cachedFileUpdateData = updateCombinedFile(cachedFile, requestedResources,
                                                          isCachingEnabled, lookupTable);
            if (!cachedFileUpdateData.success) {
                log.error(cachedFileUpdateData.message);
                response.sendError(500, cachedFileUpdateData.message);
                return;
            }
        } else {
            if (cachedFileLMD <= getIfModifiedSinceDate(request)) {
                // Requested files have not changed since the last serve.
                response.status = 304;
                return;
            }
        }
        setResponseHeaders(cachedFile, cachedFile.getContentType(), response);
        serveFile(cachedFile, response);

    };
})();
