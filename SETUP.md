# Polymarket Straddle Bot - Setup Guide

## What You Need

1. **A Polymarket wallet** - The Ethereum/Polygon wallet you use to trade on Polymarket
2. **Your wallet's private key** - Exported from MetaMask
3. **USDC in your wallet** - For funding trades

## Getting Your Private Key from MetaMask

⚠️ **SECURITY WARNING**: Your private key gives full control of your wallet. Only use a dedicated trading wallet with limited funds.

1. Open MetaMask
2. Click the three dots menu (⋮) next to your account name
3. Select **"Account Details"**
4. Click **"Show Private Key"**
5. Enter your MetaMask password
6. Copy the private key (starts with `0x` or is a long hex string)

## Deploy to Railway

### Option A: One-Click Deploy (Easiest)

1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Click **"New Project"** → **"Deploy from GitHub repo"**
3. Connect your GitHub and deploy this repository
4. Add environment variables (see below)
5. Generate a domain in Settings → Networking

### Option B: Railway CLI

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project and deploy
railway init
railway up

# Set variables
railway variables set PRIVATE_KEY=your_key_here
railway variables set DASHBOARD_PASSWORD=your_password
railway variables set BET_SIZE=10
railway variables set BOT_ENABLED=false
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PRIVATE_KEY` | Yes | Your Polygon wallet private key |
| `DASHBOARD_PASSWORD` | Yes | Password to access the dashboard |
| `BET_SIZE` | No | Amount per straddle (default: 10) |
| `BOT_ENABLED` | No | Start enabled (default: false) |
| `PORT` | No | Server port (Railway sets this) |

## Using the Dashboard

1. Open your Railway app URL
2. Enter your dashboard password
3. You'll see:
   - **Total P&L** - Cumulative profit/loss
   - **Total Trades** - Number of trades executed
   - **Active Positions** - Open straddles
   - **Last Scan** - When markets were last checked

### Controls

- **Bot Toggle** - Enable/disable automatic trading
- **Bet Size** - How much per straddle (total, split between up/down)
- **Max Combined** - Maximum combined cost for straddles
- **Force Scan** - Manually trigger a market scan
- **Emergency Stop** - Immediately disable the bot

## How It Works

Every 5 minutes (when enabled), the bot:

1. Scans Polymarket for Bitcoin prediction markets
2. Finds markets with:
   - Both UP and DOWN tokens
   - Combined cost under your max (default $1.05)
   - One cheap leg (<50¢) and one expensive leg (>50¢)
3. Executes balanced straddles on viable markets
4. Logs all trades for tracking

## Safety Features

- Bot starts **disabled** by default
- Dashboard is password protected
- Emergency stop button
- All trades are logged
- Rate limiting between orders

## Troubleshooting

### "Running in read-only mode"
Your private key isn't configured or is invalid. Check your `PRIVATE_KEY` environment variable.

### "No Bitcoin markets found"
Either there are no active Bitcoin prediction markets on Polymarket, or the API is temporarily unavailable.

### Dashboard won't connect
Make sure you're using the correct password in the dashboard input field.

## Support

This is experimental software. Use at your own risk and only trade what you can afford to lose.

