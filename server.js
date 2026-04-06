const express = require('express');
const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(express.json());
app.use(express.text());

// ===== CONFIGURATION =====
const CONFIG_FILE = path.join(__dirname, 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {}
  return null;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

function autoDetectSteam() {
  const candidates = [
    'C:\\Program Files (x86)\\Steam',
    'C:\\Program Files\\Steam',
    'D:\\Steam', 'E:\\Steam', 'F:\\Steam',
    'C:\\Steam', 'D:\\SteamLibrary', 'E:\\SteamLibrary',
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'steam.exe')) || fs.existsSync(path.join(dir, 'Steam.exe'))) return dir;
    if (fs.existsSync(path.join(dir, 'steamapps'))) return dir;
  }
  return '';
}

function autoDetectPaths(steamDir) {
  const result = { steamDir, serverDir: '', gameDir: '', modsDir: '', statsSchema: '', userStats: '', steamUserId: '' };
  if (!steamDir) return result;
  const serverDir = path.join(steamDir, 'steamapps', 'common', 'sandstorm_server');
  if (fs.existsSync(serverDir)) result.serverDir = serverDir;
  const gameDir = path.join(steamDir, 'steamapps', 'common', 'sandstorm');
  if (fs.existsSync(gameDir)) result.gameDir = gameDir;
  const modsDir = path.join(gameDir, 'Insurgency', 'Mods', 'modio');
  if (fs.existsSync(modsDir)) result.modsDir = modsDir;
  // Find user stats
  const statsSchema = path.join(steamDir, 'appcache', 'stats', 'UserGameStatsSchema_581320.bin');
  if (fs.existsSync(statsSchema)) result.statsSchema = statsSchema;
  // Find user ID from userdata
  try {
    const userdata = path.join(steamDir, 'userdata');
    if (fs.existsSync(userdata)) {
      const users = fs.readdirSync(userdata).filter(f => /^\d+$/.test(f));
      for (const uid of users) {
        if (fs.existsSync(path.join(userdata, uid, '581320'))) {
          result.steamUserId = uid;
          const userStatsFile = path.join(steamDir, 'appcache', 'stats', `UserGameStats_${uid}_581320.bin`);
          if (fs.existsSync(userStatsFile)) result.userStats = userStatsFile;
          break;
        }
      }
    }
  } catch {}
  return result;
}

// Load or create config
let config = loadConfig();
if (!config) {
  const steamDir = autoDetectSteam();
  const detected = autoDetectPaths(steamDir);
  config = {
    language: 'en',
    managerPort: 3000,
    steamDir: detected.steamDir,
    serverDir: detected.serverDir,
    gameDir: detected.gameDir,
    modsDir: detected.modsDir,
    statsSchema: detected.statsSchema,
    userStats: detected.userStats,
    steamUserId: detected.steamUserId,
    playerName: '',
    steamId: '',
    gsltToken: '',
    openaiKey: '',
    port: 27102,
    queryPort: 27131
  };
  // Do not saveConfig here — wait for user to complete setup wizard
}

let openaiKey = config.openaiKey || process.env.OPENAI_API_KEY || '';

const PORT = config.managerPort || 3000;
const SERVER_DIR = config.serverDir;
const SERVER_EXE = path.join(SERVER_DIR, 'InsurgencyServer.exe');
const CONFIG_DIR = path.join(SERVER_DIR, 'Config', 'Server');
const GAME_INI = path.join(SERVER_DIR, 'Insurgency', 'Saved', 'Config', 'WindowsServer', 'Game.ini');
const MAP_CYCLE = path.join(CONFIG_DIR, 'MapCycle.txt');
const LOG_DIR = path.join(SERVER_DIR, 'Insurgency', 'Saved', 'Logs');
const MODS_DIR = config.modsDir || path.join(config.gameDir, 'Insurgency', 'Mods', 'modio');
const PRESETS_DIR = path.join(__dirname, 'presets');
const BACKUPS_DIR = path.join(__dirname, 'backups');
const STATS_FILE = path.join(__dirname, 'player_stats.json');

// Ensure dirs exist
[PRESETS_DIR, BACKUPS_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Serve language files
app.get('/api/lang/:lang', (req, res) => {
  const langFile = path.join(__dirname, 'lang', path.basename(req.params.lang) + '.json');
  try { res.json(JSON.parse(fs.readFileSync(langFile, 'utf-8'))); } catch { res.json({}); }
});

app.get('/api/lang', (req, res) => {
  try {
    const files = fs.readdirSync(path.join(__dirname, 'lang')).filter(f => f.endsWith('.json'));
    res.json({ ok: true, languages: files.map(f => f.replace('.json', '')), current: config.language });
  } catch { res.json({ ok: false }); }
});

// Config endpoint for frontend
app.get('/api/app-config', (req, res) => {
  res.json({
    playerName: config.playerName || 'Player',
    language: config.language || 'en',
    hasGslt: !!config.gsltToken,
    hasOpenAI: !!openaiKey,
    serverDir: !!config.serverDir,
    gameDir: !!config.gameDir
  });
});

// Setup endpoint
app.get('/setup', (req, res) => {
  res.sendFile(path.join(__dirname, 'setup.html'));
});

app.post('/api/setup', (req, res) => {
  const newConfig = req.body;
  // Re-detect paths if steamDir changed
  if (newConfig.steamDir && newConfig.steamDir !== config.steamDir) {
    const detected = autoDetectPaths(newConfig.steamDir);
    Object.assign(newConfig, detected);
  }
  Object.assign(config, newConfig);
  if (config.openaiKey) openaiKey = config.openaiKey;
  saveConfig(config);
  res.json({ ok: true });
});

// ===== PERSISTENT PLAYER STATS =====
const DEFAULT_STATS = {
  totalKills: 0, totalDeaths: 0, totalGames: 0, totalWins: 0,
  headshotKills: 0, meleeKills: 0, explosiveKills: 0,
  currentStreak: 0, bestStreak: 0, bestGame: 0,
  killsPerMap: {}, killsPerRole: {}, killsPerWeapon: {},
  deathsPerMap: {}, deathsByWeapon: {},
  medals: [], rank: 'Rekrut',
  sessions: [],
  challenges: {},
  killTimestamps: [],
  deathTimestamps: [],
  dailyKills: {}
};

function loadPlayerStats() {
  try {
    if (fs.existsSync(STATS_FILE)) return { ...DEFAULT_STATS, ...JSON.parse(fs.readFileSync(STATS_FILE, 'utf-8')) };
  } catch {}
  return { ...DEFAULT_STATS };
}

function savePlayerStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), 'utf-8');
}

// Rank thresholds
const RANKS = [
  { name: 'Rekrut', kills: 0 },
  { name: 'Menig', kills: 25 },
  { name: 'Konstabel', kills: 50 },
  { name: 'Korporal', kills: 100 },
  { name: 'Sergent', kills: 200 },
  { name: 'Oversergent', kills: 350 },
  { name: 'Løjtnant', kills: 500 },
  { name: 'Kaptajn', kills: 750 },
  { name: 'Major', kills: 1000 },
  { name: 'Oberst', kills: 1500 },
  { name: 'General', kills: 2500 },
  { name: 'Feltmarskal', kills: 5000 },
];

