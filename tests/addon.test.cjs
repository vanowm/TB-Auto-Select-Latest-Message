const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const evaluate = (file, expression, globals = {}) => vm.runInNewContext(fs.readFileSync(path.join(root, "src", file), "utf8") +
	`\n${expression}`, { console: { error: () => {} }, ...globals });
const Controller = evaluate("selection.js", "AutoSelectController");
const folder = { id: "account://Inbox" };
const otherFolder = { id: "account://Other" };
const unifiedFolder = { id: "unified:/Inbox", isUnified: true, isVirtual: true };
const selectedListId = "selected-list";
const message = (id, date, read = true) =>
{
	return { id, date: new Date(date), read };
};
const deferred = () =>
{
	let fulfill;
	const promise = new Promise(resolve =>
	{
		fulfill = resolve;
	});
	return { promise, resolve: fulfill };
};

const fixture = (options = {}) =>
{
	const calls = { selected: [], listed: 0, continued: [], aborted: [], waits: [], tabs: 0, listOptions: [], counts: 0 };
	let preferences = { sel: 1, selForce: false, ...options.settings };
	let displayedFolder = folder;
	let selected = options.selected || [];
	let pages = options.pages || [[message(1, 10), message(2, 90)]];
	let pageIndex = 0;
	const page = index =>
	{
		return { id: index < pages.length - 1 ? "listed" : null, messages: pages[index] || [] };
	};
	const api = {
		mailTabs: {
			get: async () =>
			{
				calls.tabs++;
				return { id: 1, displayedFolder, ...options.tab };
			},
			getSelectedMessages: async () =>
			{
				return { messages: selected };
			},
			getListedMessages: async (tabId, listOptions) =>
			{
				calls.listed++;
				calls.listOptions.push(listOptions);
				pageIndex = 0;
				return options.list ? options.list(calls.listed, listOptions) : page(0);
			},
			setSelectedMessages: async (tabId, ids) =>
			{
				calls.selected.push([tabId, ...ids]);
				selected = ids.map(id =>
				{
					return { id };
				});
				controller.selectionChanged(tabId, selected, displayedFolder);
			},
		},
		messages: {
			continueList: async id =>
			{
				calls.continued.push(id);
				return options.next ? options.next() : page(++pageIndex);
			},
			abortList: async id => calls.aborted.push(id),
		},
	};
	if (options.browserVersion) api.runtime = { getBrowserInfo: async () =>
	{
		return { version: options.browserVersion };
	} };
	if (options.count !== undefined) api.folders = { getFolderInfo: async () =>
	{
		calls.counts++;
		return { totalMessageCount: typeof options.count === "function" ? options.count() : options.count };
	} };
	const controller = new Controller(api, () => preferences, async ms =>
	{
		calls.waits.push(ms);
		if (options.delay) await options.delay(ms);
	});
	return {
		api, controller, calls,
		choose: ids =>
		{
			selected = ids.map(id =>
			{
				return { id };
			});
			controller.selectionChanged(1, selected, displayedFolder);
		},
		setSelected: ids =>
		{
			selected = ids.map(id =>
			{
				return { id };
			});
		},
		setFolder: value =>
		{
			displayedFolder = value;
		},
		setPages: value =>
		{
			pages = value;
		},
		setSettings: value =>
		{
			preferences = value;
		},
	};
};

const waitFor = async predicate =>
{
	for (let attempt = 0; attempt < 100; attempt++)
	{
		if (predicate()) return;
		await Promise.resolve();
	}
	assert.fail("Expected asynchronous request did not start");
};

