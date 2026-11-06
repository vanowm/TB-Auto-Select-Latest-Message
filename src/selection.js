"use strict";
/* exported AutoSelectController */

class AutoSelectController
{
	constructor (api, getSettings, delay = ms => new Promise(resolve => setTimeout(resolve, ms)))
	{
		this.api = api;
		this.getSettings = getSettings;
		this.delay = delay;
		this.requests = new Map();
		this.deferred = new Map();
		this.refinements = new Map();
		this.selectionVersions = new Map();
	}

	cancel (tabId)
	{
		this.requests.delete(tabId);
		this.deferred.delete(tabId);
		this.refinements.delete(tabId);
		this.api.AutoSelect.cancelScan(tabId).catch(() => {});
	}

	userInteraction (tabId)
	{
		this.cancel(tabId);
		this.selectionVersions.set(tabId, (this.selectionVersions.get(tabId) || 0) + 1);
	}

	remove (tabId)
	{
		this.cancel(tabId);
		this.selectionVersions.delete(tabId);
	}

	selectionChanged (tabId, hasSelection = true, messageId)
	{
		this.selectionVersions.set(tabId, (this.selectionVersions.get(tabId) || 0) + 1);
		if (hasSelection) this.deferred.delete(tabId);
		const refinement = this.refinements.get(tabId);
		if (refinement && hasSelection && refinement.messageId !== messageId) this.refinements.delete(tabId);
	}

	async resumeDeferred ()
	{
		await Promise.all([...this.deferred].map(([tabId, folder]) => this.select(tabId, folder)));
	}

	async viewLoaded (tabId)
	{
		if (this.deferred.has(tabId)) return this.select(tabId, this.deferred.get(tabId));
		const refinement = this.refinements.get(tabId);
		if (refinement) return this.select(tabId, refinement.folder, refinement.messageId);
	}

	folderKey (folder)
	{
		return folder && (folder.id || JSON.stringify([folder.accountId, folder.path]));
	}

	async select (tabId, folder, previousMessageId)
	{
		this.deferred.delete(tabId);
		this.refinements.delete(tabId);
		const request = {};
		this.requests.set(tabId, request);
		const current = () => this.requests.get(tabId) === request;
		try
		{
			await this.api.AutoSelect.cancelScan(tabId).catch(() => {});
			if (!current()) return;
      // Folder events precede message loading and restored selections. Wait for
      // the view, rather than assuming that a single short timeout is enough.
			await this.delay(100);
			for (let attempt = 0; attempt < 120 && current(); attempt++)
			{
				const tab = await this.api.mailTabs.get(tabId);
				if (!current()) return;
				if (folder && this.folderKey(folder) !== this.folderKey(tab.displayedFolder)) return;
				folder = tab.displayedFolder;
				if (!folder || folder.isRoot) return;
				const state = await this.api.AutoSelect.getViewState(tabId);
				if (!current() || state.inputFocused) return;
				if (state.ready) break;
				if (attempt === 119)
				{
          // A startup password dialog can outlast this polling window. Keep
          // the request dormant until a dialog closes instead of losing it.
					this.deferred.set(tabId, folder);
					return;
				}
				await this.delay(250);
			}
			if (!current()) return;
			const settings = this.getSettings();
			if (!settings.sel) return;
			const selectionVersion = this.selectionVersions.get(tabId);
			const selected = await this.api.mailTabs.getSelectedMessages(tabId);
			if (!current()) return;
			if (selected.id) await this.api.messages.abortList(selected.id);
			if (previousMessageId !== undefined &&
          selected.messages.length > 0 &&
          (selected.messages.length !== 1 || selected.messages[0].id !== previousMessageId)) return;
			if (previousMessageId === undefined && selected.messages.length > 0 && !settings.selForce)
			{
				if (settings.focus && current()) await this.api.AutoSelect.focusMessageList(tabId);
				return;
			}

			let candidate;
			let restored = false;
			if (!settings.selForce && previousMessageId === undefined)
			{
				candidate = await this.api.AutoSelect.getRememberedMessage(tabId);
				if (!current() || candidate?.deselected) return;
				if (candidate?.pending)
				{
					this.deferred.set(tabId, folder);
					return;
				}
				restored = Boolean(candidate);
			}
			candidate ||= await this.api.AutoSelect.findMessage(tabId, settings.sel);
			if (!candidate || !current()) return;

      // Never act on a candidate after a folder change, a manual selection,
      // or a setting change while the view was being read.
			const tab = await this.api.mailTabs.get(tabId);
			const state = await this.api.AutoSelect.getViewState(tabId);
			if (!current() || this.selectionVersions.get(tabId) !== selectionVersion ||
          this.folderKey(tab.displayedFolder) !== this.folderKey(folder) ||
          !state.ready || state.inputFocused || this.getSettings() !== settings) return;
			if (state.complete === false && !restored)
			{
				this.refinements.set(tabId, { folder, messageId: candidate.id });
			}
			if (!await this.api.AutoSelect.selectMessage(tabId, candidate))
			{
				if (current()) this.refinements.delete(tabId);
				return;
			}
			if (settings.focus && current()) await this.api.AutoSelect.focusMessageList(tabId);
      // Completion may race the selection API call. Don't miss the one final
      // refinement when its event arrived just before this request finished.
			if (current() && this.refinements.has(tabId))
			{
				const afterSelection = await this.api.AutoSelect.getViewState(tabId);
				if (afterSelection.complete) await this.viewLoaded(tabId);
			}
		}
		catch (error)
		{
      // Closing a tab cancels its request before an outstanding API call fails.
			if (current()) console.error("Auto Select Latest Message:", error);
		}
		finally
		{
			if (current()) this.requests.delete(tabId);
		}
	}
}
