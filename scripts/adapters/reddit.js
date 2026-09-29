/**
 * Reddit adapter — uses Reddit's public Atom RSS feed.
 * The `.json` endpoint now 403s from server IPs (locked to logged-in browsers
 * as of the 2023 API tightening), but the RSS/Atom feed is still open with
 * a proper User-Agent.
 */

const { normalize } = require('../normalize');

const UA = 'nodeserver-news-collector/0.1 (contact: local)';

async function fetchSubreddit(name, listing = 'new', limit = 25) {
  const url = `https://www.reddit.com/r/${name}/${listing}.rss?limit=${limit}`;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`reddit /r/${name}: HTTP ${res.status}`);
  const xml = await res.text();
  return parseAtom(xml, name).map(entry => normalize({
    id: entry.id,
    source: 'reddit',
    sourceHandle: `r/${entry.subreddit || name}`,
    author: entry.author || `r/${entry.subreddit || name}`,
    createdAt: entry.updated,
    title: entry.title || '',
    text: entry.summary.slice(0, 500),
    urls: uniqueUrls([entry.outboundUrl, ...extractUrls(entry.summary)]),
    postUrl: entry.link,
    media: entry.thumb ? [{ type: 'photo', url: entry.thumb }] : [],
    metrics: {},
  }));
}

// Minimal, regex-based Atom parser. Reddit's feed is stable and well-formed.
function parseAtom(xml, subName) {
  const entries = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml))) {
    const body = m[1];
    const id = extractTag(body, 'id') || '';
    const title = decodeXml(extractTag(body, 'title') || '');
    const updated = extractTag(body, 'updated') || new Date().toISOString();
    const link = (body.match(/<link[^>]+href="([^"]+)"/) || [])[1] || '';
    const authorName = decodeXml(
      (body.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/) || [])[1] || ''
    );
    const contentRaw = extractTag(body, 'content') || '';
    const content = decodeXml(contentRaw);
    const outboundUrl = pickOutboundUrl(content, subName);
    const thumb = (content.match(/<img[^>]+src=&quot;([^&]+)&quot;/) || content.match(/<img[^>]+src="([^"]+)"/) || [])[1] || null;
    const category = (body.match(/<category[^>]+term="([^"]+)"/) || [])[1] || null;
    entries.push({
      id,
      title,
      updated,
      link,
      subreddit: category,
      author: authorName ? `u/${authorName.replace(/^\/u\//, '').replace(/^u\//, '')}` : `r/${category || subName}`,
      summary: stripHtml(content),
      outboundUrl,
      thumb,
    });
  }
  return entries;
}

function extractTag(body, tag) {
  const m = body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

function decodeXml(s) {
  let out = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Reddit double-encodes (`&amp;#32;`). Iterate until stable so nested
  // escapes get fully resolved.
  for (let i = 0; i < 3; i++) {
    const before = out;
    out = out
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
    if (out === before) break;
  }
  return out;
}

function stripHtml(s) {
  return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// The FIRST outbound (non-reddit) link in an entry is usually the deal/store URL.
function pickOutboundUrl(content, subName) {
  const links = [...content.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  for (const l of links) {
    if (/^https?:\/\/(www\.)?reddit\.com/.test(l)) continue;
    if (/^https?:\/\/(www\.)?redd\.it/.test(l)) continue;
    return l;
  }
  return null;
}

function extractUrls(text) {
  return (text.match(/https?:\/\/\S+/g) || []).map(u => u.replace(/[.,);\]]+$/, ''));
}

function uniqueUrls(list) {
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

// Reddit's unauth RSS is ~1 req/min per IP. Instead of firing one call per
// subreddit, use a multireddit URL — Reddit natively supports r/a+b+c/new.rss
// which returns merged newest posts across all of them in a single request.
async function fetchAll(subreddits) {
  const items = [];
  const errors = [];
  if (!subreddits.length) return { items, errors };
  const combined = subreddits.map(s => s.name).join('+');
  try {
    const got = await fetchSubreddit(combined, 'new', 50);
    items.push(...got);
  } catch (err) {
    errors.push({ handle: `r/${combined}`, error: err.message });
  }
  return { items, errors };
}

module.exports = { fetchAll, fetchSubreddit };
