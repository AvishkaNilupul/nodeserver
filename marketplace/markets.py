"""Best-effort live price lookups on secondary marketplaces.

The operator buys items in the source catalog and resells them elsewhere, so it
helps to see what those items currently fetch on the big resale sites. Only G2G
exposes a usable public price API; eBay actively blocks scraping and Eldorado is
a closed single-page app, so for those two we return a "manual" placeholder that
the UI turns into a "type the price you see" input.

Every lookup is wrapped so a blocked / changed endpoint degrades to
``{"ok": False, ...}`` instead of breaking the page.
"""

from __future__ import annotations

import re
import statistics
from typing import Optional

import requests

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
}

_G2G_SEARCH = "https://sls.g2g.com/offer/search"

# Hand-verified source-game -> G2G slug mappings. Each of these was confirmed to
# return live offers from G2G's public search API. Anything not listed falls back
# to slug auto-derivation below. ``TRENDING_GAMES`` (further down) reuses these.
_G2G_TERMS: dict[str, str] = {
    "world of warcraft": "wow-classic-gold",
    "wow": "wow-classic-gold",
    "league of legends": "league-of-legends-account",
    "valorant": "valorant-top-up",
    "runescape 3": "rs3-gold",
    "runescape": "rs3-gold",
    "apex legends": "apex-legends-account",
    "call of duty": "cod-account",
    "diablo 4": "diablo-4-gold",
    "diablo iv": "diablo-4-gold",
    "path of exile": "poe-currency",
    "ea sports fc 24": "ea-sports-fc-24-coins",
    "ea sports fc 25": "ea-sports-fc-24-coins",
    "fc 24": "ea-sports-fc-24-coins",
    "fifa": "ea-sports-fc-24-coins",
    "new world": "new-world-coins",
    "lost ark": "lost-ark-gold",
    "mobile legends": "mobile-legends-account",
    "wuthering waves": "wuthering-waves-top-up",
    "honkai star rail": "honkai-star-rail-accounts",
    "black desert online": "black-desert-online-account",
    "black desert": "black-desert-online-account",
}

# Curated set of popular games (display name -> G2G slug) used to build the
# "what's hot right now" board. Every slug here is verified to return live data,
# and the board is ranked by G2G's real ``total_success_order`` (units sold).
TRENDING_GAMES: list[tuple[str, str]] = [
    ("World of Warcraft", "wow-classic-gold"),
    ("Black Desert Online", "black-desert-online-account"),
    ("Apex Legends", "apex-legends-account"),
    ("Mobile Legends", "mobile-legends-account"),
    ("Call of Duty", "cod-account"),
    ("Diablo 4", "diablo-4-gold"),
    ("Path of Exile", "poe-currency"),
    ("New World", "new-world-coins"),
    ("Honkai Star Rail", "honkai-star-rail-accounts"),
    ("League of Legends", "league-of-legends-account"),
    ("Wuthering Waves", "wuthering-waves-top-up"),
    ("EA Sports FC 24", "ea-sports-fc-24-coins"),
    ("Lost Ark", "lost-ark-gold"),
    ("Valorant", "valorant-top-up"),
    ("RuneScape 3", "rs3-gold"),
]

# Suffixes we try when auto-deriving a G2G slug from a game name, ordered by how
# closely they match the kind of thing the operator resells.
_G2G_SUFFIXES = ["-account", "-accounts", "-items", "-item", "-top-up", "-gold", "-skins"]


def _slug(text: str) -> str:
    text = (text or "").lower().strip()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


def _g2g_candidates(game: str, category: str, override: Optional[str]) -> list[str]:
    if override:
        return [override.strip()]
    key = (game or "").lower().strip()
    if key in _G2G_TERMS:
        return [_G2G_TERMS[key]]

    base = _slug(game)
    if not base:
        return []
    cats = (category or "").lower()
    ordered = list(_G2G_SUFFIXES)
    # Bias the suffix order toward whatever the category looks like.
    for hint in ("account", "item", "top", "gold", "skin"):
        if hint in cats:
            ordered.sort(key=lambda s: hint not in s)
            break
    return [base + suffix for suffix in ordered]


