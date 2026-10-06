// English for the SOOP farm. SOOP is asked for English (accept-language) but
// still answers most campaign titles, category names and reward names in
// Korean; this module cleans that up with a phrase glossary. The glossary and
// the GAMES seed were built from the 171 real campaigns in
// _soop-probe/events.json. Text from SOOP is data: nothing here drops or
// invents content, and Hangul nobody has an entry for is left exactly as is.

const HANGUL_RE = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-퟿]/;

function hasHangul(s) {
  return typeof s === "string" && HANGUL_RE.test(s);
}

// [korean, english]. Phrase-level entries come first in spirit: Korean
// modifier-noun order matches English for these compounds, so a whole phrase
// ("인게임 아이템 드롭스") reads better than its words swapped one by one. Order in
// this list does not matter — matching is longest phrase first. A space in a
// key also matches no space (SOOP writes "결승 진출전" and "결승진출전").
// No one-syllable keys except "컵": counters such as 회 / 차 / 원 are handled
// with their number in RULES, where the digits keep them from matching inside words.
const GLOSSARY = [
  // drops vocabulary
  ["인게임 아이템 드롭스", "In-game Item Drops"], ["인게임 아이템", "In-game Item"], ["인게임", "In-game"],
  ["드롭스 이벤트", "Drops Event"], ["드롭스 토큰", "Drops Token"], ["카테고리 드롭스", "Category Drops"],
  ["매일매일 드롭스", "Daily Drops"], ["퀴즈 드롭스", "Quiz Drops"], ["웰컴 드롭스", "Welcome Drops"],
  ["드롭스", "Drops"], ["드롭", "Drop"], ["시청 미션", "Watch Mission"], ["시청 보상", "Watch Reward"],
  ["시청", "Watch"], ["미션", "Mission"], ["보상", "Reward"], ["이벤트", "Event"],
  ["유저 참여 이벤트", "Viewer Participation Event"], ["아이템", "Item"], ["카테고리", "Category"],
  ["토큰", "Token"], ["조각", "Shard"], ["이스포츠", "Esports"], ["e스포츠", "Esports"],
  // broadcast vocabulary
  ["생방송", "Live Broadcast"], ["생중계", "Live Broadcast"], ["입중계", "Live Commentary"],
  ["중계", "Broadcast"], ["방송", "Broadcast"],
  ["라이브", "Live"], ["코스트리밍", "Co-streaming"], ["합방", "Collab Stream"], ["다시보기", "Replay"],
  ["재방송", "Rerun"], ["하이라이트", "Highlights"], ["공식 채널", "Official Channel"], ["공식", "Official"],
  ["버추얼 스트리머", "Virtual Streamer"], ["버추얼", "Virtual"], ["스트리머", "Streamer"],
  ["서포터즈", "Supporters"], ["웰컴", "Welcome"], ["콘텐츠", "Content"], ["컨텐츠", "Content"],
  ["특선 영화", "Special Movie"], ["스페셜 무비", "Special Movie"], ["영화", "Movie"], ["특집", "Special"],
  ["오픈 기념", "Launch Special"], ["기념", "Special"], ["월간", "Monthly"], ["모바일", "Mobile"],
  ["추석 특선 영화", "Chuseok Special Movie"], ["추석 특집", "Chuseok Special"], ["추석 기념", "Chuseok Special"],
  ["추석편", "Chuseok Edition"], ["추석맞이", "Chuseok"], ["추석", "Chuseok"], ["부산편", "Busan Edition"],
  ["부산", "Busan"], ["서울", "Seoul"],
  // stages and formats
  ["결승 진출전", "Finals Qualifier"], ["결승전", "Finals"], ["결승", "Finals"], ["준결승", "Semifinals"],
  ["금메달 결정전", "Gold Medal Match"], ["평가전", "Exhibition Match"], ["와일드카드전", "Wildcard Match"],
  ["개막전", "Opening Match"], ["생존전", "Survival Battle"], ["승자조", "Winners' Bracket"],
  ["패자조", "Losers' Bracket"], ["예선", "Qualifier"], ["본선", "Main Stage"], ["플레이오프", "Playoffs"],
  ["정규 시즌", "Regular Season"], ["미드시즌", "Mid-Season"], ["시즌", "Season"], ["페이즈", "Phase"],
  ["서킷", "Circuit"], ["프로 서킷", "Pro Circuit"], ["주차", "Week"], ["회차", "Round"],
  ["월드 챔피언십", "World Championship"], ["챔피언십", "Championship"], ["선수권", "Championship"],
  ["챌린저스", "Challengers"], ["챌린저", "Challenger"], ["파이널스", "Finals"], ["파이널", "Final"],
  ["퀄리파이어", "Qualifier"], ["클로즈드", "Closed"],
  ["인비테이셔널", "Invitational"], ["마스터즈", "Masters"], ["마스터 클래스", "Master Class"], ["마스터", "Master"],
  ["토너먼트", "Tournament"], ["리그", "League"], ["대회", "Tournament"], ["컵", "Cup"],
  ["글로벌 테스트", "Global Test"], ["테스트", "Test"], ["하드코어", "Hardcore"], ["퍼시픽", "Pacific"],
  // weekdays as SOOP writes them in dated titles
  ["(일)", "(Sun)"], ["(월)", "(Mon)"], ["(화)", "(Tue)"], ["(수)", "(Wed)"], ["(목)", "(Thu)"],
  ["(금)", "(Fri)"], ["(토)", "(Sat)"],
  // rewards
  ["컬쳐랜드 문화상품권", "Cultureland Gift Voucher"], ["컬처랜드 문화상품권", "Cultureland Gift Voucher"],
  ["문화상품권", "Culture Gift Voucher"], ["모바일 상품권", "Mobile Voucher"], ["모바일 금액권", "Mobile Voucher"],
  ["상품권", "Gift Voucher"], ["기프티콘", "Gift Coupon"], ["기프트카드", "Gift Card"], ["쿠폰", "Coupon"],
  ["코인", "Coin"], ["넥슨캐시", "Nexon Cash"], ["컬쳐랜드", "Cultureland"], ["컬처랜드", "Cultureland"],
  ["네이버페이", "Naver Pay"], ["구글플레이", "Google Play"], ["배달의민족", "Baemin"], ["메가박스", "Megabox"],
  ["영화 예매권", "Movie Ticket"], ["맥도날드", "McDonald's"], ["맘스터치", "Mom's Touch"],
  ["싸이버거 세트", "Thigh Burger Set"], ["아이스 아메리카노", "Iced Americano"], ["커피", "Coffee"],
  ["선택형", "Choice of"], ["황금올리브치킨", "Golden Olive Chicken"], ["후라이드 치킨", "Fried Chicken"],
  ["기영이숯불치킨", "Kiyoung-i Charcoal Chicken"], ["크크크치킨", "Keu-Keu-Keu Chicken"], ["치킨", "Chicken"],
  ["콜라", "Cola"], ["세트", "Set"], ["전리품 상자", "Loot Box"], ["상자", "Box"], ["보급함", "Supply Crate"],
  ["특급", "Epic"], ["전설", "Legendary"], ["희귀", "Rare"], ["일반", "Standard"], ["베이직", "Basic"],
  ["골드", "Gold"], ["코드", "Code"], ["한정", "Exclusive"], ["랜덤", "Random"], ["선물", "Gift"],
  ["포토카드", "Photocard"], ["친필 사인 유니폼", "Autographed Jersey"], ["유니폼", "Jersey"], ["선수단", "Team"],
  ["키캡", "Keycap"], ["키링", "Keyring"], ["메탈 뱃지", "Metal Badge"], ["인형", "Plush"], ["젤펜", "Gel Pen"],
  ["짐색", "Gym Sack"], ["클리커", "Clicker"], ["스마트폰 마이크", "Smartphone Mic"], ["선풍기", "Fan"],
  ["로고 모자", "Logo Cap"], ["티셔츠", "T-shirt"], ["이모티콘", "Emoticon"], ["스킨", "Skin"],
  ["아이콘", "Icon"], ["챔피언스", "Champions"], ["상하이", "Shanghai"], ["신캐", "New Character"], ["연구소", "Lab"], ["플레이어", "Player"], ["선수", "Player"], ["팀", "Team"], ["스프레이", "Spray"], ["탈 것", "Mount"], ["카드", "Card"], ["티켓", "Ticket"],
  ["응모권", "Raffle Ticket"], ["추첨", "Raffle"], ["보물", "Treasure"], ["행운의", "Lucky"],
  ["스타 드롭", "Star Drop"], ["웰치스", "Welch's"], ["온사이드", "Onside"], ["로켓", "Rocket"],
  // in-game reward names (Wuthering Waves, Delta Force, Heroes of the Storm)
  ["클램 코인", "Shell Credit"], ["중급 공명 촉진제", "Medium Resonance Potion"], ["별의 소리", "Astrite"],
  ["고급 에너지 코어", "Advanced Energy Core"], ["고급 에너지 주머니", "Advanced Energy Bag"],
  ["신병 제식 장비 티켓", "Recruit Standard Gear Ticket"], ["표준 제식 장비 티켓", "Standard Issue Gear Ticket"],
  ["화력 총동원", "Full Firepower"], ["물류 증표", "Logistics Voucher"],
  ["영예로운 치명적인 혼돈의 늑대", "Glorious Vicious Chaos Wolf"],
  // games
  ["이터널 리턴", "Eternal Return"], ["오버워치", "Overwatch"], ["스타크래프트", "StarCraft"], ["스타2", "SC2"],
  ["스타리그", "Starleague"], ["히어로즈 오브 더 스톰", "Heroes of the Storm"],
  ["히어로즈 오브 스톰", "Heroes of the Storm"], ["명조: 워더링 웨이브", "Wuthering Waves"],
  ["워더링 웨이브", "Wuthering Waves"], ["명조", "Wuthering Waves"], ["더 파이널스", "THE FINALS"],
  ["브롤스타즈", "Brawl Stars"], ["사일런트 힐: 타운폴", "Silent Hill: Townfall"], ["사일런트 힐", "Silent Hill"],
  ["프로젝트 제타", "Project ZETA"], ["리그 오브 레전드", "League of Legends"], ["발로란트", "VALORANT"],
  ["배틀그라운드", "PUBG"], ["전략적 팀 전투", "Teamfight Tactics"], ["델타 포스", "Delta Force"],
  ["FC 온라인", "FC Online"], ["FC 모바일", "FC Mobile"], ["FC 프로 모바일", "FC Pro Mobile"],
  ["패스 오브 엑자일", "Path of Exile"], ["하스스톤", "Hearthstone"], ["디아블로", "Diablo"],
  ["메이플스토리", "MapleStory"], ["로스트아크", "Lost Ark"], ["서든어택", "Sudden Attack"],
  ["던전앤파이터", "Dungeon & Fighter"], ["마인크래프트", "Minecraft"], ["철권", "TEKKEN"],
  // leagues, shows and streamer events
  ["멸망전", "Myeolmangjeon"], ["절망전", "Jeolmangjeon"], ["쿵푸컵", "Kung Fu Cup"], ["코드컵", "Code Cup"],
  ["쩐의 전쟁", "War of Money"], ["협곡엔터키", "Rift Enter Key"], ["개화 컵", "Bloom Cup"],
  ["HyperX배", "HyperX Cup"], ["연예인", "Celebrity"], ["코발트의 망령들", "Ghosts of Cobalt"],
  ["루미아", "Lumia"], ["니키", "Nicky"], ["데굴데굴", "Roly-Poly"],
  ["방송 부흥 대작전", "Stream Revival Operation"], ["엠블럼 시스템", "Emblem System"],
  ["랜선투어", "Online Tour"], ["이달의 게임 파트너", "Game Partner of the Month"],
  ["먼.겜.파", "Monthly Game Partner"], ["두치와뿌꾸", "Doochi & Ppukku"], ["밸런스게임", "Balance Game"],
  ["고버지가 쏜다", "Gobeoji's Treat"], ["봉멤편", "Bong Crew Edition"], ["권피스", "Kwon Peace"],
  ["직진 윷놀이", "Straight-Ahead Yutnori"], ["윷놀이", "Yutnori"], ["고카상사", "Goka Corp"],
  ["선물 대전", "Gift Battle"], ["왁치동", "Wakchidong"], ["두뇌풀가동", "Full Brain Power"],
  ["종겜동", "Jonggemdong"], ["천하제일", "World's Best"], ["단타대회", "Day-Trading Contest"],
  ["나눔 봉사", "Sharing & Volunteering"], ["숲불짬뽕", "SOOP-bul Jjamppong"],
  ["한 그릇의 온기", "Warmth in a Bowl"], ["숲피커", "SOOPeaker"], ["시사 콘텐츠", "Current Affairs Content"],
  ["연하모니", "Yeon-Harmony"], ["레드불", "Red Bull"], ["줄타기", "Tightrope"], ["마왕루야", "Mawang Ruya"],
  ["VCT 퍼시픽에서 생긴일", "What Happened at VCT Pacific"], ["e리그앙 투어 코리아", "eLigue 1 Tour Korea"],
  ["젠랑이", "Genrang"], ["젠랑", "Genrang"], ["꿈돌이", "Kkumdori"], ["굿나잇 쇼가사리", "Good Night Shogasari"],
  // sports
  ["박신자컵", "Park Shin-ja Cup"], ["아시아 남자 배구선수권", "Asian Men's Volleyball Championship"],
  ["아시안게임", "Asian Games"], ["아시아", "Asia"], ["국가대표", "National Team"], ["남자", "Men's"],
  ["여자", "Women's"], ["프로배구", "Pro Volleyball"], ["프로야구", "Pro Baseball"],
  ["프로농구", "Pro Basketball"], ["프로축구", "Pro Football"], ["배구", "Volleyball"], ["축구", "Football"],
  ["야구", "Baseball"], ["농구", "Basketball"], ["격투기", "Combat Sports"], ["복싱", "Boxing"],
  ["피트니스", "Fitness"], ["요가", "Yoga"], ["타쿠마 이노우에", "Takuma Inoue"],
  ["텐신 나스카와", "Tenshin Nasukawa"], ["노체", "Noche"], ["실바", "Silva"], ["델가도", "Delgado"],
  ["후커", "Hooker"], ["파르나스", "Parnasse"],
  // TV channels and programmes
  ["아리랑TV", "Arirang TV"], ["아리랑", "Arirang"], ["국민방송", "National Broadcasting"],
  ["냉장고를 부탁해", "Please Take Care of My Refrigerator"], ["날아올라라 나비", "Fly High Butterfly"],
  ["한문철의 블랙박스 리뷰", "Han Moon-chul's Blackbox Review"], ["연애전쟁", "Love War"],
  ["조선혼담공작소 꽃파당", "Flower Crew: Joseon Marriage Agency"], ["빅토리", "Victory"], ["헌트", "Hunt"],
  ["디스이즈 현무로드", "This Is Hyun-moo Road"], ["전현무계획", "Jun Hyun-moo's Plan"],
  ["원더풀 라디오", "Wonderful Radio"], ["마더스", "Mothers"], ["비밀의 언덕", "The Hill of Secrets"],
  ["전설의 사내", "The Legendary Man"], ["빈칸 채우기", "Fill in the Blanks"], ["국군의 날", "Armed Forces Day"],
  ["국무회의", "Cabinet Meeting"], ["강적들", "Strong Opponents"], ["미스트롯 포유", "Miss Trot For You"],
  ["프라임타임 에미상", "Primetime Emmy Awards"],
];

