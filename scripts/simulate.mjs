// Fills a room with fake brothers who vote on whatever the host puts on screen.
// Usage: bun scripts/simulate.mjs CODE [count] [baseUrl]
// Stop with Ctrl+C. Bots stay connected after voting ends so they can join a revote.

const [code, countArg = "100", baseUrl = "http://localhost:8787"] = process.argv.slice(2);
if (!code) {
  console.error("Usage: bun scripts/simulate.mjs CODE [count] [baseUrl]");
  process.exit(1);
}

const COUNT = Number(countArg);
const WS_URL = `${baseUrl.replace(/^http/, "ws")}/api/rooms/${code.toUpperCase()}/ws`;
const YES_CHANCE = 0.6;
const SKIP_CHANCE = 0.08;
const MIN_THINK_MS = 2_000;
const MAX_THINK_MS = 15_000;
const JOIN_GAP_MS = 25;
const PING_MS = 25_000;
const RETRY_MS = 1_000;
const CLOSE_KICKED = 4001;

const FIRST = ["Alex", "Ben", "Chris", "Dan", "Eli", "Finn", "Gabe", "Hank", "Ian", "Jack", "Kyle", "Leo", "Max", "Nate", "Pete", "Ryan", "Sean", "Tom", "Vince", "Will"];
const LAST = ["Adams", "Bell", "Cole", "Diaz", "Evans", "Ford", "Gray", "Hill", "Irwin", "James", "Kim", "Lane", "Moore", "Nash", "Ortiz", "Price", "Reyes", "Shaw", "Tran", "Young"];

const stats = { joined: 0, votes: 0, skips: 0, rejected: 0 };
const bots = new Set();
let ended = false;

function report() {
  console.log(`joined ${stats.joined}/${COUNT}, votes ${stats.votes}, skipped ${stats.skips}, rejected ${stats.rejected}`);
}

function startBot(index) {
  const name = `${FIRST[index % FIRST.length]} ${LAST[Math.floor(index / FIRST.length) % LAST.length]} ${index + 1}`;
  // Stable ids let a rerun rejoin as the same brothers instead of adding new ones.
  const memberId = `sim-${code.toUpperCase()}-${index}`;
  const bot = { socket: null, votes: {}, yesUsed: 0, yesBudget: Infinity, joined: false, stopped: false, timer: null };
  bots.add(bot);

  const planVote = (pnmId) => {
    clearTimeout(bot.timer);
    if (!pnmId || bot.votes[pnmId]) return;
    if (Math.random() < SKIP_CHANCE) {
      stats.skips++;
      return;
    }
    const delay = MIN_THINK_MS + Math.random() * (MAX_THINK_MS - MIN_THINK_MS);
    bot.timer = setTimeout(() => {
      const value = Math.random() < YES_CHANCE && bot.yesUsed < bot.yesBudget ? "yes" : "no";
      if (bot.socket?.readyState !== WebSocket.OPEN) return;
      bot.socket.send(JSON.stringify({ type: "vote", pnmId, value }));
    }, delay);
  };

  const onMessage = (message) => {
    switch (message.type) {
      case "snapshot":
        if (!bot.joined) {
          bot.joined = true;
          stats.joined++;
        }
        bot.votes = { ...message.myVotes };
        bot.yesUsed = message.yesUsed;
        bot.yesBudget = message.yesBudget;
        if (message.phase === "live") planVote(message.focusPnmId);
        break;
      case "focus":
        planVote(message.pnm.id);
        break;
      case "budget":
        bot.yesBudget = message.yesBudget;
        break;
      case "myVote":
        bot.yesUsed = message.yesUsed;
        if (message.value) {
          bot.votes[message.pnmId] = message.value;
          stats.votes++;
        }
        break;
      case "ended":
        clearTimeout(bot.timer);
        break;
      case "error":
        stats.rejected++;
        if (message.code === "kicked" || message.code === "session_ended") bot.stopped = true;
        console.log(`${name}: ${message.code}: ${message.message}`);
        break;
    }
  };

  const connect = () => {
    const socket = new WebSocket(WS_URL);
    bot.socket = socket;
    let pinger;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "join", as: "brother", memberId, name }));
      pinger = setInterval(() => socket.send("ping"), PING_MS);
    };
    socket.onmessage = ({ data }) => {
      if (data === "pong") return;
      onMessage(JSON.parse(data));
    };
    socket.onclose = ({ code: closeCode }) => {
      clearInterval(pinger);
      if (closeCode === CLOSE_KICKED) bot.stopped = true;
      if (!bot.stopped && !ended) setTimeout(connect, RETRY_MS);
    };
    socket.onerror = () => {};
  };

  connect();
}

function finish() {
  if (ended) return;
  ended = true;
  report();
  for (const bot of bots) {
    bot.stopped = true;
    clearTimeout(bot.timer);
    bot.socket?.close();
  }
  process.exit(0);
}

process.on("SIGINT", finish);
process.on("SIGTERM", finish);

const response = await fetch(`${baseUrl}/api/rooms/${code.toUpperCase()}`);
if (!response.ok) {
  console.error(`No room ${code.toUpperCase()} at ${baseUrl} (${response.status}).`);
  process.exit(1);
}

for (let index = 0; index < COUNT; index++) {
  startBot(index);
  await new Promise((resolve) => setTimeout(resolve, JOIN_GAP_MS));
}
setInterval(report, 5_000);
report();
