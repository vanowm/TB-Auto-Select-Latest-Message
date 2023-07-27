var { ExtensionCommon } = ChromeUtils.import(
  "resource://gre/modules/ExtensionCommon.jsm"
);

var ScrollToView = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    function getAbout3Pane(nativeTab) {
      if (nativeTab.mode && nativeTab.mode.name == "mail3PaneTab") {
        return nativeTab.chromeBrowser.contentWindow;
      }
      return null;
    }

    return {
      ScrollToView: {
        scroll: async function (tabId) {
          let { nativeTab } = context.extension.tabManager.get(tabId);
          let about3Pane = getAbout3Pane(nativeTab);
          if (!about3Pane) {
            console.error(`The tabId ${tabId} is not an about:3pane tab`);
            return;
          }
          
          let  row = about3Pane.threadTree.selectedIndex;
          await about3Pane.threadTree.scrollToIndex(row, true);
        },
      },
    };
  }
};
