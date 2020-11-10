const {classes: Cc, interfaces: Ci, utils: Cu} = Components,
			PREF_BRANCH = "extensions.autoselectlatestmessage.";

var self = this,
		pref = Services.prefs.getBranch(PREF_BRANCH),
		prefs = {
			sel: 1,
			selForce: false,
			focus: true
		},
		log = console.log.bind(console);

function include(path)
{
	Services.scriptloader.loadSubScript(addon.getResourceURI(path).spec, self);
}

function setTimeout(callback, time)
{
	let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
	timer.initWithCallback(callback, time, Ci.nsITimer.TYPE_ONE_SHOT);
	return timer;
}

function main(window)
{

	if (!"FolderDisplayListenerManager" in window)
		return;

	let document = window.document,
			listener = {
				timer: null,
				last: 0,
				selectMessageDelayed: function listener_selectMessageDelayed()
				{
					if (this.timer)
						this.timer.cancel();

					//the timer needed to allow time to restore previous selection if any
					this.timer = setTimeout(listener.selectMessage.bind(this), 0);
				},

				selectMessage: function listener_selectMessage()
				{
					if (!prefs.sel)
						return;

					let isTextbox = this.isTextbox(window.document.activeElement),
							view = window.gFolderDisplay && window.gFolderDisplay.view;

					if (view && view.dbView && (!view.dbView.numSelected || (view.dbView.numSelected && !isTextbox && prefs.selForce)))
					{

						let msgDefault = (view.isSortedAscending && view.sortImpliesTemporalOrdering)
											? Ci.nsMsgNavigationType.lastMessage
											: Ci.nsMsgNavigationType.firstMessage;

						switch(prefs.sel)
						{
							case 1:
									msg = msgDefault;
							default:
								break;
							case 2:
									msg = Ci.nsMsgNavigationType.firstUnreadMessage;
								break;
						}

						if (!window.gFolderDisplay.navigate(msg, /* select */ true) && msg != msgDefault)
							window.gFolderDisplay.navigate(msgDefault, /* select */ true)
					}
					if (prefs.focus && !isTextbox)
					{
						setTimeout(function()
						{
							window.gFolderDisplay.tree.focus()
						}, 100);
					}
				},

				isTextbox: function listener_isTextbox(el)
				{
					if (!el)
						return false;

					if (el.tagName && el.tagName.match(/(?:textbox|html:input)/i))
						return true

					return this.isTextbox(el.parentNode);
				},

				onMessagesLoaded: function listener_onMessagesLoaded(aAll)
				{
					listener.selectMessageDelayed();
				},

				onMakeActive: function listener_onMakeActive()
				{
					listener.selectMessageDelayed();
				}
	}; //listener

	window.FolderDisplayListenerManager.registerListener(listener);

	listen(window, window, "unload", unload(function()
	{
		if ("FolderDisplayListenerManager" in window)
			window.FolderDisplayListenerManager.unregisterListener(listener)
	}), false);

//	listener.selectMessageDelayed();

	let tabmail = document.getElementById("tabmail"),
			tabMon = {
		monitorName: "aslmTabmon",
		onTabOpened: function tabMan_onTabOpened(tab, aFirstTab, aOldTab)
		{
			if (tab.mode.name != "preferencesTab")
				return;

			if (tab.browser.contentWindow.___autoSLM)
				return;

			tab.browser.addEventListener("paneSelected", function runOnce (event)
			{
				tab.browser.removeEventListener("paneSelected", runOnce, false);
				fixpref(tab.browser.contentWindow);
			}, false);
			tab.browser.contentWindow.___autoSLM = true;
			unload(function()
			{
				delete tab.browser.contentWindow.___autoSLM;
			});

		},
		onTabTitleChanged: function tabMan_onTabTitleChanged(){},
		onTabPersist: function tabMan_onTabPersist(){},
		onTabRestored: function tabMan_onTabRestored(){},
		onTabClosing: function tabMan_onTabClosing(){},
		onTabSwitched: function tabMan_onTabSwitched(tab){},
	};

	if (tabmail)
	{
		if (tabmail.tabTypes.preferencesTab)
		{
			for(let i = 0; i < tabmail.tabTypes.preferencesTab.modes.preferencesTab.tabs.length; i++)
			{
				fixpref(tabmail.tabTypes.preferencesTab.modes.preferencesTab.tabs[i].browser.contentWindow);
			}
		}
		tabmail.registerTabMonitor(tabMon);
		unload(function()
		{
			tabmail.unregisterTabMonitor(tabMon)
		});
	}

} //main()

