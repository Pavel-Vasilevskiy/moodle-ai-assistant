"use strict";

// The toolbar action opens the persistent extension side panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => {
    console.error("Could not enable the side panel toolbar action:", error);
  });