// gameNo -> name. `kind` lets the UI keep games apart from TV, sports and
// SOOP's own promotions. Guessed from the evidence in the probe file where
// SOOP gives no category name: 248 (KRAFTON + KeSPA Asian Games try-outs),
// 407 (a game-category league paid in Nexon Cash), 305 (single-streamer gifts).
const GAMES = {
  "4": { name: "League of Legends", kind: "game" }, "6": { name: "Teamfight Tactics", kind: "game" },
  "8": { name: "PUBG", kind: "game" }, "10": { name: "StarCraft", kind: "game" },
  "12": { name: "Overwatch", kind: "game" }, "14": { name: "VALORANT", kind: "game" },
  "16": { name: "StarCraft II", kind: "game" }, "18": { name: "Eternal Return", kind: "game" },
  "26": { name: "THE FINALS", kind: "game" }, "28": { name: "Variety Games", kind: "game" },
  "30": { name: "FC Online", kind: "game" }, "94": { name: "Path of Exile 2", kind: "game" },
  "164": { name: "FC Mobile", kind: "game" }, "170": { name: "Virtual Streamers", kind: "platform" },
  "200": { name: "Delta Force", kind: "game" }, "242": { name: "Monthly Online Tour", kind: "platform" },
  "244": { name: "Wuthering Waves", kind: "game" }, "248": { name: "PUBG Mobile", kind: "game" },
  "269": { name: "JTBC", kind: "tv" }, "281": { name: "Project ZETA", kind: "game" },
  "299": { name: "Current Affairs", kind: "platform" }, "305": { name: "Streamer Giveaways", kind: "platform" },
  "313": { name: "Charity & Volunteering", kind: "platform" }, "327": { name: "Brawl Stars", kind: "game" },
  "335": { name: "Welcome Drops", kind: "platform" }, "349": { name: "National Team", kind: "sports" },
  "363": { name: "MBN", kind: "tv" }, "369": { name: "Combat Sports", kind: "sports" },
  "379": { name: "Pro Volleyball", kind: "sports" }, "381": { name: "Economy & Finance", kind: "platform" },
  "383": { name: "Arirang TV / KTV", kind: "tv" }, "385": { name: "WKBL", kind: "sports" },
  "387": { name: "TV CHOSUN", kind: "tv" }, "407": { name: "FCL", kind: "game" },
  "415": { name: "Fitness", kind: "sports" }, "421": { name: "Silent Hill: Townfall", kind: "game" },
  "425": { name: "Emblem System", kind: "platform" }, "427": { name: "Red Bull", kind: "sports" },
  "433": { name: "Heroes of the Storm", kind: "game" },
};

