/**
 * Reusable X (Twitter) GraphQL client for the news collector prototype.
 * Uses a cookie session from .env.local. Caches user_id lookups.
 */

require('dotenv').config({ path: '.env.local' });

const BEARER = process.env.X_BEARER;
const AUTH_TOKEN = process.env.X_AUTH_TOKEN;
const CT0 = process.env.X_CT0;
const UA = process.env.X_USER_AGENT;
const GUEST_ID = process.env.X_GUEST_ID || '';
const PERSONALIZATION_ID = process.env.X_PERSONALIZATION_ID || '';
const TWID = process.env.X_TWID || '';

const QID_USER_BY_SCREEN_NAME = process.env.X_QID_USER_BY_SCREEN_NAME;
const QID_TIMELINE = process.env.X_QID_USER_ORIGINALS_TIMELINE;
const QID_SEARCH_TIMELINE = process.env.X_QID_SEARCH_TIMELINE || null;

function requireEnv() {
  const missing = [];
  if (!BEARER) missing.push('X_BEARER');
  if (!AUTH_TOKEN) missing.push('X_AUTH_TOKEN');
  if (!CT0) missing.push('X_CT0');
  if (!UA) missing.push('X_USER_AGENT');
  if (!QID_USER_BY_SCREEN_NAME) missing.push('X_QID_USER_BY_SCREEN_NAME');
  if (!QID_TIMELINE) missing.push('X_QID_USER_ORIGINALS_TIMELINE');
  if (missing.length) {
    throw new Error(`Missing env in .env.local: ${missing.join(', ')}`);
  }
}

function searchAvailable() {
  return Boolean(QID_SEARCH_TIMELINE);
}

function cookieHeader() {
  return [
    GUEST_ID && `guest_id=${GUEST_ID}`,
    PERSONALIZATION_ID && `personalization_id="${PERSONALIZATION_ID}"`,
    TWID && `twid=${TWID}`,
    `auth_token=${AUTH_TOKEN}`,
    `ct0=${CT0}`,
  ].filter(Boolean).join('; ');
}

function baseHeaders() {
  return {
    'authorization': `Bearer ${BEARER}`,
    'x-csrf-token': CT0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'accept': '*/*',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'user-agent': UA,
    'referer': 'https://x.com/',
    'origin': 'https://x.com',
    'cookie': cookieHeader(),
  };
}

async function gql(qid, opName, variables, features, fieldToggles) {
  let url = `https://x.com/i/api/graphql/${qid}/${opName}`
    + `?variables=${encodeURIComponent(JSON.stringify(variables))}`
    + `&features=${encodeURIComponent(JSON.stringify(features))}`;
  if (fieldToggles) {
    url += `&fieldToggles=${encodeURIComponent(JSON.stringify(fieldToggles))}`;
  }
  const res = await fetch(url, { headers: baseHeaders() });
  const rateLimit = {
    limit: Number(res.headers.get('x-rate-limit-limit')) || null,
    remaining: Number(res.headers.get('x-rate-limit-remaining')) || null,
    resetAt: Number(res.headers.get('x-rate-limit-reset')) * 1000 || null,
  };
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${opName} HTTP ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.rateLimit = rateLimit;
    throw err;
  }
  return { json: JSON.parse(text), rateLimit };
}

// ---- Endpoint request shapes (captured 2026-08-18) --------------------------

const USER_FEATURES = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const USER_FIELD_TOGGLES = {
  withPayments: false,
  withAuxiliaryUserLabels: true,
};

const TIMELINE_FEATURES = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

const TIMELINE_FIELD_TOGGLES = { withArticlePlainText: false };

// ---- Public API -------------------------------------------------------------

const userIdCache = new Map(); // handle(lowercase) -> user_id

