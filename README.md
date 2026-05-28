# Orca Browser Bridge

## What this is

Orca Browser Bridge is a Google Chrome extension that lets the Orca desktop app see LinkedIn pages
while you browse. When you visit a LinkedIn profile or post, the extension quietly passes that
information to Orca over a private, local connection (no data leaves your computer). Orca uses
this to find posts worth commenting on as part of its LinkedIn social-media feature. Without the
extension, Orca cannot read what is on screen in Chrome.

This extension holds no passwords or account credentials. It is simply a communication channel
between Chrome and the Orca app already running on your Mac.

---

## Installing the extension

Follow these steps in order. You only need to do this once.

**Step 1 -- Download the extension files**

On this GitHub page, click the green "Code" button near the top-right, then click "Download ZIP".
Your browser will save a file called something like `orca-browser-bridge-main.zip` to your
Downloads folder.

**Step 2 -- Unzip the downloaded file**

Open your Downloads folder and double-click the ZIP file. macOS will automatically unpack it
into a folder called `orca-browser-bridge-main` (or similar) in the same location. Move the unzipped folder somewhere on your machine that won't be deleted, like /documents or similar.

**Step 3 -- Open the Chrome extensions page**

Open Google Chrome. Click in the address bar at the top, type `chrome://extensions`, and press
Enter. You will see a page listing any extensions you already have installed.

**Step 4 -- Turn on Developer mode**

In the top-right corner of the extensions page, find the toggle labelled "Developer mode" and
switch it on. A few extra buttons will appear across the top of the page.

**Step 5 -- Load the extension**

Click the "Load unpacked" button that appeared in the top-left. A file picker window will open.

**Step 6 -- Select the extension folder**

Navigate to your Downloads folder and select the folder you unzipped in Step 2. You are looking
for the folder that contains a file called `manifest.json` inside it. Select that folder and
click "Select" (or "Open").

**Step 7 -- Confirm it has loaded**

The "Orca Browser Bridge" card will now appear on the extensions page. That means Chrome has
loaded the extension successfully.

**Step 8 -- Check the connection**

Make sure the Orca app is open on your Mac. Click the Orca Browser Bridge icon in the Chrome
toolbar (it may be hidden in the puzzle-piece extensions menu). A small window will appear and
should say "Connected" with a green dot. That means everything is working.

---

## Updating to a newer version

When a new version is available, you will be given a new ZIP file (or a link to download one
from this page).

1. Download the new ZIP and unzip it as described in Steps 1 and 2 above.
2. Go to `chrome://extensions` in Chrome.
3. Find the Orca Browser Bridge card and click the circular refresh/reload icon on it.
   If you cannot see a refresh icon, click "Remove" on the old card, then follow Steps 5 and 6
   above to load the new folder.

---

## Troubleshooting

**The popup says "Disconnected" or shows no green dot**

This means the extension cannot reach the Orca app. Check:

- The Orca desktop app is open. The Bridge only works while Orca is running.
- Only one copy of Orca is open at a time. If you have two Orca windows open, close one.
- Once Orca is running, click the extension icon and press the "Reconnect" button.

**I cannot see the extension icon in the toolbar**

Click the puzzle-piece icon to the right of Chrome's address bar. Find "Orca Browser Bridge" in
the list and click the pin icon next to it. The Orca icon will then appear permanently in the
toolbar.

**The "Load unpacked" button is not visible**

Make sure Developer mode is switched on (Step 4). The button only appears when Developer mode
is enabled.

---

## Privacy note

The extension communicates only with the Orca app installed on your own computer. No data is
sent to any external server by the extension itself. All processing, including any database
access, is handled by the Orca desktop app using your own credentials.
