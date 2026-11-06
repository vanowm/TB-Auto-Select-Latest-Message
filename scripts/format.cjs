const path = require("node:path");
const fs = require("node:fs");
const espree = require("espree");
const postcss = require("postcss");
const { ESLint } = require("eslint");
const stylelint = require("stylelint");

const root = path.join(__dirname, "..");
const lint = process.argv.includes("--lint");
const check = lint || process.argv.includes("--check");
const targets = [
	"src/**/*.js", "src/**/*.json", "scripts/**/*.cjs", "tests/**/*.cjs", "schemas/**/*.json",
	"package.json", ".eslintrc.js", ".stylelintrc.js", ".vscode/*.code-workspace",
];
const extraFormattingRules = new Set(["jsonc/sort-keys", "one-var", "arrow-body-style"]);
const formatting = (ruleId, metadata) => metadata[ruleId]?.type === "layout" || extraFormattingRules.has(ruleId);

const expandStatementLines = file =>
{
	const source = fs.readFileSync(file, "utf8");
	const ast = espree.parse(source, { ecmaVersion: "latest", sourceType: "script", loc: true, range: true });
	const breaks = new Set();
	const visit = node =>
	{
		if (!node || typeof node !== "object") return;
		if (node.type === "BlockStatement" && node.body.length > 0)
		{
			const first = node.body[0];
			const last = node.body.at(-1);
			if (first.loc.start.line === node.loc.start.line) breaks.add(first.range[0]);
			if (last.loc.end.line === node.loc.end.line) breaks.add(node.range[1] - 1);
		}
		if (Array.isArray(node.body))
		{
			for (let index = 1; index < node.body.length; index++)
			{
				if (node.body[index - 1].loc.end.line === node.body[index].loc.start.line)
				{
					breaks.add(node.body[index].range[0]);
				}
			}
		}
		for (const [key, value] of Object.entries(node))
		{
			if (key === "loc" || key === "range") continue;
			if (Array.isArray(value))
			{
				for (const child of value) visit(child);
			}
			else if (value && typeof value.type === "string") visit(value);
		}
	};
	visit(ast);
	let output = source;
	for (const position of [...breaks].sort((left, right) => right - left))
	{
		output = output.slice(0, position) + "\n" + output.slice(position);
	}
	if (output !== source) fs.writeFileSync(file, output);
};

const expandCssBlocks = () =>
{
	const source = path.join(root, "src");
	for (const file of fs.readdirSync(source, { recursive: true }).filter(entry => entry.endsWith(".css")))
	{
		const absolute = path.join(source, file);
		const ast = postcss.parse(fs.readFileSync(absolute, "utf8"));
		ast.walk(node =>
		{
			if (!node.nodes?.length) return;
			node.raws.between = "\n";
			node.raws.after = "\n";
			for (const child of node.nodes) child.raws.before = "\n";
		});
		fs.writeFileSync(absolute, ast.toString());
	}
};

const main = async () =>
{
	const options = { cwd: root, errorOnUnmatchedPattern: false };
	if (!lint) options.overrideConfig = { rules: { "json-schema-validator/no-invalid": "off" } };
	const inspector = new ESLint(options);
	let results = await inspector.lintFiles(targets);
	if (!check)
	{
		for (const result of results.filter(entry => /\.(js|cjs)$/.test(entry.filePath)))
		{
			expandStatementLines(result.filePath);
		}
		expandCssBlocks();
		results = await inspector.lintFiles(targets);
		for (let pass = 0; pass < 3; pass++)
		{
			const metadata = inspector.getRulesMetaForResults(results);
			const fixer = new ESLint({ ...options, fix: message => formatting(message.ruleId, metadata) });
			results = await fixer.lintFiles(targets);
			await ESLint.outputFixes(results);
			if (!results.some(result => result.output !== undefined)) break;
			results = await inspector.lintFiles(targets);
		}
	}
	const metadata = inspector.getRulesMetaForResults(results);
	const remaining = results.map(result =>
	{
		return { ...result,
			messages: result.messages.filter(message => lint || message.fatal || formatting(message.ruleId, metadata)),
		};
	}).filter(result => result.messages.length);
	if (remaining.length > 0)
	{
		const reporter = await inspector.loadFormatter("stylish");
		console.error(reporter.format(remaining));
		process.exitCode = 1;
	}
	const css = await stylelint.lint({ cwd: root, files: "src/**/*.css", fix: !check,
		configFile: path.join(root, ".stylelintrc.js") });
	if (css.errored)
	{
		console.error(css.output);
		process.exitCode = 1;
	}
	if (!process.exitCode)
	{
		if (lint) console.log("ESLint and Stylelint passed with no errors or warnings.");
		else console.log(check ? "Formatting checks passed." : "Code formatted using the project ESLint and Stylelint rules.");
	}
};

main().catch(error =>
{
	console.error(error);
	process.exitCode = 1;
});
