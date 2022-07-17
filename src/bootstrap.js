
//jshint -W083
const {classes: Cc, interfaces: Ci, utils: Cu} = Components,
			PREF_BRANCH = "extensions.autoselectlatestmessage.";

const debug = (...args) => debug.log.apply(debug, args);
Object.setPrototypeOf(debug, new Proxy(Function.prototype,
{
	get(target, prop)
	{
		const ret = ()=>{};//target[prop] || console[prop];
		return ret.bind(ret);
	}
}));
var self = this,
		pref = Services.prefs.getBranch(PREF_BRANCH),
		prefs = {
			sel: 1,
			selForce: false,
			focus: true
		};

function include(path)
{
	Services.scriptloader.loadSubScript(addon.getResourceURI(path).spec, self);
}

function main(window)
{
	// open console
	// window.toJavaScriptConsole && window.toJavaScriptConsole();

	if (!("FolderDisplayListenerManager" in window))
		return;

	let document = window.document,
			listener = new Proxy({
				events: { //list of events that will trigger selectImage()
					onMakeActive: true,
					// onMessagesLoaded: true,
					onDisplayingFolder: true,
					_SelectMessageStartup: true //fake custom function
				},
				timer: null,
				calls: new Map(),
				selection: new Map(),
				func: function()
				{
					let {that, prop} = this,
							args = arguments;

					clearTimeout(that.timer);

					that.calls.set(this.prop, args);
debug("selectMessageDelayed: " + args, that);
					//the timer needed to allow time to restore previous selection if any
					that.timer = setTimeout(e => that.selectMessage.apply(that, args), 0);
					// that.selectMessage.apply(that, args);
					const tree = args[0].tree;
					if (tree && !tree.___autoSLM)
					{
						tree.___autoSLM = true;
						listen(tree, tree, "select", e =>
						{
							that.selection.set(tree.view.viewFolder.URI, tree.view.hdrForFirstSelectedMessage);
						});
						unload(() => delete tree.___autoSLM);
					}
				},
				
				selectMessage: function listener_selectMessage(tree)
				{
debug("selectMessage: " + [...this.calls.keys()], tree.view.dbView);
					// if (!this.calls.has("onMessagesLoaded"))
					// 	return;

					const isOnDisplayingFolder = this.calls.has("onDisplayingFolder");
					this.calls.clear();

					//remember last selection.
					//smart folders don't work properly, after add/remove folders
					if (!prefs.selForce && tree.view.dbView && !tree.view.dbView.numSelected && this.selection.has(tree.view.dbView.viewFolder.URI))
					{
						const hdr = this.selection.get(tree.view.dbView.viewFolder.URI);
						const index = tree.view.dbView.findIndexOfMsgHdr(hdr, true);
						if (index !== 0xFFFFFFFF)
							tree.selectViewIndex(tree.view.dbView.findIndexOfMsgHdr(hdr, true));
					}
					if (!prefs.sel)
						return;

					const isTextbox = this.isTextbox(window.document.activeElement);

					if (tree.view.dbView && (!tree.view.dbView.numSelected || (tree.view.dbView.numSelected && !isTextbox && prefs.selForce && isOnDisplayingFolder)))
					{
						let msgDefault = Ci.nsMsgNavigationType.firstMessage,
								msgUnread = Ci.nsMsgNavigationType.firstUnreadMessage,
								msg = msgDefault;

						if (tree.view.isSortedAscending && tree.view.sortImpliesTemporalOrdering)
						{
							msgDefault = Ci.nsMsgNavigationType.lastMessage;
//							msgUnread = Ci.nsMsgNavigationType.lastUnreadMessage; //doesn't work, bug?
						}
						switch(prefs.sel)
						{
							case 1:
									msg = msgDefault;
									break;
							case 2:
									msg = msgUnread;
									break;
							default:
								break;
						}
						if (!window.gFolderDisplay.navigate(msg, true /* select */) && msg != msgDefault)
							window.gFolderDisplay.navigate(msgDefault, true /* select */);
					}
					if (prefs.focus && !isTextbox)
					{
						setTimeout(e => (tree.tree.focus()), 100);
					}
				},

				isTextbox: function listener_isTextbox(el)
				{
					if (!el)
						return false;

					if (el.tagName && el.tagName.match(/(?:textbox|html:input)/i))
						return true;

					return this.isTextbox(el.parentNode);
				}
			},
			{
				get(target, prop)
				{
					return target.func.bind({that: target, prop});
				},
				has(target, prop)
				{
					// return true;
					return target.events.hasOwnProperty(prop);
				}
			}), //listener

			tabmail = document.getElementById("tabmail"),
			tabMon = new Proxy({
				onTabOpened: (tab, aFirstTab, aOldTab) =>
				{
					debug("tabMon: "+this, arguments);
					if (tab.mode.name != "preferencesTab")
						return;

					if (tab.browser.contentWindow.___autoSLM)
						return;

					listen(tab.browser, tab.browser, "paneSelected", function runOnce (event)
					{
						tab.browser.removeEventListener("paneSelected", runOnce, false);
						prefWinLoaded(tab.browser.contentWindow);
					}, false);
					tab.browser.contentWindow.___autoSLM = true;
					unload(function()
					{
						delete tab.browser.contentWindow.___autoSLM;
					});
				},
				blank: function(){debug("tabMon: "+this, arguments);}
			},
			{
				get(target, prop)
				{
					return (target[prop] || target.blank).bind(prop);
				},
			});

	window.FolderDisplayListenerManager.registerListener(listener);

	listen(window, window, "unload", unload(e =>
	{
		if ("FolderDisplayListenerManager" in window)
			window.FolderDisplayListenerManager.unregisterListener(listener);
	}), false);

	listener._SelectMessageStartup(window.gFolderDisplay);
	if (tabmail)
	{
		if (tabmail.tabTypes.preferencesTab)
		{
			for(let i = 0; i < tabmail.tabTypes.preferencesTab.modes.preferencesTab.tabs.length; i++)
				prefWinLoaded(tabmail.tabTypes.preferencesTab.modes.preferencesTab.tabs[i].browser.contentWindow);
		}
		tabmail.registerTabMonitor(tabMon);
		unload(e => tabmail.unregisterTabMonitor(tabMon));
	}
} //main()

