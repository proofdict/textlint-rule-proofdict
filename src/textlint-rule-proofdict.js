// MIT © 2017 azu
"use strict";
const debug = require("debug")("textlint-rule-proofdict");
const { createLocalStorage } = require("localstorage-ponyfill");
const { RuleHelper } = require("textlint-rule-helper");
import { createTester } from "./create-tester";
import { fetchProofdict } from "./fetch-proofdict";
import { getDictJSONURL, getRuleURL } from "./proofdict-repo-util";

const DefaultOptions = {
    // If you want to use live-proofdict
    // Proofdict-style dictionary URL
    // Example: "https://example.github.io/proof-dictionary/"
    // If you want to specific JSON end point, please pass
    // `dictURL; { jsonAPI: string, ruleBase: string }`
    "dictURL": undefined,
    // If you want to use local proofdict
    // dictPath is glob style path
    // TODO: Not implement yet
    "dictPath": undefined,
    // Default: 60sec(60 * 1000ms)
    "autoUpdateInterval": 60 * 1000,
    // = Tag settings
    // Filter dictionary by whitelist or blacklist
    // Default: Enable all terms of the dictionary.
    // When set both options, this rule prefer whitelist to blacklist
    "whitelistTags": [],
    "blacklistTags": [],
    // For testing
    // set you proofdict json object
    "proofdict": undefined
};

/**
 * @type {{LOCAL: string, NETWORK: string}}
 */
const MODE = {
    LOCAL: "LOCAL",
    NETWORK: "NETWORK"
};
const reporter = (context, options = DefaultOptions) => {
    const helper = new RuleHelper(context);
    const { Syntax, RuleError, report, getSource, fixer } = context;
    if (!options.dictURL && !options.dictPath && !options.proofdict) {
        return {
            [Syntax.Document](node) {
                report(node, new RuleError(`Not found dictionary setting.
Please set dictURL or dictPath to .textlintrc.`))
            }
        }
    }
    const mode = options.dictURL ? MODE.NETWORK : MODE.LOCAL;
    const whitelistTags = Array.isArray(options.whitelistTags) ? options.whitelistTags : DefaultOptions.whitelistTags;
    const blacklistTags = Array.isArray(options.blacklistTags) ? options.blacklistTags : DefaultOptions.blacklistTags;
    const autoUpdateInterval = options.autoUpdateInterval !== undefined
        ? options.autoUpdateInterval
        : DefaultOptions.autoUpdateInterval;
    const localStorage = createLocalStorage();
    const targetNodes = [];
    const addQueue = node => targetNodes.push(node);
    let promiseQueue = null;
    return {
        [Syntax.Document]() {
            // default: 0
            const lastUpdated = Number(localStorage.getItem("proofdict-lastUpdated", "0"));
            const isExpired = lastUpdated + autoUpdateInterval < Date.now();
            if (mode === MODE.NETWORK && isExpired) {
                const jsonAPIURL = getDictJSONURL(options);
                promiseQueue = fetchProofdict({ URL: jsonAPIURL })
                    .then(dictionary => {
                        localStorage.setItem("proofdict", JSON.stringify(dictionary));
                        localStorage.setItem("proofdict-lastUpdated", Date.now());
                    })
                    .catch(error => {
                        debug("Fetch is failed", error);
                    });
            } else {
                promiseQueue = Promise.resolve();
            }
            return promiseQueue;
        },
        [Syntax.Str](node) {
            addQueue(node);
        },
        [`${Syntax.Document}:exit`]() {
            return promiseQueue.then(() => {
                const getDict = (options) => {
                    // prefer `dictionary` option
                    if (options.proofdict !== undefined) {
                        return options.proofdict;
                    }
                    let proofDictData;
                    // NETWORK
                    if (options.dictURL) {
                        try {
                            const cachedProofdict = localStorage.getItem("proofdict");
                            proofDictData = JSON.parse(cachedProofdict);
                        } catch (error) {
                            localStorage.removeItem("proofdict");
                        }
                    }
                    // LOCAL
                    if (options.dictPath) {
                        // TODO: not implemented
                    }
                    return proofDictData;
                };
                const dictionary = getDict(options);
                const lastUpdated = Number(localStorage.getItem("proofdict-lastUpdated", "0"));
                const tester = createTester({
                    dictionary,
                    lastUpdated,
                    whitelistTags,
                    blacklistTags
                });
                // check
                const promises = targetNodes.map(node => {
                    if (helper.isChildNode(node, [Syntax.Link, Syntax.Image, Syntax.BlockQuote, Syntax.Emphasis])) {
                        return;
                    }
                    const text = getSource(node);
                    return tester.match(text).then(result => {
                        result.details.forEach(detail => {
                            const { matchStartIndex, matchEndIndex, actual, expected, description, rule } = detail;
                            // If result is not changed, should not report
                            if (actual === expected) {
                                return;
                            }
                            const url = getRuleURL(options, rule);
                            const additionalDescription = description ? `\n${description}` : "";
                            const additionalReference = url ? `\nSee ${url}` : "";
                            const messages = actual + " => " + expected + additionalDescription + additionalReference;
                            report(
                                node,
                                new RuleError(messages, {
                                    index: matchStartIndex,
                                    fix: fixer.replaceTextRange([matchStartIndex, matchEndIndex], expected)
                                })
                            );
                        });
                    });
                });
                return Promise.all(promises);
            });
        }
    };
};
module.exports = {
    linter: reporter,
    fixer: reporter
};
