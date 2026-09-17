"use strict";

delete require.cache[require.resolve("./index.cjs")];
delete require.cache[require.resolve("./lib.cjs")];
module.exports = require("./index.cjs");