test("the package contains only public API entry points", () =>
{
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "src/manifest.json")));
	assert.equal(manifest.experiment_apis, undefined);
	assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, "128.0");
	assert.equal(manifest.browser_specific_settings.gecko.strict_max_version, "161.*");
	assert.equal(manifest.browser_specific_settings.gecko.id, "autoselectlatestmessage@vano");
	for (const file of [...manifest.background.scripts, manifest.options_ui.page]) assert.ok(fs.existsSync(path.join(root, "src", file)), file);
	assert.equal(fs.existsSync(path.join(root, "src/api")), false);
	for (const file of ["background.js", "selection.js", "options.js"])
	{
		assert.doesNotMatch(fs.readFileSync(path.join(root, "src", file), "utf8"), /messenger\.AutoSelect|ChromeUtils|Services\.|Components\./);
	}
});

test("settings recover invalid values and retain supported legacy selections", () =>
{
	const settings = evaluate("settings.js", "ASLMSettings");
	for (const invalid of [null, undefined, false, 12, "invalid", []])
	{
		assert.equal(settings.normalize(invalid).sel, 1);
		assert.equal(settings.normalize(invalid).selForce, false);
	}
	assert.equal(settings.normalize({ sel: 0 }).sel, 0);
	assert.equal(settings.normalize({ sel: 2, selForce: true }).sel, 2);
	assert.equal(settings.normalize({ sel: -1 }).sel, 1);
});