const PROVIDERS = { kuro: "Kuro Games", krafton: "KRAFTON", riot: "Riot Games", nexon: "NEXON" };
const REWARD_KIND_LABEL = {
  code: "Code",
  link: "Link / form",
  ingame: "In-game (linked account)",
  other: "Other",
};
const GIVE_CON_LABEL = { term: "Guaranteed", draw: "Raffle", none: "Random" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
  "October", "November", "December"];
const BRACKET = { 4: "Semifinals", 8: "Quarterfinals" };
const NO_HANGUL_NEXT = "(?![\\uAC00-\\uD7A3])";

function ordinal(n) {
  const v = Number(n) % 100;
  const suffix = v > 10 && v < 14 ? "th" : ["th", "st", "nd", "rd"][v % 10] || "th";
  return `${Number(n)}${suffix}`;
}

function won(n) {
  return `${Number(n).toLocaleString("en-US")} KRW`;
}

// Korean puts the counter after the number ("6회", "1주차", "5천원"), English
// before it, so these cannot be glossary phrases. Applied before the glossary,
// in this order (specific counters first).
const RULES = [
  [/제\s?(\d+)\s?주년(\s+(?=\S))?/g, (n, more) => `${ordinal(n)} Anniversary${more ? " of " : ""}`],
  [new RegExp(`제\\s?(\\d+)\\s?회(?!차)${NO_HANGUL_NEXT}`, "g"), (n) => ordinal(n)],
  [/(\d+)\s?[~-]\s?(\d+)\s?회차/g, (a, b) => `Rounds ${a}-${b}`],
  [/(\d+)\s?회차/g, (n) => `Round ${n}`],
  [new RegExp(`(\\d+)\\s?[~-]\\s?(\\d+)\\s?회${NO_HANGUL_NEXT}`, "g"), (a, b) => `Ep. ${a}-${b}`],
  [new RegExp(`(\\d+)\\s?회${NO_HANGUL_NEXT}`, "g"), (n) => `Ep. ${n}`],
  [/(\d+)\s?주\s?차/g, (n) => `Week ${n}`],
  [/(\d+)\s?일\s?차/g, (n) => `Day ${n}`],
  [new RegExp(`(\\d+)\\s?차${NO_HANGUL_NEXT}`, "g"), (n) => ordinal(n)],
  [new RegExp(`(\\d+)\\s?강${NO_HANGUL_NEXT}`, "g"), (n) => BRACKET[n] || `Round of ${n}`],
  [new RegExp(`(\\d{4}|\\d{2})년${NO_HANGUL_NEXT}`, "g"), (y) => (y.length === 2 ? `20${y}` : y)],
  [new RegExp(`(\\d{1,2})월${NO_HANGUL_NEXT}`, "g"), (m) => MONTHS[Number(m) - 1] || null],
  [/(\d+)\s?시간/g, (n) => `${n}-Hour`],
  [/(\d+)\s?만\s?원\s?권?/g, (n) => won(Number(n) * 10000)],
  [/(\d+)\s?천\s?원\s?권?/g, (n) => won(Number(n) * 1000)],
  [new RegExp(`(\\d[\\d,]*)\\s?원\\s?권?${NO_HANGUL_NEXT}`, "g"), (n) => won(n.replace(/,/g, ""))],
  [/(\d+)\s?억/g, (n) => `${Number(n) * 100}M`],
  [new RegExp(`(\\d[\\d,]*)\\s?젬${NO_HANGUL_NEXT}`, "g"), (n) => `${n} Gems`],
  [new RegExp(`(\\d+)\\s?개${NO_HANGUL_NEXT}`, "g"), (n) => `x${n}`],
  [/\s?\*\s?(\d[\d,]*)$/g, (n) => ` x${n}`],
];

