const CHAIN = {
  chainId: "0x1237",
  chainName: "Robinhood Chain",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
  blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
};

const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

let cfg, abi, provider, signer, account;
let payAsset = "ETH";
let pairFilter = "ALL";

const app = () => document.getElementById("app");
const setLog = (m) => {
  const el = document.querySelector(".log");
  if (el) el.textContent = m || "";
};
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "—");
function getMeta(id) {
  try { return JSON.parse(localStorage.getItem("stinks-meta") || "{}")[id] || {}; }
  catch { return {}; }
}
function artFor(t) {
  const meta = getMeta(t.id || t);
  if (meta.img) return meta.img;
  const tok = (t.token || "").toLowerCase();
  if (tok && cfg.stinks && tok === String(cfg.stinks).toLowerCase()) return "./logo.png?v=2";
  if (String(t.symbol || "").toUpperCase() === "STINKS") return "./logo.png?v=2";
  return "";
}
function shrinkFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => {
      const im = new Image();
      im.onerror = () => resolve(r.result);
      im.onload = () => {
        const c = document.createElement("canvas");
        const s = 96;
        c.width = s;
        c.height = s;
        c.getContext("2d").drawImage(im, 0, 0, s, s);
        resolve(c.toDataURL("image/jpeg", 0.7));
      };
      im.src = r.result;
    };
    r.readAsDataURL(file);
  });
}
async function curveTarget(pad) {
  // ethers v6: contract.target is the address, shadows Solidity target()
  return pad.getFunction("target")();
}

const LIGHTER = "https://api.rh.lighter.xyz/api/v1";
let lighterBooks = null;
let lighterAt = 0;
let tapeTimer = 0;