async function resolveUserId(handle) {
  requireEnv();
  const key = handle.toLowerCase();
  if (userIdCache.has(key)) return userIdCache.get(key);
  const { json } = await gql(
    QID_USER_BY_SCREEN_NAME,
    'UserByScreenName',
    { screen_name: handle, withGrokTranslatedBio: true },
    USER_FEATURES,
    USER_FIELD_TOGGLES,
  );
  const userId = json?.data?.user?.result?.rest_id;
  if (!userId) {
    throw new Error(`Could not resolve @${handle}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  userIdCache.set(key, userId);
  return userId;
}

function flattenTweets(payload) {
  const instructions = payload?.data?.user?.result?.timeline?.timeline?.instructions
    || payload?.data?.user?.result?.timeline_v2?.timeline?.instructions
    || [];
  const entries = [];
  for (const ins of instructions) {
    if (Array.isArray(ins.entries)) entries.push(...ins.entries);
    if (ins.entry) entries.push(ins.entry);
  }
  const results = [];
  for (const e of entries) {
    const item = e?.content?.itemContent?.tweet_results?.result;
    if (item) {
      const t = item.__typename === 'TweetWithVisibilityResults' ? item.tweet : item;
      if (t?.legacy) results.push(t);
    }
    const items = e?.content?.items || [];
    for (const it of items) {
      const it2 = it?.item?.itemContent?.tweet_results?.result;
      if (it2) {
        const t = it2.__typename === 'TweetWithVisibilityResults' ? it2.tweet : it2;
        if (t?.legacy) results.push(t);
      }
    }
  }
  return results;
}

const { normalize } = require('./normalize');

function normalizeTweet(raw, handle) {
  const l = raw.legacy;
  const u = raw.core?.user_results?.result?.legacy || raw.core?.user_results?.result?.core || {};
  return normalize({
    id: l.id_str,
    source: 'x',
    sourceHandle: handle,
    author: u.name || handle,
    createdAt: new Date(l.created_at).toISOString(),
    text: (l.full_text || l.text || '').trim(),
    urls: (l.entities?.urls || []).map(x => x.expanded_url).filter(Boolean),
    postUrl: `https://x.com/${handle}/status/${l.id_str}`,
    media: (l.entities?.media || []).map(m => ({ type: m.type, url: m.media_url_https })),
    metrics: {
      likes: l.favorite_count,
      retweets: l.retweet_count,
      comments: l.reply_count,
    },
  });
}

// SearchTimeline endpoint — variables/features shape captured from x.com
// as of 2026-08. If the hash rotates, re-capture and paste into .env.local.
async function searchTweets(query, count = 20) {
  requireEnv();
  if (!QID_SEARCH_TIMELINE) throw new Error('X_QID_SEARCH_TIMELINE not set in .env.local');
  const { json, rateLimit } = await gql(
    QID_SEARCH_TIMELINE,
    'SearchTimeline',
    {
      rawQuery: query,
      count,
      querySource: 'typed_query',
      product: 'Latest',
    },
    TIMELINE_FEATURES,
    TIMELINE_FIELD_TOGGLES,
  );
  const instructions = json?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions
    || json?.data?.search_by_raw_query?.search_timeline?.timeline_v2?.timeline?.instructions
    || [];
  const entries = [];
  for (const ins of instructions) {
    if (Array.isArray(ins.entries)) entries.push(...ins.entries);
    if (ins.entry) entries.push(ins.entry);
  }
  const results = [];
  for (const e of entries) {
    const item = e?.content?.itemContent?.tweet_results?.result;
    if (item) {
      const t = item.__typename === 'TweetWithVisibilityResults' ? item.tweet : item;
      if (t?.legacy) {
        const handle = t.core?.user_results?.result?.legacy?.screen_name
          || t.core?.user_results?.result?.core?.screen_name
          || 'search';
        results.push(normalizeTweet(t, handle));
      }
    }
  }
  return { tweets: results, rateLimit };
}

async function fetchHandle(handle, count = 20) {
  requireEnv();
  const userId = await resolveUserId(handle);
  const { json, rateLimit } = await gql(
    QID_TIMELINE,
    'UserOriginalsTimeline',
    {
      userId,
      count,
      includePromotedContent: true,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
    },
    TIMELINE_FEATURES,
    TIMELINE_FIELD_TOGGLES,
  );
  const tweets = flattenTweets(json).map(t => normalizeTweet(t, handle));
  return { handle, tweets, rateLimit };
}

module.exports = {
  fetchHandle,
  resolveUserId,
  searchTweets,
  searchAvailable,
};
