"use strict";
/* exported AutoSelect */

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");

const candidate = (record, id) =>
{
	return {
		id, viewToken: record.viewToken, interactionVersion: record.interactionVersion,
		generation: record.generation,
	};
};

var AutoSelect = class extends ExtensionCommon.ExtensionAPI
{
	onShutdown (isAppShutdown)
	{
		for (const close of this.cleanups || []) close();
		if (!isAppShutdown) Services.obs.notifyObservers(null, "startupcache-invalidate");
	}

	getAPI (context)
	{
		let viewLoadedFire;
		let interactionFire;
		let settingsFire;
		let preferences;
		let nextViewToken = 0;
		const panes = new Map();
		this.cleanups ||= new Set();

		const inputFocused = pane =>
		{
			let document = pane?.top.document;
			const seen = new Set();
			while (document && !seen.has(document))
			{
				seen.add(document);
				let element = document.activeElement;
				while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
				if (!element) return false;
				if (element.isContentEditable ||
            ["input", "textarea", "textbox", "search-textbox"].includes(element.localName)) return true;
				document = element.contentDocument;
			}
			return false;
		};

		const remember = record =>
		{
			const { pane, memory, pendingUserSelection } = record;
			const folder = pane.gFolder?.URI;
			let header;
			try
			{
				if (pane.gDBView?.numSelected) header = pane.gDBView.hdrForFirstSelectedMessage;
			}
			catch
			{
				return;
			} // A selection range can disappear during view replacement.
			if (!folder || pane.gViewWrapper?.displayedFolder &&
          pane.gViewWrapper.displayedFolder !== pane.gFolder) return;
			if (header)
			{
				memory.delete(folder);
				memory.set(folder, { id: context.extension.messageManager.convert(header).id });
			}
			else if (pendingUserSelection)
			{
				memory.set(folder, { deselected: true });
			}
			record.pendingUserSelection = false;
			while (memory.size > 200) memory.delete(memory.keys().next().value);
		};

		const refresh = record =>
		{
			if (record.view !== record.pane.gDBView || record.folder !== record.pane.gFolder?.URI)
			{
				record.view = record.pane.gDBView;
				record.folder = record.pane.gFolder?.URI;
				record.viewToken = ++nextViewToken;
				record.generation++;
			}
			return record;
		};

		const getRecord = tabId =>
		{
			const tab = context.extension.tabManager.get(tabId);
			const pane = tab.nativeTab.chromeBrowser?.contentWindow;
			if (!pane) return { tab };
			let record = panes.get(pane);
			if (!record)
			{
				record = { pane, tabId, generation: 0, interactionVersion: 0, memory: new Map(), listeners: [] };
				const listen = (node, type, listener, capture = false) =>
				{
					if (!node) return;
					node.addEventListener(type, listener, capture);
					record.listeners.push(() => node.removeEventListener(type, listener, capture));
				};
				const interaction = event =>
				{
					if (!event.isTrusted) return;
					record.interactionVersion++;
					record.generation++;
					record.pendingUserSelection = true;
					interactionFire?.async(tabId);
				};
				const tree = pane.document.getElementById("threadTree");
				listen(tree, "pointerdown", interaction, true);
				listen(tree, "keydown", interaction, true);
				listen(tree, "select", () => remember(record));
				listen(pane, "folderURIChanged", () =>
				{
					record.pendingUserSelection = false;
					record.generation++;
					refresh(record);
				});
				listen(pane, "allMessagesLoaded", () => viewLoadedFire?.async(tabId));
				listen(pane, "unload", () =>
				{
					record.generation++;
					for (const remove of record.listeners) remove();
					panes.delete(pane);
				});
				panes.set(pane, record);
				refresh(record);
				remember(record);
			}
			return { tab, record: refresh(record), pane };
		};

		const close = () =>
		{
			preferences?.dispose();
			preferences = null;
			for (const record of panes.values())
			{
				record.generation++;
				for (const remove of record.listeners) remove();
			}
			panes.clear();
			this.cleanups.delete(close);
		};
		this.cleanups.add(close);
		context.callOnClose?.({ close });
		const event = (name, setFire) => new ExtensionCommon.EventManager({
			context, name: "AutoSelect." + name,
			register: fire =>
			{
				setFire(fire);
				return () => setFire(null);
			},
		}).api();

		return { AutoSelect: {
			onViewLoaded: event("onViewLoaded", fire =>
			{
				viewLoadedFire = fire;
			}),
			onUserInteraction: event("onUserInteraction", fire =>
			{
				interactionFire = fire;
			}),
			onSettingsChanged: event("onSettingsChanged", fire =>
			{
				settingsFire = fire;
			}),
			onWindowClosed: new ExtensionCommon.EventManager({
				context, name: "AutoSelect.onWindowClosed",
				register: fire =>
				{
					const observer = { observe (_window, topic)
					{
						if (topic === "domwindowclosed") fire.async();
					} };
					Services.ww.registerNotification(observer);
					return () => Services.ww.unregisterNotification(observer);
				},
			}).api(),
			async setSettings (settings)
			{
				if (preferences)
				{
					preferences.update(settings);
				}
				else
				{
					preferences = new ASLMPreferences(context.extension, settings, values => settingsFire?.async(values));
					preferences.start();
				}
			},
			async getLegacyPreferences ()
			{
				const branch = Services.prefs.getBranch("extensions.autoselectlatestmessage.");
				return { sel: branch.getIntPref("sel", 1), selForce: branch.getBoolPref("selForce", false),
					focus: branch.getBoolPref("focus", true) };
			},
			async cancelScan (tabId)
			{
				const { record } = getRecord(tabId);
				if (record) record.generation++;
			},
			async getViewState (tabId)
			{
				const { pane, record } = getRecord(tabId);
				const wrapper = pane?.gViewWrapper;
				const cached = Boolean(pane?.gDBView?.rowCount > 0 && wrapper?._enteredFolder &&
          pane.gFolder && !pane.gFolder.server.serverBusy &&
          !Services.prefs.getBoolPref("mail.password_protect_local_cache", false));
				return {
					ready: Boolean(pane?.gDBView && wrapper && (!wrapper.isFolderLoading() || cached) &&
            (!wrapper.searching || cached && wrapper.isVirtual) && !pane.top.windowUtils?.isInModalState()),
					complete: !wrapper?.searching, inputFocused: inputFocused(pane),
					viewToken: record?.viewToken, interactionVersion: record?.interactionVersion,
				};
			},
			async getRememberedMessage (tabId)
			{
				const { record, pane } = getRecord(tabId);
				if (!record) return null;
				const saved = record.memory.get(record.folder);
				if (!saved || saved.deselected) return saved || null;
				const header = context.extension.messageManager.get(saved.id);
				if (!header)
				{
					record.memory.delete(record.folder);
					return null;
				}
				const index = pane.gViewWrapper?.getViewIndexForMsgHdr(header);
				if (index === undefined || index === 0xFF_FF_FF_FF)
				{
					if (pane.gViewWrapper?.searching) return { pending: true };
					record.memory.delete(record.folder);
					return null;
				}
				return candidate(record, saved.id);
			},
			async findMessage (tabId, mode)
			{
				const { record, pane } = getRecord(tabId);
				const view = pane?.gDBView;
				if (!view) return null;
				const generation = ++record.generation;
				const folder = record.folder;
				const cancelled = () => generation !== record.generation || pane.closed ||
          pane.gDBView !== view || pane.gFolder?.URI !== folder;
				let newest;
				let unread;
				let processed = 0;
				let sliceStarted = Date.now();
				function* messages (row, wholeThread)
				{
					const thread = wholeThread || view.isContainer(row) && !view.isContainerOpen(row)
						? view.getThreadContainingIndex(row) : null;
					for (let i = 0; i < (thread ? thread.numChildren : 1); i++)
					{
						yield thread ? thread.getChildHdrAt(i) : view.getMsgHdrAt(row);
					}
				}
				const dateSorted = mode === 1 && view.rowCount > 0 && view.sortType === Ci.nsMsgViewSortType.byDate &&
          !pane.gViewWrapper.showGroupedBySort && (!pane.gViewWrapper.showThreaded ||
            !Services.prefs.getBoolPref("mailnews.sort_threads_by_root", false));
				const edge = view.sortOrder === Ci.nsMsgViewSortOrder.ascending ? view.rowCount - 1 : 0;
				for (let row = dateSorted ? edge : 0; row < (dateSorted ? edge + 1 : view.rowCount); row++)
				{
					for (const message of messages(row, dateSorted && pane.gViewWrapper.showThreaded))
					{
						if (message && !(message.flags & 0x20_00_00_00))
						{
							if (!newest || message.date > newest.date) newest = message;
							if (!message.isRead && !unread) unread = message;
							if (mode === 2 && unread) break;
						}
            // Bound work and elapsed time between yields, including huge threads.
						if (++processed % 64 === 0 && (Date.now() - sliceStarted >= 8 || processed % 512 === 0))
						{
							await new Promise(resolve => pane.setTimeout(resolve, 0));
							if (cancelled()) return null;
							sliceStarted = Date.now();
						}
					}
					if (mode === 2 && unread) break;
				}
				if (cancelled()) return null;
				const header = mode === 2 ? unread || newest : newest;
				return header ? candidate(record, context.extension.messageManager.convert(header).id) : null;
			},
			async selectMessage (tabId, message)
			{
				const { record, pane } = getRecord(tabId);
				if (!record || record.viewToken !== message.viewToken || record.generation !== message.generation ||
            record.interactionVersion !== message.interactionVersion || inputFocused(pane) ||
            pane.top.windowUtils?.isInModalState()) return false;
				const header = context.extension.messageManager.get(message.id);
				if (!header) return false;
				const index = pane.gViewWrapper?.getViewIndexForMsgHdr(header);
				if (index === undefined || index === 0xFF_FF_FF_FF || pane.gDBView !== record.view) return false;
        // Validate and select without an asynchronous API that could switch folders.
				pane.threadTree.selectedIndices = [index];
				pane.threadTree.scrollToIndex(index, true);
				remember(record);
				return true;
			},
			async focusMessageList (tabId)
			{
				const { tab, pane } = getRecord(tabId);
				if (!tab.active || !pane?.gDBView || inputFocused(pane) || pane.top.windowUtils?.isInModalState()) return;
				const tree = pane.document.getElementById("threadTree");
				(tree?.table?.body || tree)?.focus();
			},
		} };
	}
};

