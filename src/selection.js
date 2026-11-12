"use strict";
/* exported AutoSelectController */

// Folder-change events can precede the message view and restored selection.
const INITIAL_DELAY_MS = 100;
const RETRY_DELAY_MS = 250;
const READY_ATTEMPTS = 120;

class AutoSelectController
{
	constructor (api, getSettings, delay = ms => new Promise(resolve => setTimeout(resolve, ms)))
	{
		this.api = api;
		this.getSettings = getSettings;
		this.delay = delay;
		this.requests = new Map();
		this.deferred = new Map();
		this.selectionVersions = new Map();
		this.folders = new Map();
		this.memory = new Map();
		this.applying = new Map();
	}

	folderKey (folder)
	{
		return folder && (folder.id || JSON.stringify([folder.accountId, folder.path]));
	}

	async abortList (listId)
	{
		if (listId) await this.api.messages.abortList(listId).catch(() => {});
	}

	cancel (tabId)
	{
		const request = this.requests.get(tabId);
		this.requests.delete(tabId);
		this.deferred.delete(tabId);
		if (request?.listId) this.abortList(request.listId).catch(() => {});
	}

	cancelAll ()
	{
		for (const tabId of new Set([...this.requests.keys(), ...this.deferred.keys()])) this.cancel(tabId);
	}

	remove (tabId)
	{
		this.cancel(tabId);
		this.folders.delete(tabId);
		this.memory.delete(tabId);
		this.selectionVersions.delete(tabId);
		this.applying.delete(tabId);
	}

	remember (tabId, folderKey, messageIds)
	{
		if (!folderKey) return;
		if (!this.memory.has(tabId)) this.memory.set(tabId, new Map());
		this.memory.get(tabId).set(folderKey, messageIds);
	}

	selectionChanged (tabId, messages, folder, partial = false)
	{
		const ids = messages.map(message => message.id);
		const key = this.folderKey(folder) || this.folders.get(tabId);
		const expected = this.applying.get(tabId);
		if (expected && expected.length === ids.length && expected.every((id, index) => id === ids[index])) return;
		this.selectionVersions.set(tabId, (this.selectionVersions.get(tabId) || 0) + 1);
		// Thunderbird clears its old selection while switching folders. Only
		// remember a cleared selection after the pending folder request ends.
		if (partial) this.memory.get(tabId)?.delete(key);
		else if (ids.length > 0 || !this.requests.has(tabId)) this.remember(tabId, key, ids);
		// The initial settling window also includes Thunderbird restoring its
		// previous selection. Force must still be allowed to replace that one.
		if (ids.length > 0 && !this.requests.get(tabId)?.settling) this.cancel(tabId);
	}

	async resumeDeferred ()
	{
		await Promise.all([...this.deferred].map(([tabId, folder]) => this.select(tabId, folder)));
	}

	async selectedMessages (tabId, current, complete = false)
	{
		let page = await this.api.mailTabs.getSelectedMessages(tabId);
		const messages = [...page.messages];
		try
		{
			while (complete && page.id && current())
			{
				page = await this.api.messages.continueList(page.id);
				messages.push(...page.messages);
			}
			return messages;
		}
		finally
		{
			await this.abortList(page.id);
		}
	}

