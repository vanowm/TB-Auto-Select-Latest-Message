"use strict";

const form = document.getElementById("settings");
const statusMessage = document.getElementById("status");
const selection = document.getElementById("sel");
const force = document.getElementById("selForce");
const focusCheckbox = document.getElementById("focus");
const selectionOptions = document.getElementById("selection-options");
const save = form.querySelector("button");
save.disabled = true;

selection.addEventListener("change", () =>
{
	selectionOptions.disabled = selection.value === "0";
});
form.addEventListener("submit", async event =>
{
	event.preventDefault();
	save.disabled = true;
	try
	{
		await messenger.storage.local.set({ settings: {
			sel: Number(selection.value), selForce: force.checked, focus: focusCheckbox.checked,
		} });
		statusMessage.textContent = "Settings saved.";
	}
	catch (error)
	{
		statusMessage.textContent = `Could not save settings: ${error.message}`;
	}
	finally
	{
		save.disabled = false;
	}
});

const load = async () =>
{
	try
	{
		const stored = await messenger.storage.local.get("settings");
		render(ASLMSettings.normalize(stored.settings === undefined
			? await messenger.AutoSelect.getLegacyPreferences() : stored.settings));
	}
	catch
	{
		render(ASLMSettings.normalize());
		statusMessage.textContent = "Stored settings could not be loaded. Defaults are shown.";
	}
	save.disabled = false;
};

const render = settings =>
{
	selection.value = String(settings.sel);
	force.checked = settings.selForce;
	focusCheckbox.checked = settings.focus;
	selectionOptions.disabled = selection.value === "0";
};

messenger.storage.onChanged.addListener((changes, area) =>
{
	if (area === "local" && changes.settings) render(ASLMSettings.normalize(changes.settings.newValue));
});
load().catch(error =>
{
	statusMessage.textContent = `Could not load settings: ${error.message}`;
});