// Medal definitions
const MEDAL_DEFS = [
  // Kill milestones
  { id: 'first_blood', name: 'F\u00f8rste Blod', desc: 'Dit allerf\u00f8rste kill', icon: '&#127919;', condition: s => s.totalKills >= 1 },
  { id: 'ten_kills', name: 'Skarpskytte', desc: '10 kills i alt', icon: '&#9876;', condition: s => s.totalKills >= 10 },
  { id: 'fifty_kills', name: 'Veteran', desc: '50 kills i alt', icon: '&#11088;', condition: s => s.totalKills >= 50 },
  { id: 'hundred_kills', name: 'Centurion', desc: '100 kills i alt', icon: '&#127942;', condition: s => s.totalKills >= 100 },
  { id: 'twofifty_kills', name: 'Kriger', desc: '250 kills i alt', icon: '&#9876;&#9876;', condition: s => s.totalKills >= 250 },
  { id: 'fivehundred_kills', name: 'Krigsherre', desc: '500 kills i alt', icon: '&#9813;', condition: s => s.totalKills >= 500 },
  { id: 'thousand_kills', name: 'Legende', desc: '1000 kills i alt', icon: '&#9812;', condition: s => s.totalKills >= 1000 },
  { id: 'twothousand_kills', name: 'Mytisk', desc: '2000 kills i alt', icon: '&#9812;&#9812;', condition: s => s.totalKills >= 2000 },
  { id: 'fivethousand_kills', name: 'Gud', desc: '5000 kills i alt', icon: '&#9812;&#9812;&#9812;', condition: s => s.totalKills >= 5000 },
  { id: 'tenthousand_kills', name: 'Udd\u00f8delig', desc: '10.000 kills i alt', icon: '&#8734;', condition: s => s.totalKills >= 10000 },

  // Kill streaks
  { id: 'streak_5', name: 'Ustoppelig', desc: '5 kills i tr\u00e6k', icon: '&#128293;', condition: s => s.bestStreak >= 5 },
  { id: 'streak_10', name: 'Ramboen', desc: '10 kills i tr\u00e6k', icon: '&#128165;', condition: s => s.bestStreak >= 10 },
  { id: 'streak_20', name: 'D\u00f8dsmaskinen', desc: '20 kills i tr\u00e6k', icon: '&#9760;', condition: s => s.bestStreak >= 20 },
  { id: 'streak_50', name: 'Uovervindelig', desc: '50 kills i tr\u00e6k', icon: '&#9760;&#9760;', condition: s => s.bestStreak >= 50 },
  { id: 'streak_100', name: 'Uh\u00f8rt', desc: '100 kills i tr\u00e6k', icon: '&#9760;&#9760;&#9760;', condition: s => s.bestStreak >= 100 },

  // Session records
  { id: 'best_game_10', name: 'Slagmarken', desc: '10+ kills i \u00e9n session', icon: '&#9733;', condition: s => s.bestGame >= 10 },
  { id: 'best_game_25', name: 'Massaker', desc: '25+ kills i \u00e9n session', icon: '&#9733;&#9733;', condition: s => s.bestGame >= 25 },
  { id: 'best_game_50', name: 'Apokalypse', desc: '50+ kills i \u00e9n session', icon: '&#9762;', condition: s => s.bestGame >= 50 },
  { id: 'best_game_100', name: 'Ragnarok', desc: '100+ kills i \u00e9n session', icon: '&#9762;&#9762;', condition: s => s.bestGame >= 100 },
  { id: 'best_game_200', name: 'Armageddon', desc: '200+ kills i \u00e9n session', icon: '&#9762;&#9762;&#9762;', condition: s => s.bestGame >= 200 },

  // K/D ratio
  { id: 'survivor', name: 'Overleveren', desc: 'K/D over 3.0 (min 50 kills)', icon: '&#9879;', condition: s => s.totalKills >= 50 && s.totalDeaths > 0 && (s.totalKills / s.totalDeaths) >= 3 },
  { id: 'kd_5', name: 'Pr\u00e6cision', desc: 'K/D over 5.0 (min 100 kills)', icon: '&#9879;&#9879;', condition: s => s.totalKills >= 100 && s.totalDeaths > 0 && (s.totalKills / s.totalDeaths) >= 5 },
  { id: 'kd_10', name: 'Perfektionist', desc: 'K/D over 10.0 (min 200 kills)', icon: '&#9879;&#9879;&#9879;', condition: s => s.totalKills >= 200 && s.totalDeaths > 0 && (s.totalKills / s.totalDeaths) >= 10 },

  // Weapon mastery (top weapon 50+ kills)
  { id: 'weapon_master_50', name: 'V\u00e5benmester', desc: '50+ kills med \u00e9t v\u00e5ben', icon: '&#9876;', condition: s => s.killsPerWeapon && Object.values(s.killsPerWeapon).some(v => v >= 50) },
  { id: 'weapon_master_100', name: 'V\u00e5benekspert', desc: '100+ kills med \u00e9t v\u00e5ben', icon: '&#9876;&#9876;', condition: s => s.killsPerWeapon && Object.values(s.killsPerWeapon).some(v => v >= 100) },
  { id: 'weapon_master_500', name: 'V\u00e5bengud', desc: '500+ kills med \u00e9t v\u00e5ben', icon: '&#9876;&#9876;&#9876;', condition: s => s.killsPerWeapon && Object.values(s.killsPerWeapon).some(v => v >= 500) },

  // Weapon variety
  { id: 'arsenal_5', name: 'Arsenal', desc: 'Kills med 5 forskellige v\u00e5ben', icon: '&#9733;', condition: s => s.killsPerWeapon && Object.keys(s.killsPerWeapon).length >= 5 },
  { id: 'arsenal_10', name: 'V\u00e5benlager', desc: 'Kills med 10 forskellige v\u00e5ben', icon: '&#9733;&#9733;', condition: s => s.killsPerWeapon && Object.keys(s.killsPerWeapon).length >= 10 },
  { id: 'arsenal_20', name: 'V\u00e5bensamler', desc: 'Kills med 20 forskellige v\u00e5ben', icon: '&#9733;&#9733;&#9733;', condition: s => s.killsPerWeapon && Object.keys(s.killsPerWeapon).length >= 20 },

  // Map mastery
  { id: 'map_master_100', name: 'Kartograf', desc: '100+ kills p\u00e5 \u00e9t map', icon: '&#9873;', condition: s => s.killsPerMap && Object.values(s.killsPerMap).some(v => v >= 100) },
  { id: 'map_master_500', name: 'Territoriumsherre', desc: '500+ kills p\u00e5 \u00e9t map', icon: '&#9873;&#9873;', condition: s => s.killsPerMap && Object.values(s.killsPerMap).some(v => v >= 500) },
  { id: 'map_master_1000', name: 'Lokal Legende', desc: '1000+ kills p\u00e5 \u00e9t map', icon: '&#9873;&#9873;&#9873;', condition: s => s.killsPerMap && Object.values(s.killsPerMap).some(v => v >= 1000) },
  { id: 'globe_5', name: 'Globetrotter', desc: 'Kills p\u00e5 5 forskellige maps', icon: '&#9992;', condition: s => s.killsPerMap && Object.keys(s.killsPerMap).length >= 5 },
  { id: 'globe_10', name: 'Verdensrejsende', desc: 'Kills p\u00e5 10 forskellige maps', icon: '&#9992;&#9992;', condition: s => s.killsPerMap && Object.keys(s.killsPerMap).length >= 10 },

  // Sessions
  { id: 'ten_games', name: 'Stamg\u00e6st', desc: '10 sessions spillet', icon: '&#9654;', condition: s => s.sessions.length >= 10 },
  { id: 'fifty_games', name: 'H\u00e6rdet', desc: '50 sessions spillet', icon: '&#9654;&#9654;', condition: s => s.sessions.length >= 50 },
  { id: 'hundred_games', name: 'Livstidskriger', desc: '100 sessions spillet', icon: '&#9654;&#9654;&#9654;', condition: s => s.sessions.length >= 100 },
];

