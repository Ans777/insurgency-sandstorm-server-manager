# Insurgency Sandstorm – Local Server Manager

> A web-based manager for your local Insurgency: Sandstorm dedicated server — with kill tracking, ranks, medals, AI assistant, Steam integration, and community feeds.

![Server Tab](screenshots/server.png)


A web-based local server manager for Insurgency: Sandstorm dedicated servers with built-in gamification, kill tracking, AI assistant, and Steam integration.

## Features

### Server Management
- Start/stop dedicated server with configurable parameters
- Map, game mode, side, and player count selection
- Quick settings panel with tooltips for all game parameters
- Mutator support (Frenzy, Vampirism, BulletSponge, etc.)
- Preset system - save and load server configurations
- MapCycle and Game.ini editors with backup/restore
- Mod manager - browse and toggle installed mod.io mods
- RCON console for live server commands
- Auto-restart on server crash
- Real-time server log viewer with search and filters

### Player Gamification
- Personal kill tracking via LogGameplayEvents (your kills only, not bots)
- 12-tier military rank system (Recruit to Field Marshal)
- 37+ medals across kill milestones, streaks, weapon mastery, and map mastery
- Custom challenges with live progress tracking
- Daily auto-rotating challenges
- K/D ratio per map and per weapon
- Session performance graph
- Activity heatmap by hour
- Kill feed with weapon names and color-coded events
- Rank-up animation with sound effects
- RCON announcements in-game for medals and streaks
- Stats export as shareable PNG image

### Steam Integration
- Steam achievements with unlock status
- Global achievement comparison (you vs. all players)
- Live player count from Steam API
- News feed from New World Interactive (patch notes, updates)
- GSLT token support for player name display and XP rewards

### AI Assistant
- OpenAI Realtime API voice assistant
- Specialized in Insurgency: Sandstorm server administration
- Text and voice input/output
- Multi-language support

### Multi-Language
- English and Danish included
- Easy to add more languages by copying a JSON file

## Installation

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or later
- Insurgency: Sandstorm dedicated server installed via Steam (App ID: 581330)
- Steam running on the same machine

### Setup

1. Clone the repository:
```bash
git clone https://github.com/YOUR_USERNAME/insurgency-sandstorm-server-manager.git
cd insurgency-sandstorm-server-manager
```

2. Install dependencies:
```bash
npm install
```

3. Start the manager:
```bash
node server.js
```

4. Open http://127.0.0.1:3000/setup in your browser to configure paths and options.

Or on Windows, simply double-click `start.bat`.

## Configuration

The setup wizard auto-detects your Steam installation and server paths. You can also manually edit `config.json`:

```json
{
  "language": "en",
  "managerPort": 3000,
  "steamDir": "D:\\Steam",
  "serverDir": "D:\\Steam\\steamapps\\common\\sandstorm_server",
  "gameDir": "D:\\Steam\\steamapps\\common\\sandstorm",
  "playerName": "",
  "steamId": "",
  "gsltToken": "",
  "openaiKey": "",
  "port": 27102,
  "queryPort": 27131
}
```

### GSLT Token (optional but recommended)
A Game Server Login Token enables player name display and XP rewards:
1. Go to https://steamcommunity.com/dev/managegameservers
2. Create a token with App ID **581320**
3. Enter it in the setup wizard or `config.json`

### OpenAI API Key (optional)
For the AI voice assistant, enter your OpenAI API key in setup or `config.json`.

### Player Name
Your player name is auto-detected from the server log when you first connect. No manual configuration needed.

## Security Notice

This application is designed for **local use only** (localhost). It has no authentication system. If you want to expose it externally:
- Add authentication (e.g., basic auth or session-based login)
- Use a reverse proxy (nginx/caddy) with HTTPS
- Never expose API keys or GSLT tokens

## Adding Languages

Copy `lang/en.json` to `lang/xx.json` and translate the values. Then select your language in the setup wizard.

## Tech Stack
- **Backend**: Node.js + Express + WebSocket
- **Frontend**: Vanilla HTML/CSS/JavaScript (no framework)
- **APIs**: Steam Web API, OpenAI Realtime API, mod.io

## Screenshots

| Server Control | Player Stats |
|---|---|
| ![Server](screenshots/server.png) | ![Player](screenshots/player.png) |

| Community Feed | Setup Wizard |
|---|---|
| ![Community](screenshots/community.png) | ![Setup](screenshots/setup.png) |

> **Want to contribute screenshots?** Take them while the app is running, add them to a `screenshots/` folder, and open a pull request.

## Feedback & Contributing

Found a bug? Have an idea for a new feature?

- **[Open an Issue](https://github.com/Ans777/insurgency-sandstorm-server-manager/issues)** — bug reports and feature requests
- **[Start a Discussion](https://github.com/Ans777/insurgency-sandstorm-server-manager/discussions)** — questions, ideas, show & tell
- **Pull requests are welcome** — fork the repo, make your changes, and submit a PR

If you find the project useful, a ⭐ on GitHub helps others discover it!

## Built With

This project was built entirely using **[Claude Code](https://claude.ai/code)** — Anthropic's AI coding assistant. From the first line of server code to the gamification system, Steam integration, AI assistant, and this documentation — everything was developed in collaboration with Claude over the course of three days.

> A real-world example of what's possible when domain knowledge meets AI-assisted development.

## License

MIT License - see [LICENSE](LICENSE)
