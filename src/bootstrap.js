//bootstrap routine borrowed from restartless restart v1.0


const {classes: Cc, interfaces: Ci, utils: Cu} = Components;
Cu.import("resource://gre/modules/Services.jsm");

var autoSLM = {
	cleanupAry: [],
	shutdown: false,

	main: function(win)
	{
		if (!win.FolderDisplayListenerManager)
			return;
	
		let func = {
			selectMessage: function()
			{
				if (win.gFolderDisplay.view.dbView && !win.gFolderDisplay.view.dbView.numSelected)
					win.gFolderDisplay.navigate(((win.gFolderDisplay.view.isSortedAscending && win.gFolderDisplay.view.sortImpliesTemporalOrdering)
																		? win.nsMsgNavigationType.lastMessage
																		: win.nsMsgNavigationType.firstMessage), /* select */ true);
			},
	
			onActiveMessagesLoaded: function(aAll)
			{
				//the timer needed to allow time to restore previous selection if any
				Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer).init({observe: function()
					{
						this.selectMessage();
					}
				}, 100, Ci.nsITimer.TYPE_ONE_SHOT);
			},
	
			onMakeActive: function()
			{
				this.selectMessage();
			},
		};
		win.FolderDisplayListenerManager.registerListener(func);
		this.cleanupAry.push(function() win.FolderDisplayListenerManager.unregisterListener(func));
		func.selectMessage();
	},
	
	disableAll: function(obj, r)
	{
		if (obj.tagName == "button")
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
				this.disableAll(obj.childNodes[i],r);
			}
		}
	},

	fixpref: function(doc, r, s)
	{
		r = autoSLM.shutdown || r ? true : false;
		if (doc.getElementById("mailnewsStartPageEnabled"))
		{
			if (!r && !doc.getElementById("autoSLM"))
			{
				let t = doc.createElement("label")
				let vbox = doc.createElement("hbox")
				vbox.id = "autoSLM";
				t.setAttribute("value", "*Disabled by Auto Select Latest Message");
				vbox.appendChild(t);
				doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode.appendChild(vbox);
			}
			autoSLM.disableAll(doc.getElementById("mailnewsStartPageEnabled").parentNode.parentNode, r);
			if (r)
				if (doc.getElementById("autoSLM"))
					doc.getElementById("autoSLM").parentNode.removeChild(doc.getElementById("autoSLM"));
			else
				autoSLM.cleanupAry.push(function() autoSLM.fixpref(doc, true));
		}
		else if (!r && !s && doc.getElementById("paneGeneral"))
			doc.getElementById("paneGeneral").addEventListener("paneload", function() autoSLM.fixpref(doc, r, true), true);
	}
}

function startup(data, reason)
{
	autoSLM.shutdown = false;
	let wins = Services.wm.getEnumerator("mail:3pane");
	while (wins.hasMoreElements())
		autoSLM.main(wins.getNext());

	let wins = Services.wm.getEnumerator("Mail:Preferences");
	while (wins.hasMoreElements())
		autoSLM.fixpref(wins.getNext().document);

	function winObs(aSubject, aTopic)
	{
		if ("domwindowopened" != aTopic)
			return;

		let winLoad = function()
		{
			aSubject.removeEventListener("load", winLoad, false);
			let doc = aSubject.document;
			if ("mail:3pane" == doc.documentElement.getAttribute("windowtype"))
				autoSLM.main(aSubject);
			else if ("Mail:Preferences" == doc.documentElement.getAttribute("windowtype"))
				autoSLM.fixpref(doc);
		}
		aSubject.addEventListener("load", winLoad, false);
	}
	Services.ww.registerNotification(winObs);
	autoSLM.cleanupAry.push(function() Services.ww.unregisterNotification(winObs));
}

function shutdown(data, reason)
{
	autoSLM.shutdown = true;
	for (let [, cleaner] in Iterator(autoSLM.cleanupAry)) cleaner && cleaner();
}

function install(data, reason)
{
	startup();
}

function uninstall(data, reason)
{
	shutdown();
}