	async scan (tabId, tab, request, settings, remembered, current)
	{
		let newest;
		let firstUnread;
		const restored = [];
		const wanted = new Set(remembered);
		// A descending, unthreaded date view starts with the newest message.
		// Other views require comparing dates across their paginated headers.
		const newestFirst = tab.sortType === "date" && tab.sortOrder === "descending" && tab.viewType === "ungrouped";
		let page = await this.api.mailTabs.getListedMessages(tabId);
		try
		{
			while (page)
			{
				request.listId = page.id;
				if (!current()) return;
				for (const message of page.messages)
				{
					if (!Number.isInteger(message?.id)) continue;
					if (wanted.has(message.id)) restored.push(message.id);
					if (!firstUnread && message.read === false) firstUnread = message;
					const date = new Date(message.date).getTime();
					if (Number.isFinite(date) && (!newest || date > new Date(newest.date).getTime())) newest = message;
				}
				if (wanted.size > 0 && restored.length === wanted.size) return { ids: restored };
				const candidate = settings.sel === 2 ? firstUnread : newest;
				if (wanted.size === 0 && candidate && (settings.sel === 2 || newestFirst)) return { ids: [candidate.id] };
				if (!page.id) break;
				page = await this.api.messages.continueList(page.id);
			}
			if (restored.length > 0) return { ids: restored };
			const candidate = settings.sel === 2 ? firstUnread || newest : newest;
			return candidate && { ids: [candidate.id] };
		}
		finally
		{
			await this.abortList(request.listId || page?.id);
			request.listId = undefined;
		}
	}

	async attempt (tabId, folder, request, settings, current)
	{
		const tab = await this.api.mailTabs.get(tabId);
		if (!current()) return "cancelled";
		const key = this.folderKey(tab.displayedFolder);
		if (folder && this.folderKey(folder) !== key) return "cancelled";
		if (!key || tab.displayedFolder.isRoot) return "cancelled";
		this.folders.set(tabId, key);
		request.folder = tab.displayedFolder;
		const version = this.selectionVersions.get(tabId);
		const selected = await this.selectedMessages(tabId, current, !settings.selForce);
		if (!current() || version !== this.selectionVersions.get(tabId)) return "cancelled";
		if (selected.length > 0 && !settings.selForce)
		{
			this.remember(tabId, key, selected.map(message => message.id));
			return "done";
		}
		const remembered = settings.selForce ? undefined : this.memory.get(tabId)?.get(key);
		if (remembered?.length === 0) return "done";
		const candidate = await this.scan(tabId, tab, request, settings, remembered, current);
		if (!current() || version !== this.selectionVersions.get(tabId)) return "cancelled";
		if (!candidate) return "retry";
		const latestTab = await this.api.mailTabs.get(tabId);
		const latestSelected = await this.selectedMessages(tabId, current);
		if (!current() || version !== this.selectionVersions.get(tabId) || this.getSettings() !== settings ||
			this.folderKey(latestTab.displayedFolder) !== key) return "cancelled";
		if (!settings.selForce && latestSelected.length > 0) return "done";
		this.applying.set(tabId, candidate.ids);
		try
		{
			await this.api.mailTabs.setSelectedMessages(tabId, candidate.ids);
			if (current()) this.remember(tabId, key, candidate.ids);
		}
		finally
		{
			this.applying.delete(tabId);
		}
		return "done";
	}

	async select (tabId, folder)
	{
		this.cancel(tabId);
		if (folder) this.folders.set(tabId, this.folderKey(folder));
		const request = { folder, settling: true };
		this.requests.set(tabId, request);
		const current = () => this.requests.get(tabId) === request;
		try
		{
			await this.delay(INITIAL_DELAY_MS);
			request.settling = false;
			const settings = this.getSettings();
			if (!settings.sel || !current()) return;
			for (let attempt = 0; attempt < READY_ATTEMPTS && current(); attempt++)
			{
				try
				{
					const result = await this.attempt(tabId, folder, request, settings, current);
					if (result !== "retry") return;
				}
				catch (error)
				{
					if (!current()) return;
					if (attempt === READY_ATTEMPTS - 1) console.error("Auto Select Latest Message:", error);
				}
				if (attempt < READY_ATTEMPTS - 1 && current()) await this.delay(RETRY_DELAY_MS);
			}
			// Public APIs expose no view-loaded event. Window/focus events can
			// retry an empty or unavailable view after a startup prompt closes.
			if (current()) this.deferred.set(tabId, request.folder);
		}
		finally
		{
			await this.abortList(request.listId);
			if (current()) this.requests.delete(tabId);
		}
	}
}
