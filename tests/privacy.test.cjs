const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const zlib = require("node:zlib");
const { checkPackage, checkPrivacy, inspectText, packageFiles } = require("../scripts/privacy.cjs");

const artifacts = path.resolve(__dirname, "../dist");
const packageFixture = (overrides = {}, method = 8) =>
{
	const contents = new Map(packageFiles.map(name => [name, name === "manifest.json"
		? JSON.stringify({ manifest_version: 2, name: "Fixture", version: "1.0" }) : "reviewed fixture\n"]));
	for (const [name, value] of Object.entries(overrides)) contents.set(name, value);
	const localParts = [];
	const directory = [];
	let offset = 0;
	for (const [name, text] of contents)
	{
		const nameBytes = Buffer.from(name);
		const content = Buffer.from(text);
		const data = method === 0 ? content : zlib.deflateRawSync(content);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04_03_4B_50);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(content.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		localParts.push(local, nameBytes, data);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02_01_4B_50);
		entry.writeUInt16LE(method, 10);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(content.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		directory.push(entry, nameBytes);
		offset += local.length + nameBytes.length + data.length;
	}
	const central = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06_05_4B_50);
	end.writeUInt16LE(contents.size, 8);
	end.writeUInt16LE(contents.size, 10);
	end.writeUInt32LE(central.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...localParts, central, end]);
};
const fixture = context =>
{
	fs.mkdirSync(artifacts, { recursive: true });
	const directory = fs.mkdtempSync(path.join(artifacts, "privacy-test-"));
	context.after(() =>
	{
		const target = path.resolve(directory);
		assert.equal(path.dirname(target), artifacts);
		assert.ok(path.basename(target).startsWith("privacy-test-"));
		fs.rmSync(target, { recursive: true, force: true });
	});
	for (const file of packageFiles)
	{
		const target = path.join(directory, "src", file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, file === "manifest.json" ? JSON.stringify({ manifest_version: 2, name: "Fixture", version: "1.0" }) : "reviewed fixture\n");
	}
	return directory;
};

test("privacy checks allow ordinary extension settings and public URLs", () =>
{
	assert.deepEqual(inspectText('messenger.storage.local.get("settings"); https://example.org/public'), []);
});

test("privacy checks recognize synthetic credentials and personal paths", () =>
{
	const cases = [
		["private key", ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")],
		["GitHub token", "ghp_" + "a".repeat(36)],
		["AWS access key", "AKIA" + "A".repeat(16)],
		["Slack token", "xoxb-" + "a".repeat(25)],
		["URL credentials", ["https://example:", "fixture@example.org/"].join("")],
		["literal credential", ["password", "=", JSON.stringify("fixture-value-only")].join(" ")],
		["personal home path", ["C:", "Users", "Example", "private.json"].join("/")],
		["personal home path", ["", "home", "example", "private.json"].join("/")],
	];
	for (const [reason, value] of cases) assert.ok(inspectText(value).includes(reason), reason);
});

test("privacy checks accept precisely the reviewed package files", context =>
{
	const result = checkPrivacy(fixture(context));
	assert.equal(result.packageFiles, packageFiles.length);
});

test("privacy checks reject an extra file even without a Git checkout", context =>
{
	const directory = fixture(context);
	fs.writeFileSync(path.join(directory, "src/.env"), "fixture-only");
	assert.throws(() => checkPrivacy(directory), /unexpected files/);
});

test("public packages reject an experimental manifest even without native source files", context =>
{
	const directory = fixture(context);
	const manifest = path.join(directory, "src/manifest.json");
	fs.writeFileSync(manifest, JSON.stringify({ experiment_apis: {} }));
	assert.throws(() => checkPrivacy(directory), /Experimental APIs/);
});

for (const source of [
	'ChromeUtils.importESModule("resource:///modules/MailServices.sys.mjs");',
	"Components.classes;",
	"Services.prefs.getBoolPref('setting');",
	"messenger.AutoSelect.findMessage(1, 1);",
])
{
	test(`public packages reject privileged runtime code: ${source.split(/[(.]/)[0]}`, context =>
	{
		const directory = fixture(context);
		fs.writeFileSync(path.join(directory, "src/selection.js"), source);
		assert.throws(() => checkPrivacy(directory), /Privileged runtime code/);
	});
}

test("privacy failures never print matched credentials", context =>
{
	const directory = fixture(context);
	const value = "fixture-secret-value";
	fs.writeFileSync(path.join(directory, "src/settings.js"), ["password", "=", JSON.stringify(value)].join(" "));
	assert.throws(() => checkPrivacy(directory), error =>
	{
		assert.match(error.message, /literal credential/);
		assert.ok(!error.message.includes(value));
		assert.ok(!error.message.includes(directory));
		return true;
	});
});

test("privacy checks reject publishable credential files and honor Git exclusions", context =>
{
	const directory = fixture(context);
	execFileSync("git", ["init", "--quiet", directory]);
	fs.writeFileSync(path.join(directory, ".env"), "fixture-only");
	assert.throws(() => checkPrivacy(directory), /credential files/);
	fs.writeFileSync(path.join(directory, ".gitignore"), ".env\n");
	assert.equal(checkPrivacy(directory).packageFiles, packageFiles.length);
});

for (const method of [0, 8])
{
	test(`release checks inspect actual ZIP contents with compression method ${method}`, () =>
	{
		assert.equal(checkPackage(packageFixture({}, method)).name, "Fixture");
	});
}

test("release checks reject an experimental XPI even if the current sources are public", () =>
{
	const bytes = packageFixture({ "manifest.json": JSON.stringify({ experiment_apis: {} }) });
	assert.throws(() => checkPackage(bytes), /Experimental APIs/);
});

test("release checks reject privileged code inside a compressed XPI", () =>
{
	const bytes = packageFixture({ "background.js": "Services.prefs.getBoolPref('setting');" });
	assert.throws(() => checkPackage(bytes), /Privileged runtime code/);
});

test("release checks reject extra native API files and truncated packages", () =>
{
	assert.throws(() => checkPackage(packageFixture({ "api/native.js": "native fixture" })), /unexpected files/);
	assert.throws(() => checkPackage(packageFixture().subarray(0, 20)), /ZIP directory/);
});
