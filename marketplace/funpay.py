"""Scraping helpers for FunPay.

This module knows how to do two things:

1. Build a *catalog* of every game listed on the FunPay home page together with
   its categories (Accounts, Items, Twitch Drops, Top Up, ...). Each category
   points at a FunPay listing page.
2. Scrape an individual listing page (``/lots/<id>/`` or ``/chips/<id>/``) into a
   normalised list of offers.

The rest of the app only ever talks to these helpers, so all of the FunPay HTML
knowledge lives in one place.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

import requests
from bs4 import BeautifulSoup, Tag

BASE_URL = "https://funpay.com/en/"
HOME_URL = BASE_URL

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

# Matches the first numeric value (with optional decimals) in a price string,
# tolerating spaces / non breaking spaces used as thousands separators.
_PRICE_RE = re.compile(r"(\d[\d \u00a0]*(?:[.,]\d+)?)")
_CURRENCY_RE = re.compile(r"[€$£₽]|RUB|USD|EUR", re.IGNORECASE)

# Strips upstream branding (urls + the source name) from any text we display so
# the site reads as the operator's own storefront.
_BRAND_URL_RE = re.compile(r"https?://\S*funpay\S*", re.IGNORECASE)
_BRAND_WORD_RE = re.compile(r"\b(?:funpay\.?com|funpay)\b", re.IGNORECASE)


def debrand(text: str) -> str:
    """Remove upstream brand names / links from user facing text."""

    if not text:
        return ""
    cleaned = _BRAND_URL_RE.sub("", text)
    cleaned = _BRAND_WORD_RE.sub("", cleaned)
    return re.sub(r"\s{2,}", " ", cleaned).strip(" -|·")

_SESSION = requests.Session()
_SESSION.headers.update(HEADERS)


@dataclass
class Category:
    """A single buyable section of a game, e.g. "Twitch Drops"."""

    name: str
    url: str
    section_id: str
    kind: str  # "lots" or "chips"


@dataclass
class Game:
    """A game on FunPay together with all of its categories."""

    id: str
    name: str
    categories: list[Category] = field(default_factory=list)


def _fetch(url: str, timeout: int = 30) -> str:
    response = _SESSION.get(url, timeout=timeout)
    response.raise_for_status()
    return response.text


def _parse_section_url(url: str) -> Optional[tuple[str, str]]:
    """Return ``(kind, section_id)`` for a FunPay listing URL, else ``None``."""

    match = re.search(r"/(lots|chips)/(\d+)/", url)
    if not match:
        return None
    return match.group(1), match.group(2)


def fetch_catalog() -> list[Game]:
    """Scrape the FunPay home page into a list of :class:`Game`."""

    soup = BeautifulSoup(_fetch(HOME_URL), "html.parser")
    games: list[Game] = []

    for item in soup.select(".promo-game-item"):
        title_el = item.select_one(".game-title")
        if not title_el:
            continue

        name = title_el.get_text(strip=True)
        game_id = title_el.get("data-id") or ""
        categories: list[Category] = []
        seen: set[str] = set()

        for link in item.select(".list-inline li a"):
            href = link.get("href", "")
            parsed = _parse_section_url(href)
            if not parsed:
                continue
            kind, section_id = parsed
            if href in seen:
                continue
            seen.add(href)
            categories.append(
                Category(
                    name=link.get_text(strip=True) or "Listing",
                    url=href,
                    section_id=section_id,
                    kind=kind,
                )
            )

        if name and categories:
            games.append(Game(id=game_id, name=name, categories=categories))

    games.sort(key=lambda game: game.name.lower())
    return games


def parse_price(raw: str) -> tuple[float, str]:
    """Return ``(value, currency)`` parsed from a FunPay price string."""

    value = 0.0
    match = _PRICE_RE.search(raw or "")
    if match:
        cleaned = match.group(1).replace(" ", "").replace("\u00a0", "")
        cleaned = cleaned.replace(",", ".")
        try:
            value = float(cleaned)
        except ValueError:
            value = 0.0

    currency_match = _CURRENCY_RE.search(raw or "")
    currency = currency_match.group(0) if currency_match else ""
    return value, currency


def _text(node: Optional[Tag]) -> str:
    return node.get_text(" ", strip=True) if node else ""


def _build_description(row: Tag, fallback: str) -> str:
    """Build a human friendly description.

    ``/lots/`` rows have a ``.tc-desc-text`` block. ``/chips/`` rows (currencies)
    have no description, so we stitch together the server / side / amount columns.
    """

    desc = _text(row.select_one(".tc-desc-text"))
    if desc:
        return desc

    parts = [
        _text(row.select_one(".tc-server")),
        _text(row.select_one(".tc-side")),
    ]
    amount = _text(row.select_one(".tc-amount"))
    if amount:
        parts.append(f"{amount} in stock")
    parts = [part for part in parts if part]
    return " · ".join(parts) if parts else fallback


def scrape_offers(url: str, markup: float = 0.0) -> dict[str, object]:
    """Scrape a single FunPay listing page into normalised offers."""

    parsed = _parse_section_url(url)
    if not parsed:
        raise ValueError(f"Unsupported FunPay url: {url!r}")

    soup = BeautifulSoup(_fetch(url), "html.parser")
    heading = debrand(_text(soup.select_one("h1"))) or "Offers"

    offers: list[dict[str, object]] = []
    for row in soup.select(".tc-item"):
        price_value, currency = parse_price(_text(row.select_one(".tc-price")))
        final_value = round(price_value + markup, 2)
        symbol = currency or "€"

        offers.append(
            {
                "id": _offer_id(row.get("href", "")),
                "description": debrand(_build_description(row, heading)),
                "seller": _text(row.select_one(".media-user-name")) or "Unknown",
                "server": _text(row.select_one(".tc-server")),
                "amount": _text(row.select_one(".tc-amount")),
                "originalPrice": price_value,
                "currency": symbol,
                "price": f"{final_value:.2f} {symbol}".strip(),
                "priceValue": final_value,
            }
        )

    return {"title": heading, "offers": offers}


def _offer_id(href: str) -> str:
    match = re.search(r"[?&]id=(\d+)", href or "")
    return match.group(1) if match else ""


def scrape_offer_detail(offer_id: str, markup: float = 0.0) -> dict[str, object]:
    """Scrape a single item page into a normalised detail record."""

    if not offer_id.isdigit():
        raise ValueError(f"Invalid offer id: {offer_id!r}")

    url = f"{BASE_URL}lots/offer?id={offer_id}"
    soup = BeautifulSoup(_fetch(url), "html.parser")

    # Skip purely transactional / pricing-internal rows from the upstream page.
    skip = {
        "your account will be charged for",
        "account payment discount",
        "remaining price",
    }

    params: list[dict[str, str]] = []
    short_desc = ""
    detailed_desc = ""
    for item in soup.select(".param-item"):
        head = item.find("h5")
        label = _text(head)
        if head:
            head.extract()
        value = debrand(_text(item))
        norm = label.replace("\u00a0", " ").strip().lower()
        if not value or norm in skip:
            continue
        if norm == "short description":
            short_desc = value
        elif norm == "detailed description":
            detailed_desc = value
        else:
            params.append({"label": label.replace("\u00a0", " ").strip(), "value": value})

    avatar = soup.select_one(".media-user .avatar-photo, .media-user img")
    avatar_url = ""
    if avatar:
        avatar_url = avatar.get("src") or ""
        if not avatar_url and avatar.get("style"):
            match = re.search(r"url\(([^)]+)\)", avatar["style"])
            if match:
                avatar_url = match.group(1).strip("'\"")

    # The upstream item page <h1> is a generic label ("Ordering"), so prefer the
    # short description as the human readable title.
    title = short_desc or debrand(_text(soup.select_one("h1"))) or "Item"

    return {
        "id": offer_id,
        "title": title,
        "shortDescription": short_desc,
        "detailedDescription": detailed_desc,
        "params": params,
        "seller": _text(soup.select_one(".media-user-name")) or "Unknown",
        "sellerOnline": bool(soup.select_one(".media-user .chat-msg-author-online, .online")),
        "sellerAvatar": avatar_url,
    }
