const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Only reviewed runtime files belong in the XPI. Update this list deliberately
// when adding an asset; profiles, logs, editor settings, and credentials stay out.
const packageFiles = [
	"api/AutoSelect/implementation.js",
	"api/AutoSelect/schema.json",
	"background.js",
	"manifest.json",
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

module.exports = { checkPrivacy, inspectText, packageFiles };
if (require.main === module)
{
	const result = checkPrivacy(path.join(__dirname, ".."));
	console.log(`Privacy checks passed: ${result.checked} repository files and ${result.packageFiles} allowed package files.`);
}