function pickInverse(sym) {
  const list = cfg.inverses || [];
  return list.find((x) => x.symbol === sym) || list.find((x) => x.status === "live") || list[0];
}
function fmtUsd(n) {
  const x = Number(n) || 0;
  if (x >= 1e6) return "$" + (x / 1e6).toFixed(1) + "M";
  if (x >= 1e3) return "$" + (x / 1e3).toFixed(1) + "K";
  return "$" + x.toFixed(0);
}
function sparkSvg(values, up, id) {
  const w = 320, h = 92, p = 2;
  const gid = "g" + (id || (up ? "u" : "d"));
  if (!values || values.length < 2) {
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="M0 ${h/2} L${w} ${h/2}" fill="none" stroke="${up?"#39ff88":"#e10600"}" stroke-width="2"/></svg>`;
  }
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => {
    const x = p + (i * (w - 2 * p)) / (values.length - 1);
    const y = h - p - ((v - min) / span) * (h - 2 * p);
    return [x, y];
  });
  const line = pts.map((q, i) => (i ? "L" : "M") + q[0].toFixed(1) + " " + q[1].toFixed(1)).join(" ");
  const fill = line + ` L ${w} ${h} L 0 ${h} Z`;
  const c = up ? "#39ff88" : "#e10600";
  const g = up ? "rgba(57,255,136,0.22)" : "rgba(225,6,0,0.22)";
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${g}"/><stop offset="100%" stop-color="transparent"/>
    </linearGradient></defs>
    <path d="${fill}" fill="url(#${gid})"/>
    <path d="${line}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round"/>
  </svg>`;
}
async function loadLighter(force) {
  if (!force && lighterBooks && Date.now() - lighterAt < 50000) return lighterBooks;
  const r = await fetch(LIGHTER + "/orderBookDetails");
  const d = await r.json();
  lighterBooks = {};
  for (const b of d.order_book_details || []) lighterBooks[String(b.symbol).toUpperCase()] = b;
  lighterAt = Date.now();
  return lighterBooks;
}
async function inverseTape(marketId) {
  try {
    const r = await fetch(LIGHTER + "/recentTrades?market_id=" + marketId + "&limit=24");
    const d = await r.json();
    const px = (d.trades || []).map((t) => Number(t.price)).filter((x) => x > 0).reverse();
    return px.map((p) => 1 / p);
  } catch {
    return [];
  }
}

async function loadCfg() {
  const [a, b] = await Promise.all([
    fetch("./addresses.json?v=21").then((r) => r.json()),
    fetch("./abi.json?v=21").then((r) => r.json()),
  ]);
  cfg = a;
  abi = b;
}

function C(name, kind) {
  return new ethers.Contract(cfg[name], abi[kind], signer || provider);
}
function readProvider() {
  if (provider) return provider;
  return new ethers.JsonRpcProvider(cfg.rpc);
}
const vaultC = () => C("vault", "InverseVault");
const iTokC = () => C("iNVDA", "InverseToken");
const padC = () => C("pad", "Launchpad");
const hopC = () => C("hopper", "FeeHopper");
const oraC = () => C("oracle", "PriceOracle");
const stinksC = () => C("stinks", "StinksToken");
const usdgC = () => new ethers.Contract(cfg.usdg, ERC20_ABI, signer || provider);

async function ensureChain() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet. Install MetaMask or Rabby.");
  const add = () => eth.request({ method: "wallet_addEthereumChain", params: [CHAIN] });
  const sw = () => eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CHAIN.chainId }] });
  try {
    await sw();
  } catch (e) {
    const msg = String(e?.message || e);
    const unknown = e.code === 4902 || e?.data?.originalError?.code === 4902 || /unrecognized chain/i.test(msg);
    if (!unknown) throw e;
    await add();
    await sw();
  }
}

function paintWallet() {
  const c = document.getElementById("connect");
  const d = document.getElementById("disconnect");
  const a = document.getElementById("acct");
  if (account) {
    c.textContent = short(account);
    c.title = account;
    if (d) d.hidden = false;
    if (a) a.textContent = account;
  } else {
    c.textContent = "Connect wallet";
    c.title = "";
    if (d) d.hidden = true;
    if (a) a.textContent = "";
  }
}

async function connect() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet. Install MetaMask or Rabby.");
  provider = new ethers.BrowserProvider(eth);
  try {
    await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
  } catch (e) {
    if (e && (e.code === 4001 || e.code === "ACTION_REJECTED")) throw e;
    await provider.send("eth_requestAccounts", []);
  }
  await ensureChain();
  signer = await provider.getSigner();
  account = await signer.getAddress();
  paintWallet();
  render();
}

async function disconnect() {
  const eth = window.ethereum;
  try {
    await eth?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
  } catch (_) {}
  signer = null;
  account = null;
  provider = null;
  paintWallet();
  render();
}

async function hydrateWallet() {
  const eth = window.ethereum;
  if (!eth) return;
  const accs = await eth.request({ method: "eth_accounts" });
  if (!accs || !accs[0]) return;
  provider = new ethers.BrowserProvider(eth);
  await ensureChain();
  signer = await provider.getSigner();
  account = await signer.getAddress();
  paintWallet();
}

function watchWallet() {
  const eth = window.ethereum;
  if (!eth || eth.__stinksWatch) return;
  eth.__stinksWatch = true;
  eth.on?.("accountsChanged", (accs) => {
    if (!accs || accs.length === 0) {
      signer = null;
      account = null;
      provider = null;
      paintWallet();
      render();
      return;
    }
    hydrateWallet().then(render).catch(() => {});
  });
}

function assetToggle() {
  return `<div class="toggle">
    <button class="chip ${payAsset==="ETH"?"on":""}" data-asset="ETH">ETH</button>
    <button class="chip ${payAsset==="USDG"?"on":""}" data-asset="USDG">USDG</button>
  </div>`;
}
function bindToggle() {
  document.querySelectorAll("[data-asset]").forEach((b) => {
    b.onclick = () => { payAsset = b.dataset.asset; render(); };
  });
}

function parseLaunch(L) {
  return {
    token: L.token || L[0],
    vault: L.vault_ || L[1],
    pair: L.pair || L[2],
    raisedWad: L.raisedWad ?? L[3],
    raisedEth: L.raisedEth ?? L[4],
    raisedUsdg: L.raisedUsdg ?? L[5],
    sold: L.sold ?? L[6],
    graduated: L.graduated ?? L[7],
    launcher: L.launcher || L[8],
  };
}

async function loadBoard() {
  const p = new ethers.Contract(cfg.pad, abi.Launchpad, readProvider());
  const v = new ethers.Contract(cfg.vault, abi.InverseVault, readProvider());
  const n = Number(await p.launchCount());
  const target = await curveTarget(p);
  const targetWad = await v.ethToWad(target);
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const L = parseLaunch(await p.getLaunch(i));
    let name = "Token", symbol = "TKN";
    try {
      const t = new ethers.Contract(L.token, ERC20_ABI, readProvider());
      name = await t.name();
      symbol = await t.symbol();
    } catch (_) {}
    const pct = targetWad > 0n ? Number((L.raisedWad * 10000n) / targetWad) / 100 : 0;
    rows.push({ id: i, ...L, name, symbol, pct: Math.min(100, pct) });
  }
  return { rows, target, targetWad, n };
}

function isOfficial(t) {
  const tok = (t.token || "").toLowerCase();
  return (cfg.stinks && tok === String(cfg.stinks).toLowerCase())
    || String(t.symbol || "").toUpperCase() === "STINKS";
}
function tokenCard(t) {
  const av = (t.symbol || "?").replace("$", "").slice(0, 3).toUpperCase();
  const meta = getMeta(t.id);
  const src = artFor(t);
  const img = src
    ? `<div class="av" style="background-image:url('${src}');background-size:cover;background-position:center"></div>`
    : `<div class="av">${av}</div>`;
  const pair = meta.pair || "ETH";
  return `<a class="card" href="#token/${t.id}">
    <div class="card-top">
      ${img}
      <div>
        <div class="tkr">$${t.symbol}${isOfficial(t) ? " · official" : ""}</div>
        <div class="nm">${isOfficial(t) ? "Official launchpad token. 70% of launchpad's volume fees buy and burn the token." : t.name}</div>
      </div>
      <span class="badge ${isOfficial(t) ? "off" : t.graduated ? "ok" : ""}">${isOfficial(t) ? "Official" : t.graduated ? "Graduated" : "Live"}</span>
    </div>
    <div class="meta">Paired with <b>${pair}</b></div>
    <div class="bar"><i style="width:${t.pct}%"></i></div>
    <div class="meta">${t.pct.toFixed(1)}% to graduation · ${short(t.token)}</div>
  </a>`;
}

function home() {
  return `
    <section class="hero">
      <div>
        <h1>Launch coins<br>paired with <em>inverse stocks</em></h1>
        <p>Ape in ETH or USDG. Graduate to MEME/iToken. Fees buy and burn $STINKS. When stocks dump, Stinks prints.</p>
        <a class="btn btn-red" href="#launch">Launch a token →</a>
      </div>
      <div class="feat">
        <div>
          <div class="k">Live inverse</div>
          <h3>iNVDA</h3>
          <div class="pair">Pure inverse · mint ETH or USDG</div>
        </div>
        <div class="row">
          <div><div class="pair">Deck</div><div class="big">NVDA ↓ = iNVDA ↑</div></div>
          <a class="btn btn-red" href="#vault">Mint</a>
        </div>
      </div>
    </section>
    <a class="official" href="#token/0">
      <div class="av" style="background-image:url('./logo.png?v=2');background-size:cover"></div>
      <div>
        <div class="tkr">$STINKS · official pad token</div>
        <p>Official launchpad token. 70% of launchpad's volume fees buy and burn the token.</p>
        <span class="ca">${cfg.stinks}</span>
      </div>
    </a>
    <div class="toolbar">
      <input class="search" id="q" placeholder="Search name, ticker, or contract" />
    </div>
    <div class="chips" id="filters"></div>
    <div id="board" class="grid"><div class="empty">Loading launches…</div></div>
  `;
}

function launchPage() {
  const inv = cfg.inverses || [];
  const tiles = [`<button type="button" class="pair-tile on" data-symbol="ETH" data-vault="">
      <b>ETH</b><span>Ethereum</span>
    </button>`].concat(inv.map((x) => {
    const on = "";
    return `<button type="button" class="pair-tile ${x.status==="live"?"":"dead"}" data-symbol="${x.symbol}" data-vault="${x.vault || ""}" ${x.status!=="live"?"disabled":""}>
      <b>${x.symbol}</b><span>${x.underlying}${x.status==="live"?"":" · soon"}</span>
    </button>`;
  })).join("");
  return `
    <a class="back" href="#home">← Explore</a>
    <div class="ticket">
      <div class="ticket-k">NEW LISTING</div>
      <div class="ticket-row">
        <div class="prev-av" id="prevAv">?</div>
        <div class="ticket-id">
          <div class="ticket-name" id="prevName">Untitled</div>
          <div class="ticket-tkr">$<span id="prevTkr">TICKER</span> · <span id="prevPair">ETH</span></div>
        </div>
        <div class="ticket-fees">
          <span>1% launch</span>
          <span>1% trade</span>
          <span id="prevGrad">grad —</span>
          <span>LP from curve</span>
        </div>
      </div>
    </div>
    <div class="desk">
      <p class="desk-label">Quote</p>
      <div class="pair-tiles">${tiles}</div>
      <input type="hidden" id="pair" value="ETH" data-vault="" />
      <p class="hint" id="gradHint">ETH quote graduates MEME/ETH from the curve — you don’t seed LP. Inverse quote graduates MEME/iToken.</p>
      <div class="row2">
        <div><label>Name</label><input id="nm" placeholder="DumpCoin" maxlength="32" /></div>
        <div><label>Ticker</label><input id="sym" placeholder="DUMP" maxlength="10" /></div>
      </div>
      <label>Pitch</label>
      <textarea id="desc" rows="2" placeholder="One line. Why this prints when the stock dumps."></textarea>
      <div class="row2">
        <div>
          <label>Art</label>
          <label class="drop" for="img">
            <input id="img" type="file" accept="image/*" hidden />
            <span id="imgLab">Drop / choose</span>
          </label>
        </div>
        <div>
          <label>First ape</label>
          <div class="devbuy">
            <input id="devbuy" placeholder="0" />
            <span class="unit">ETH</span>
          </div>
        </div>
      </div>
      <div class="row2">
        <div><label>X</label><input id="x" placeholder="@handle" /></div>
        <div><label>Telegram</label><input id="tg" placeholder="t.me/…" /></div>
      </div>
      <button class="btn btn-red btn-wide" id="create" style="margin-top:22px">${account ? "Send it" : "Connect wallet"}</button>
      <div class="log"></div>
    </div>`;
}

function tokenPage(id) {
  const unit = payAsset === "USDG" ? "USDG" : "ETH";
  const meta = getMeta(id);
  const src = artFor({ id, token: Number(id) === 0 ? cfg.stinks : "", symbol: Number(id) === 0 ? "STINKS" : "" });
  const av = src
    ? `<div class="av" style="width:64px;height:64px;background-image:url('${src}');background-size:cover;background-position:center"></div>`
    : `<div class="av" style="width:64px;height:64px">$</div>`;
  return `
    <div class="panel">
      <div class="card-top" style="margin-bottom:16px">
        ${av}
        <div>
          <h2 id="tt" style="margin:0">${Number(id) === 0 ? "$STINKS" : "Launch #" + id}</h2>
          <p class="stat" id="tsub" style="margin:4px 0 0">${Number(id) === 0 ? "Official launchpad token. 70% of launchpad's volume fees buy and burn the token." : "Paired with " + (meta.pair || "ETH")}</p>
        </div>
      </div>
      ${assetToggle()}
      <div class="bar" style="margin:16px 0"><i id="tbar" style="width:0"></i></div>
      <p class="stat">raised $ <b id="raised">—</b> · ETH <b id="reth">—</b> · USDG <b id="rusd">—</b> · <b id="g">—</b></p>
      <p class="stat">token <b id="mtok">—</b><br>pair <b id="mpair">—</b></p>
      <label>Ape ${unit}</label>
      <input id="ape" placeholder="${payAsset==="USDG"?"3":"0.003"}" />
      <button class="btn btn-red btn-wide" id="buy" style="margin-top:14px">Buy with ${unit}</button>
      <div class="log"></div>
    </div>`;
}

function vaultPage(sym) {
  const inv = pickInverse(sym);
  const unit = payAsset === "USDG" ? "USDG" : "ETH";
  const live = inv && inv.status === "live";
  const mint = live ? `
        ${assetToggle()}
        <p class="stat">Your ${inv.symbol} <b id="ibal">—</b> · ${unit} <b id="abal">—</b></p>
        <div class="row2">
          <div>
            <label>${unit} in <button type="button" class="max" id="maxIn">Max</button></label>
            <input id="mintAmt" placeholder="${payAsset==="USDG"?"10":"0.001"}" />
          </div>
          <div>
            <label>${inv.symbol} out <button type="button" class="max" id="maxOut">Max</button></label>
            <input id="redAmt" placeholder="1" />
          </div>
        </div>
        <div class="row2" style="margin-top:12px">
          <button class="btn btn-red btn-wide" id="mint">Mint ${inv.symbol}</button>
          <button class="btn btn-ghost btn-wide" id="redeem">Redeem ${unit}</button>
        </div>
      ` : `<p class="stat">Poster only. Same card once the vault is deployed.</p>`;
  return `
    <div class="vault-head">
      <div>
        <h1>Inverse Deck</h1>
        <p>Charts show the inverse performance of the stocks — green means the stock dumped. Tape refreshes every minute.</p>
      </div>
    </div>
    <div class="panel mint-desk" id="mintDesk">
      <h2 id="mintTitle">${inv ? inv.symbol : "Deck"}</h2>
      <p class="stat" id="mintSub">${live ? "Mint / redeem inverse stocks." : "This desk is not live yet."}</p>
      <p class="stat">Tape <b id="px">—</b>${live ? ' · NAV <b id="nav">—</b>' : ""}</p>
      ${mint}
      <div class="log"></div>
    </div>
    <div id="desks" class="desks"><div class="empty">Loading tape…</div></div>`;
}

function hopperPage() {
  return statsPage();
}
function statsPage() {
  return `
    <div class="vault-head">
      <h1>Stats</h1>
      <p>Launchpad volume fees: 70% buybacks and burns $STINKS, 30% buys the launched token.</p>
    </div>
    <div class="kpis" id="kpis">
      <div class="kpi"><span>Loading…</span><b>—</b></div>
    </div>
    <div class="panel">
      <h2>Buyback pipeline</h2>
      <p class="stat">Pending in hopper is unspent. Burned is $STINKS already eaten. Split 70 / 30 on each keeper pump.</p>
      <div class="pipe" id="pipe"></div>
    </div>
    <div class="panel">
      <h2>Protocol</h2>
      <table class="docs" id="proto"></table>
    </div>`;
}

function docsPage() {
  const inv = (cfg.inverses || []).map((x) => `
    <tr>
      <td><b>${x.symbol}</b></td>
      <td>${x.underlying}</td>
      <td class="ca">${x.token || "—"}</td>
      <td class="ca">${x.vault || "—"}</td>
      <td>${x.status}</td>
    </tr>`).join("");
  return `
    <div class="panel">
      <h2>Stinks</h2>
      <p>Inverse stocks on Robinhood Chain. Launchpad, inverse deck, hopper.</p>
      <div class="steps" style="margin-top:16px">
        <div><b>Deck</b><p>Deposit ETH or USDG, mint iToken at NAV. Pure inverse of the stock. Funding goes to hopper buybacks.</p></div>
        <div><b>Pad</b><p>Create a coin quoted against a live inverse. Ape ETH or USDG. Hit the target → MEME/iToken LP.</p></div>
        <div><b>Hopper</b><p>Launchpad fees plus funding: 70% burns $STINKS, 30% bids the launched token.</p></div>
      </div>
    </div>
    <div class="panel">
      <h2>Inverse stocks</h2>
      <table class="docs">
        <thead><tr><th>iToken</th><th>Underlying</th><th>Token</th><th>Vault</th><th></th></tr></thead>
        <tbody>${inv}</tbody>
      </table>
    </div>
    <div class="panel">
      <h2>Contracts</h2>
      <table class="docs">
        <tbody>
          <tr><td>$STINKS</td><td class="ca">${cfg.stinks}</td></tr>
          <tr><td>STINKS/ETH</td><td class="ca">${cfg.stinksPair}</td></tr>
          <tr><td>Hopper</td><td class="ca">${cfg.hopper}</td></tr>
          <tr><td>Pad</td><td class="ca">${cfg.pad}</td></tr>
          <tr><td>NVDA oracle</td><td class="ca">${cfg.oracle}</td></tr>
          <tr><td>ETH/USD oracle</td><td class="ca">${cfg.ethUsd || "—"}</td></tr>
          <tr><td>USDG</td><td class="ca">${cfg.usdg}</td></tr>
        </tbody>
      </table>
    </div>`;
}

async function fillBoard() {
  const el = document.getElementById("board");
  const filters = document.getElementById("filters");
  if (!el) return;
  filters.innerHTML = ["ALL", "ETH"].concat((cfg.inverses || []).map((x) => x.symbol)).map((s) =>
    `<button class="chip ${pairFilter===s?"on":""}" data-pair="${s}">${s === "ALL" ? "All" : s}</button>`
  ).join("");
  filters.querySelectorAll("[data-pair]").forEach((b) => {
    b.onclick = () => { pairFilter = b.dataset.pair; fillBoard(); };
  });
  try {
    const { rows } = await loadBoard();
    const q = (document.getElementById("q")?.value || "").toLowerCase();
    const shown = rows.filter((t) => {
      if (pairFilter !== "ALL" && (getMeta(t.id).pair || "ETH") !== pairFilter) return false;
      if (!q) return true;
      return (t.symbol + t.name + t.token).toLowerCase().includes(q);
    });
    el.innerHTML = shown.length ? shown.map(tokenCard).join("") :
      `<div class="empty">No launches yet. <a href="#launch" style="color:var(--red);font-weight:700">Launch a token</a></div>`;
    const search = document.getElementById("q");
    if (search && !search._bound) {
      search._bound = true;
      search.addEventListener("input", () => fillBoard());
    }
  } catch (e) {
    el.innerHTML = `<div class="empty">${e.shortMessage || e.message}</div>`;
  }
}

function fmtTok(bn, d = 18) {
  const n = Number(ethers.formatUnits(bn, d));
  if (!Number.isFinite(n)) return "—";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(4);
  if (n === 0) return "0";
  return n.toFixed(6);
}

async function fillStats() {
  const kpis = document.getElementById("kpis");
  if (!kpis) return;
  try {
    const p = readProvider();
    const hop = new ethers.Contract(cfg.hopper, abi.FeeHopper, p);
    const pad = new ethers.Contract(cfg.pad, abi.Launchpad, p);
    const tok = new ethers.Contract(cfg.iNVDA, abi.InverseToken, p);
    const v = new ethers.Contract(cfg.vault, abi.InverseVault, p);
    const usd = new ethers.Contract(cfg.usdg, ERC20_ABI, p);
    let supply = 0n;
    let burnedSupply = 0n;
    if (cfg.stinks) {
      const st = new ethers.Contract(cfg.stinks, abi.StinksToken, p);
      supply = await st.totalSupply();
      const genesis = ethers.parseEther("1000000000");
      burnedSupply = genesis > supply ? genesis - supply : 0n;
    }
    const hEth = await p.getBalance(cfg.hopper);
    let hUsdg = 0n, totalIn = 0n, totalBurned = 0n, pumps = 0n, last = 0n, meme = ethers.ZeroAddress;
    try { hUsdg = await usd.balanceOf(cfg.hopper); } catch (_) {}
    try { totalIn = await hop.totalIn(); } catch (_) {}
    try { totalBurned = await hop.totalBurned(); } catch (_) {}
    try { pumps = await hop.pumpCount(); } catch (_) {}
    try { last = await hop.lastPumpAt(); } catch (_) {}
    try { meme = await hop.meme(); } catch (_) {}
    const burned = totalBurned > burnedSupply ? totalBurned : burnedSupply;
    const launches = await pad.launchCount();
    const iSup = await tok.totalSupply();
    const accounted = await v.accountedWad();
    kpis.innerHTML = `
      <div class="kpi"><span>$STINKS burned</span><b>${fmtTok(burned)}</b></div>
      <div class="kpi"><span>$STINKS supply</span><b>${fmtTok(supply)}</b></div>
      <div class="kpi"><span>Hopper ETH</span><b>${fmtTok(hEth)}</b></div>
      <div class="kpi"><span>Hopper USDG</span><b>${fmtTok(hUsdg, 6)}</b></div>
      <div class="kpi"><span>Launches</span><b>${launches.toString()}</b></div>
      <div class="kpi"><span>iNVDA supply</span><b>${fmtTok(iSup)}</b></div>
    `;
    const lastTxt = last > 0n ? new Date(Number(last) * 1000).toUTCString() : "never";
    document.getElementById("pipe").innerHTML = `
      <div class="kv"><span>ETH in (lifetime)</span><b>${fmtTok(totalIn)}</b></div>
      <div class="kv"><span>Pending ETH (70% burn / 30% meme)</span><b>${fmtTok(hEth)}</b></div>
      <div class="kv"><span>Pending USDG</span><b>${fmtTok(hUsdg, 6)}</b></div>
      <div class="kv"><span>Keeper pumps</span><b>${pumps.toString()}</b></div>
      <div class="kv"><span>Last pump</span><b>${lastTxt}</b></div>
      <div class="kv"><span>Current meme</span><b>${meme && meme !== ethers.ZeroAddress ? short(meme) : "none"}</b></div>
    `;
    document.getElementById("proto").innerHTML = `
      <tr><td>Vault TVL (wad)</td><td class="ca">${fmtTok(accounted)}</td></tr>
      <tr><td>Hopper</td><td class="ca">${cfg.hopper}</td></tr>
      <tr><td>$STINKS</td><td class="ca">${cfg.stinks}</td></tr>
      <tr><td>Pad</td><td class="ca">${cfg.pad}</td></tr>
    `;
  } catch (e) {
    kpis.innerHTML = `<div class="kpi"><span>Error</span><b>${e.shortMessage || e.message}</b></div>`;
  }
}

async function paintTape(sym) {
  const inv = pickInverse(sym);
  const el = document.getElementById("px");
  if (!inv || !el) return;
  try {
    const books = await loadLighter();
    const b = books[inv.underlying];
    if (!b) return;
    const mark = Number(b.mark_price);
    const iChg = -Number(b.daily_price_change);
    el.textContent = inv.underlying + " $" + mark.toFixed(2) + " · i " + (iChg >= 0 ? "+" : "") + iChg.toFixed(2) + "%";
  } catch (_) {}
}
function startTape(extra) {
  clearInterval(tapeTimer);
  const tick = () => {
    lighterAt = 0;
    fillDesks(extra);
    paintTape(extra);
  };
  tick();
  tapeTimer = setInterval(tick, 60000);
}
async function fillDesks(selected) {
  const el = document.getElementById("desks");
  if (!el) return;
  const invs = cfg.inverses || [];
  const sel = pickInverse(selected);
  const card = (inv, b) => {
    const mark = b ? Number(b.mark_price) : 0;
    const chg = b ? Number(b.daily_price_change) : 0;
    const iChg = -chg;
    const up = iChg >= 0;
    let series = [];
    if (b) {
      const hi = Number(b.daily_price_high) || mark;
      const lo = Number(b.daily_price_low) || mark;
      series = [1 / (hi || mark || 1), 1 / (((hi + lo) / 2) || mark || 1), 1 / (lo || mark || 1), 1 / (mark || 1)].filter((x) => x > 0);
    }
    const on = sel && sel.symbol === inv.symbol ? "on" : "";
    const vol = b ? fmtUsd(b.daily_quote_token_volume) : "—";
    const px = mark ? "$" + mark.toFixed(2) : "—";
    const pct = (up ? "+" : "") + iChg.toFixed(2) + "%";
    return `<a class="desk-card ${on} ${up ? "up" : "dn"}" href="#vault/${inv.symbol}">
      <div class="desk-top">
        <div>
          <div class="desk-sym">${inv.symbol}</div>
          <div class="desk-name">Inverse ${inv.name || inv.underlying}</div>
        </div>
        <div class="desk-px">
          <div class="desk-mark">${pct}</div>
          <div class="desk-chg ${up ? "up" : "dn"}">${inv.underlying} ${px}</div>
        </div>
      </div>
      ${sparkSvg(series, up, inv.symbol)}
      <div class="desk-bot">
        <span class="tag">${inv.status === "live" ? "LIVE" : "SOON"}</span>
        <span class="tag">STOCK</span>
        <span class="tag">PERP</span>
        <span class="desk-vol">Vol. ${vol}</span>
      </div>
    </a>`;
  };
  el.innerHTML = invs.map((inv) => card(inv, null)).join("") || `<div class="empty">No desks</div>`;
  try {
    const books = await loadLighter();
    el.innerHTML = invs.map((inv) => card(inv, books[inv.underlying])).join("");
  } catch (_) {}
}

async function after(page, extra) {
  bindToggle();
  if (page !== "vault") clearInterval(tapeTimer);
  if (page === "home") {
    fillBoard();
    return;
  }
  if (!signer && (page === "launch" || page === "token" || page === "vault")) {
    setLog("Connect wallet to transact.");
  }
  try {
    if (page === "launch") {
      const syncPrev = () => {
        const name = document.getElementById("nm").value.trim() || "Untitled";
        const tkr = (document.getElementById("sym").value.trim() || "TICKER").toUpperCase();
        const pair = document.getElementById("pair");
        document.getElementById("prevName").textContent = name;
        document.getElementById("prevTkr").textContent = tkr;
        document.getElementById("prevPair").textContent = pair.value;
        const av = document.getElementById("prevAv");
        if (!av.dataset.src) av.textContent = tkr.slice(0, 3);
      };
      ["nm", "sym"].forEach((id) => {
        document.getElementById(id).addEventListener("input", syncPrev);
      });
      document.querySelectorAll(".pair-tile:not(.dead)").forEach((tile) => {
        tile.onclick = () => {
          document.querySelectorAll(".pair-tile").forEach((t) => t.classList.remove("on"));
          tile.classList.add("on");
          const pair = document.getElementById("pair");
          pair.value = tile.dataset.symbol;
          pair.dataset.vault = tile.dataset.vault;
          syncPrev();
        };
      });
      document.getElementById("img").addEventListener("change", async (ev) => {
        const f = ev.target.files && ev.target.files[0];
        if (!f) return;
        const data = await shrinkFile(f);
        const av = document.getElementById("prevAv");
        av.style.backgroundImage = `url(${data})`;
        av.style.backgroundSize = "cover";
        av.textContent = "";
        document.getElementById("imgLab").textContent = f.name;
        av.dataset.src = data;
      });
      try {
        const p = new ethers.Contract(cfg.pad, abi.Launchpad, readProvider());
        const t = await curveTarget(p);
        document.getElementById("prevGrad").textContent = "grad " + ethers.formatEther(t) + " ETH";
        document.getElementById("gradHint").textContent =
          "Graduates at " + ethers.formatEther(t) + " ETH. ETH quote → MEME/ETH LP from the curve. Inverse quote → MEME/iToken.";
      } catch (_) {}
      document.getElementById("create").onclick = async () => {
        try {
          if (!signer) { await connect(); return; }
          const name = document.getElementById("nm").value.trim();
          const symbol = document.getElementById("sym").value.trim();
          if (!name || !symbol) throw new Error("Name and ticker required");
          const pair = document.getElementById("pair");
          const isEth = pair.value === "ETH";
          const vault = isEth ? ethers.ZeroAddress : pair.dataset.vault;
          if (!isEth && !vault) throw new Error("That inverse is not live yet");
          setLog("creating…");
          const tx = await padC().create(name, symbol, vault);
          setLog("tx " + tx.hash);
          await tx.wait();
          const n = Number(await padC().launchCount());
          const id = n - 1;
          const meta = {
            desc: document.getElementById("desc").value,
            x: document.getElementById("x").value,
            tg: document.getElementById("tg").value,
            pair: pair.value,
            img: document.getElementById("prevAv").dataset.src || "",
          };
          try {
            const all = JSON.parse(localStorage.getItem("stinks-meta") || "{}");
            if (meta.img && meta.img.length > 180000) meta.img = "";
            all[id] = meta;
            localStorage.setItem("stinks-meta", JSON.stringify(all));
          } catch (_) {}
          const buyAmt = document.getElementById("devbuy").value;
          if (buyAmt && Number(buyAmt) > 0) {
            setLog("developer buy…");
            const btx = await padC().buy(id, { value: ethers.parseEther(buyAmt) });
            await btx.wait();
          }
          location.hash = "#token/" + id;
        } catch (e) { setLog(e.shortMessage || e.message); }
      };
    }
    if (page === "token") {
      const p = new ethers.Contract(cfg.pad, abi.Launchpad, signer || readProvider());
      const v = new ethers.Contract(cfg.vault, abi.InverseVault, signer || readProvider());
      const L = parseLaunch(await p.getLaunch(extra));
      const target = await curveTarget(p);
      const targetWad = await v.ethToWad(target);
      const pct = targetWad > 0n ? Number((L.raisedWad * 10000n) / targetWad) / 100 : 0;
      try {
        const t = new ethers.Contract(L.token, ERC20_ABI, readProvider());
        document.getElementById("tt").textContent = `$${await t.symbol()} · ${await t.name()}`;
      } catch (_) {}
      document.getElementById("tbar").style.width = Math.min(100, pct) + "%";
      document.getElementById("raised").textContent = ethers.formatEther(L.raisedWad);
      document.getElementById("reth").textContent = ethers.formatEther(L.raisedEth);
      document.getElementById("rusd").textContent = ethers.formatUnits(L.raisedUsdg, 6);
      document.getElementById("g").textContent = L.graduated ? "graduated" : pct.toFixed(1) + "% to graduation";
      document.getElementById("mtok").textContent = L.token;
      document.getElementById("mpair").textContent = L.pair;
      document.getElementById("buy").onclick = async () => {
        try {
          if (!signer) throw new Error("Connect wallet");
          const id = extra;
          if (payAsset === "USDG") {
            const amt = ethers.parseUnits(document.getElementById("ape").value || "0", 6);
            setLog("approving USDG…");
            await (await usdgC().approve(cfg.pad, amt)).wait();
            const tx = await padC().buyUSDG(id, amt);
            setLog("tx " + tx.hash);
            await tx.wait();
          } else {
            const amt = ethers.parseEther(document.getElementById("ape").value || "0");
            const tx = await padC().buy(id, { value: amt });
            setLog("tx " + tx.hash);
            await tx.wait();
          }
          setLog("bought");
          render();
        } catch (e) { setLog(e.shortMessage || e.message); }
      };
    }
    if (page === "vault") {
      startTape(extra);
      const inv = pickInverse(extra);
      if (inv && inv.status === "live" && signer) {
        const v = new ethers.Contract(inv.vault, abi.InverseVault, signer);
        const tok = new ethers.Contract(inv.token, abi.InverseToken, signer);
        document.getElementById("nav").textContent = Number(ethers.formatEther(await v.nav())).toFixed(6);
        document.getElementById("ibal").textContent = ethers.formatEther(await tok.balanceOf(account));
        if (payAsset === "USDG") {
          document.getElementById("abal").textContent = ethers.formatUnits(await usdgC().balanceOf(account), 6);
        } else {
          document.getElementById("abal").textContent = ethers.formatEther(await signer.provider.getBalance(account));
        }
        document.getElementById("maxIn").onclick = async () => {
          if (!signer) { await connect(); return; }
          if (payAsset === "USDG") {
            document.getElementById("mintAmt").value = ethers.formatUnits(await usdgC().balanceOf(account), 6);
          } else {
            const gas = ethers.parseEther("0.0003");
            const bal = await signer.provider.getBalance(account);
            document.getElementById("mintAmt").value = ethers.formatEther(bal > gas ? bal - gas : 0n);
          }
        };
        document.getElementById("maxOut").onclick = async () => {
          if (!signer) { await connect(); return; }
          document.getElementById("redAmt").value = ethers.formatEther(await tok.balanceOf(account));
        };
        document.getElementById("mint").onclick = async () => {
          try {
            if (payAsset === "USDG") {
              const amt = ethers.parseUnits(document.getElementById("mintAmt").value || "0", 6);
              setLog("approving USDG…");
              await (await usdgC().approve(inv.vault, amt)).wait();
              const tx = await v.depositUSDG(amt);
              setLog("tx " + tx.hash);
              await tx.wait();
            } else {
              const amt = ethers.parseEther(document.getElementById("mintAmt").value || "0");
              const tx = await v.deposit({ value: amt });
              setLog("tx " + tx.hash);
              await tx.wait();
            }
            setLog("minted");
            render();
          } catch (e) { setLog(e.shortMessage || e.message); }
        };
        document.getElementById("redeem").onclick = async () => {
          try {
            const amt = ethers.parseEther(document.getElementById("redAmt").value || "0");
            const tx = await v.redeem(amt, payAsset === "USDG");
            setLog("tx " + tx.hash);
            await tx.wait();
            setLog("redeemed");
            render();
          } catch (e) { setLog(e.shortMessage || e.message); }
        };
      }
    }
    if (page === "hopper" || page === "stats") {
      fillStats();
    }
  } catch (e) {
    setLog(e.shortMessage || e.message);
  }
}

function render() {
  const raw = (location.hash || "#home").replace("#", "") || "home";
  const [page, extra] = raw.split("/");
  if (page === "launch") app().innerHTML = launchPage();
  else if (page === "token") app().innerHTML = tokenPage(extra || "0");
  else if (page === "vault") app().innerHTML = vaultPage(extra);
  else if (page === "hopper" || page === "stats") app().innerHTML = statsPage();
  else if (page === "docs") app().innerHTML = docsPage();
  else app().innerHTML = home();
  after(page === "" ? "home" : page, extra);
}

document.getElementById("connect").onclick = () => connect().catch((e) => alert(e.shortMessage || e.message));
document.getElementById("disconnect").onclick = () => disconnect().catch((e) => alert(e.shortMessage || e.message));
watchWallet();
window.addEventListener("hashchange", render);
loadCfg().then(async () => {
  try { await hydrateWallet(); } catch (_) {}
  render();
}).catch((e) => { app().innerHTML = "<p>" + e.message + "</p>"; });