var ASLMPreferences = class
{
	constructor (extension, settings, onChange)
	{
		this.id = `${extension.id}-preferences-${extension.instanceId}`;
		this.settings = settings;
		this.onChange = onChange;
		this.windows = new Map();
		this.browsers = new Map();
		this.documents = new Map();
		this.support = ChromeUtils.importESModule("resource:///modules/ExtensionSupport.sys.mjs").ExtensionSupport;
	}

	start ()
	{
		this.support.registerWindowListener(this.id, {
			chromeURLs: ["chrome://messenger/content/messenger.xhtml"],
			onLoadWindow: window => this.watchWindow(window),
			onUnloadWindow: window => this.unwatchWindow(window),
		});
	}

	watchWindow (window)
	{
		const tabmail = window.document.getElementById("tabmail");
		if (!tabmail || this.windows.has(window)) return;
		const monitor = {
			onTabOpened: tab => this.watchBrowser(tab.browser),
			onTabRestored: tab => this.watchBrowser(tab.browser),
			onTabSwitched: tab => this.watchBrowser(tab.browser),
			onTabClosing: tab => this.unwatchBrowser(tab.browser),
			onTabTitleChanged () {}, onTabPersist () {},
		};
		this.windows.set(window, { tabmail, monitor });
		tabmail.registerTabMonitor(monitor);
		for (const tab of tabmail.tabInfo) this.watchBrowser(tab.browser);
	}

	unwatchWindow (window)
	{
		const item = this.windows.get(window);
		if (!item) return;
		item.tabmail.unregisterTabMonitor(item.monitor);
		for (const tab of item.tabmail.tabInfo) this.unwatchBrowser(tab.browser);
		this.windows.delete(window);
	}

	watchBrowser (browser)
	{
		if (!browser || this.browsers.has(browser)) return;
		const load = () => this.watchDocument(browser.contentDocument);
		browser.addEventListener("load", load, true);
		this.browsers.set(browser, load);
		load();
	}

	unwatchBrowser (browser)
	{
		const load = this.browsers.get(browser);
		if (!load) return;
		browser.removeEventListener("load", load, true);
		this.browsers.delete(browser);
		if (browser.contentDocument) this.unwatchDocument(browser.contentDocument);
	}

	watchDocument (document)
	{
		if (!document?.documentURI?.startsWith("about:preferences") || this.documents.has(document)) return;
		const state = { section: null };
		const inject = () =>
		{
			const anchor = document.getElementById("startPageSettings") ||
        document.getElementById("mailnewsStartPageEnabled")?.closest("fieldset, groupbox");
			if (!anchor || state.section || document.getElementById("aslm-settings")) return;
			const make = (tag, text) =>
			{
				const node = document.createElementNS("http://www.w3.org/1999/xhtml", tag);
				if (text) node.textContent = text;
				return node;
			};
			const section = make("fieldset");
			section.id = "aslm-settings";
			section.dataset.category = "paneGeneral";
			section.append(make("legend", "Auto Select Latest Message"));
			section.append(make("p", "Select a message when opening a folder or starting Thunderbird."));
			const selectionLabel = make("label", "Automatically select ");
			const selection = make("select");
			selection.id = "aslm-selection";
			for (const [value, text] of [[0, "Default Thunderbird behavior"], [1, "Newest message"], [2, "First unread message"]])
			{
				const option = make("option", text);
				option.value = String(value);
				selection.append(option);
			}
			selectionLabel.append(selection);
			section.append(selectionLabel);
			const checkbox = (id, text) =>
			{
				const label = make("label");
				label.style.display = "block";
				label.style.marginBlock = "1em";
				const input = make("input");
				input.type = "checkbox";
				input.id = id;
				label.append(input, document.createTextNode(` ${text}`));
				section.append(label);
				return input;
			};
			const force = checkbox("aslm-force", "Override Thunderbird’s remembered selection when opening a folder");
			const focus = checkbox("aslm-focus", "Focus the message list after opening a folder");
			const change = () => this.onChange({ sel: Number(selection.value), selForce: force.checked, focus: focus.checked });
			section.addEventListener("change", change);
			Object.assign(state, { section, selection, force, focus, change });
			anchor.after(section);
			this.render(state);
			state.observer.disconnect();
		};
		state.observer = new document.defaultView.MutationObserver(inject);
		state.unload = () => this.unwatchDocument(document);
		document.defaultView.addEventListener("unload", state.unload, { once: true });
		this.documents.set(document, state);
		state.observer.observe(document.documentElement, { childList: true, subtree: true });
		inject();
	}

	render (state)
	{
		if (!state.section) return;
		state.selection.value = String(this.settings.sel);
		state.force.checked = this.settings.selForce;
		state.focus.checked = this.settings.focus;
		state.force.disabled = !this.settings.sel;
		state.focus.disabled = !this.settings.sel;
	}

	update (settings)
	{
		this.settings = settings;
		for (const state of this.documents.values()) this.render(state);
	}

	unwatchDocument (document)
	{
		const state = this.documents.get(document);
		if (!state) return;
		state.observer.disconnect();
		document.defaultView.removeEventListener("unload", state.unload);
		state.section?.removeEventListener("change", state.change);
		state.section?.remove();
		this.documents.delete(document);
	}

	dispose ()
	{
		this.support.unregisterWindowListener(this.id);
		for (const window of this.windows.keys()) this.unwatchWindow(window);
		for (const browser of this.browsers.keys()) this.unwatchBrowser(browser);
		for (const document of this.documents.keys()) this.unwatchDocument(document);
	}
};
