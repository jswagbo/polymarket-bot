# Polymarket Straddle Bot

An automated trading bot for Polymarket that executes balanced straddle trades on Bitcoin prediction markets.

## Strategy

The bot is based on research showing Polymarket odds are systematically miscalibrated:

- **Cheap options (<50¢)** hit WAY less than implied:
  - 20-30¢ options win only 3% (should be ~25%)
  - 30-40¢ options win only 10% (should be ~35%)

- **Expensive options (>50¢)** hit WAY more:
  - 60-70¢ options win 93% (should be ~65%)
  - 70-80¢ options win 98% (should be ~75%)

The bot runs balanced straddles (buys both UP and DOWN) on Bitcoin markets. In every straddle, one side is cheap and one is expensive. The expensive side overperforms, creating net positive expectation.

## Features

- 🔄 **Automatic market scanning** - Finds Bitcoin up/down markets every 5 minutes
- 📊 **Straddle execution** - Balanced trades on both sides
- 📈 **Dashboard** - Beautiful UI to monitor and control the bot
- 💾 **Trade history** - SQLite database tracks all trades and P&L
- 🔒 **Password protected** - Simple auth for the dashboard

## Quick Start

### Deploy to Railway

1. Click the button below to deploy:

   [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

2. Set your environment variables:
   - `PRIVATE_KEY` - Your Polygon wallet private key
   - `DASHBOARD_PASSWORD` - Password for the dashboard
   - `BET_SIZE` - Amount per straddle (default: 10)
   - `BOT_ENABLED` - Start with bot enabled (default: false)

3. Your bot will be live at the Railway-provided URL!

### Run Locally

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file:
   ```
   PRIVATE_KEY=your_private_key_here
   DASHBOARD_PASSWORD=your_password
   BET_SIZE=10
   BOT_ENABLED=false
   PORT=3000
   ```

4. Build and run:
   ```bash
   npm run build
   npm start
   ```

5. Open http://localhost:3000

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Your Polygon wallet private key (from MetaMask) | Required |
| `DASHBOARD_PASSWORD` | Password to access the dashboard | `changeme` |
| `BET_SIZE` | Total $ amount per straddle trade | `10` |
| `BOT_ENABLED` | Whether bot starts enabled | `false` |
| `PORT` | Server port | `3000` |

## Dashboard

The dashboard lets you:
- Toggle the bot on/off
- Adjust bet size
- Force manual market scans
- View all trades and P&L
- Emergency stop

## How It Works

```
Every 5 minutes:
1. Scan Polymarket for active Bitcoin markets
2. For each market, check if:
   - Has both UP and DOWN tokens
   - Combined cost < $1.05
   - One leg is cheap (<50¢), one is expensive (>50¢)
3. Execute balanced straddles on viable markets
4. Log trades and wait for resolution
```

## Security

⚠️ **IMPORTANT**: Your private key grants full access to your wallet. Keep it secure!

- Never share your private key
- Use a dedicated wallet with only trading funds
- The bot stores your key in Railway's encrypted environment variables
- The dashboard is password protected

## Disclaimer

- This is experimental software - use at your own risk
- Past performance doesn't guarantee future results
- Only trade what you can afford to lose
- Polymarket is restricted for US residents
- This bot is not affiliated with Polymarket

## License

MIT

