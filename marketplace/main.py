"""FunPay multi-game marketplace mirror.

Serves a small single page app plus a JSON API that proxies FunPay listings for
*any* game (not just Rust), applying a configurable markup to every price.
"""

from __future__ import annotations

import os
import time

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import funpay
import markets
import resale

_HERE = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="FunPay Marketplace")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Markup added to every price (in the listing's own currency).
MARKUP = float(os.getenv("MARKUP", "2.00"))

# Storefront name shown in the UI.
SITE_NAME = os.getenv("SITE_NAME", "Game Marketplace")

# How long (seconds) cached data stays fresh before we re-scrape.
CATALOG_TTL = int(os.getenv("CATALOG_TTL", str(24 * 60 * 60)))
OFFERS_TTL = int(os.getenv("OFFERS_TTL", "60"))

_catalog: list[funpay.Game] = []
_catalog_ts: float = 0.0
_offers_cache: dict[str, tuple[float, dict[str, object]]] = {}
_detail_cache: dict[str, tuple[float, dict[str, object]]] = {}


def _get_catalog(force: bool = False) -> list[funpay.Game]:
    global _catalog, _catalog_ts
    if force or not _catalog or time.time() - _catalog_ts > CATALOG_TTL:
        _catalog = funpay.fetch_catalog()
        _catalog_ts = time.time()
    return _catalog


def _serialize_game(game: funpay.Game) -> dict[str, object]:
    return {
        "id": game.id,
        "name": game.name,
        "categories": [
            {
                "name": category.name,
                "sectionId": category.section_id,
                "kind": category.kind,
                "url": category.url,
            }
            for category in game.categories
        ],
    }


@app.get("/")
def home() -> FileResponse:
    return FileResponse(os.path.join(_HERE, "index.html"))


@app.get("/api/games")
def list_games(refresh: bool = False) -> dict[str, object]:
    """Return every game and its categories."""

    catalog = _get_catalog(force=refresh)
    return {
        "count": len(catalog),
        "markup": MARKUP,
        "siteName": SITE_NAME,
        "games": [_serialize_game(game) for game in catalog],
    }


@app.get("/api/offers")
def get_offers(
    url: str = Query(..., description="FunPay listing url to scrape"),
    page: int = 1,
    limit: int = 50,
    refresh: bool = False,
    sellPrice: float = Query(0.0, description="Expected resale price in USD"),
    feePct: float = Query(10.0, description="Marketplace seller fee (percent)"),
) -> dict[str, object]:
    """Scrape (and cache) a single FunPay listing page."""

    if not url.startswith(funpay.BASE_URL):
        raise HTTPException(status_code=400, detail="url must be a FunPay listing url")

    cached = _offers_cache.get(url)
    if refresh or not cached or time.time() - cached[0] > OFFERS_TTL:
        try:
            data = funpay.scrape_offers(url, markup=MARKUP)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - surface upstream failures cleanly
            raise HTTPException(status_code=502, detail=f"FunPay request failed: {exc}") from exc
        _offers_cache[url] = (time.time(), data)
        cached = _offers_cache[url]

    data = cached[1]
    offers = data["offers"]
    assert isinstance(offers, list)

    # Resale insights: summarise the going price and tag each offer with its
    # buy-and-flip economics, so the page slice we return is already annotated.
    stats = resale.market_stats(offers)
    resale.annotate_offers(offers, stats, sellPrice, feePct)
    recommendations = resale.rank_recommendations(offers)

    start = (page - 1) * limit
    end = start + limit
    return {
        "title": data["title"],
        "count": len(offers),
        "page": page,
        "limit": limit,
        "markup": MARKUP,
        "stats": stats,
        "feePct": feePct,
        "sellPrice": sellPrice,
        "recommendations": recommendations,
        "offers": offers[start:end],
    }


@app.get("/api/offer/{offer_id}")
def get_offer_detail(offer_id: str, refresh: bool = False) -> dict[str, object]:
    """Scrape (and cache) the full detail of a single item."""

    cached = _detail_cache.get(offer_id)
    if refresh or not cached or time.time() - cached[0] > OFFERS_TTL:
        try:
            data = funpay.scrape_offer_detail(offer_id, markup=MARKUP)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - surface upstream failures cleanly
            raise HTTPException(status_code=502, detail=f"upstream request failed: {exc}") from exc
        _detail_cache[offer_id] = (time.time(), data)
        cached = _detail_cache[offer_id]

    return cached[1]


_markets_cache: dict[str, tuple[float, dict[str, object]]] = {}
MARKETS_TTL = int(os.getenv("MARKETS_TTL", "600"))


@app.get("/api/markets")
def compare_markets(
    game: str = Query(..., description="Game name to look up on resale sites"),
    category: str = "",
    g2gTerm: str = "",
    refresh: bool = False,
    medianUsd: float = Query(0.0, description="Source-catalog median buy price (USD)"),
    liquidity: str = Query("", description="Source-catalog liquidity rating"),
    supply: int = Query(0, description="Number of priced offers in the source catalog"),
    bestProfitUsd: float = Query(-1.0, description="Best per-flip profit found (USD), -1 if unknown"),
) -> dict[str, object]:
    """Best-effort live price comparison across secondary marketplaces.

    Also returns a plain-English "good to sell" verdict combining live G2G
    demand with the source catalog's supply/liquidity and the best flip found.
    """

    key = f"{game}|{category}|{g2gTerm}"
    cached = _markets_cache.get(key)
    if refresh or not cached or time.time() - cached[0] > MARKETS_TTL:
        try:
            data = markets.compare_markets(game, category, g2gTerm or None)
        except Exception as exc:  # noqa: BLE001 - never let a flaky market break the page
            raise HTTPException(status_code=502, detail=f"market lookup failed: {exc}") from exc
        _markets_cache[key] = (time.time(), data)
        cached = _markets_cache[key]

    data = dict(cached[1])
    g2g = next((m for m in data.get("markets", []) if m.get("source") == "G2G"), None)
    stats = {"priced": supply, "liquidity": liquidity, "medianUsd": medianUsd}
    best_profit = None if bestProfitUsd < 0 else bestProfitUsd
    data["verdict"] = resale.sell_verdict(stats, g2g, best_profit)
    return data


@app.get("/api/trending")
def trending(limit: int = 12, refresh: bool = False) -> dict[str, object]:
    """Popular games ranked by how much they are actually selling on G2G."""

    key = f"__trending__{limit}"
    cached = _markets_cache.get(key)
    if refresh or not cached or time.time() - cached[0] > MARKETS_TTL:
        try:
            data = markets.trending(limit)
        except Exception as exc:  # noqa: BLE001 - never let a flaky market break the page
            raise HTTPException(status_code=502, detail=f"trending lookup failed: {exc}") from exc
        _markets_cache[key] = (time.time(), data)
        cached = _markets_cache[key]

    return cached[1]


if __name__ == "__main__":
    import uvicorn

    # Bound to localhost only: the app is reached through the Node admin panel's
    # authenticated reverse proxy, never exposed publicly on its own port.
    uvicorn.run(
        app,
        host=os.getenv("MARKETPLACE_HOST", "127.0.0.1"),
        port=int(os.getenv("MARKETPLACE_PORT", os.getenv("PORT", "8001"))),
    )