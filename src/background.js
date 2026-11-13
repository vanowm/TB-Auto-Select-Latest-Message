"use strict";

let settings = ASLMSettings.defaults;
const controller = new AutoSelectController(messenger, () => settings);

// Register before the asynchronous startup work so restored tabs are covered.
const ready = initializeSettings();
const select = async (tabId, folder) =>
{
	await ready;
	return controller.select(tabId, folder);
};
const resumeDeferred = async () =>
{
	await ready;
	return controller.resumeDeferred();
};
const report = error => console.error("Auto Select Latest Message:", error);

messenger.mailTabs.onDisplayedFolderChanged.addListener((tab, folder) => select(tab.id, folder));
messenger.mailTabs.onSelectedMessagesChanged.addListener(async (tab, selected) =>
{
	try
	{
		let folder = tab.displayedFolder;
		if (!folder && !controller.requests.has(tab.id))
		{
			try
			{
				const currentTab = await messenger.mailTabs.get(tab.id);
				folder = currentTab.displayedFolder;
			}
			catch
			{
				// The tab can close before its final selection event is delivered.
				return;
			}
		}
		// Pending selections must receive manual input immediately, before any
		// asynchronous tab lookup could let the current scan finish.
		controller.selectionChanged(tab.id, selected.messages, folder, Boolean(selected.id));
	}
	finally
	{
		if (selected.id) await messenger.messages.abortList(selected.id).catch(report);
	}
});
messenger.tabs.onCreated.addListener(tab =>
{
	if (tab.type === "mail" || tab.mailTab) select(tab.id).catch(report);
});
messenger.tabs.onRemoved.addListener(tabId => controller.remove(tabId));
messenger.tabs.onActivated.addListener(() => resumeDeferred().catch(report));
messenger.windows.onFocusChanged.addListener(windowId =>
{
	if (windowId !== messenger.windows.WINDOW_ID_NONE) resumeDeferred().catch(report);
});
messenger.windows.onRemoved.addListener(() => resumeDeferred().catch(report));
messenger.folders?.onFolderInfoChanged?.addListener(() =>
{
	if (controller.deferred.size > 0) resumeDeferred().catch(report);
});
messenger.storage.onChanged.addListener((changes, area) =>
{
	if (area === "local" && changes.settings)
	{
		settings = ASLMSettings.normalize(changes.settings.newValue);
		controller.cancelAll();
	}
});

// eslint-disable-next-line prefer-arrow-functions/prefer-arrow-functions -- Startup calls this before registering listeners.
async function initializeSettings ()
{
	try
	{
		const stored = await messenger.storage.local.get("settings");
		settings = ASLMSettings.normalize(stored.settings);
	}
	catch (error)
	{
		settings = ASLMSettings.normalize();
		console.error("Auto Select Latest Message settings recovery:", error);
	}
	await messenger.storage.local.set({ settings }).catch(error =>
		console.error("Auto Select Latest Message settings repair:", error));
}

const initializeTabs = async () =>
{
	await ready;
	const tabs = await messenger.mailTabs.query({});
	await Promise.all(tabs.map(tab => select(tab.id, tab.displayedFolder)));
};

initializeTabs().catch(report);