test("newest compares dates across every page without changing the view sort", async () =>
{
	const f = fixture({ pages: [[message(1, 20)], [message(2, 90), message(3, 50)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.equal(f.calls.continued.length, 1);
	assert.equal(f.controller.requests.size, 0);
});

test("descending unthreaded date views stop after their first page", async () =>
{
	const f = fixture({ tab: { sortType: "date", sortOrder: "descending", viewType: "ungrouped" },
		pages: [[message(1, 90), message(2, 50)], [message(3, 20)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.equal(f.calls.continued.length, 0);
	assert.deepEqual(f.calls.aborted, ["listed"]);
});

test("threaded views still compare every listed message", async () =>
{
	const f = fixture({ tab: { sortType: "date", sortOrder: "descending", viewType: "groupedByThread" },
		pages: [[message(1, 20)], [message(2, 90)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.equal(f.calls.continued.length, 1);
});

test("first unread follows UI order and stops pagination once found", async () =>
{
	const f = fixture({ settings: { sel: 2 }, pages: [[message(1, 10, false), message(2, 90, false)], [message(3, 50)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.equal(f.calls.continued.length, 0);
	assert.deepEqual(f.calls.aborted, ["listed"]);
});

test("first unread continues later pages without consuming subsequent pages", async () =>
{
	const f = fixture({ settings: { sel: 2 }, pages: [[message(1, 10)], [message(2, 20, false)], [message(3, 90, false)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.equal(f.calls.continued.length, 1);
	assert.deepEqual(f.calls.aborted, ["listed"]);
});

test("first unread falls back to newest when all listed messages are read", async () =>
{
	const f = fixture({ settings: { sel: 2 }, pages: [[message(1, 90)], [message(2, 20)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.equal(f.calls.continued.length, 1);
});

test("existing selections remain unless override is enabled", async () =>
{
	const normal = fixture({ selected: [{ id: 7 }] });
	await normal.controller.select(1, folder);
	assert.equal(normal.calls.listed, 0);
	assert.equal(normal.calls.selected.length, 0);
	const forced = fixture({ selected: [{ id: 7 }], settings: { selForce: true } });
	await forced.controller.select(1, folder);
	assert.deepEqual(forced.calls.selected, [[1, 2]]);
});

for (const force of [false, true])
{
	test(`restored selection during initial settling respects override=${force}`, async () =>
	{
		const settling = deferred();
		const f = fixture({ settings: { selForce: force }, delay: ms => (ms === 100 ? settling.promise : undefined) });
		const pending = f.controller.select(1, folder);
		await waitFor(() => f.calls.waits.length > 0);
		f.choose([1]);
		settling.resolve();
		await pending;
		assert.deepEqual(f.calls.selected, force ? [[1, 2]] : []);
	});
}

test("disabled automatic selection does not query messages", async () =>
{
	const f = fixture({ settings: { sel: 0 } });
	await f.controller.select(1, folder);
	assert.equal(f.calls.listed, 0);
	assert.equal(f.calls.selected.length, 0);
});

test("unified folders select an ID already listed in the unified view", async () =>
{
	const unified = { id: "unified://Inbox", isUnified: true };
	const f = fixture({ pages: [[{ ...message(1, 20), folder }, { ...message(2, 90), folder: otherFolder }]] });
	f.setFolder(unified);
	await f.controller.select(1, unified);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	const tab = await f.api.mailTabs.get();
	assert.equal(tab.displayedFolder.id, unified.id);
});

test("empty startup views retry before selecting cached messages", async () =>
{
	const f = fixture({ list: attempt =>
	{
		return { id: null, messages: attempt < 3 ? [] : [message(1, 20)] };
	} });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.deepEqual(f.calls.waits, [100, 250, 250]);
});

test("an unavailable startup view retries after an API error", async () =>
{
	const f = fixture({ list: attempt =>
	{
		if (attempt === 1) throw new Error("view not ready");
		return { id: null, messages: [message(1, 20)] };
	} });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.equal(f.calls.listed, 2);
});

test("a long startup prompt leaves a bounded deferred retry", async () =>
{
	let loaded = false;
	const f = fixture({ list: () =>
	{
		return { id: null, messages: loaded ? [message(1, 20)] : [] };
	} });
	await f.controller.select(1, folder);
	assert.equal(f.calls.listed, 120);
	assert.equal(f.controller.deferred.size, 1);
	loaded = true;
	await f.controller.resumeDeferred();
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.equal(f.controller.deferred.size, 0);
});

test("remembered selections are restored after a round trip between folders", async () =>
{
	const f = fixture();
	await f.controller.select(1, folder);
	f.choose([1]);
	f.setFolder(otherFolder);
	f.setSelected([]);
	f.setPages([[message(3, 30)]]);
	await f.controller.select(1, otherFolder);
	f.setFolder(folder);
	f.setSelected([]);
	f.setPages([[message(1, 10), message(2, 90)]]);
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2], [1, 3], [1, 1]]);
});

test("remembered multi-selection can span multiple pages", async () =>
{
	const f = fixture({ pages: [[message(1, 10)], [message(2, 90)]] });
	f.controller.selectionChanged(1, [{ id: 1 }, { id: 2 }], folder);
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 1, 2]]);
});

test("missing remembered IDs fall back to a message still in the view", async () =>
{
	const f = fixture();
	f.controller.selectionChanged(1, [{ id: 999 }], folder);
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
});

test("stable explicit deselection stays empty on a later visit", async () =>
{
	const f = fixture();
	await f.controller.select(1, folder);
	f.choose([]);
	f.setFolder(otherFolder);
	f.setPages([[message(3, 30)]]);
	await f.controller.select(1, otherFolder);
	f.setFolder(folder);
	f.setSelected([]);
	const listedBefore = f.calls.listed;
	await f.controller.select(1, folder);
	assert.equal(f.calls.listed, listedBefore);
	assert.deepEqual(f.calls.selected, [[1, 2], [1, 3]]);
});

test("override ignores remembered selection and remembered deselection", async () =>
{
	for (const ids of [[1], []])
	{
		const f = fixture({ settings: { selForce: true } });
		f.controller.selectionChanged(1, ids.map(id =>
		{
			return { id };
		}), folder);
		await f.controller.select(1, folder);
		assert.deepEqual(f.calls.selected, [[1, 2]]);
	}
});

test("manual selection cancels a late page even with override enabled", async () =>
{
	const next = deferred();
	const f = fixture({ settings: { selForce: true }, pages: [[message(1, 10)], []], next: () => next.promise });
	const pending = f.controller.select(1, folder);
	await waitFor(() => f.calls.continued.length > 0);
	f.choose([7]);
	next.resolve({ id: "late-list", messages: [message(2, 90)] });
	await pending;
	assert.equal(f.calls.selected.length, 0);
	assert.ok(f.calls.aborted.includes("listed"));
	assert.ok(f.calls.aborted.includes("late-list"));
});

test("manual clearing during a scan prevents the pending selection", async () =>
{
	const next = deferred();
	const f = fixture({ pages: [[message(1, 10)], []], next: () => next.promise });
	const pending = f.controller.select(1, folder);
	await waitFor(() => f.calls.continued.length > 0);
	f.choose([]);
	next.resolve({ id: null, messages: [message(2, 90)] });
	await pending;
	assert.equal(f.calls.selected.length, 0);
});

test("a folder change during pagination rejects the stale candidate", async () =>
{
	const next = deferred();
	const f = fixture({ pages: [[message(1, 10)], []], next: () => next.promise });
	const pending = f.controller.select(1, folder);
	await waitFor(() => f.calls.continued.length > 0);
	f.setFolder(otherFolder);
	next.resolve({ id: null, messages: [message(2, 90)] });
	await pending;
	assert.equal(f.calls.selected.length, 0);
});

test("tab closure cancels an initial list returned after cancellation", async () =>
{
	const list = deferred();
	const f = fixture({ list: () => list.promise });
	const pending = f.controller.select(1, folder);
	await waitFor(() => f.calls.listed > 0);
	f.controller.remove(1);
	list.resolve({ id: "late-list", messages: [message(1, 20)] });
	await pending;
	assert.equal(f.calls.selected.length, 0);
	assert.deepEqual(f.calls.aborted, ["late-list"]);
	assert.equal(f.controller.memory.size, 0);
});

test("settings changes during pagination reject the old candidate", async () =>
{
	const next = deferred();
	const f = fixture({ pages: [[message(1, 10)], []], next: () => next.promise });
	const pending = f.controller.select(1, folder);
	await waitFor(() => f.calls.continued.length > 0);
	f.setSettings({ sel: 0, selForce: false });
	next.resolve({ id: null, messages: [message(2, 90)] });
	await pending;
	assert.equal(f.calls.selected.length, 0);
});

test("all selected-message pages are retained in folder memory", async () =>
{
	const f = fixture();
	f.api.mailTabs.getSelectedMessages = async () =>
	{
		return { id: selectedListId, messages: [{ id: 7 }] };
	};
	f.api.messages.continueList = async () =>
	{
		return { id: null, messages: [{ id: 8 }] };
	};
	await f.controller.select(1, folder);
	assert.deepEqual([...f.controller.memory.get(1).get(folder.id)], [7, 8]);
	assert.equal(f.calls.listed, 0);
});

test("a partial selection event does not store a truncated remembered selection", () =>
{
	const f = fixture();
	f.controller.remember(1, folder.id, [7, 8]);
	f.controller.selectionChanged(1, [{ id: 9 }], folder, true);
	assert.equal(f.controller.memory.get(1).has(folder.id), false);
});

test("selection guard pagination is released after its first page", async () =>
{
	const f = fixture({ settings: { selForce: true } });
	f.api.mailTabs.getSelectedMessages = async () =>
	{
		return { id: selectedListId, messages: [{ id: 7 }] };
	};
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.aborted, [selectedListId, selectedListId]);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
});

test("a pagination failure releases its list before retrying", async () =>
{
	let failures = 1;
	const f = fixture({ pages: [[message(1, 10)], [message(2, 90)]], next: () =>
	{
		if (failures-- > 0) throw new Error("view changed");
		return { id: null, messages: [message(2, 90)] };
	} });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.ok(f.calls.aborted.includes("listed"));
	assert.equal(f.calls.listed, 2);
});

test("root folders do not start a message scan", async () =>
{
	const rootFolder = { id: "account://", isRoot: true };
	const f = fixture();
	f.setFolder(rootFolder);
	await f.controller.select(1, rootFolder);
	assert.equal(f.calls.listed, 0);
});

test("malformed view rows cannot become selected candidates", async () =>
{
	const f = fixture({ pages: [[null, { id: "group", date: new Date(999) }, { id: 7, date: "invalid" }, message(2, 90)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
});

test("cancelAll clears deferred and active work without forgetting selections", async () =>
{
	const f = fixture({ list: () =>
	{
		return { id: null, messages: [] };
	} });
	await f.controller.select(1, folder);
	f.controller.remember(2, folder.id, [7]);
	f.controller.cancelAll();
	assert.equal(f.controller.deferred.size, 0);
	assert.equal(f.controller.requests.size, 0);
	assert.deepEqual([...f.controller.memory.get(2).get(folder.id)], [7]);
});

test("a transient clear during the first unified list retries instead of losing selection", async () =>
{
	const initial = deferred();
	const f = fixture({ list: attempt => (attempt === 1 ? initial.promise : { id: null, messages: [message(2, 90)] }) });
	f.setFolder(unifiedFolder);
	const pending = f.controller.select(1, unifiedFolder);
	await waitFor(() => f.calls.listed === 1);
	f.choose([]);
	initial.resolve({ id: null, messages: [message(1, 10)] });
	await pending;
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.ok(f.calls.listed >= 2);
});

test("an empty event before entering a new unified folder is not remembered as manual deselection", async () =>
{
	const f = fixture();
	f.controller.selectionChanged(1, [], unifiedFolder);
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
});

test("a transient unified clear during pagination restarts a fresh list", async () =>
{
	const next = deferred();
	const f = fixture({ pages: [[message(1, 10)], []], next: () => next.promise });
	f.setFolder(unifiedFolder);
	const pending = f.controller.select(1, unifiedFolder);
	await waitFor(() => f.calls.continued.length > 0);
	f.choose([]);
	next.resolve({ id: null, messages: [message(2, 90)] });
	await pending;
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.ok(f.calls.listed >= 2);
});

test("a same-folder unified view rebuild can populate without a new folder event", async () =>
{
	let rebuilt = false;
	const f = fixture({
		list: () =>
		{
			return { id: null, messages: rebuilt ? [message(2, 90)] : [] };
		},
		delay: ms =>
		{
			if (ms === 250 && f.calls.listed === 2)
			{
				f.choose([]);
				rebuilt = true;
			}
		},
	});
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.equal(f.controller.deferred.size, 0);
});

test("later account results refine only the add-on's initial unified selection", async () =>
{
	const f = fixture({ pages: [[message(1, 10)]], delay: ms =>
	{
		if (ms === 250) f.setPages([[message(1, 10), message(2, 90)]]);
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1], [1, 2]]);
	assert.equal(f.calls.waits.reduce((sum, ms) => sum + ms, 0), 30_100);
});

test("virtual refinement never takes ownership of a preexisting native selection", async () =>
{
	const f = fixture({ selected: [{ id: 7 }] });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.equal(f.calls.listed, 0);
	assert.deepEqual(f.calls.waits, [100]);
});

test("virtual refinement preserves an explicitly remembered message", async () =>
{
	const f = fixture();
	f.setFolder(unifiedFolder);
	f.controller.selectionChanged(1, [{ id: 1 }], unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.deepEqual(f.calls.waits, [100]);
});

test("a different manual selection stops unified refinement", async () =>
{
	const f = fixture({ pages: [[message(1, 10)]], delay: ms =>
	{
		if (ms === 250)
		{
			f.choose([7]);
			f.setPages([[message(2, 90)]]);
		}
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.deepEqual([...f.controller.memory.get(1).get(unifiedFolder.id)], [7]);
});

test("a stable manual clear in a populated unified view stops refinement", async () =>
{
	const f = fixture({ pages: [[message(1, 10)]], delay: ms =>
	{
		if (ms === 250) f.choose([]);
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.deepEqual([...f.controller.memory.get(1).get(unifiedFolder.id)], []);
});

test("an owned unified selection survives an empty rebuild with unchanged folder counts", async () =>
{
	const f = fixture({ count: 10, pages: [[message(1, 10)]], delay: ms =>
	{
		if (ms === 250)
		{
			f.setPages([[]]);
			f.choose([]);
		}
		if (ms === 500) f.setPages([[message(2, 90)]]);
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1], [1, 2]]);
});

test("a unified rebuild invalidates a late page from an owned refinement", async () =>
{
	const stale = deferred();
	let rebuilding = false;
	const f = fixture({
		list: attempt =>
		{
			if (attempt === 1) return { id: null, messages: [message(1, 10)] };
			if (attempt === 2) return { id: "old-view", messages: [message(1, 10)] };
			return { id: null, messages: rebuilding ? [] : [message(3, 100)] };
		},
		next: () => stale.promise,
		delay: ms =>
		{
			if (ms === 500) rebuilding = false;
		},
	});
	f.setFolder(unifiedFolder);
	const pending = f.controller.select(1, unifiedFolder);
	await waitFor(() => f.calls.continued.length > 0);
	rebuilding = true;
	f.choose([]);
	stale.resolve({ id: null, messages: [message(2, 90)] });
	await pending;
	assert.deepEqual(f.calls.selected, [[1, 1], [1, 3]]);
});

for (const change of ["folder", "settings", "tab"])
{
	test(`a ${change} change cancels an owned unified refinement`, async () =>
	{
		const f = fixture({ pages: [[message(1, 10)]], delay: ms =>
		{
			if (ms !== 250) return;
			if (change === "folder") f.setFolder(otherFolder);
			if (change === "settings") f.setSettings({ sel: 0, selForce: false });
			if (change === "tab") f.controller.remove(1);
			f.setPages([[message(2, 90)]]);
		} });
		f.setFolder(unifiedFolder);
		await f.controller.select(1, unifiedFolder);
		assert.deepEqual(f.calls.selected, [[1, 1]]);
	});
}

test("a view empty at the clear event stays a loading clear when rows return before confirmation", async () =>
{
	const f = fixture({ pages: [[message(1, 10)]], delay: ms =>
	{
		if (ms === 250)
		{
			f.setPages([[]]);
			f.choose([]);
		}
		if (ms === 100 && f.calls.selected.length > 0) f.setPages([[message(2, 90)]]);
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1], [1, 2]]);
});

test("display marking the owned first unread read does not advance through unread messages", async () =>
{
	const f = fixture({ settings: { sel: 2 }, pages: [[message(1, 10, false), message(2, 20, false)]], delay: ms =>
	{
		if (ms === 250) f.setPages([[message(1, 10, true), message(2, 20, false)]]);
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
});

test("a newly loaded unread earlier in view order refines the owned unread selection", async () =>
{
	const f = fixture({ settings: { sel: 2 }, pages: [[message(1, 10, false)]], delay: ms =>
	{
		if (ms === 250) f.setPages([[message(2, 20, false), message(1, 10, true)]]);
		if (ms === 500) f.setPages([[message(2, 20, true), message(1, 10, true), message(3, 30, false)]]);
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1], [1, 2]]);
});

test("unchanged folder counts limit large-view rescans but still make safety passes", async () =>
{
	const f = fixture({ count: 100_000 });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.equal(f.calls.listed, 3);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
});

test("changed virtual folder counts trigger refinement before the safety passes", async () =>
{
	let count = 1;
	const f = fixture({ count: () => count, pages: [[message(1, 10)]], delay: ms =>
	{
		if (ms === 250)
		{
			count = 2;
			f.setPages([[message(1, 10), message(2, 90)]]);
		}
	} });
	f.setFolder(unifiedFolder);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 1], [1, 2]]);
	assert.equal(f.calls.listed, 4);
});

for (const browserVersion of ["128.0", "147.0", "148.0", "159.0"])
{
	test(`newest sorted-list capability is gated for Thunderbird ${browserVersion}`, async () =>
	{
		const f = fixture({ browserVersion, pages: [[message(2, 90)], [message(1, 10)]] });
		await f.controller.select(1, folder);
		assert.deepEqual(f.calls.selected, [[1, 2]]);
		if (Number.parseInt(browserVersion, 10) >= 148)
		{
			assert.equal(f.calls.listOptions[0].sortType, "date");
			assert.equal(f.calls.listOptions[0].sortOrder, "descending");
			assert.equal(f.calls.continued.length, 0);
			assert.deepEqual(f.calls.aborted, ["listed"]);
		}
		else
		{
			assert.equal(f.calls.listOptions[0], undefined);
			assert.equal(f.calls.continued.length, 1);
		}
	});
}

test("first unread keeps UI order even when sorted newest listings are supported", async () =>
{
	const f = fixture({ browserVersion: "159.0", settings: { sel: 2 }, pages: [[message(1, 10, false), message(2, 90, false)]] });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 1]]);
	assert.equal(f.calls.listOptions[0], undefined);
});

test("a rejected sorted-list request falls back to comparing all ordinary pages", async () =>
{
	const f = fixture({ browserVersion: "159.0", list: (attempt, options) =>
	{
		if (options) throw new Error("sort unavailable");
		return { id: "fallback-list", messages: [message(1, 10)] };
	}, next: () =>
	{
		return { id: null, messages: [message(2, 90)] };
	} });
	await f.controller.select(1, folder);
	assert.deepEqual(f.calls.selected, [[1, 2]]);
	assert.equal(f.calls.continued.length, 1);
});

const backgroundFixture = (stored, failure) =>
{
	const listeners = new Map();
	const calls = { selected: [], writes: [], resumes: 0, cancellations: 0, selectionEvents: [], aborted: [] };
	const event = name =>
	{
		return { addListener: listener => listeners.set(name, listener) };
	};
	const api = {
		mailTabs: {
			onDisplayedFolderChanged: event("folder"),
			onSelectedMessagesChanged: event("selection"),
			query: async () => [{ id: 1, displayedFolder: folder }],
			get: async () =>
			{
				return { id: 1, displayedFolder: folder };
			},
		},
		messages: { abortList: async id => calls.aborted.push(id) },
		tabs: { onCreated: event("created"), onRemoved: event("removed"), onActivated: event("activated") },
		folders: { onFolderInfoChanged: event("folderInfo") },
		windows: { onFocusChanged: event("focus"), onRemoved: event("windowRemoved"), WINDOW_ID_NONE: -1 },
		storage: {
			onChanged: event("settings"),
			local: {
				get: async () =>
				{
					if (failure === "read") throw new Error("storage unavailable");
					return { settings: stored };
				},
				set: async value =>
				{
					if (failure === "write") throw new Error("read-only storage");
					calls.writes.push(value);
				},
			},
		},
	};
	class BackgroundController
	{
		constructor ()
		{
			this.deferred = new Map();
			this.requests = new Map();
		}
		select (tabId, displayedFolder)
		{
			calls.selected.push([tabId, displayedFolder]);
		}
		resumeDeferred ()
		{
			calls.resumes++;
		}
		cancelAll ()
		{
			calls.cancellations++;
		}
		selectionChanged (...values)
		{
			calls.selectionEvents.push(values);
		}
		remove () {}
	}
	const context = evaluate("background.js", "({ ready, controller, getSettings: () => settings })", {
		messenger: api, AutoSelectController: BackgroundController, ASLMSettings: evaluate("settings.js", "ASLMSettings"),
	});
	return { ...context, calls, listeners, api };
};

test("public background registers lifecycle events and starts restored tabs", async () =>
{
	const f = backgroundFixture({ sel: 2, selForce: true, focus: false });
	assert.deepEqual([...f.listeners.keys()].sort(), ["activated", "created", "focus", "folder", "folderInfo", "removed", "selection", "settings", "windowRemoved"]);
	await f.ready;
	await waitFor(() => f.calls.selected.length > 0);
	assert.equal(f.getSettings().sel, 2);
	assert.equal(f.getSettings().selForce, true);
	assert.equal(f.getSettings().focus, undefined);
	assert.deepEqual(f.calls.selected, [[1, folder]]);
	assert.equal(f.calls.writes.length, 1);
	await f.listeners.get("folder")({ id: 2 }, otherFolder);
	assert.deepEqual(f.calls.selected.at(-1), [2, otherFolder]);
});

for (const failure of ["read", "write", "null"])
{
	test(`public background recovers from ${failure} settings`, async () =>
	{
		const f = backgroundFixture(failure === "null" ? null : { sel: 2, selForce: true }, failure);
		await f.ready;
		assert.equal(f.getSettings().sel, failure === "write" ? 2 : 1);
		assert.equal(f.getSettings().selForce, failure === "write");
	});
}

test("public background retries deferred startup on activation and window events", async () =>
{
	const f = backgroundFixture({ sel: 1 });
	await f.ready;
	f.listeners.get("activated")();
	f.listeners.get("focus")(-1);
	f.listeners.get("focus")(1);
	f.listeners.get("windowRemoved")();
	await waitFor(() => f.calls.resumes === 3);
	f.listeners.get("settings")({ settings: { newValue: { sel: 0 } } }, "local");
	assert.equal(f.getSettings().sel, 0);
	assert.equal(f.calls.cancellations, 1);
});

test("folder count events wake only deferred empty startup views", async () =>
{
	const f = backgroundFixture({ sel: 1 });
	await f.ready;
	f.listeners.get("folderInfo")();
	await Promise.resolve();
	assert.equal(f.calls.resumes, 0);
	f.controller.deferred.set(1, unifiedFolder);
	f.listeners.get("folderInfo")();
	await waitFor(() => f.calls.resumes === 1);
});

test("a standard-tab empty event resolves the new folder before remembering deselection", async () =>
{
	const f = fixture();
	await f.controller.select(1, folder);
	const background = backgroundFixture({ sel: 1 });
	await background.ready;
	background.controller.requests = f.controller.requests;
	background.controller.selectionChanged = (...values) => f.controller.selectionChanged(...values);
	background.api.mailTabs.get = f.api.mailTabs.get;
	f.setFolder(unifiedFolder);
	f.setSelected([]);
	await background.listeners.get("selection")({ id: 1 }, { messages: [] });
	assert.deepEqual([...f.controller.memory.get(1).get(folder.id)], [2]);
	assert.equal(f.controller.memory.get(1).has(unifiedFolder.id), false);
	await f.controller.select(1, unifiedFolder);
	assert.deepEqual(f.calls.selected, [[1, 2], [1, 2]]);
});

test("a missing tab during selection lookup is ignored and its list is released", async () =>
{
	const f = backgroundFixture({ sel: 1 });
	await f.ready;
	f.api.mailTabs.get = async () =>
	{
		throw new Error("tab closed");
	};
	await f.listeners.get("selection")({ id: 7 }, { id: selectedListId, messages: [] });
	assert.equal(f.calls.selectionEvents.length, 0);
	assert.deepEqual(f.calls.aborted, [selectedListId]);
});

test("a pending request receives manual selection events before an asynchronous lookup", async () =>
{
	const f = backgroundFixture({ sel: 1 });
	await f.ready;
	f.controller.requests.set(1, {});
	let lookups = 0;
	f.api.mailTabs.get = async () =>
	{
		lookups++;
		return { id: 1, displayedFolder: folder };
	};
	const pending = f.listeners.get("selection")({ id: 1 }, { messages: [{ id: 7 }] });
	assert.equal(f.calls.selectionEvents.length, 1);
	assert.equal(lookups, 0);
	await pending;
});
