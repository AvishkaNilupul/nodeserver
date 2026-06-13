"""Resale recommendation engine.

This module turns a list of scraped offers into *resale insights*: it works out
the going market price inside the source catalog, then ranks individual offers by
how profitable they look to buy-and-flip on a secondary marketplace
(G2G / eBay / Eldorado / ...), after that marketplace's fees.

Everything here is pure Python with no network access, so it is fully
deterministic and easy to test. All money math is done in USD so prices coming
from different places (the source catalog is usually EUR, G2G is USD, ...) can be
compared on a level field.
"""

from __future__ import annotations

import os
import statistics
from typing import Optional

# Rough FX table: how many USD one unit of the given currency is worth. These are
# only used so prices from different markets are roughly comparable; the operator
# can override the main one with the ``FX_USD_PER_EUR`` env var.
_FX_USD: dict[str, float] = {
    "USD": 1.0,
    "$": 1.0,
    "EUR": float(os.getenv("FX_USD_PER_EUR", "1.08")),
    "€": float(os.getenv("FX_USD_PER_EUR", "1.08")),
    "GBP": 1.27,
    "£": 1.27,
    "RUB": 0.011,
    "₽": 0.011,
}

# Typical seller fee (percent) charged by each resale marketplace. The operator
# can tweak these in the UI; these are sane defaults.
MARKETPLACE_FEES: dict[str, float] = {
    "g2g": 10.0,
    "ebay": 13.0,
    "eldorado": 10.0,
    "custom": 0.0,
}

# Recommendation thresholds.
MIN_MARGIN_PCT = float(os.getenv("RESALE_MIN_MARGIN", "15"))
# Minimum absolute profit (USD) for an item to be worth flipping - stops the
# engine from "recommending" penny items with huge percentage margins but no
# real money in them.
MIN_PROFIT_USD = float(os.getenv("RESALE_MIN_PROFIT", "0.50"))
UNDERPRICED_PCT = 20.0
HIGH_MARGIN_PCT = 35.0


def to_usd(value: float, currency: str) -> float:
    """Convert ``value`` expressed in ``currency`` into USD (best effort)."""

    if not value:
        return 0.0
    rate = _FX_USD.get((currency or "").strip(), None)
    if rate is None:
        rate = _FX_USD.get((currency or "").strip().upper(), 1.0)
    return value * rate


def market_stats(offers: list[dict[str, object]]) -> dict[str, object]:
    """Summarise the going price of a listing page (in its own currency + USD)."""

    costs: list[float] = []
    currency = ""
    for offer in offers:
        price = float(offer.get("originalPrice") or 0)
        if price > 0:
            costs.append(price)
            if not currency:
                currency = str(offer.get("currency") or "")

    if not costs:
        return {
            "count": len(offers),
            "priced": 0,
            "currency": currency,
            "lowest": 0.0,
            "median": 0.0,
            "average": 0.0,
            "lowestUsd": 0.0,
            "medianUsd": 0.0,
            "liquidity": "unknown",
        }

    median = round(statistics.median(costs), 2)
    return {
        "count": len(offers),
        "priced": len(costs),
        "currency": currency,
        "lowest": round(min(costs), 2),
        "median": median,
        "average": round(statistics.fmean(costs), 2),
        "lowestUsd": round(to_usd(min(costs), currency), 2),
        "medianUsd": round(to_usd(median, currency), 2),
        "liquidity": _liquidity(len(costs)),
    }


def _liquidity(priced: int) -> str:
    if priced >= 40:
        return "high"
    if priced >= 15:
        return "medium"
    return "low"


