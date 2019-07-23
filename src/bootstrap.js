const {classes: Cc, interfaces: Ci, utils: Cu} = Components,
			PREF_BRANCH = "extensions.autoselectlatestmessage.";
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/AddonManager.jsm");
var self = this,
		width = 0,
		height = 0,
		pref = Services.prefs.getBranch(PREF_BRANCH),
		prefs = {
			sel: 1,
		},
		log = console.log;

function include(path)
{
	Services.scriptloader.loadSubScript(addon.getResourceURI(path).spec, self);
}

function main(window)
{
	if (!"FolderDisplayListenerManager" in window)
		return;

	let func = {
		selectMessageDelayed: function()
		{
			//the timer needed to allow time to restore previous selection if any
			Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer).init({observe: function()
				{
					func.selectMessage();
				}
			}, 100, Ci.nsITimer.TYPE_ONE_SHOT);
		},
		selectMessage: function()
		{
			var sel = pref.getIntPref("sel");
			if (!sel)
				return;

			if (window.gFolderDisplay && window.gFolderDisplay.view.dbView && window.gFolderDisplay.view.dbView.numSelected == 0)
			{
				let msgDefault = (window.gFolderDisplay.view.isSortedAscending && window.gFolderDisplay.view.sortImpliesTemporalOrdering)
									? window.nsMsgNavigationType.lastMessage
									: window.nsMsgNavigationType.firstMessage;
				switch(sel)
				{
					case 1:
							msg = msgDefault;
					default:
						break;
					case 2:
							msg = window.nsMsgNavigationType.firstUnreadMessage;
						break;
				}
				if (!window.gFolderDisplay.navigate(msg, /* select */ true) && msg != msgDefault)
					window.gFolderDisplay.navigate(msgDefault, /* select */ true)

					if (!this.isTextbox(window.document.activeElement))
						window.gFolderDisplay.tree.focus();
			}
		},

		isTextbox: function(el)
		{
			if (!el)
				return false;

			if (el.tagName == "textbox")
				return true

			return this.isTextbox(el.parentNode);
		},

		onMessagesLoaded: function(aAll)
		{
			func.selectMessageDelayed();
		},

		onMakeActive: function()
		{
			func.selectMessageDelayed();
		},
	};
	window.FolderDisplayListenerManager.registerListener(func);
	listen(window, window, "unload", unload(function(){
		if ("FolderDisplayListenerManager" in window)
			window.FolderDisplayListenerManager.unregisterListener(func)
		}), false);
	func.selectMessage();
}
	
function disableAll(obj, r)
{
	if (obj.tagName == "button" || obj.id == "autoSLM_box")
		return;

	if (!r && !obj.hasAttribute("backupDisabled"))
		obj.setAttribute("backupDisabled", obj.disabled);

	if (r && obj.hasAttribute("backupDisabled"))
		obj.disabled = obj.getAttribute("backupDisabled") == "true";
	else if (!r)
		obj.disabled = true;

	if (obj.childNodes.length)
	{
		for(var i = 0; i < obj.childNodes.length; i++)
		{
			disableAll(obj.childNodes[i],r);
		}
	}
}

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
				branch.setCharPref(name + key, val);
				val = pref.getCharPref(name + key);
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

function fixpref(window, r, s)
{
	var doc = window.document;
	if (!doc)
		return;

	r =  r ? true : false;
	if (doc.getElementById("mailnewsStartPageEnabled"))
	{
		if (!r && !doc.getElementById("autoSLM_box"))
		{
			let h = doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode.clientHeight;
			let w = doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode.clientWidth;

			let menupopup = doc.createElement("menupopup")
			let menulist = doc.createElement("menulist");
			menulist.id = "autoSLM";
			menulist.setAttribute("label", "Select first unread message only");
			menulist.setAttribute("preference", "autoSLM_pref");
			menulist.addEventListener("command", prefChange, true);
			let box = doc.createElement("hbox");
			box.setAttribute("flex", false);
			box.id = "autoSLM_box";
			let menuitem = doc.createElement("menuitem");
			menuitem.setAttribute("value", 0);
			menuitem.setAttribute("label", "Default");
			menupopup.appendChild(menuitem);
			menuitem = doc.createElement("menuitem");
			menuitem.setAttribute("value", 1);
			menuitem.setAttribute("label", "Newest message");
			menupopup.appendChild(menuitem);
			menuitem = doc.createElement("menuitem");
			menuitem.setAttribute("value", 2);
			menuitem.setAttribute("label", "First unread message");
			menupopup.appendChild(menuitem);
			menulist.appendChild(menupopup);
			box.appendChild(menulist);
			
			doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode.insertBefore(box, doc.getElementById("mailnewsStartPageEnabled").parentNode);

			let p = doc.createElement("preference");
			p.id = "autoSLM_pref";
			p.setAttribute("type", "int");
			p.name = "extensions.autoselectlatestmessage.sel";
			doc.getElementById("generalPreferences").appendChild(p);

			disableAll(doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode, menulist.value == 0);
			width = doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode.clientWidth - w;
			height = doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode.clientHeight - h;
			window.resizeBy(width, height);
			doc.getElementById("MailPreferences").showPane(doc.getElementById("MailPreferences").currentPane);
		}
		if (!r)
			listen(window, window, "unload", unload(function(){
				doc.getElementById("autoSLM_box").parentNode.removeChild(doc.getElementById("autoSLM_box"));
				doc.getElementById("autoSLM_pref").parentNode.removeChild(doc.getElementById("autoSLM_pref"));
				disableAll(doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode, true);
				window.resizeBy(-width, -height);
			}), false);
	}
	else if (!s && doc.getElementById("paneGeneral"))
		doc.getElementById("paneGeneral").addEventListener("paneload", function() {fixpref(window, r, true)}, true);
}
function prefChange(e)
{
	disableAll(e.target.parentNode.parentNode.parentNode.parentNode, e.target.value == "0");
}

function startup(data, reason)
{
	let callback = function callback(a)
	{
		addon = a;
		include("includes/utils.js");
		setDefaultPrefs(prefs);

		watchWindows(main);
		watchWindows(fixpref, "Mail:Preferences");
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