function disableAll(obj, r, s)
{
	if (obj.hasAttribute && obj.hasAttribute("autoSLM"))
		return true;

	if (!s && obj.hasAttribute && obj.hasAttribute("autoSLM"))
		s = true;

	if (s || typeof(r) == "undefined")
	{
		if ("disabled" in obj && !("___autoSLM_disabled" in obj))
		{
			obj.___autoSLM_disabled = obj.disabled;
		}
		if (typeof(r) == "undefined")
		{
			obj.disabled = obj.___autoSLM_disabled;
			delete obj.___autoSLM_disabled;
		}
		else
		{
			obj.disabled = r;
		}
	}
	if (obj.childNodes.length)
	{
		for(let i = 0; i < obj.childNodes.length; i++)
		{
			let a = disableAll(obj.childNodes[i], r, s);
			if (a)
				s = a;
		}
	}
}

function prefString(pref, key, val)
{
	let r, er = [];
	if (typeof(val) == "undefined")
	{
		try
		{
			r = pref.getComplexValue(key, Ci.nsISupportsString).data;
		}
		catch(e)
		{
			er.push(e);
			try
			{
				r = pref.getStringPref(key);
			}
			catch(e)
			{
				er.push(e);
				try
				{
					r = pref.getComplexValue(key, Ci.nsIPrefLocalizedString).data;
				}
				catch(e)
				{
					er.push(e);
					try
					{
						r = pref.getCharPref(key);
					}
					catch(e)
					{
						er.push(e);
						log(er);
					}
				}
			}
		}
	}
	else
	{
		try
		{
			let str = Cc["@mozilla.org/supports-string;1"].createInstance(Ci.nsISupportsString);
			str.data = val;
			r = pref.setComplexValue(key, Ci.nsISupportsString, str);
		}
		catch(e)
		{
			er.push(e);
			try
			{
				r = pref.setStringPref(key,val);
			}
			catch(e)
			{
				er.push(e);
				try
				{
					let str = Cc["@mozilla.org/pref-localizedstring;1"].createInstance(Ci.nsIPrefLocalizedString);
					str.data = val;
					r = pref.setComplexValue(key, Ci.nsIPrefLocalizedString, str);
				}
				catch(e)
				{
					er.push(e);
					try
					{
						r = pref.setCharPref(key, val);
					}
					catch(e)
					{
						er.push(e);
						log(er);
					}
				}
			}
		}
	}
	return r;
}//prefString()

function setDefaultPrefs(prefs, prefix)
{
	var prefix = prefix || "";
	let p, name = "";
	if (prefix)
	{
		p = prefs[prefix];
		name = prefix + ".";
	}
	else
	{
		p = prefs;
	}
	let branch = Services.prefs.getDefaultBranch(PREF_BRANCH);
	for (let key in p)
	{
		let val = p[key];
		switch (typeof val)
		{
			case "boolean":
				branch.setBoolPref(name + key, val);
				val = pref.getBoolPref(name + key);
				break;
			case "number":
				branch.setIntPref(name + key, val);
				val = pref.getIntPref(name + key);
				break;
			case "string":
				prefString(branch, name + key, val);
				val = prefString(pref, name + key, val);
				break;
			case "object":
				prefs[val] = setDefaultPrefs(prefs, key);
				continue;
				break;
		}
		if (prefix)
			prefs[prefix][key] = val;
		else
			prefs[key] = val;
	}
	return prefs;
}

function onPrefChange(pref, aTopic, key)
{
	if(aTopic != "nsPref:changed" || typeof(prefs[key]) == "undefined")
		return;

	switch (pref.getPrefType(key))
	{
		case Ci.nsIPrefBranch.PREF_BOOL:
			prefs[key] = pref.getBoolPref(key);
			break;

		case Ci.nsIPrefBranch.PREF_INT:
			prefs[key] = pref.getIntPref(key);
			break;

		case Ci.nsIPrefBranch.PREF_STRING:
			prefs[key] = prefString(pref, key);
			break;
		default:
			return;
	}
//	Services.obs.notifyObservers(null, 'autoSLM_prefChanged', key);
} //onPrefChange()

