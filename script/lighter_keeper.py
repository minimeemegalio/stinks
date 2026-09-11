#!/usr/bin/env python3
"""USDG mint → Lighter deposit + 1x short. Redeem queue → close → withdraw → fulfill."""
from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

import lighter

ROOT = Path(__file__).resolve().parents[1]
ENVF = ROOT / ".env"
RPC = "https://rpc.mainnet.chain.robinhood.com"
LIGHTER = "https://api.rh.lighter.xyz"
USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"
BRIDGE = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d"
STATE = ROOT / "script" / "lighter-keeper-state.json"
HEDGE = "0xd6f53f4CcE2298585e5091b492daB61e16Fe7EE2"

DESKS = [
    {"symbol": "iNVDA", "market": "NVDA", "market_id": 15, "vault": os.environ.get("INVDA_VAULT", "0x02b73D06c5d08199a8960879BDBefb31f9A0eCB2"), "size_decimals": 4, "min_base": 0.04, "min_quote": 10.0},
    {"symbol": "iTSLA", "market": "TSLA", "market_id": 16, "vault": os.environ.get("ITSLA_VAULT", "0xF040459713289Ea6BE38117538D52D46696c7117"), "size_decimals": 4, "min_base": 0.02, "min_quote": 10.0},
]


def load_env() -> dict:
    out = dict(os.environ)
    if ENVF.exists():
        for line in ENVF.read_text().splitlines():
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            out.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    return out


def path_env(env: dict) -> dict:
    e = dict(env)
    e["PATH"] = os.path.expanduser("~/.foundry/bin") + ":" + e.get("PATH", "")
    return e


def cast(args: list[str], env: dict) -> str:
    return subprocess.check_output(["cast"] + args, text=True, env=path_env(env)).strip()


def send(args: list[str], env: dict) -> str:
    pk = env["PRIVATE_KEY"]
    cmd = ["cast", "send", "--rpc-url", RPC, "--private-key", pk, "--legacy", "--gas-price", "500000000"] + args
    return subprocess.check_output(cmd, text=True, env=path_env(env)).strip()


def u256(s: str) -> int:
    return int(s.split()[0])


