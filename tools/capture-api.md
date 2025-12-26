# How to Capture Polymarket Live Crypto API Calls

## Step 1: Open Browser Dev Tools

1. Go to: https://polymarket.com/event/btc-updown-15m-1765995300
2. Open Developer Tools:
   - **Chrome/Edge**: Press `F12` or `Cmd+Option+I` (Mac) / `Ctrl+Shift+I` (Windows)
   - **Firefox**: Press `F12` or `Cmd+Option+I`
3. Go to the **Network** tab

## Step 2: Filter and Capture

1. In the Network tab, click **Clear** (🚫) to clear existing requests
2. Refresh the page (`Cmd+R` or `F5`)
3. In the filter box, type: `api` or `market` or `btc`
4. Look for XHR/Fetch requests (click "Fetch/XHR" filter)

## Step 3: Find the Right Request

Look for requests that:
- Return JSON with market data
- Contain "up", "down", "btc", or "bitcoin" in the URL or response
- Have token IDs, prices, or order book data

**Common patterns to look for:**
- `wss://` - WebSocket connections
- `/markets/` or `/events/` endpoints
- Condition IDs starting with `0x`

## Step 4: Export the Data

For each interesting request:
1. Right-click the request
2. Select **Copy** → **Copy as cURL** (or Copy as fetch)
3. Paste into a text file

Or export all:
1. Right-click in the Network panel
2. Select **Save all as HAR with content**
3. Save the .har file

## Step 5: Share What You Find

Once you've captured requests, look for:
- The API endpoint URL
- Any authentication headers
- The response structure (token IDs, prices, etc.)

Share the cURL commands or HAR file and I'll analyze them to update the bot!