def _g2g_query(seo_term: str, limit: int = 30) -> Optional[list[dict]]:
    params = {
        "seo_term": seo_term,
        "page_size": str(limit),
        "page": "1",
        "currency": "USD",
        "country": "US",
        "sort": "lowest_price",
    }
    resp = requests.get(_G2G_SEARCH, params=params, headers=_HEADERS, timeout=20)
    if resp.status_code != 200:
        return None
    payload = resp.json().get("payload", {})
    results = payload.get("results") or []
    return results or None


def g2g_lookup(
    game: str, category: str = "", override_term: Optional[str] = None
) -> dict[str, object]:
    """Look up live G2G prices for a game, returning a normalised summary."""

    tried: list[str] = []
    for term in _g2g_candidates(game, category, override_term):
        tried.append(term)
        try:
            results = _g2g_query(term)
        except Exception:  # noqa: BLE001 - network/parse issues degrade gracefully
            results = None
        if not results:
            continue

        prices: list[float] = []
        sales = 0
        for row in results:
            price = float(row.get("unit_price_in_usd") or row.get("converted_unit_price") or 0)
            if price > 0:
                prices.append(price)
            sales += int(row.get("total_success_order") or 0)
        if not prices:
            continue

        median = round(statistics.median(prices), 2)
        return {
            "ok": True,
            "source": "G2G",
            "mode": "live",
            "currency": "USD",
            "term": term,
            "count": len(prices),
            "lowest": round(min(prices), 2),
            "median": median,
            "highest": round(max(prices), 2),
            "totalSales": sales,
            "unit": str(results[0].get("unit_name") or "item"),
            "url": f"https://www.g2g.com/categories/{term}",
        }

    return {
        "ok": False,
        "source": "G2G",
        "mode": "live",
        "reason": "no matching G2G product",
        "tried": tried,
    }


def _manual(source: str, search_url: str) -> dict[str, object]:
    return {
        "ok": False,
        "source": source,
        "mode": "manual",
        "reason": "no public price API – enter the price you see",
        "url": search_url,
    }


def compare_markets(
    game: str,
    category: str = "",
    g2g_term: Optional[str] = None,
) -> dict[str, object]:
    """Compare a game's items across the supported secondary marketplaces."""

    q = requests.utils.quote(f"{game} {category}".strip())
    markets = [
        g2g_lookup(game, category, g2g_term),
        _manual("eBay", f"https://www.ebay.com/sch/i.html?_nkw={q}"),
        _manual("Eldorado", f"https://www.eldorado.gg/search?q={q}"),
    ]

    live = [m for m in markets if m.get("ok")]
    best_sell_usd = min((float(m["lowest"]) for m in live), default=0.0)
    return {
        "game": game,
        "category": category,
        "markets": markets,
        "bestLiveSellUsd": round(best_sell_usd, 2) if best_sell_usd else 0.0,
    }


def trending(limit: int = 12) -> dict[str, object]:
    """Rank popular games by how much they are actually selling on G2G.

    Uses G2G's real ``total_success_order`` (units sold) as a demand signal, so
    the board reflects what is genuinely moving right now rather than a guess.
    Games that fail to return data are simply skipped, so the board degrades
    gracefully if G2G is unreachable.
    """

    rows: list[dict[str, object]] = []
    for name, term in TRENDING_GAMES:
        try:
            results = _g2g_query(term)
        except Exception:  # noqa: BLE001 - skip anything that fails to load
            results = None
        if not results:
            continue

        prices = [
            float(r.get("unit_price_in_usd") or r.get("converted_unit_price") or 0)
            for r in results
        ]
        prices = [p for p in prices if p > 0]
        if not prices:
            continue
        sales = sum(int(r.get("total_success_order") or 0) for r in results)
        rows.append(
            {
                "game": name,
                "term": term,
                "sold": sales,
                "offers": len(prices),
                "lowest": round(min(prices), 4),
                "median": round(statistics.median(prices), 4),
                "unit": str(results[0].get("unit_name") or "item"),
                "url": f"https://www.g2g.com/categories/{term}",
            }
        )

    rows.sort(key=lambda r: r["sold"], reverse=True)
    return {
        "source": "G2G",
        "count": len(rows),
        "games": rows[:limit],
    }