def annotate_offers(
    offers: list[dict[str, object]],
    stats: dict[str, object],
    sell_price_usd: Optional[float],
    fee_pct: float,
) -> None:
    """Attach resale metrics to each offer in place.

    ``sell_price_usd`` is the price the operator expects to resell the item for on
    the secondary marketplace, in USD. When it is not provided we fall back to the
    source catalog's median price (a conservative "fair value" baseline), so the
    engine still surfaces under-priced listings to flip even with no external data.
    """

    currency = str(stats.get("currency") or "")
    median_usd = float(stats.get("medianUsd") or 0)
    baseline_usd = sell_price_usd if sell_price_usd and sell_price_usd > 0 else median_usd
    fee_mult = max(0.0, 1.0 - fee_pct / 100.0)

    for offer in offers:
        cost = float(offer.get("originalPrice") or 0)
        cost_usd = round(to_usd(cost, currency), 2)
        offer["costUsd"] = cost_usd

        if cost_usd <= 0 or baseline_usd <= 0:
            offer["resale"] = None
            continue

        net = baseline_usd * fee_mult
        profit = round(net - cost_usd, 2)
        margin = round(profit / cost_usd * 100, 1)
        discount = round((median_usd - cost_usd) / median_usd * 100, 1) if median_usd > 0 else 0.0

        badges: list[str] = []
        if discount >= UNDERPRICED_PCT:
            badges.append("underpriced")
        if margin >= HIGH_MARGIN_PCT:
            badges.append("high-margin")
        if profit > 0:
            badges.append("profitable")
        else:
            badges.append("thin")

        # Rank by real money per flip (absolute profit) so healthy-priced items
        # win over penny listings with cosmetically huge percentage margins.
        offer["resale"] = {
            "costUsd": cost_usd,
            "sellUsd": round(baseline_usd, 2),
            "netUsd": round(net, 2),
            "profitUsd": profit,
            "marginPct": margin,
            "discountPct": discount,
            "feePct": fee_pct,
            "score": profit,
            "badges": badges,
            "recommend": bool(
                profit >= MIN_PROFIT_USD and margin >= MIN_MARGIN_PCT
            ),
            "baseline": "sell-price" if (sell_price_usd and sell_price_usd > 0) else "median",
        }


def _demand_level(sold: int) -> tuple[str, str]:
    """Map a G2G units-sold count to a (label, tone) demand rating."""

    if sold >= 300:
        return "hot", "good"
    if sold >= 50:
        return "steady", "good"
    if sold >= 1:
        return "slow", "ok"
    return "quiet", "bad"


def sell_verdict(
    stats: dict[str, object],
    g2g: Optional[dict[str, object]],
    best_profit_usd: Optional[float] = None,
) -> dict[str, object]:
    """Produce a plain-English "is this good to sell" call for a category.

    Combines three real signals:
      * **demand** - how many units of this game actually sold on G2G recently;
      * **supply / liquidity** - how many offers exist in the source catalog
        (lots of supply = easy to source, but also more competition);
      * **profitability** - the best per-flip profit found at the chosen sell
        price (when the operator has entered / pulled one in).

    Returns ``{verdict, tone, reasons[], demand, soldCount}``. ``tone`` is one of
    ``good`` / ``ok`` / ``bad`` so the UI can colour the banner.
    """

    reasons: list[str] = []
    supply = int(stats.get("priced") or 0)
    liquidity = str(stats.get("liquidity") or "unknown")

    sold = 0
    has_live = bool(g2g and g2g.get("ok"))
    if has_live:
        sold = int(g2g.get("totalSales") or 0)
    demand, demand_tone = _demand_level(sold) if has_live else ("unknown", "ok")

    if has_live:
        reasons.append(
            f"{sold:,} sold recently on G2G ({demand} demand) at ~${g2g.get('median')}/{g2g.get('unit')}"
        )
    else:
        reasons.append("no live external sales data – judged on source supply only")

    if supply:
        reasons.append(f"{supply} offers in stock here ({liquidity} supply)")

    profitable = best_profit_usd is not None and best_profit_usd >= MIN_PROFIT_USD
    if best_profit_usd is not None and best_profit_usd > 0:
        reasons.append(f"best flip clears ${round(best_profit_usd, 2)} profit")
    elif best_profit_usd is not None:
        reasons.append("no flip clears the profit floor at this sell price")

    # Decide the headline verdict. Demand drives "how often it sells"; supply and
    # profit decide whether it is actually worth your time.
    if not has_live:
        verdict, tone = "No live market — check manually", "ok"
    elif demand == "hot" and (profitable or best_profit_usd is None):
        verdict, tone = "Strong sell — moves fast", "good"
    elif demand in ("hot", "steady") and profitable:
        verdict, tone = "Good to flip", "good"
    elif demand in ("hot", "steady"):
        verdict, tone = "Sells well — mind your margin", "ok"
    elif demand == "slow":
        verdict, tone = "Slow mover — be patient", "ok"
    else:
        verdict, tone = "Low demand — skip", "bad"

    if demand_tone == "good" and supply and liquidity == "low":
        reasons.append("thin supply here — grab underpriced ones fast")

    return {
        "verdict": verdict,
        "tone": tone,
        "demand": demand,
        "soldCount": sold,
        "hasLive": has_live,
        "reasons": reasons,
    }


def rank_recommendations(
    offers: list[dict[str, object]], limit: int = 12
) -> list[dict[str, object]]:
    """Return the best offers to flip, best first."""

    scored = [
        offer
        for offer in offers
        if isinstance(offer.get("resale"), dict)
        and offer["resale"].get("recommend")
    ]
    scored.sort(key=lambda o: o["resale"]["score"], reverse=True)
    return scored[:limit]