const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { checkPackage, checkPrivacy } = require("./privacy.cjs");

const root = path.join(__dirname, "..");
checkPrivacy(root);
const source = path.join(root, "src");
const manifest = JSON.parse(fs.readFileSync(path.join(source, "manifest.json"), "utf8"));
assert.ok(!Object.hasOwn(manifest, "experiment_apis"), "Experimental APIs cannot be released from master.");
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lockInfo = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const version = manifest.version;
assert.match(version, /^\d{2}(?:\.[1-9]\d?){2}\.(0|[1-9]\d{0,3})$/, "Expected YY.M.D.hmm CalVer");
assert.equal(version, packageInfo.version, "Manifest and package versions must match");
assert.equal(version, lockInfo.version, "Manifest and lockfile versions must match");
assert.equal(version, lockInfo.packages[""].version, "Manifest and lockfile package versions must match");
const [year, month, day, time] = version.split(".").map(Number);
const date = new Date(Date.UTC(2000 + year, month - 1, day));
assert.equal(date.getUTCMonth(), month - 1, "Invalid CalVer date");
assert.equal(date.getUTCDate(), day, "Invalid CalVer day");
assert.ok(Math.floor(time / 100) < 24 && time % 100 < 60, "Invalid CalVer time");
const tag = `v${version}`;
if (process.env.GITHUB_REF_TYPE === "tag") assert.equal(process.env.GITHUB_REF_NAME, tag, "Tag and manifest version differ");

const asset = `dist/auto-select-latest-message-${version}.xpi`;
const checksum = `${asset}.sha256`;
if (process.argv[2] === "verify")
{
	const bytes = fs.readFileSync(path.join(root, asset));
	assert.ok(bytes.length > 0, "The release package is empty");
	assert.deepEqual(checkPackage(bytes), manifest, "The built manifest differs from the source manifest.");
	const hash = crypto.createHash("sha256").update(bytes).digest("hex");
	fs.writeFileSync(path.join(root, checksum), `${hash}  ${path.basename(asset)}\n`);
	console.log(`Verified ${asset}; wrote ${checksum}`);
}
else
{
	execFileSync(process.execPath, [path.join(__dirname, "check-atn.cjs")], { stdio: "inherit" });
	const entries = ["manifest.json", ...(manifest.background?.scripts || []), manifest.options_ui?.page];
	for (const entry of entries.filter(Boolean))
	{
		const absolute = path.resolve(source, entry);
		assert.ok(absolute.startsWith(source + path.sep), `Entry escapes src: ${entry}`);
		assert.ok(fs.statSync(absolute).isFile(), `Missing entry point: ${entry}`);
	}
	for (const file of fs.readdirSync(source, { recursive: true }).filter(entry => entry.endsWith(".js")))
	{
		execFileSync(process.execPath, ["--check", path.join(source, file)], { stdio: "inherit" });
	}
	if (process.env.GITHUB_OUTPUT)
	{
		fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ntag=${tag}\nasset=${asset}\nchecksum=${checksum}\n`);
	}
	console.log(`Release metadata and JavaScript validated: ${tag}`);
}
