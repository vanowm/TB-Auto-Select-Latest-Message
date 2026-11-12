const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCatalog, validateVersions } = require("../scripts/check-atn.cjs");

const versions = new Set(["128.0", "161.*", "*"]);
const supported = { strict_min_version: "128.0", strict_max_version: "161.*" };

test("ATN catalog parsing selects Thunderbird's application list", () =>
{
	const html = "<li>GUID: <code>{3550f703-e582-4d05-9a08-453d09bdfdc6}</code></li><li>Versions: <code>128.0, 161.*, *</code></li></ul>";
	assert.deepEqual(parseCatalog(html), versions);
});

test("ATN catalog parsing fails closed for an unrelated application", () =>
{
	assert.throws(() => parseCatalog("<li>Versions: <code>162.*</code></li>"), /Could not read/);
});

test("ATN accepts a minimum and maximum registered in its catalog", () =>
{
	assert.doesNotThrow(() => validateVersions(supported, versions));
});

test("ATN rejects a Nightly maximum not yet registered in its catalog", () =>
{
	assert.throws(() => validateVersions({ ...supported, strict_max_version: "162.*" }, versions), /strict_max_version=162\.\*/);
});

test("ATN rejects an unsupported minimum version", () =>
{
	assert.throws(() => validateVersions({ ...supported, strict_min_version: "127.0" }, versions), /strict_min_version=127\.0/);
});

test("ATN rejects a wildcard minimum even when the catalog lists it", () =>
{
	assert.throws(() => validateVersions({ ...supported, strict_min_version: "*" }, versions), /wildcard minimum/);
});