function prefWinLoaded(window, r, s)
{
	let document = window.document;
	if (!document || !window.MozXULElement)
		return;

debug("prefWinLoaded", document.readyState);
	if (document.readyState != "complete")
		return setTimeout(e => prefWinLoaded(window, r, s));

	r =  r ? true : false;

	let startBox = document.getElementById("mailnewsStartPageEnabled");
	if (startBox)
	{

		const prefChange = (e, val) =>
		{
			const target = e && e[0].target;

			if (target)
				val = ~~target.value;
			else
				val = prefs.sel;

			disableAll(startBox.parentNode.parentNode, val ? true : false);
			disableAll(document.getElementById("autoSLM_box").firstChild, !val, undefined, true);
		};
		if (!r && !document.getElementById("autoSLM_box"))
		{
			let tags = {
					PREF_BRANCH: PREF_BRANCH
				},
				vbox = window.MozXULElement.parseXULToFragment(
`<vbox id="autoSLM_box" autoSLM="">
	<vbox>
		<hbox flex="false">
			<menulist id="autoSLM_sel"
								preference="{PREF_BRANCH}sel"
								autoSLM=""
			>
				<menupopup>
					<menuitem value="0" label="Default"></menuitem>
					<menuitem value="1" label="Newest message"></menuitem>
					<menuitem value="2" label="First unread message"></menuitem>
				</menupopup>
			</menulist>
			<checkbox id="autoSLM_selForce"
								label="Force"
								preference="{PREF_BRANCH}selForce"
								tooltiptext="Thunderbird remembers last selected message, force it to forget"
			></checkbox>
		</hbox>
		<checkbox id="autoSLM_focus" label="Auto focus on messages list" preference="{PREF_BRANCH}focus"></checkbox>
	</vbox>
</vbox>`.replace(/\{([a-zA-Z0-9-_.]+)\}/g, (a,b) => b in tags ? tags[b] : a));

			startBox.parentNode.parentNode.insertBefore(vbox, startBox.parentNode);
			vbox = document.getElementById("autoSLM_box");
			const observer = new window.MutationObserver(prefChange);
			observer.observe(vbox, {
				attributes: true,
				attributeFilter: ["value"],
				subtree: true,
			});
			listen(window, window, "unload", unload(e =>
			{
				vbox.parentNode.removeChild(vbox);
				observer.disconnect();
			}), false);

			try
			{
				let p = [],
						types = {
							number: "int",
							boolean: "bool",
							string: "string"
						};

				for(let n in prefs)
					p[p.length] = {id: PREF_BRANCH + n, type: types[typeof(prefs[n])]};

				window.Preferences.addAll(p);
				unload(e =>
				{
					for(let i = 0; i < p.length; i++)
						delete window.Preferences._all[p[i].id];
				});
			}
			catch(e){debug(e);}
		}
		prefChange();
		if (!r)
			listen(window, window, "unload", unload(e => disableAll(startBox.parentNode.parentNode)), false);
	}
	else if (!s && document.getElementById("paneGeneral"))
	{
		let undo = listen(window, document, "paneSelected", e => (prefWinLoaded(window, r, true),undo()), true);
	}

} //prefWinLoaded()

function startup(data, reason)
{
	let callback = function callback(a)
	{
		addon = a;
		include("includes/utils.js");
		setDefaultPrefs(prefs);

		watchWindows(main);
		watchWindows(prefWinLoaded, "Mail:Preferences");
		watchWindows(prefWinLoaded, "about:preferences");
		pref.QueryInterface(Ci.nsIPrefBranch).addObserver('', onPrefChange, false);
		unload(e => pref.QueryInterface(Ci.nsIPrefBranch).removeObserver('', onPrefChange, false));
	};
	let promise = AddonManager.getAddonByID(data.id, callback);
	if (typeof(promise) == "object" && "then" in promise)
		promise.then(callback);
}

function shutdown(data, reason)
{
	unload();
}

function install(data, reason)
{
}

function uninstall(data, reason)
{
}

