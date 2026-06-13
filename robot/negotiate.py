"""
Dutch auction over GibberLink — two robots negotiate a price by SOUND.

The guard (seller) auctions an item (the EventPass NFT). It announces a price
that ticks DOWN each round, by voice (for the crowd) and by ggwave chirp +
network mirror (for the machine handshake). The courier (buyer) listens and
accepts the instant the price drops to its budget. The agreed price then feeds
the x402 settlement + mint.

Wire: guard calls run_seller(), courier calls run_buyer(), concurrently. Both
talk through gibber.send/recv so the audio chirp is the show and the network
mirror is the reliable channel (same design as the checkpoint handshake).
"""
import json
import time

import gibber
import voice


def _dollars(price):
    """Spoken price, e.g. 1.25 -> 'one dollar and twenty five cents'."""
    d, c = int(price), int(round((price - int(price)) * 100))
    head = f"{d} dollar{'s' if d != 1 else ''}"
    return head if c == 0 else f"{head} and {c} cents"


def _auctioneer_line(item, price, first):
    if first:
        return (f"Awright folks, step right up! We got a {item} on the block. "
                f"Do I hear {_dollars(price)}? {_dollars(price)}, who'll gimme {_dollars(price)}!")
    return (f"{_dollars(price)}! Goin' for {_dollars(price)}, "
            f"do I hear a yes? Come on now!")


def run_seller(item="EventPass", start=2.00, floor=0.50, step=0.25,
               tick_secs=4.0, auction_id="a1", speak=True):
    """Dutch auction seller — a Texas auctioneer. Returns the deal dict, or a
    no-deal dict if no buyer by the floor. Announces each price (voice +
    mirror), then listens one tick for an ACCEPT."""
    price = start
    first = True
    while price >= floor - 1e-9:
        offer = {"type": "offer", "item": item, "price": round(price, 2),
                 "auctionId": auction_id, "seller": "guard.rover.eth"}
        if speak:
            voice.say(_auctioneer_line(item, price, first), voice="texas")
        first = False
        gibber.send(json.dumps(offer))               # chirp + mirror

        deadline = time.time() + tick_secs
        while time.time() < deadline:
            raw = gibber.recv(timeout_secs=max(0.5, deadline - time.time()), network_only=True)
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                continue
            if (msg.get("type") == "accept"
                    and msg.get("auctionId") == auction_id):
                deal = {"agreed": True, "price": round(price, 2), "item": item,
                        "buyer": msg.get("buyer"), "auctionId": auction_id}
                gibber.send(json.dumps({"type": "settled", **deal}))  # signal first
                if speak:
                    voice.say(f"SOLD! To the little robot, for {_dollars(price)}! "
                              f"Yeehaw!", voice="texas")              # theater after
                return deal
        price -= step

    if speak:
        voice.say("No takers. Auction closed.")
    return {"agreed": False, "auctionId": auction_id}


def run_buyer(budget=1.25, auction_id="a1", timeout_secs=40, speak=True):
    """Dutch auction buyer. Accepts the first offer at or below `budget`.

    Returns the deal dict, or None on timeout.
    """
    deadline = time.time() + timeout_secs
    while time.time() < deadline:
        raw = gibber.recv(timeout_secs=max(0.5, deadline - time.time()), network_only=True)
        if not raw:
            continue
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            continue
        if msg.get("type") != "offer" or msg.get("auctionId") != auction_id:
            continue
        price = float(msg.get("price", 1e9))
        if price <= budget + 1e-9:
            accept = {"type": "accept", "auctionId": auction_id,
                      "price": price, "buyer": "courier.rover.eth"}
            gibber.send(json.dumps(accept))          # signal FIRST (chirp + mirror)
            if speak:
                voice.say(f"Deal. I'll take it for {price:.2f} dollars.")  # theater after
            return {"agreed": True, "price": price, "item": msg.get("item"),
                    "auctionId": auction_id}
        # else: too pricey, wait for the next lower offer
    if speak:
        voice.say("Too rich for me. Walking away.")
    return {"agreed": False, "auctionId": auction_id}