function updateRankAndMedals(stats) {
  // Update rank
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (stats.totalKills >= RANKS[i].kills) { stats.rank = RANKS[i].name; break; }
  }
  // Check medals
  MEDAL_DEFS.forEach(m => {
    if (!stats.medals.includes(m.id) && m.condition(stats)) {
      stats.medals.push(m.id);
    }
  });
  return stats;
}

let serverProcess = null;
let serverLog = [];
const MAX_LOG_LINES = 500;

function serverWeaponName(raw) {
  if (!raw) return '';
  return raw.replace(/^(Firearm|Projectile)_/, '').replace(/_/g, ' ');
}

function recordKillServerSide(victimRole, map, weapon) {
  const stats = loadPlayerStats();
  stats.totalKills++;
  stats.currentStreak++;
  if (stats.currentStreak > stats.bestStreak) stats.bestStreak = stats.currentStreak;
  if (victimRole) stats.killsPerRole[victimRole] = (stats.killsPerRole[victimRole] || 0) + 1;
  if (map) stats.killsPerMap[map] = (stats.killsPerMap[map] || 0) + 1;
  if (weapon) { if (!stats.killsPerWeapon) stats.killsPerWeapon = {}; stats.killsPerWeapon[weapon] = (stats.killsPerWeapon[weapon] || 0) + 1; }
  const today = new Date().toISOString().slice(0, 10);
  if (!stats.dailyKills) stats.dailyKills = {};
  if (!stats.dailyKills[today]) stats.dailyKills[today] = { kills: 0, deaths: 0 };
  stats.dailyKills[today].kills++;
  if (!stats.killTimestamps) stats.killTimestamps = [];
  stats.killTimestamps.push(new Date().toISOString());
  if (!stats._currentSession) { stats._currentSession = { date: new Date().toISOString(), kills: 0, deaths: 0, map: map || '', topWeapon: '' }; stats.sessions.push(stats._currentSession); }
  stats._currentSession.kills++;
  if (map) stats._currentSession.map = map;
  if (weapon) { stats._currentSession._weapons = stats._currentSession._weapons || {}; stats._currentSession._weapons[weapon] = (stats._currentSession._weapons[weapon] || 0) + 1; stats._currentSession.topWeapon = Object.entries(stats._currentSession._weapons).sort((a,b)=>b[1]-a[1])[0][0]; }
  if (stats._currentSession.kills > stats.bestGame) stats.bestGame = stats._currentSession.kills;
  const prevRank = stats.rank;
  const prevMedals = [...stats.medals];
  updateRankAndMedals(stats);
  savePlayerStats(stats);
  const newMedals = stats.medals.filter(m => !prevMedals.includes(m));
  const rankedUp = stats.rank !== prevRank;
  if (serverProcess && serverProcess.exitCode === null) {
    const pName = config.playerName || 'Player';
    if (rankedUp) { try { serverProcess.stdin.write(`say ${pName} promoted to ${stats.rank}!\n`); } catch {} }
    newMedals.forEach(mId => { const medal = MEDAL_DEFS.find(m => m.id === mId); if (medal) { try { serverProcess.stdin.write(`say ${pName} earned medal: ${medal.name}!\n`); } catch {} } });
    if (stats.currentStreak > 0 && stats.currentStreak % 10 === 0) { try { serverProcess.stdin.write(`say ${pName} has a ${stats.currentStreak} KILL STREAK!\n`); } catch {} }
  }
}

function recordDeathServerSide(weapon, map) {
  const stats = loadPlayerStats();
  stats.totalDeaths++;
  stats.currentStreak = 0;
  if (weapon) { if (!stats.deathsByWeapon) stats.deathsByWeapon = {}; stats.deathsByWeapon[weapon] = (stats.deathsByWeapon[weapon] || 0) + 1; }
  if (!stats.deathTimestamps) stats.deathTimestamps = [];
  stats.deathTimestamps.push(new Date().toISOString());
  if (map) { if (!stats.deathsPerMap) stats.deathsPerMap = {}; stats.deathsPerMap[map] = (stats.deathsPerMap[map] || 0) + 1; }
  if (stats._currentSession) stats._currentSession.deaths++;
  const today = new Date().toISOString().slice(0, 10);
  if (!stats.dailyKills) stats.dailyKills = {};
  if (!stats.dailyKills[today]) stats.dailyKills[today] = { kills: 0, deaths: 0 };
  stats.dailyKills[today].deaths++;
  updateRankAndMedals(stats);
  savePlayerStats(stats);
}

// Auto-restart state
let autoRestart = false;
let lastStartParams = null;

