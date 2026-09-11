#!/usr/bin/env python3
"""Size 1x Lighter RH shorts to InverseVault TVL. Mint ETH stays in the vault so redeem still pays."""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import lighter

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / ".env"
RPC = "https://rpc.mainnet.chain.robinhood.com"
LIGHTER = "https://api.rh.lighter.xyz"
STATE = ROOT / "script" / "lighter-keeper-state.json"

DESKS = [
    {
        "symbol": "iNVDA",
        "market": "NVDA",
        "market_id": 15,
        "vault": "0x4dF861f37662DCFE9e104eb7d77f655Db742805f",
        "size_decimals": 4,
        "min_base": 0.04,
        "min_quote": 10.0,
    },
    {
        "symbol": "iTSLA",
        "market": "TSLA",
        "market_id": 16,
        "vault": "0xd9706f093ef1aa4f547e09C023e2CD2f7C6ab410",
        "size_decimals": 4,
        "min_base": 0.02,
        "min_quote": 10.0,
    },
]


def load_env() -> dict:
    out = dict(os.environ)
    if ENV.exists():
        for line in ENV.read_text().splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return out


def rpc_call(to: str, sig: str) -> str:
    env = os.environ.copy()
    env["PATH"] = os.path.expanduser("~/.foundry/bin") + ":" + env.get("PATH", "")
    out = subprocess.check_output(
        ["cast", "call", to, sig, "--rpc-url", RPC],
        text=True,
        env=env,
    )
    return out.strip().split()[0]


def accounted_usd(vault: str) -> float:
    raw = rpc_call(vault, "accountedWad()(uint256)")
    return int(raw) / 1e18


def lighter_get(path: str):
    import urllib.request

    req = urllib.request.Request(
        LIGHTER + path,
        headers={"User-Agent": "stinks-keeper"},
    )
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def marks() -> dict:
    d = lighter_get("/api/v1/orderBookDetails")
    out = {}
    for b in d.get("order_book_details") or []:
        out[str(b.get("symbol", "")).upper()] = b
    return out


def position_base(account: dict, market_id: int) -> float:
    for p in account.get("positions") or []:
        if int(p.get("market_id", -1)) == market_id:
            # sign: short is negative position or sign field
            sz = float(p.get("position") or p.get("size") or 0)
            sign = str(p.get("sign") or p.get("side") or "").lower()
            if sign in ("short", "sell", "ask"):
                sz = -abs(sz)
            elif sign in ("long", "buy", "bid"):
                sz = abs(sz)
            return sz
    return 0.0


def to_base_int(base: float, decimals: int) -> int:
    return int(round(abs(base) * (10 ** decimals)))


async def hedge(env: dict) -> None:
    acct_idx = int(env["LIGHTER_ACCOUNT_INDEX"])
    key_idx = int(env.get("LIGHTER_API_KEY_INDEX") or "4")
    pk = env["LIGHTER_API_PRIVATE_KEY"]
    client = lighter.SignerClient(
        url=LIGHTER,
        account_index=acct_idx,
        api_private_keys={key_idx: pk},
        chain_id=466324,
    )
    books = marks()
    acc = lighter_get(f"/api/v1/account?by=index&value={acct_idx}")["accounts"][0]
    state = {}
    if STATE.exists():
        state = json.loads(STATE.read_text())

    lines = []
    for desk in DESKS:
        usd = accounted_usd(desk["vault"])
        book = books[desk["market"]]
        mark = float(book["mark_price"])
        target_short = usd / mark if mark else 0.0  # stock shares to short
        cur = position_base(acc, desk["market_id"])  # negative = short
        want = -target_short
        delta = want - cur  # negative => sell/short more
        notional = abs(delta) * mark
        lines.append(
            f"{desk['symbol']} vault=${usd:.4f} mark={mark} pos={cur:.4f} want={want:.4f} d={delta:.4f} ${notional:.2f}"
        )
        if notional < desk["min_quote"] or abs(delta) < desk["min_base"]:
            lines[-1] += " skip"
            continue

        mid = desk["market_id"]
        if not state.get(f"lev_{mid}"):
            _, _, err = await client.update_leverage(mid, client.CROSS_MARGIN_MODE, 1)
            if err:
                lines[-1] += f" lev_err={err}"
            else:
                state[f"lev_{mid}"] = True

        is_ask = delta < 0
        reduce = (cur < 0 and delta > 0) or (cur > 0 and delta < 0)
        base_amt = to_base_int(delta, desk["size_decimals"])
        coid = int(time.time() * 1000) % (2**31) + mid
        tx, resp, err = await client.create_market_order_limited_slippage(
            market_index=mid,
            client_order_index=coid,
            base_amount=base_amt,
            max_slippage=0.01,
            is_ask=is_ask,
            reduce_only=reduce and abs(want) < abs(cur),
        )
        if err:
            lines[-1] += f" err={err}"
        else:
            lines[-1] += f" ok coid={coid}"
        time.sleep(1)

    STATE.write_text(json.dumps(state, indent=2))
    print("\n".join(lines))
    await client.close()


def main() -> None:
    import asyncio

    env = load_env()
    for k in ("LIGHTER_API_PRIVATE_KEY", "LIGHTER_ACCOUNT_INDEX"):
        if not env.get(k):
            raise SystemExit(f"missing {k}")
    asyncio.run(hedge(env))


if __name__ == "__main__":
    main()
