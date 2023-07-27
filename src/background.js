async function init() {
    const PREF_BRANCH = "extensions.autoselectlatestmessage.";
    const PREF_DEFAULT = {
        sel: 1,
        selForce: false,
        focus: true //?
    };

    let prefs = {}
    for (let [name, value] of Object.entries(PREF_DEFAULT)) {
        await messenger.LegacyPrefs.setDefaultPref(`${PREF_BRANCH}${name}`, value);
        prefs[name] = await messenger.LegacyPrefs.getPref(`${PREF_BRANCH}${name}`);
    }

    // Update prefs chache, if they are changed somewhere.
    messenger.LegacyPrefs.onChanged.addListener(async (name, value) => {
        // The value is null if it is the default, so we always pull the new value.
        prefs[name] = await messenger.LegacyPrefs.getPref(`${PREF_BRANCH}${name}`);
    }, PREF_BRANCH);


    // Generator function to walk through message lists more easily.
    async function* listMessages(folder) {
        let page = await messenger.messages.list(folder);
        for (let message of page.messages) {
            yield message;
        }

        while (page.id) {
            page = await messenger.messages.continueList(page.id);
            for (let message of page.messages) {
                yield message;
            }
        }
    }

    async function searchMessage(folder, options) {
        // Neither both not none may be selected.
        if (
            (!options.newest && !options.unread) ||
            (options.newest && options.unread)
        ) {
            return null;
        }

        let messages = listMessages(folder);
        let newestMsg;
        for await (let message of messages) {
            if (options.unread && message.read == false) {
                return message;
            }
            newestMsg = message;
        }
        return newestMsg;
    }

    messenger.mailTabs.onDisplayedFolderChanged.addListener(async (tab, displayedFolder) => {
        let selectedMsg = await messenger.messageDisplay.getDisplayedMessage(tab.id);
        if (selectedMsg && !prefs.selForce) {
            return;
        }

        let options = { newest: prefs.sel == 1, unread: prefs.sel == 2 }
        let desiredMsg = await searchMessage(displayedFolder, options);
        if (!desiredMsg) {
            return;
        }
        console.log("Updating display message", desiredMsg.id);
        await messenger.mailTabs.setSelectedMessages(tab.id, [desiredMsg.id]);
        // Bug in TB, wil be fixed soon.
        await messenger.ScrollToView.scroll(tab.id);
    })
}

init();