// Serve the frontend
app.get('/', (req, res) => {
  if (!fs.existsSync(CONFIG_FILE)) return res.redirect('/setup');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Server status
app.get('/api/status', (req, res) => {
  const running = serverProcess !== null && serverProcess.exitCode === null;
  res.json({ running, pid: running ? serverProcess.pid : null, autoRestart });
});

// Internal function to start the server
function startServerProcess(params) {
  const {
    map = 'Farmhouse',
    scenario = 'Scenario_Farmhouse_Checkpoint_Security',
    maxPlayers = 8,
    port = 27102,
    noSteam = false,
    useMapCycle = true,
    mutators = [],
    mods = []
  } = params;

  let travelUrl = `${map}?Scenario=${scenario}?MaxPlayers=${maxPlayers}?listen`;
  if (mutators.length > 0) {
    travelUrl += `?Mutators=${mutators.join(',')}`;
  }

  const gslt = params.gslt || config.gsltToken || '';
  const qPort = config.queryPort || 27131;
  const args = [travelUrl, `-Port=${port}`, `-QueryPort=${qPort}`, '-log', '-LogCmds=LogGameplayEvents Log'];
  if (gslt) { args.push(`-GSLTToken=${gslt}`); args.push('-GameStats'); }
  if (noSteam) args.push('-NOSTEAM');
  if (useMapCycle) args.push('-MapCycle=MapCycle');
  if (mods.length > 0) {
    args.push('-Mods');
    args.push(`-ModList=${mods.join(',')}`);
  }

  serverLog = [];
  lastStartParams = params;

  serverProcess = spawn(SERVER_EXE, args, { cwd: SERVER_DIR, stdio: ['pipe', 'pipe', 'pipe'] });

  const captureOutput = (stream) => {
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      const entry = `[${new Date().toLocaleTimeString('da-DK')}] ${line}`;
      serverLog.push(entry);
      if (serverLog.length > MAX_LOG_LINES) serverLog.shift();
    });
  };

  captureOutput(serverProcess.stdout);
  captureOutput(serverProcess.stderr);

  // Tail the log file for LogGameplayEvents (not sent to stdout)
  const logFile = path.join(LOG_DIR, 'Insurgency.log');
  // Start from beginning of file to catch ALL events from this session
  let logFileSize = 0;
  // Track already-seen lines to avoid duplicates after restart
  const seenLogLines = new Set();

  const readNewLogLines = () => {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size <= logFileSize) {
        // File was truncated/rotated - reset
        if (stat.size < logFileSize) logFileSize = 0;
        return;
      }
      const fd = fs.openSync(logFile, 'r');
      const readSize = Math.min(stat.size - logFileSize, 1024 * 1024); // Max 1MB per read
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, logFileSize);
      fs.closeSync(fd);
      logFileSize += readSize;
      let text = buf.toString('utf-8');
      if (text.includes('\ufffd')) text = buf.toString('latin1');
      const newLines = text.split('\n').filter(l => l.trim());
      newLines.forEach(line => {
        // Auto-detect player name from login event
        if (!config.playerName || !config.steamId) {
          const loginMatch = line.match(/Login request:.*Name=(.+?)\s+userId:\s*SteamNWI:(\d+)/);
          if (loginMatch) {
            config.playerName = loginMatch[1].trim();
            config.steamId = loginMatch[2];
            saveConfig(config);
          }
        }
        if (/LogGameplayEvents/.test(line)) {
          // Dedup using the original timestamp from the log
          const lineKey = line.substring(0, 40);
          if (seenLogLines.has(lineKey)) return;
          seenLogLines.add(lineKey);
          if (seenLogLines.size > 2000) {
            const first = seenLogLines.values().next().value;
            seenLogLines.delete(first);
          }
          const clean = line.replace(/^\[[\d.\-:]+\]\[\s*\d+\]/, '').trim();
          const entry = `[${new Date().toLocaleTimeString('da-DK')}] ${clean}`;
          serverLog.push(entry);
          if (serverLog.length > MAX_LOG_LINES) serverLog.shift();

          // New round → save current session and start fresh
          if (/Display: Round \d+ started/.test(clean)) {
            const stats = loadPlayerStats();
            if (stats._currentSession && stats._currentSession.kills > 0) {
              stats._currentSession = null;
              stats.totalGames++;
              savePlayerStats(stats);
            }
          }

          // Server-side kill/death tracking
          if (config.playerName) {
            const killMatch = clean.match(/Display:\s+(.+?)\s+killed\s+(.+?)\s+with\s+BP_(\w+?)_C/);
            if (killMatch) {
              const killerStr = killMatch[1].trim();
              const victimStr = killMatch[2].trim();
              const rawWeapon = killMatch[3];
              const pNameEsc = config.playerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const isYourKill = new RegExp(pNameEsc).test(killerStr);
              const youDied = new RegExp(pNameEsc).test(victimStr);
              const isEnemyVictim = /team 1/.test(victimStr);
              const map = lastStartParams ? lastStartParams.map : '';
              const weapon = serverWeaponName(rawWeapon);
              if (isYourKill && isEnemyVictim) {
                const role = victimStr.replace(/\[.*?\]/g, '').trim();
                recordKillServerSide(role, map, weapon);
              } else if (youDied) {
                recordDeathServerSide(weapon, map);
              }
            }
          }
        }
      });
    } catch {}
  };

  // Read immediately to catch events already in the file
  readNewLogLines();

  const logWatcher = setInterval(() => {
    if (!serverProcess || serverProcess.exitCode !== null) {
      clearInterval(logWatcher);
      return;
    }
    readNewLogLines();
  }, 500);

  serverProcess.on('close', (code) => {
    const ts = new Date().toLocaleTimeString('da-DK');
    serverLog.push(`[${ts}] Server stoppet (exit code: ${code})`);
    const pid = serverProcess ? serverProcess.pid : null;
    serverProcess = null;

    // Auto-restart on crash
    if (autoRestart && code !== 0 && lastStartParams) {
      serverLog.push(`[${ts}] Auto-restart aktiveret - genstarter om 5 sekunder...`);
      setTimeout(() => {
        if (!serverProcess) {
          try {
            startServerProcess(lastStartParams);
            serverLog.push(`[${new Date().toLocaleTimeString('da-DK')}] Server genstartet automatisk`);
          } catch (err) {
            serverLog.push(`[${new Date().toLocaleTimeString('da-DK')}] Auto-restart fejlede: ${err.message}`);
          }
        }
      }, 5000);
    }
  });

  serverProcess.on('error', (err) => {
    serverLog.push(`[${new Date().toLocaleTimeString('da-DK')}] FEJL: ${err.message}`);
    serverProcess = null;
  });

  return { pid: serverProcess.pid, args };
}

