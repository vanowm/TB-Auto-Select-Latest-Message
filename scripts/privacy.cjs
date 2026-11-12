const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

// Only reviewed runtime files belong in the XPI. Update this list deliberately
// when adding an asset; profiles, logs, editor settings, and credentials stay out.
const manifestFile = "manifest.json";
const packageFiles = [
	"background.js",
	manifestFile,
	"options.css",
	"options.html",
	"options.js",
	"selection.js",
	"settings.js",
];
const patterns = [
	["private key", /-{5}BEGIN (?:[\dA-Z]+ )*PRIVATE KEY(?: BLOCK)?-{5}/],
	["GitHub token", /\b(?:gh[oprsu]_\w{30,}|github_pat_\w{30,})\b/],
	["AWS access key", /\b(?:AKIA|ASIA)[\dA-Z]{16}\b/],
	["Slack token", /\bxox[abprs]-[\dA-Za-z-]{20,}\b/],
	["URL credentials", /https?:\/\/[^\s/:@]+:[^\s/@]+@/],
	["literal credential", /\b(?:password|passwd|api[_-]?key|api[_-]?secret|access[_-]?token|client[_-]?secret|_authtoken)["']?\s*[:=]\s*["'][^\n\r"']{8,}["']/i],
	["personal home path", /\b[a-z]:[/\\](?:users|documents and settings)[/\\][^\s"'/\\]+/i],
	["personal home path", /\/(?:home|Users)\/[^\s"'/]+/],
];
const privateNames = new Set([
	".npmrc", "logins.json", "key3.db", "key4.db", "cert9.db", "prefs.js", "user.js",
	"profiles", "mail", "imapmail",
]);

const inspectText = text => patterns.filter(([, pattern]) => pattern.test(text)).map(([reason]) => reason);
const privilegedSource = /\b(?:ChromeUtils|Components|ExtensionCommon|ExtensionAPI)\b|\bServices\s*\.|(?:chrome|resource):\/\/|\b(?:messenger|browser)\s*\.\s*AutoSelect\b/;
const checkPublicApis = files =>
{
	const manifest = JSON.parse(files.get(manifestFile));
	assert.ok(!Object.hasOwn(manifest, "experiment_apis"), "Experimental APIs are not allowed in the public release.");
	for (const [name, text] of files)
	{
		if (name.endsWith(".js")) assert.ok(!privilegedSource.test(text), "Privileged runtime code is not allowed in the public release.");
	}
};
const checkPackage = bytes =>
{
	// Read the central directory rather than trusting the current source tree:
	// a stale XPI must not publish privileged code after a public-only rebuild.
	let end = -1;
	for (let candidate = bytes.length - 22; candidate >= Math.max(0, bytes.length - 65_557); candidate--)
	{
		if (bytes.readUInt32LE(candidate) === 0x06_05_4B_50 && candidate + 22 + bytes.readUInt16LE(candidate + 20) === bytes.length)
		{
			end = candidate;
			break;
		}
	}
	const invalidDirectory = "The release package has an invalid ZIP directory.";
	assert.ok(end >= 0, invalidDirectory);
	assert.equal(bytes.readUInt16LE(end + 4), 0, invalidDirectory);
	assert.equal(bytes.readUInt16LE(end + 6), 0, invalidDirectory);
	const count = bytes.readUInt16LE(end + 10);
	assert.equal(bytes.readUInt16LE(end + 8), count, invalidDirectory);
	assert.equal(count, packageFiles.length, "The release package has unexpected files.");
	const size = bytes.readUInt32LE(end + 12);
	let offset = bytes.readUInt32LE(end + 16);
	assert.equal(offset + size, end, invalidDirectory);
	const files = new Map();
	let unpacked = 0;
	for (let index = 0; index < count; index++)
	{
		assert.ok(offset + 46 <= end && bytes.readUInt32LE(offset) === 0x02_01_4B_50, "Invalid ZIP entry.");
		const flags = bytes.readUInt16LE(offset + 8);
		const method = bytes.readUInt16LE(offset + 10);
		const compressedSize = bytes.readUInt32LE(offset + 20);
		const expandedSize = bytes.readUInt32LE(offset + 24);
		const nameSize = bytes.readUInt16LE(offset + 28);
		const extraSize = bytes.readUInt16LE(offset + 30);
		const commentSize = bytes.readUInt16LE(offset + 32);
		const local = bytes.readUInt32LE(offset + 42);
		assert.ok(offset + 46 + nameSize + extraSize + commentSize <= end, "Truncated ZIP entry.");
		const name = bytes.subarray(offset + 46, offset + 46 + nameSize).toString("utf8");
		assert.ok(packageFiles.includes(name) && !files.has(name), "The release package has unexpected or duplicate files.");
		assert.equal(flags & 1, 0, "Encrypted release packages are not supported.");
		assert.ok(method === 0 || method === 8, "Unsupported release package compression.");
		unpacked += expandedSize;
		assert.ok(unpacked <= 4 * 1024 * 1024, "The release package is unexpectedly large.");
		assert.ok(local + 30 <= offset && bytes.readUInt32LE(local) === 0x04_03_4B_50, "Invalid ZIP file header.");
		const localNameSize = bytes.readUInt16LE(local + 26);
		const localExtraSize = bytes.readUInt16LE(local + 28);
		const start = local + 30 + localNameSize + localExtraSize;
		assert.equal(bytes.subarray(local + 30, local + 30 + localNameSize).toString("utf8"), name, "Conflicting ZIP file names.");
		assert.ok(start + compressedSize <= offset, "Invalid ZIP file contents.");
		const data = bytes.subarray(start, start + compressedSize);
		const expanded = method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: expandedSize + 1 });
		assert.equal(expanded.length, expandedSize, "Incorrect ZIP file size.");
		files.set(name, expanded.toString("utf8"));
		offset += 46 + nameSize + extraSize + commentSize;
	}
	assert.equal(offset, end, "Unexpected ZIP directory contents.");
	assert.deepEqual([...files.keys()].sort(), packageFiles, "The release package has missing or unexpected files.");
	checkPublicApis(files);
	for (const text of files.values()) assert.equal(inspectText(text).length, 0, "Potential private data detected in the release package.");
	return JSON.parse(files.get(manifestFile));
};
const privateFile = file => file.split("/").some(part => privateNames.has(part.toLowerCase()) ||
	/^\.env(?:\.(?!(?:example|sample)$).*)?$/i.test(part) ||
	/\.(?:pem|key|p12|pfx|jks|sqlite(?:-wal|-shm)?)$/i.test(part) || /^smoke-profile-/i.test(part));

const checkPrivacy = root =>
{
	const source = path.join(root, "src");
	assert.ok(fs.lstatSync(source).isDirectory(), "The package source must be a real directory.");
	const sourceEntries = fs.readdirSync(source, { recursive: true });
	const sourceFiles = sourceEntries.filter(entry =>
	{
		const stat = fs.lstatSync(path.join(source, entry));
		assert.ok(!stat.isSymbolicLink(), "Symlinks are not allowed in package sources.");
		return stat.isFile();
	}).map(entry => entry.split(path.sep).join("/")).sort();
	assert.ok(JSON.stringify(sourceFiles) === JSON.stringify(packageFiles),
		"The package contains missing or unexpected files. Review src locally before releasing.");
	checkPublicApis(new Map(sourceFiles.map(file => [file, fs.readFileSync(path.join(source, file), "utf8")])));
	const files = new Set(sourceFiles.map(file => `src/${file}`));
	if (fs.existsSync(path.join(root, ".git")))
	{
		const publishable = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
			{ cwd: root, encoding: "utf8" });
		for (const file of publishable.split("\0").filter(Boolean)) files.add(file);
	}
	let checked = 0;
	for (const file of files)
	{
		const absolute = path.join(root, file);
		if (!fs.existsSync(absolute)) continue; // Tracked deletions are not published.
		assert.ok(!privateFile(file), "Private profile or credential files are eligible for publication. Release blocked.");
		const stat = fs.lstatSync(absolute);
		assert.ok(!stat.isSymbolicLink(), "Review repository symlinks before publishing.");
		if (!stat.isFile()) continue;
		const bytes = fs.readFileSync(absolute);
		if (!bytes.includes(0))
		{
			const reasons = inspectText(bytes.toString("utf8"));
			// Keep matched content and paths out of CI logs: either can be private.
			assert.equal(reasons.length, 0, `Potential private data detected (${reasons.join(", ")}). Review locally; release blocked.`);
		}
		checked++;
	}
	return { checked, packageFiles: sourceFiles.length };
};

module.exports = { checkPackage, checkPrivacy, checkPublicApis, inspectText, packageFiles };
if (require.main === module)
{
	const result = checkPrivacy(path.join(__dirname, ".."));
	console.log(`Privacy checks passed: ${result.checked} repository files and ${result.packageFiles} allowed package files.`);
}