def lighter_get(path: str):
    import urllib.request
    req = urllib.request.Request(LIGHTER + path, headers={"User-Agent": "stinks-keeper"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def position_base(account: dict, market_id: int) -> float:
    for p in account.get("positions") or []:
        if int(p.get("market_id", -1)) == market_id:
            sz = float(p.get("position") or p.get("size") or 0)
            sign = str(p.get("sign") or p.get("side") or "").lower()
            if sign in ("short", "sell", "ask"):
                sz = -abs(sz)
            elif sign in ("long", "buy", "bid"):
                sz = abs(sz)
            return sz
    return 0.0


async def run(env: dict) -> None:
    desks_path = ROOT / "web" / "addresses.json"
    if desks_path.exists():
        cfg = json.loads(desks_path.read_text())
        for inv in cfg.get("inverses") or []:
            for d in DESKS:
                if inv.get("symbol") == d["symbol"] and inv.get("vault"):
                    d["vault"] = inv["vault"]

    acct_idx = int(env["LIGHTER_ACCOUNT_INDEX"])
    key_idx = int(env.get("LIGHTER_API_KEY_INDEX") or "4")
    client = lighter.SignerClient(
        url=LIGHTER,
        account_index=acct_idx,
        api_private_keys={key_idx: env["LIGHTER_API_PRIVATE_KEY"]},
        chain_id=466324,
    )
    books = {str(b.get("symbol","")).upper(): b for b in (lighter_get("/api/v1/orderBookDetails").get("order_book_details") or [])}
    acc = lighter_get(f"/api/v1/account?by=index&value={acct_idx}")["accounts"][0]
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    lines = []

    for desk in DESKS:
        v = desk["vault"]
        usdg_bal = u256(cast(["call", USDG, "balanceOf(address)(uint256)", v, "--rpc-url", RPC], env))
        pending = u256(cast(["call", v, "pendingTotal()(uint256)", "--rpc-url", RPC], env))
        wad = u256(cast(["call", v, "accountedWad()(uint256)", "--rpc-url", RPC], env))
        usd = wad / 1e18
        mark = float(books[desk["market"]]["mark_price"])
        lines.append(f"{desk['symbol']} usd={usd:.2f} vault_usdg={usdg_bal} pending={pending} mark={mark}")

        if usdg_bal > 0:
            send([v, "pullUSDG(uint256,address)", str(usdg_bal), HEDGE], env)
            send([USDG, "approve(address,uint256)", BRIDGE, str(usdg_bal)], env)
            send([BRIDGE, "deposit(address,uint16,uint8,uint256)", HEDGE, "3", "0", str(usdg_bal)], env)
            lines[-1] += f" deposited {usdg_bal}"
            time.sleep(2)

        if pending > 0:
            # close short toward remaining TVL, then withdraw pending
            want_short = max(usd, 0) / mark if mark else 0
            cur = position_base(acc, desk["market_id"])
            # cover so remaining short matches remaining TVL
            delta = (-want_short) - cur
            notional = abs(delta) * mark
            if notional >= desk["min_quote"] and abs(delta) >= desk["min_base"]:
                mid = desk["market_id"]
                if not state.get(f"lev_{mid}"):
                    _, _, err = await client.update_leverage(mid, client.CROSS_MARGIN_MODE, 1)
                    if not err:
                        state[f"lev_{mid}"] = True
                coid = int(time.time() * 1000) % (2**31) + mid
                _, _, err = await client.create_market_order_limited_slippage(
                    market_index=mid,
                    client_order_index=coid,
                    base_amount=int(round(abs(delta) * 10 ** desk["size_decimals"])),
                    max_slippage=0.01,
                    is_ask=delta < 0,
                    reduce_only=True,
                )
                lines[-1] += f" close_err={err}" if err else " closed"
            amt = pending / 1e6
            _, _, err = await client.withdraw(3, 0, amt)
            lines[-1] += f" withdraw_err={err}" if err else f" withdraw {amt}"
            # pay if hedge wallet already has USDG (fast path / previous withdraw landed)
            hedge_u = u256(cast(["call", USDG, "balanceOf(address)(uint256)", HEDGE, "--rpc-url", RPC], env))
            if hedge_u >= pending:
                send([USDG, "transfer(address,uint256)", v, str(pending)], env)
                qlen = u256(cast(["call", v, "redeemQueue.length()(uint256)", "--rpc-url", RPC], env)) if False else 8
                for i in range(8):
                    try:
                        user = cast(["call", v, "redeemQueue(uint256)(address)", str(i), "--rpc-url", RPC], env).split()[0]
                    except Exception:
                        break
                    pend = u256(cast(["call", v, "pending(address)(uint256)", user, "--rpc-url", RPC], env))
                    if pend > 0:
                        send([v, "fulfillRedeem(address)", user], env)
                        lines[-1] += f" filled {user[:8]}"
            continue

        # target short = TVL
        want = -(usd / mark) if mark else 0
        cur = position_base(acc, desk["market_id"])
        delta = want - cur
        notional = abs(delta) * mark
        if notional < desk["min_quote"] or abs(delta) < desk["min_base"]:
            lines[-1] += " skip"
            continue
        mid = desk["market_id"]
        if not state.get(f"lev_{mid}"):
            _, _, err = await client.update_leverage(mid, client.CROSS_MARGIN_MODE, 1)
            if not err:
                state[f"lev_{mid}"] = True
        coid = int(time.time() * 1000) % (2**31) + mid
        _, _, err = await client.create_market_order_limited_slippage(
            market_index=mid,
            client_order_index=coid,
            base_amount=int(round(abs(delta) * 10 ** desk["size_decimals"])),
            max_slippage=0.01,
            is_ask=delta < 0,
            reduce_only=False,
        )
        lines[-1] += f" err={err}" if err else " shorted"

    STATE.write_text(json.dumps(state, indent=2))
    print("\n".join(lines))
    await client.close()


def main() -> None:
    import asyncio
    env = load_env()
    for k in ("LIGHTER_API_PRIVATE_KEY", "LIGHTER_ACCOUNT_INDEX", "PRIVATE_KEY"):
        if not env.get(k):
            raise SystemExit(f"missing {k}")
    asyncio.run(run(env))


if __name__ == "__main__":
    main()