function fixpref(window, r, s)
{
	let doc = window.document;
	if (!doc)
		return;

	r =  r ? true : false;

	let startBox = doc.getElementById("mailnewsStartPageEnabled");
	if (startBox)
	{
		function addElement(el, parent, type)
		{
			type = type || "appendChild";

			if (type == "insertBefore")
				parent.parentNode.insertBefore(el, parent);
			else
				parent[type](el);

			listen(window, window, "unload", unload(function()
			{
				el.parentNode.removeChild(el);
			}), false);
		}

		function prefChange(e, val)
		{
			if (e && (e.target.id != "autoSLM_sel" || e.attrName != "value"))
				return;

			if (e && "newValue" in e)
				val = ~~e.newValue;
			else
				val = prefs.sel;

			disableAll(startBox.parentNode.parentNode, val ? true : false);
			try
			{
				doc.getElementById("autoSLM_focus").disabled = !val;
			}
			catch (e){}
			try
			{
				doc.getElementById("autoSLM_selForce").disabled = !val;
			}
			catch (e){}
		}

		if (!r && !doc.getElementById("autoSLM_box"))
		{
			let h = startBox.parentNode.parentNode.clientHeight,
					w = startBox.parentNode.parentNode.clientWidth,
					checkbox = doc.createXULElement("checkbox"),
					menupopup = doc.createXULElement("menupopup"),
					menulist = doc.createXULElement("menulist"),
					vbox = doc.createXULElement("vbox"),
					hbox = doc.createXULElement("hbox"),
					menuitem = doc.createXULElement("menuitem");

			vbox.id = "autoSLM_box";
			vbox.setAttribute("autoSLM", '');

			menulist.id = "autoSLM_sel";
			menulist.setAttribute("label", "Select first unread message only");
			menulist.setAttribute("preference", PREF_BRANCH + "sel");
			menulist.addEventListener("DOMAttrModified", prefChange, false);
			menulist.value = prefs.sel;
			hbox.setAttribute("flex", false);
			menuitem.setAttribute("value", 0);
			menuitem.setAttribute("label", "Default");
			menupopup.appendChild(menuitem);
			menuitem = doc.createXULElement("menuitem");
			menuitem.setAttribute("value", 1);
			menuitem.setAttribute("label", "Newest message");
			menupopup.appendChild(menuitem);
			menuitem = doc.createXULElement("menuitem");
			menuitem.setAttribute("value", 2);
			menuitem.setAttribute("label", "First unread message");
			menupopup.appendChild(menuitem);
			menulist.appendChild(menupopup);
			hbox.appendChild(menulist);

			checkbox.id = "autoSLM_selForce";
			checkbox.setAttribute("label", "Force");
			checkbox.setAttribute("tooltiptext", "TB remembers last selected message, force it to forget");
			checkbox.setAttribute("preference", PREF_BRANCH + "selForce");
			hbox.appendChild(checkbox);
			vbox.appendChild(hbox);
			checkbox = doc.createXULElement("checkbox");
			checkbox.id = "autoSLM_focus";
			checkbox.setAttribute("label", "Auto focus on messages list");
			checkbox.setAttribute("preference", PREF_BRANCH + "focus");
			vbox.appendChild(checkbox);

			addElement(vbox, startBox.parentNode, "insertBefore");

			try
			{
				let p = [
					{ id: "extensions.autoselectlatestmessage.sel", type: "int" },
					{ id: "extensions.autoselectlatestmessage.selForce", type: "bool" },
					{ id: "extensions.autoselectlatestmessage.focus", type: "bool" },
				];
				window.Preferences.addAll(p);
				unload(function()
				{
					for(let i = 0; i < p.length; i++)
						delete window.Preferences._all[p[i].id];
				});
			}
			catch(e){}
		}
		prefChange()
		if (!r)
			listen(window, window, "unload", unload(function()
			{
				disableAll(startBox.parentNode.parentNode);
			}), false);
	}
	else if (!s && doc.getElementById("paneGeneral"))
		listen(window, doc.getElementById("paneGeneral"), "paneload", function() {fixpref(window, r, true)}, true);

/*
	function prefChanged(aSubject, aTopic, aData)
	{
		if (aTopic != "autoSLM_prefChanged")
				return;

log(prefs[aData], arguments);
	}

	Services.obs.addObserver(prefChanged, "autoSLM_prefChanged", false);
	let u = function()
	{
log("unloaded");
		Services.obs.removeObserver(prefChanged, "autoSLM_prefChanged", false);
	}
	listen(window, window, "unload", u);
	unload(u);
*/
} //fixpref()

function startup(data, reason)
{
	let callback = function callback(a)
	{
		addon = a;
		include("includes/utils.js");
		setDefaultPrefs(prefs);

		watchWindows(main);
		watchWindows(fixpref, "Mail:Preferences");
		pref.QueryInterface(Ci.nsIPrefBranch).addObserver('', onPrefChange, false);
		unload(function()
		{
			pref.QueryInterface(Ci.nsIPrefBranch).removeObserver('', onPrefChange, false);
		});
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