// Korean glues words that English separates ("시즌22", "[10/03]이터널 리턴",
// "쿠폰(20,000원)"), so an English replacement gets a space wherever it would
// otherwise touch a letter, a digit, "&" or the outside of a bracket.
const TOUCH_BEFORE = /[A-Za-z0-9&\])ᄀ-ᇿ㄰-㆏가-퟿]/;
const TOUCH_AFTER = /[A-Za-z0-9&[(ᄀ-ᇿ㄰-㆏가-퟿]/;

function spaced(english, whole, start, end) {
  const before = start > 0 && TOUCH_BEFORE.test(whole[start - 1]) ? " " : "";
  const after = end < whole.length && TOUCH_AFTER.test(whole[end]) ? " " : "";
  return before + english + after;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// One alternation, longest key first, so a single pass always takes the longest
// phrase available at each position and never re-translates its own output.
// Compiled once at load: edit GLOSSARY in this file, not at run time.
const PHRASES = new Map(GLOSSARY.map(([ko, en]) => [ko.replace(/\s+/g, ""), en]));
const PHRASE_RE = new RegExp(
  GLOSSARY.map(([ko]) => ko)
    .sort((a, b) => b.length - a.length)
    .map((ko) => escapeRe(ko).replace(/ /g, " ?"))
    .join("|"),
  "g",
);

function tidy(s) {
  return s.replace(/\s+/g, " ").trim();
}

function lookup(table, key) {
  if (!table || typeof table !== "object") return undefined;
  if (table instanceof Map) return table.get(key);
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function translate(s, opts) {
  if (typeof s !== "string") return "";
  const overrides = opts && opts.overrides;
  for (const key of [s, s.trim()]) {
    const hit = lookup(overrides, key);
    if (typeof hit === "string" && hit.trim()) return tidy(hit);
  }
  let out = tidy(s);
  if (!HANGUL_RE.test(out)) return out;
  for (const [re, fn] of RULES) {
    out = out.replace(re, (...args) => {
      const whole = args[args.length - 1];
      const start = args[args.length - 2];
      const english = fn(...args.slice(1, -2));
      return english == null ? args[0] : spaced(english, whole, start, start + args[0].length);
    });
  }
  out = out.replace(PHRASE_RE, (match, start, whole) =>
    spaced(PHRASES.get(match.replace(/\s+/g, "")), whole, start, start + match.length),
  );
  return tidy(out);
}

function gameName(gameNo, opts) {
  const { cateName, typeNm, overrides } = opts || {};
  const no = gameNo == null ? "" : String(gameNo).trim();
  if (no) {
    const hit = lookup(overrides, no);
    const named = hit && typeof hit === "object" ? hit.name : hit;
    if (typeof named === "string" && named.trim()) return named.trim();
    const seeded = lookup(GAMES, no);
    if (seeded) return seeded.name;
  }
  const category = translate(cateName);
  if (category) return category;
  const provider = lookup(PROVIDERS, typeof typeNm === "string" ? typeNm.trim().toLowerCase() : "");
  if (provider) return provider;
  return no ? `Game #${no}` : "Other";
}

function rewardKind(itemType) {
  const t = itemType == null ? "" : String(itemType).trim();
  if (t === "1") return "code";
  if (t === "2") return "link";
  if (t === "4") return "ingame";
  return "other";
}

module.exports = {
  hasHangul,
  translate,
  GLOSSARY,
  GAMES,
  gameName,
  PROVIDERS,
  rewardKind,
  REWARD_KIND_LABEL,
  GIVE_CON_LABEL,
};