// Start server
app.post('/api/start', (req, res) => {
  if (serverProcess && serverProcess.exitCode === null) {
    return res.json({ ok: false, error: 'Server kører allerede' });
  }
  try {
    const result = startServerProcess(req.body || {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Stop server
app.post('/api/stop', (req, res) => {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return res.json({ ok: false, error: 'Server kører ikke' });
  }
  try {
    execSync(`taskkill /PID ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
    serverProcess = null;
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Change map - stop and restart with new map
app.post('/api/server/changemap', (req, res) => {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return res.json({ ok: false, error: 'Server kører ikke' });
  }
  if (!lastStartParams) {
    return res.json({ ok: false, error: 'Ingen start-parametre tilgængelige' });
  }
  const { map, mode, side } = req.body;
  if (!map) return res.json({ ok: false, error: 'Map mangler' });
  const newParams = {
    ...lastStartParams,
    map,
    scenario: `Scenario_${map}_${mode || 'Checkpoint'}_${side || 'Security'}`
  };
  try {
    execSync(`taskkill /PID ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
    serverProcess = null;
  } catch {}
  res.json({ ok: true });
  setTimeout(() => {
    if (!serverProcess) {
      try { startServerProcess(newParams); } catch {}
    }
  }, 2000);
});

// Toggle auto-restart
app.post('/api/autorestart', (req, res) => {
  autoRestart = !!req.body.enabled;
  res.json({ ok: true, autoRestart });
});

// RCON - send command to server stdin
app.post('/api/rcon', (req, res) => {
  if (!serverProcess || serverProcess.exitCode !== null) {
    return res.json({ ok: false, error: 'Server kører ikke' });
  }
  const cmd = req.body.command;
  if (!cmd) return res.json({ ok: false, error: 'Ingen kommando angivet' });
  try {
    serverProcess.stdin.write(cmd + '\n');
    serverLog.push(`[${new Date().toLocaleTimeString('da-DK')}] > RCON: ${cmd}`);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Server stats (CPU/RAM)
app.get('/api/stats', (req, res) => {
  if (!serverProcess || serverProcess.exitCode === null === false) {
    // Check if process is actually running
    if (!serverProcess || serverProcess.exitCode !== null) {
      return res.json({ ok: false, error: 'Server kører ikke' });
    }
  }
  const pid = serverProcess.pid;
  try {
    const wmicOut = execSync(
      `wmic process where "ProcessId=${pid}" get WorkingSetSize,KernelModeTime,UserModeTime /format:csv`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const lines = wmicOut.trim().split('\n').filter(l => l.trim());
    if (lines.length >= 2) {
      const headers = lines[0].split(',').map(h => h.trim());
      const values = lines[lines.length - 1].split(',').map(v => v.trim());
      const data = {};
      headers.forEach((h, i) => { data[h] = values[i]; });
      const ramMB = Math.round(parseInt(data.WorkingSetSize || 0) / 1024 / 1024);
      res.json({ ok: true, pid, ramMB });
    } else {
      res.json({ ok: true, pid, ramMB: 0 });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Get live log
app.get('/api/log', (req, res) => {
  const since = parseInt(req.query.since) || 0;
  res.json({ lines: serverLog.slice(since), total: serverLog.length });
});

// Read game.ini
app.get('/api/config/game', (req, res) => {
  try {
    res.json({ ok: true, content: fs.readFileSync(GAME_INI, 'utf-8') });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Save game.ini
app.post('/api/config/game', (req, res) => {
  try {
    fs.writeFileSync(GAME_INI, req.body, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Read MapCycle
app.get('/api/config/mapcycle', (req, res) => {
  try {
    res.json({ ok: true, content: fs.readFileSync(MAP_CYCLE, 'utf-8') });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Save MapCycle
app.post('/api/config/mapcycle', (req, res) => {
  try {
    fs.writeFileSync(MAP_CYCLE, req.body, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== PRESETS =====
app.get('/api/presets', (req, res) => {
  try {
    const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
    const presets = files.map(f => {
      const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf-8'));
      return { id: f.replace('.json', ''), ...data };
    });
    res.json({ ok: true, presets });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/presets', (req, res) => {
  try {
    const { name, ...settings } = req.body;
    const id = name.toLowerCase().replace(/[^a-z0-9æøå]/g, '_').replace(/_+/g, '_');
    const filePath = path.join(PRESETS_DIR, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ name, ...settings }, null, 2), 'utf-8');
    res.json({ ok: true, id });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.delete('/api/presets/:id', (req, res) => {
  try {
    const filePath = path.join(PRESETS_DIR, `${path.basename(req.params.id)}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== BACKUPS =====
app.get('/api/backups', (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR).filter(f => f.endsWith('.json'));
    const backups = files.map(f => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { id: f.replace('.json', ''), name: f, created: stat.mtime };
    }).sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ ok: true, backups });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/backup', (req, res) => {
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backup = {
      timestamp,
      gameIni: fs.readFileSync(GAME_INI, 'utf-8'),
      mapCycle: fs.readFileSync(MAP_CYCLE, 'utf-8')
    };
    const filePath = path.join(BACKUPS_DIR, `backup_${timestamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(backup, null, 2), 'utf-8');
    res.json({ ok: true, id: `backup_${timestamp}` });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/restore/:id', (req, res) => {
  try {
    const filePath = path.join(BACKUPS_DIR, `${path.basename(req.params.id)}.json`);
    const backup = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    fs.writeFileSync(GAME_INI, backup.gameIni, 'utf-8');
    fs.writeFileSync(MAP_CYCLE, backup.mapCycle, 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== MODS =====
const MODS_FILE = path.join(__dirname, 'mods.json');

app.get('/api/mods', (req, res) => {
  try {
    if (fs.existsSync(MODS_FILE)) {
      res.json({ ok: true, mods: JSON.parse(fs.readFileSync(MODS_FILE, 'utf-8')) });
    } else {
      res.json({ ok: true, mods: [] });
    }
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.post('/api/mods', (req, res) => {
  try {
    fs.writeFileSync(MODS_FILE, JSON.stringify(req.body.mods || [], null, 2), 'utf-8');
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Scan installed mod.io mods
app.get('/api/mods/installed', (req, res) => {
  try {
    const dirs = fs.readdirSync(MODS_DIR).filter(f => {
      try { return fs.statSync(path.join(MODS_DIR, f)).isDirectory(); } catch { return false; }
    });
    const installed = dirs.map(id => {
      try {
        const raw = fs.readFileSync(path.join(MODS_DIR, id, 'State.json'));
        let json;
        try { json = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch {
          json = JSON.parse(raw.toString('utf16le').replace(/^\uFEFF/, ''));
        }
        return {
          id,
          name: json.name || id,
          summary: (json.summary || '').slice(0, 100),
          thumb: json.logo?.thumb_640x360 || ''
        };
      } catch {
        const paks = fs.readdirSync(path.join(MODS_DIR, id)).filter(f => f.endsWith('.pak'));
        const name = paks[0] ? paks[0].replace(/pakchunk.*$/, '') : id;
        return { id, name, summary: '', thumb: '' };
      }
    });
    res.json({ ok: true, installed });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== LAUNCH GAME =====
// Connect to running dedicated server
app.post('/api/launch-game', (req, res) => {
  const port = req.body.port || 27102;
  try {
    exec(`start "" "steam://run/581320//+connect%20127.0.0.1:${port}"`, { shell: true });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Launch local play via Steam (friendly bots + rewards)
app.post('/api/launch-local', (req, res) => {
  const {
    map = 'Farmhouse',
    scenario = 'Scenario_Farmhouse_Checkpoint_Security',
    maxPlayers = 8,
    mutators = []
  } = req.body || {};

  let travelParams = `${map}?Scenario=${scenario}?MaxPlayers=${maxPlayers}?bBots=true?listen`;
  if (mutators.length > 0) {
    travelParams += `?Mutators=${mutators.join(',')}`;
  }

  // Encode for steam:// URL - launch through Steam for rewards
  const encoded = encodeURIComponent(travelParams);
  try {
    exec(`start "" "steam://run/581320//${encoded}"`, { shell: true });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Get recent log files from disk
app.get('/api/logfiles', (req, res) => {
  try {
    const files = fs.readdirSync(LOG_DIR)
      .filter(f => f.endsWith('.log'))
      .map(f => ({
        name: f,
        size: fs.statSync(path.join(LOG_DIR, f)).size,
        modified: fs.statSync(path.join(LOG_DIR, f)).mtime
      }))
      .sort((a, b) => b.modified - a.modified)
      .slice(0, 10);
    res.json({ ok: true, files });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// Read a specific log file (last N lines)
app.get('/api/logfiles/:name', (req, res) => {
  try {
    const filePath = path.join(LOG_DIR, path.basename(req.params.name));
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').slice(-200);
    res.json({ ok: true, lines });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== ACHIEVEMENTS =====
const STATS_SCHEMA = config.statsSchema || '';
const USER_STATS = config.userStats || '';

let achievementCache = null;
let achievementCacheTime = 0;

app.get('/api/achievements', (req, res) => {
  try {
    // Cache achievements for 10 seconds
    if (achievementCache && Date.now() - achievementCacheTime < 10000) {
      return res.json(achievementCache);
    }
    const buf = fs.readFileSync(STATS_SCHEMA);
    const achievements = [];
    let searchPos = 0;

    function findStr(buf, start, label) {
      const tag = Buffer.from(label + '\x00', 'latin1');
      const idx = buf.indexOf(tag, start);
      if (idx === -1) return { val: '', end: start };
      const s = idx + tag.length;
      const e = buf.indexOf(0, s);
      return { val: buf.toString('utf8', s, e), end: e };
    }

    while (true) {
      const nameTag = Buffer.from('name\x00ACH_', 'latin1');
      const idx = buf.indexOf(nameTag, searchPos);
      if (idx === -1) break;
      const nameStart = idx + 5;
      const nameEnd = buf.indexOf(0, nameStart);
      const achId = buf.toString('latin1', nameStart, nameEnd);

      const dispTag = buf.indexOf(Buffer.from('display\x00', 'latin1'), nameEnd);
      if (dispTag === -1) break;
      const eng = findStr(buf, dispTag, 'english');
      const da = findStr(buf, eng.end, 'danish');
      const displayName = da.val || eng.val;

      const descTag = buf.indexOf(Buffer.from('desc\x00', 'latin1'), eng.end);
      let desc = '';
      if (descTag !== -1 && descTag < eng.end + 2000) {
        const descEng = findStr(buf, descTag, 'english');
        const descDa = findStr(buf, descEng.end, 'danish');
        desc = descDa.val || descEng.val;
      }

      achievements.push({ id: achId, name: displayName, desc });
      searchPos = nameEnd + 1;
    }

    // Parse unlocked
    const stats = fs.readFileSync(USER_STATS);
    const statsStr = stats.toString('latin1');
    const idRe = /\x02(\d+)\x00/g;
    let m;
    const unlockedIds = new Set();
    while ((m = idRe.exec(statsStr)) !== null) {
      if (m[1].length <= 3 && parseInt(m[1]) > 0) unlockedIds.add(parseInt(m[1]));
    }

    const result = achievements.map((a, i) => ({
      ...a,
      unlocked: unlockedIds.has(i + 1),
      index: i + 1
    }));

    const unlocked = result.filter(a => a.unlocked).length;
    achievementCache = { ok: true, achievements: result, total: result.length, unlocked };
    achievementCacheTime = Date.now();
    res.json(achievementCache);
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ===== CHALLENGES =====
const CHALLENGES_FILE = path.join(__dirname, 'challenges.json');

const CHALLENGE_TEMPLATES = [
  { id: 'pistol_master', name: 'Pistol Mester', desc: 'Få {target} kills med pistol', targetKey: 'pistolKills', target: 20, icon: '&#9876;', map: null },
  { id: 'farmhouse_domination', name: 'Farmhouse Dominans', desc: 'Få {target} kills på Farmhouse', targetKey: 'mapKills', target: 30, icon: '&#9733;', map: 'Farmhouse' },
  { id: 'ministry_cleaner', name: 'Ministry Renser', desc: 'Få {target} kills på Ministry', targetKey: 'mapKills', target: 30, icon: '&#9733;', map: 'Ministry' },
  { id: 'hideout_hunter', name: 'Hideout Jæger', desc: 'Få {target} kills på Hideout', targetKey: 'mapKills', target: 30, icon: '&#9733;', map: 'Hideout' },
  { id: 'streak_hunter', name: 'Streak Jæger', desc: 'Opnå en kill streak på {target}', targetKey: 'bestStreak', target: 10, icon: '&#128293;', map: null },
  { id: 'survivor_run', name: 'Overlever', desc: 'Gennemfør en session med max {target} deaths', targetKey: 'lowDeaths', target: 3, icon: '&#9879;', map: null },
  { id: 'mass_destruction', name: 'Masseødelæggelse', desc: 'Få {target} kills i én session', targetKey: 'sessionKills', target: 40, icon: '&#9760;', map: null },
  { id: 'globe_trotter', name: 'Globetrotter', desc: 'Få kills på {target} forskellige maps', targetKey: 'uniqueMaps', target: 5, icon: '&#9992;', map: null },
  { id: 'centurion_session', name: 'Centurion Session', desc: 'Få {target} kills i én session', targetKey: 'sessionKills', target: 100, icon: '&#9812;', map: null },
  { id: 'kd_king', name: 'K/D Konge', desc: 'Opnå K/D ratio på {target} i en session (min 10 kills)', targetKey: 'sessionKD', target: 5, icon: '&#9813;', map: null },
];

function loadChallenges() {
  try {
    if (fs.existsSync(CHALLENGES_FILE)) return JSON.parse(fs.readFileSync(CHALLENGES_FILE, 'utf-8'));
  } catch {}
  return { active: [], completed: [] };
}

function saveChallenges(data) {
  fs.writeFileSync(CHALLENGES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

app.get('/api/challenges', (req, res) => {
  const data = loadChallenges();
  res.json({ ok: true, ...data, templates: CHALLENGE_TEMPLATES });
});

app.post('/api/challenges/activate', (req, res) => {
  const { id, customTarget } = req.body;
  const template = CHALLENGE_TEMPLATES.find(t => t.id === id);
  if (!template) return res.json({ ok: false, error: 'Ukendt challenge' });
  const data = loadChallenges();
  if (data.active.find(c => c.id === id)) return res.json({ ok: false, error: 'Allerede aktiv' });
  const target = customTarget || template.target;
  data.active.push({
    ...template, target, progress: 0,
    startedAt: new Date().toISOString(),
    desc: template.desc.replace('{target}', target)
  });
  saveChallenges(data);
  res.json({ ok: true });
});

app.post('/api/challenges/deactivate', (req, res) => {
  const data = loadChallenges();
  data.active = data.active.filter(c => c.id !== req.body.id);
  saveChallenges(data);
  res.json({ ok: true });
});

app.post('/api/challenges/progress', (req, res) => {
  const { killRole, killMap, sessionKills, sessionDeaths, currentStreak } = req.body;
  const data = loadChallenges();
  const stats = loadPlayerStats();
  const newlyCompleted = [];

  data.active.forEach(c => {
    let progress = c.progress;
    switch (c.targetKey) {
      case 'mapKills':
        if (killMap && c.map && killMap === c.map) progress++;
        break;
      case 'pistolKills':
        // Can't detect weapon type from logs, count all kills for now
        break;
      case 'bestStreak':
        progress = Math.max(progress, currentStreak || 0);
        break;
      case 'sessionKills':
        progress = sessionKills || 0;
        break;
      case 'lowDeaths':
        progress = sessionDeaths !== undefined ? (sessionDeaths <= c.target ? c.target : sessionDeaths) : progress;
        break;
      case 'uniqueMaps':
        progress = Object.keys(stats.killsPerMap || {}).length;
        break;
      case 'sessionKD':
        if (sessionKills >= 10 && sessionDeaths > 0) progress = Math.max(progress, Math.round(sessionKills / sessionDeaths * 10) / 10);
        break;
    }
    c.progress = progress;
  });

  // Check completions
  data.active = data.active.filter(c => {
    const isComplete = (c.targetKey === 'lowDeaths')
      ? (c.progress <= c.target)
      : (c.progress >= c.target);
    if (isComplete && c.targetKey !== 'lowDeaths') {
      c.completedAt = new Date().toISOString();
      data.completed.push(c);
      newlyCompleted.push(c);
      return false;
    }
    return true;
  });

  saveChallenges(data);
  res.json({ ok: true, active: data.active, newlyCompleted });
});

// ===== DAILY CHALLENGE =====
const DAILY_CHALLENGES = [
  { name: 'Pistolero', desc: 'F\u00e5 10 kills med pistol', targetKey: 'weaponKills', weaponMatch: /PF940|Makarov|M45|M9|L106|MR73|Welrod/, target: 10 },
  { name: 'Sniper Elite', desc: 'F\u00e5 5 kills med sniper', targetKey: 'weaponKills', weaponMatch: /Mosin|SVD|M24|M110/, target: 5 },
  { name: 'Eksplosiv Dag', desc: 'F\u00e5 8 kills med eksplosiver', targetKey: 'weaponKills', weaponMatch: /Projectile|RPG|AT4|M3MAAWS/, target: 8 },
  { name: 'Haglbyge', desc: 'F\u00e5 10 kills med shotgun', targetKey: 'weaponKills', weaponMatch: /M870|KSG|TOZ|Saiga/, target: 10 },
  { name: 'Overlevelse', desc: 'F\u00e5 30 kills med max 3 deaths', targetKey: 'survivalRun', target: 30, maxDeaths: 3 },
  { name: 'Hurtig Finger', desc: 'F\u00e5 en kill streak p\u00e5 15', targetKey: 'streakTarget', target: 15 },
  { name: 'Halvtreds', desc: 'F\u00e5 50 kills i dag', targetKey: 'dailyKills', target: 50 },
  { name: 'Hundrede', desc: 'F\u00e5 100 kills i dag', targetKey: 'dailyKills', target: 100 },
  { name: 'Maskingeværet', desc: 'F\u00e5 15 kills med LMG', targetKey: 'weaponKills', weaponMatch: /M249|PKM|M240/, target: 15 },
  { name: 'Nulstilling', desc: 'Gennemf\u00f8r en session uden at d\u00f8', targetKey: 'zeroDeath', target: 20 },
];

function getDailyChallenge() {
  const today = new Date().toISOString().slice(0, 10);
  // Deterministic daily pick based on date
  const seed = today.split('-').reduce((a, b) => a + parseInt(b), 0);
  return { ...DAILY_CHALLENGES[seed % DAILY_CHALLENGES.length], date: today };
}

app.get('/api/daily-challenge', (req, res) => {
  const dc = getDailyChallenge();
  const stats = loadPlayerStats();
  const today = dc.date;
  const todayKills = (stats.killTimestamps || []).filter(t => t.startsWith(today)).length;
  const todayDeaths = (stats.deathTimestamps || []).filter(t => t.startsWith(today)).length;
  res.json({ ok: true, challenge: dc, todayKills, todayDeaths });
});

// ===== PLAYER GAMIFICATION =====
app.get('/api/playerstats', (req, res) => {
  const stats = loadPlayerStats();
  updateRankAndMedals(stats);
  const nextRank = RANKS.find(r => r.kills > stats.totalKills);
  const currentRank = RANKS.slice().reverse().find(r => stats.totalKills >= r.kills);
  const prevThreshold = currentRank ? currentRank.kills : 0;
  const nextThreshold = nextRank ? nextRank.kills : prevThreshold;
  const progress = nextThreshold > prevThreshold ? Math.round((stats.totalKills - prevThreshold) / (nextThreshold - prevThreshold) * 100) : 100;
  const kd = stats.totalDeaths > 0 ? (stats.totalKills / stats.totalDeaths).toFixed(2) : stats.totalKills.toFixed(2);
  const medalDetails = MEDAL_DEFS.map(m => ({ ...m, unlocked: stats.medals.includes(m.id), condition: undefined }));
  res.json({ ok: true, ...stats, kd, nextRank: nextRank?.name || 'Max', nextRankKills: nextThreshold, rankProgress: progress, medalDetails });
});

app.post('/api/playerstats/kill', (req, res) => {
  const stats = loadPlayerStats();
  const { role, map, weapon } = req.body;
  stats.totalKills++;
  stats.currentStreak++;
  if (stats.currentStreak > stats.bestStreak) stats.bestStreak = stats.currentStreak;
  if (role) stats.killsPerRole[role] = (stats.killsPerRole[role] || 0) + 1;
  if (map) stats.killsPerMap[map] = (stats.killsPerMap[map] || 0) + 1;
  if (weapon) {
    if (!stats.killsPerWeapon) stats.killsPerWeapon = {};
    stats.killsPerWeapon[weapon] = (stats.killsPerWeapon[weapon] || 0) + 1;
  }
  // Track daily kills
  const today = new Date().toISOString().slice(0, 10);
  if (!stats.dailyKills) stats.dailyKills = {};
  if (!stats.dailyKills[today]) stats.dailyKills[today] = { kills: 0, deaths: 0 };
  stats.dailyKills[today].kills++;
  // Track timestamp for heatmap
  if (!stats.killTimestamps) stats.killTimestamps = [];
  stats.killTimestamps.push(new Date().toISOString());
  // Track session kills
  if (stats.sessions.length === 0 || !stats._currentSession) {
    stats._currentSession = { date: new Date().toISOString(), kills: 0, deaths: 0, map: map || '', topWeapon: '' };
    stats.sessions.push(stats._currentSession);
  }
  stats._currentSession.kills++;
  stats._currentSession.map = map || stats._currentSession.map;
  // Track top weapon per session
  const sessionWeapons = {};
  if (weapon) {
    stats._currentSession._weapons = stats._currentSession._weapons || {};
    stats._currentSession._weapons[weapon] = (stats._currentSession._weapons[weapon] || 0) + 1;
    stats._currentSession.topWeapon = Object.entries(stats._currentSession._weapons).sort((a,b) => b[1]-a[1])[0][0];
  }
  if (stats._currentSession.kills > stats.bestGame) stats.bestGame = stats._currentSession.kills;
  const prevRank = stats.rank;
  const prevMedals = [...stats.medals];
  updateRankAndMedals(stats);
  savePlayerStats(stats);

  // Detect new medals and rank ups
  const newMedals = stats.medals.filter(m => !prevMedals.includes(m));
  const rankedUp = stats.rank !== prevRank;

  // RCON announcements
  if (serverProcess && serverProcess.exitCode === null) {
    const pName = config.playerName || 'Player';
    if (rankedUp) {
      try { serverProcess.stdin.write(`say ${pName} promoted to ${stats.rank}!\n`); } catch {}
    }
    newMedals.forEach(mId => {
      const medal = MEDAL_DEFS.find(m => m.id === mId);
      if (medal) {
        try { serverProcess.stdin.write(`say ${pName} earned medal: ${medal.name}!\n`); } catch {}
      }
    });
    if (stats.currentStreak > 0 && stats.currentStreak % 10 === 0) {
      try { serverProcess.stdin.write(`say ${pName} has a ${stats.currentStreak} KILL STREAK!\n`); } catch {}
    }
  }

  res.json({ ok: true, totalKills: stats.totalKills, currentStreak: stats.currentStreak, rank: stats.rank, rankedUp, newMedals });
});

app.post('/api/playerstats/death', (req, res) => {
  const stats = loadPlayerStats();
  const { weapon } = req.body;
  stats.totalDeaths++;
  stats.currentStreak = 0;
  if (weapon) {
    if (!stats.deathsByWeapon) stats.deathsByWeapon = {};
    stats.deathsByWeapon[weapon] = (stats.deathsByWeapon[weapon] || 0) + 1;
  }
  if (!stats.deathTimestamps) stats.deathTimestamps = [];
  stats.deathTimestamps.push(new Date().toISOString());
  // Track deaths per map
  const deathMap = req.body.map;
  if (deathMap) {
    if (!stats.deathsPerMap) stats.deathsPerMap = {};
    stats.deathsPerMap[deathMap] = (stats.deathsPerMap[deathMap] || 0) + 1;
  }
  if (stats._currentSession) stats._currentSession.deaths++;
  // Track daily deaths
  const deathDay = new Date().toISOString().slice(0, 10);
  if (!stats.dailyKills) stats.dailyKills = {};
  if (!stats.dailyKills[deathDay]) stats.dailyKills[deathDay] = { kills: 0, deaths: 0 };
  stats.dailyKills[deathDay].deaths++;
  updateRankAndMedals(stats);
  savePlayerStats(stats);
  res.json({ ok: true, totalDeaths: stats.totalDeaths });
});

app.post('/api/playerstats/session', (req, res) => {
  const stats = loadPlayerStats();
  stats.totalGames++;
  stats._currentSession = null;
  updateRankAndMedals(stats);
  savePlayerStats(stats);
  res.json({ ok: true });
});

// ===== GLOBAL STATS (Steam API) =====
let globalStatsCache = null;
let globalStatsCacheTime = 0;

app.get('/api/global-stats', (req, res) => {
  if (globalStatsCache && Date.now() - globalStatsCacheTime < 300000) {
    return res.json(globalStatsCache);
  }

  let pending = 3;
  let playerCount = 0;
  let achievements = [];
  let chartData = null;

  const done = () => {
    pending--;
    if (pending > 0) return;
    // Load local player stats for comparison
    const localStats = loadPlayerStats();
    globalStatsCache = { ok: true, playerCount, achievements, localStats: {
      totalKills: localStats.totalKills, totalDeaths: localStats.totalDeaths,
      bestStreak: localStats.bestStreak, bestGame: localStats.bestGame,
      medals: localStats.medals.length, rank: localStats.rank
    }};
    globalStatsCacheTime = Date.now();
    res.json(globalStatsCache);
  };

  // Current players
  https.get('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=581320', apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try { playerCount = JSON.parse(data).response.player_count; } catch {}
      done();
    });
  }).on('error', () => done());

  // Global achievement percentages
  https.get('https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=581320', apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      try {
        const items = JSON.parse(data).achievementpercentages?.achievements || [];
        // Map to our achievement names
        const localStats = loadPlayerStats();
        achievements = items.map(a => ({
          id: a.name,
          percent: Math.round(a.percent * 10) / 10,
          unlocked: localStats.medals ? true : false // We'll match in frontend
        })).sort((a, b) => b.percent - a.percent);
      } catch {}
      done();
    });
  }).on('error', () => done());

  // Steam Charts (player history) - use SteamCharts page
  https.get('https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=581320', apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => { done(); });
  }).on('error', () => done());
});

// ===== GAME NEWS (Steam API) =====
const https = require('https');
let newsCache = null;
let newsCacheTime = 0;

app.get('/api/news', (req, res) => {
  // Cache for 10 minutes
  if (newsCache && Date.now() - newsCacheTime < 600000) {
    return res.json(newsCache);
  }
  const url = 'https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=581320&count=10&maxlength=300&format=json';
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        const news = (json.appnews?.newsitems || []).map(n => ({
          title: n.title,
          url: n.url,
          author: n.author,
          date: new Date(n.date * 1000).toISOString(),
          contents: n.contents.replace(/\[.*?\]/g, '').replace(/\{.*?\}/g, '').trim(),
          feedLabel: n.feedlabel
        }));
        newsCache = { ok: true, news };
        newsCacheTime = Date.now();
        res.json(newsCache);
      } catch (err) {
        res.json({ ok: false, error: err.message });
      }
    });
  }).on('error', err => {
    res.json({ ok: false, error: err.message });
  });
});

// ===== REDDIT COMMUNITY =====
let redditCache = null, redditCacheTime = 0;
app.get('/api/reddit', (req, res) => {
  if (redditCache && Date.now() - redditCacheTime < 300000) return res.json(redditCache);
  const options = {
    hostname: 'www.reddit.com',
    path: '/r/insurgency/hot.json?limit=15',
    headers: { 'User-Agent': 'InsurgencySandstormServerManager/1.0' }
  };
  https.get(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const json = JSON.parse(data);
        const posts = (json.data?.children || [])
          .filter(p => !p.data.stickied)
          .map(p => ({
            title: p.data.title,
            url: 'https://www.reddit.com' + p.data.permalink,
            author: p.data.author,
            score: p.data.score,
            comments: p.data.num_comments,
            flair: p.data.link_flair_text || '',
            selftext: (p.data.selftext || '').slice(0, 200),
            created: new Date(p.data.created_utc * 1000).toISOString(),
            thumbnail: (p.data.thumbnail && p.data.thumbnail.startsWith('http')) ? p.data.thumbnail : null
          }));
        redditCache = { ok: true, posts };
        redditCacheTime = Date.now();
        res.json(redditCache);
      } catch (err) { res.json({ ok: false, error: err.message }); }
    });
  }).on('error', err => res.json({ ok: false, error: err.message }));
});

// ===== STEAM COMMUNITY DISCUSSIONS =====
let steamDiscCache = null, steamDiscCacheTime = 0;
app.get('/api/steam-discussions', (req, res) => {
  const force = req.query.force === '1';
  if (!force && steamDiscCache && Date.now() - steamDiscCacheTime < 120000) return res.json(steamDiscCache);
  const options = {
    hostname: 'steamcommunity.com',
    path: '/app/581320/discussions/',
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  };
  https.get(options, (apiRes) => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      try {
        const items = [];
        const topicRe = /data-gidforumtopic="(\d+)"[\s\S]*?forum_topic_overlay"\s+href="([^"]+)"[\s\S]*?forum_topic_name[^>]*>([\s\S]*?)<\/div>[\s\S]*?forum_topic_op[^>]*>\s*([\s\S]*?)\s*<\/div>[\s\S]*?forum_topic_reply_count[^>]*>[\s\S]*?(\d+)\s*<\/div>[\s\S]*?data-timestamp="(\d+)"/g;
        let m;
        while ((m = topicRe.exec(data)) !== null && items.length < 15) {
          const title = m[3].replace(/<[^>]+>/g, '').trim();
          if (!title) continue;
          items.push({
            title,
            url: m[2],
            author: m[4].replace(/<[^>]+>/g, '').trim(),
            replies: parseInt(m[5]) || 0,
            date: new Date(parseInt(m[6]) * 1000).toISOString()
          });
        }
        if (items.length > 0) {
          steamDiscCache = { ok: true, items };
          steamDiscCacheTime = Date.now();
          return res.json(steamDiscCache);
        }
        res.json({ ok: false, error: 'No items parsed' });
      } catch (err) { res.json({ ok: false, error: err.message }); }
    });
  }).on('error', err => res.json({ ok: false, error: err.message }));
});

// OpenAI key management
app.get('/api/ai/status', (req, res) => {
  res.json({ hasKey: !!openaiKey });
});

app.post('/api/ai/key', (req, res) => {
  openaiKey = req.body.key || '';
  res.json({ ok: true });
});

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws/realtime' });

const SYSTEM_INSTRUCTIONS = `Du er en hjælpsom AI-assistent specialiseret i Insurgency: Sandstorm dedicated server administration.

Du taler dansk og hjælper brugeren med:
- Server konfiguration (game.ini indstillinger, MapCycle, launch parametre)
- Gameplay mekanikker (checkpoint mode, push, firefight, osv.)
- Bot konfiguration (friendly bots, enemy AI difficulty, bot quota)
- Maps og scenarios (hvilke maps der er gode til hvad, taktiske tips)
- Mods og mutators
- Performance optimering
- Troubleshooting (server crashes, connection issues, bots der ikke spawner)
- Generelle tips og tricks til spillet

Hold svarene korte og præcise. Brugeren kører en lokal server primært til solo/coop med bots.
Svar altid på dansk med mindre brugeren skriver på engelsk.`;

wss.on('connection', (clientWs) => {
  if (!openaiKey) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'OpenAI API nøgle mangler. Indtast den i indstillingerne.' }));
    clientWs.close();
    return;
  }

  let openaiWs = null;

  try {
    openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17', {
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    });
  } catch (err) {
    clientWs.send(JSON.stringify({ type: 'error', message: 'Kunne ikke oprette forbindelse til OpenAI: ' + err.message }));
    clientWs.close();
    return;
  }

  openaiWs.on('open', () => {
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: SYSTEM_INSTRUCTIONS,
        voice: 'ash',
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 700
        }
      }
    }));
    clientWs.send(JSON.stringify({ type: 'connected' }));
  });

  openaiWs.on('message', (data) => {
    try { clientWs.send(data.toString()); } catch {}
  });

  openaiWs.on('error', (err) => {
    try { clientWs.send(JSON.stringify({ type: 'error', message: 'OpenAI fejl: ' + err.message })); } catch {}
  });

  openaiWs.on('close', () => {
    try { clientWs.send(JSON.stringify({ type: 'disconnected' })); clientWs.close(); } catch {}
  });

  clientWs.on('message', (data) => {
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.send(data.toString());
    } catch {}
  });

  clientWs.on('close', () => {
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Insurgency Sandstorm Server Manager kører på http://127.0.0.1:${PORT}`);
});
