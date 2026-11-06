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

messenger.mailTabs.onDisplayedFolderChanged.addListener((tab, folder) => select(tab.id, folder));
messenger.mailTabs.onSelectedMessagesChanged.addListener((tab, selected) =>
	controller.selectionChanged(tab.id, selected.messages.length > 0,
		selected.messages.length === 1 ? selected.messages[0].id : undefined));
messenger.tabs.onCreated.addListener(tab =>
{
	if (tab.type === "mail" || tab.mailTab) select(tab.id);
});
messenger.tabs.onRemoved.addListener(tabId => controller.remove(tabId));
messenger.AutoSelect.onWindowClosed.addListener(() => controller.resumeDeferred());
messenger.AutoSelect.onViewLoaded.addListener(tabId => controller.viewLoaded(tabId));
messenger.AutoSelect.onUserInteraction.addListener(tabId => controller.userInteraction(tabId));
messenger.AutoSelect.onSettingsChanged.addListener(async values =>
{
	try
	{
		await messenger.storage.local.set({ settings: ASLMSettings.normalize(values) });
	}
	catch (error)
	{
		console.error("Auto Select Latest Message settings:", error);
		await messenger.AutoSelect.setSettings(settings);
	}
});
messenger.storage.onChanged.addListener((changes, area) =>
{
	if (area === "local" && changes.settings)
	{
		settings = ASLMSettings.normalize(changes.settings.newValue);
		for (const tabId of controller.requests.keys()) controller.cancel(tabId);
		for (const tabId of controller.deferred.keys()) controller.cancel(tabId);
		for (const tabId of controller.refinements.keys()) controller.cancel(tabId);
		messenger.AutoSelect.setSettings(settings).catch(error => console.error("Auto Select Latest Message preferences:", error));
	}
});

// eslint-disable-next-line prefer-arrow-functions/prefer-arrow-functions -- Startup calls this before registering listeners.
async function initializeSettings ()
{
	try
	{
		const stored = await messenger.storage.local.get("settings");
		settings = ASLMSettings.normalize(stored.settings === undefined
			? await messenger.AutoSelect.getLegacyPreferences() : stored.settings);
	}
	catch (error)
	{
		settings = ASLMSettings.normalize();
		console.error("Auto Select Latest Message settings recovery:", error);
	}
	await messenger.storage.local.set({ settings }).catch(error =>
		console.error("Auto Select Latest Message settings repair:", error));
	await messenger.AutoSelect.setSettings(settings).catch(error => console.error("Auto Select Latest Message preferences:", error));
}

const initializeTabs = async () =>
{
	await ready;
	const tabs = await messenger.mailTabs.query({});
	await Promise.all(tabs.map(tab => select(tab.id, tab.displayedFolder)));
};

initializeTabs().catch(error => console.error("Auto Select Latest Message startup:", error));
