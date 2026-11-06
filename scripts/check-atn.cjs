const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const catalogURL = "https://addons.thunderbird.net/en-US/thunderbird/pages/appversions/";
const thunderbirdID = "{3550f703-e582-4d05-9a08-453d09bdfdc6}";

const parseCatalog = html =>
{
	const application = html.split(thunderbirdID)[1]?.split("</ul>")[0];
	const match = application?.match(/Versions:\s*<code>([^<]+)<\/code>/);
	assert.ok(match, "Could not read Thunderbird versions from ATN's catalog.");
	return new Set(match[1].split(",").map(value => value.trim()));
};

const validateVersions = (gecko, versions) =>
{
	for (const key of ["strict_min_version", "strict_max_version"])
	{
		const value = gecko?.[key];
		assert.ok(typeof value === "string" && versions.has(value),
			`ATN does not recognize ${key}=${value}. Check ${catalogURL}`);
	}
	assert.ok(!gecko.strict_min_version.includes("*"), "ATN does not allow a wildcard minimum version.");
};

const check = async () =>
{
	const response = await fetch(catalogURL, { signal: AbortSignal.timeout(15_000) });
	assert.ok(response.ok, `ATN version catalog request failed: HTTP ${response.status}`);
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../src/manifest.json"), "utf8"));
	const gecko = manifest.browser_specific_settings.gecko;
	validateVersions(gecko, parseCatalog(await response.text()));
	console.log(`ATN accepts Thunderbird ${gecko.strict_min_version} through ${gecko.strict_max_version}.`);
};

module.exports = { parseCatalog, validateVersions };
if (require.main === module)
{
	check().catch(error =>
	{
		console.error(error.message);
		process.exitCode = 1;
	});
}
