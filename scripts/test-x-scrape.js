/**
 * Smoke test for X (Twitter) GraphQL scraping.
 * Reads a cookie session from .env.local, calls UserByScreenName -> UserTweets,
 * prints the latest tweets for a handle.
 *
 * Usage:  node scripts/test-x-scrape.js [handle]
 *         node scripts/test-x-scrape.js FreeGameFindings
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

const HANDLE = process.argv[2] || 'FreeGameFinding';

function need(v, name) {
  if (!v) {
    console.error(`Missing ${name} in .env.local`);
    process.exit(1);
  }
}
need(BEARER, 'X_BEARER');
need(AUTH_TOKEN, 'X_AUTH_TOKEN');
need(CT0, 'X_CT0');
need(UA, 'X_USER_AGENT');
need(QID_USER_BY_SCREEN_NAME, 'X_QID_USER_BY_SCREEN_NAME');
need(QID_TIMELINE, 'X_QID_USER_ORIGINALS_TIMELINE');

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
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${opName} HTTP ${res.status}\n${text.slice(0, 600)}`);
  }
  try { return JSON.parse(text); }
  catch { throw new Error(`${opName} non-JSON:\n${text.slice(0, 400)}`); }
}

// Mirror of the current x.com web client's UserByScreenName request (captured 2026-08-18).
// If X redeploys and errors with "missing features", re-capture and update this block.
const USER_VARIABLES = (screen_name) => ({
  screen_name,
  withGrokTranslatedBio: true,
});

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

// Mirror of the current x.com UserOriginalsTimeline request (captured 2026-08-18).
const TIMELINE_VARIABLES = (userId) => ({
  userId,
  count: 20,
  includePromotedContent: true,
  withQuickPromoteEligibilityTweetFields: true,
  withVoice: true,
});

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

const TIMELINE_FIELD_TOGGLES = {
  withArticlePlainText: false,
};

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
    // Threaded conversation modules
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

async function main() {
  console.log(`\n→ Resolving @${HANDLE}…`);
  const u = await gql(
    QID_USER_BY_SCREEN_NAME,
    'UserByScreenName',
    USER_VARIABLES(HANDLE),
    USER_FEATURES,
    USER_FIELD_TOGGLES,
  );
  const userId = u?.data?.user?.result?.rest_id;
  if (!userId) {
    console.error('No user_id in UserByScreenName response:');
    console.error(JSON.stringify(u, null, 2).slice(0, 800));
    process.exit(1);
  }
  console.log(`  user_id: ${userId}`);

  console.log(`→ Fetching UserOriginalsTimeline…`);
  const t = await gql(
    QID_TIMELINE,
    'UserOriginalsTimeline',
    TIMELINE_VARIABLES(userId),
    TIMELINE_FEATURES,
    TIMELINE_FIELD_TOGGLES,
  );

  const tweets = flattenTweets(t);
  if (!tweets.length) {
    console.error('No tweets parsed. Raw payload head:');
    console.error(JSON.stringify(t, null, 2).slice(0, 1200));
    process.exit(1);
  }

  console.log(`\nLatest ${Math.min(5, tweets.length)} tweets:\n`);
  for (const tw of tweets.slice(0, 5)) {
    const l = tw.legacy;
    const created = new Date(l.created_at).toISOString();
    const text = (l.full_text || '').replace(/\s+/g, ' ').trim();
    const urls = (l.entities?.urls || []).map(x => x.expanded_url);
    console.log(`[${created}] id=${l.id_str}`);
    console.log(`  ${text}`);
    if (urls.length) console.log(`  urls: ${urls.join(', ')}`);
    console.log();
  }
  console.log('✔ Smoke test OK');
}

main().catch(err => {
  console.error('\n✖ Smoke test failed:');
  console.error(err.message);
  process.exit(1);
});
