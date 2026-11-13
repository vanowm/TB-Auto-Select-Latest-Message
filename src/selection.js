"use strict";
/* exported AutoSelectController */

// Folder-change events can precede the message view and restored selection.
const INITIAL_DELAY_MS = 100;
const RETRY_DELAY_MS = 250;
const READY_ATTEMPTS = 120;
// Virtual folders gather results from accounts independently. Recheck our own
// selection on a bounded 30-second schedule without delaying the first result.
const REFINEMENT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 14_250];

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
		this.sortedListing = this.supportsSortedListing();
	}

	folderKey (folder)
	{
		return folder && (folder.id || JSON.stringify([folder.accountId, folder.path]));
	}

	async supportsSortedListing ()
	{
		try
		{
			const info = await this.api.runtime?.getBrowserInfo();
			return Number.parseInt(info?.version, 10) >= 148;
		}
		catch
		{
			return false;
		}
	}

	isVirtual (folder)
	{
		return Boolean(folder?.isVirtual || folder?.isUnified || folder?.isTag);
	}

	sameIds (left, right)
	{
		return Boolean(left && right && left.length === right.length && left.every((id, index) => id === right[index]));
	}

	async folderCount (folder)
	{
		try
		{
			const info = await this.api.folders?.getFolderInfo(folder);
			return Number.isFinite(info?.totalMessageCount) ? info.totalMessageCount : undefined;
		}
		catch
		{}
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
		const request = this.requests.get(tabId);
		if (this.sameIds(expected, ids) || this.sameIds(request?.ownedIds, ids)) return;
		// A new folder can clear selection before its folder-change event.
		// Such a clear must not become an explicitly remembered empty folder.
		if (ids.length === 0 && !request && (!this.folders.has(tabId) || key !== this.folders.get(tabId))) return;
		if (ids.length === 0 && request && this.isVirtual(request.folder))
		{
			request.viewCleared = true;
			request.viewVersion = (request.viewVersion || 0) + 1;
			if (request.ownedIds)
			{
				const token = {};
				request.emptyToken = token;
				request.emptyCheck = this.confirmEmpty(tabId, request, key, token);
			}
			return;
		}
		this.selectionVersions.set(tabId, (this.selectionVersions.get(tabId) || 0) + 1);
		// Thunderbird clears its old selection while switching folders. Only
		// remember a cleared selection after the pending folder request ends.
		if (partial) this.memory.get(tabId)?.delete(key);
		else if (ids.length > 0 || !this.requests.has(tabId)) this.remember(tabId, key, ids);
		// The initial settling window also includes Thunderbird restoring its
		// previous selection. Force must still be allowed to replace that one.
		if (ids.length > 0 && !this.requests.get(tabId)?.settling) this.cancel(tabId);
	}

	async confirmEmpty (tabId, request, key, token)
	{
		const current = () => this.requests.get(tabId) === request && request.emptyToken === token;
		try
		{
			const initialPage = await this.api.mailTabs.getListedMessages(tabId);
			await this.abortList(initialPage.id);
			const viewWasEmpty = initialPage.messages.length === 0;
			await this.delay(INITIAL_DELAY_MS);
			if (!current()) return;
			const tab = await this.api.mailTabs.get(tabId);
			const selected = await this.selectedMessages(tabId, current);
			if (!current() || this.folderKey(tab.displayedFolder) !== key || selected.length > 0 || viewWasEmpty) return;
			const page = await this.api.mailTabs.getListedMessages(tabId);
			await this.abortList(page.id);
			// An empty/unavailable view is still loading. A stable, populated
			// view with no selection is an intentional clear and takes priority.
			if (current() && page.messages.length > 0)
			{
				this.remember(tabId, key, []);
				this.cancel(tabId);
			}
		}
		catch
		{
			// A virtual view can disappear briefly while its search is rebuilt.
		}
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
		let sorted = settings.sel === 1 && await this.sortedListing;
		let page;
		if (sorted)
		{
			try
			{
				page = await this.api.mailTabs.getListedMessages(tabId, { sortType: "date", sortOrder: "descending" });
			}
			catch
			{
				// Unsupported or temporarily unavailable sorting must not stop
				// ordinary listed-message selection from working.
				sorted = false;
				this.sortedListing = Promise.resolve(false);
				page = await this.api.mailTabs.getListedMessages(tabId);
			}
		}
		else page = await this.api.mailTabs.getListedMessages(tabId);
		const newestFirst = sorted || (tab.sortType === "date" && tab.sortOrder === "descending" && tab.viewType === "ungrouped");
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
					// Displaying our first unread message can mark it read. Keep it
					// eligible during refinement so we do not walk through the inbox.
					if (!firstUnread && (message.read === false || (request.ownedUnread && request.ownedIds?.includes(message.id)))) firstUnread = message;
					const date = new Date(message.date).getTime();
					if (Number.isFinite(date) && (!newest || date > new Date(newest.date).getTime())) newest = message;
				}
				if (wanted.size > 0 && restored.length === wanted.size) return { ids: restored, restored: true };
				const candidate = settings.sel === 2 ? firstUnread : newest;
				if (wanted.size === 0 && candidate && (settings.sel === 2 || newestFirst)) return { ids: [candidate.id], unread: Boolean(firstUnread) };
				if (!page.id) break;
				page = await this.api.messages.continueList(page.id);
			}
			if (restored.length > 0) return { ids: restored, restored: true };
			const candidate = settings.sel === 2 ? firstUnread || newest : newest;
			return candidate && { ids: [candidate.id], unread: Boolean(firstUnread) };
		}
		finally
		{
			await this.abortList(request.listId || page?.id);
			request.listId = undefined;
		}
	}

	async attempt (tabId, folder, request, settings, current)
	{
		if (request.emptyCheck) await request.emptyCheck;
		const tab = await this.api.mailTabs.get(tabId);
		if (!current()) return "cancelled";
		const key = this.folderKey(tab.displayedFolder);
		if (folder && this.folderKey(folder) !== key) return "cancelled";
		if (!key || tab.displayedFolder.isRoot) return "cancelled";
		this.folders.set(tabId, key);
		request.folder = tab.displayedFolder;
		const version = this.selectionVersions.get(tabId);
		const viewVersion = request.viewVersion;
		const selected = await this.selectedMessages(tabId, current, !settings.selForce);
		if (!current() || version !== this.selectionVersions.get(tabId)) return "cancelled";
		const owned = this.sameIds(request.ownedIds, selected.map(message => message.id));
		if (request.ownedIds && selected.length > 0 && !owned) return "cancelled";
		if (selected.length > 0 && !settings.selForce && !owned)
		{
			this.remember(tabId, key, selected.map(message => message.id));
			return "done";
		}
		const remembered = settings.selForce || request.ownedIds ? undefined : this.memory.get(tabId)?.get(key);
		if (remembered?.length === 0) return "done";
		if (this.isVirtual(tab.displayedFolder) && request.folderCount === undefined) request.folderCount = await this.folderCount(tab.displayedFolder);
		const candidate = await this.scan(tabId, tab, request, settings, remembered, current);
		if (request.emptyCheck) await request.emptyCheck;
		if (!current() || version !== this.selectionVersions.get(tabId)) return "cancelled";
		if (viewVersion !== request.viewVersion) return "retry";
		if (!candidate) return "retry";
		const latestTab = await this.api.mailTabs.get(tabId);
		const latestSelected = await this.selectedMessages(tabId, current);
		if (!current() || version !== this.selectionVersions.get(tabId) || this.getSettings() !== settings ||
			this.folderKey(latestTab.displayedFolder) !== key) return "cancelled";
		if (viewVersion !== request.viewVersion) return "retry";
		const stillOwned = this.sameIds(request.ownedIds, latestSelected.map(message => message.id));
		if (request.ownedIds && latestSelected.length > 0 && !stillOwned) return "cancelled";
		if (!settings.selForce && latestSelected.length > 0 && !stillOwned) return "done";
		if (this.sameIds(request.ownedIds, candidate.ids) && stillOwned)
		{
			request.viewCleared = false;
			return "refine";
		}
		this.applying.set(tabId, candidate.ids);
		try
		{
			await this.api.mailTabs.setSelectedMessages(tabId, candidate.ids);
			if (current())
			{
				request.viewCleared = false;
				this.remember(tabId, key, candidate.ids);
				if (!candidate.restored && this.isVirtual(tab.displayedFolder))
				{
					request.ownedIds = candidate.ids;
					request.ownedUnread = settings.sel === 2 && candidate.unread;
				}
			}
		}
		finally
		{
			this.applying.delete(tabId);
		}
		return request.ownedIds ? "refine" : "done";
	}

	async refine (tabId, request, settings, current)
	{
		for (let index = 0; index < REFINEMENT_DELAYS_MS.length && current(); index++)
		{
			await this.delay(REFINEMENT_DELAYS_MS[index]);
			if (!current() || this.getSettings() !== settings) return;
			const count = await this.folderCount(request.folder);
			// Counts are refreshed when virtual searches finish, but unchanged
			// totals do not prove unchanged contents. Always make two safety
			// passes; other checks avoid repeated full scans of large views.
			const safetyPass = index === 3 || index === REFINEMENT_DELAYS_MS.length - 1;
			if (count !== undefined && count === request.folderCount && !safetyPass && !request.viewCleared) continue;
			request.folderCount = count;
			try
			{
				const result = await this.attempt(tabId, request.folder, request, settings, current);
				if (result !== "refine" && result !== "retry") return;
			}
			catch (error)
			{
				if (current() && index === REFINEMENT_DELAYS_MS.length - 1) console.error("Auto Select Latest Message:", error);
			}
		}
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
					if (result === "refine")
					{
						await this.refine(tabId, request, settings, current);
						return;
					}
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
