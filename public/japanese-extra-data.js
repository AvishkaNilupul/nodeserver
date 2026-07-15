// Extra learning content for the Japanese app: graded reading passages and
// listening dialogues for N5 and N4. Loaded before the app script; exposes
// window.JP_EXTRA = { readings, dialogues }.
(function () {
  const q = (question, choices, a) => ({ q: question, choices, a });

  // ---------------------------------------------------------------
  // Reading comprehension passages
  // jp: the passage (short lines), en: full translation, qs: questions
  // ---------------------------------------------------------------
  const readings = [
    {
      lv: "n5",
      title: "わたしの いちにち — My day",
      jp: "わたしは まいあさ ６じに おきます。あさごはんを たべて、７じはんに うちを でます。でんしゃで かいしゃへ いきます。しごとは ９じから ５じまでです。よる、うちで ばんごはんを つくります。１１じに ねます。",
      en: "I get up at 6 every morning. I eat breakfast and leave home at 7:30. I go to the office by train. Work is from 9 to 5. In the evening I cook dinner at home. I go to bed at 11.",
      qs: [
        q("What time does the writer get up?", ["6:00", "7:30", "9:00", "11:00"], "6:00"),
        q("How do they go to work?", ["By train", "By bus", "By car", "On foot"], "By train"),
        q("What do they do in the evening?", ["Cook dinner", "Watch TV", "Study Japanese", "Go shopping"], "Cook dinner"),
      ],
    },
    {
      lv: "n5",
      title: "レストランで — At a restaurant",
      jp: "きのう ともだちと レストランへ いきました。わたしは さかなりょうりを たべました。ともだちは にくが すきですから、ステーキを たべました。りょうりは とても おいしかったです。でも、すこし たかかったです。",
      en: "Yesterday I went to a restaurant with a friend. I ate a fish dish. My friend likes meat, so he ate steak. The food was very delicious. But it was a little expensive.",
      qs: [
        q("When did they go to the restaurant?", ["Yesterday", "Today", "Last week", "Tomorrow"], "Yesterday"),
        q("Why did the friend eat steak?", ["He likes meat", "It was cheap", "He dislikes fish", "It was recommended"], "He likes meat"),
        q("What was the problem with the food?", ["A little expensive", "Too salty", "Cold", "Slow service"], "A little expensive"),
      ],
    },
    {
      lv: "n5",
      title: "てんきと しゅうまつ — Weather and the weekend",
      jp: "こんしゅうの どようびは あめでしょう。だから、うちで えいがを みます。にちようびは はれでしょう。にちようびに こうえんへ いって、しゃしんを とりたいです。",
      en: "This Saturday it will probably rain. So I will watch a movie at home. Sunday will probably be sunny. On Sunday I want to go to the park and take photos.",
      qs: [
        q("What is the weather forecast for Saturday?", ["Rain", "Sunny", "Snow", "Cloudy"], "Rain"),
        q("What does the writer want to do on Sunday?", ["Take photos in the park", "Watch a movie", "Stay home", "Go shopping"], "Take photos in the park"),
      ],
    },
    {
      lv: "n5",
      title: "たんじょうびの プレゼント — A birthday present",
      jp: "らいしゅうは ははの たんじょうびです。ははは はなが すきですから、はなを かいます。それから、ケーキも つくります。かぞくで ばんごはんを たべて、おいわいを します。",
      en: "Next week is my mother's birthday. My mother likes flowers, so I will buy flowers. Then I will also make a cake. Our family will eat dinner together and celebrate.",
      qs: [
        q("Whose birthday is next week?", ["Mother's", "Father's", "Friend's", "The writer's"], "Mother's"),
        q("What will the writer buy?", ["Flowers", "A cake", "A book", "Clothes"], "Flowers"),
        q("What will the writer make?", ["A cake", "Dinner", "A card", "Tea"], "A cake"),
      ],
    },
    {
      lv: "n5",
      title: "としょかんの おしらせ — Library notice",
      jp: "としょかんは ごぜん ９じから ごご ８じまでです。げつようびは やすみです。ほんは ２しゅうかん かりることが できます。としょかんの なかで たべものを たべないで ください。",
      en: "The library is open from 9 a.m. to 8 p.m. It is closed on Mondays. You can borrow books for two weeks. Please do not eat food inside the library.",
      qs: [
        q("When is the library closed?", ["Monday", "Sunday", "Saturday", "Friday"], "Monday"),
        q("How long can you borrow books?", ["Two weeks", "One week", "One month", "Three days"], "Two weeks"),
        q("What must you NOT do in the library?", ["Eat food", "Read books", "Study", "Borrow books"], "Eat food"),
      ],
    },
    {
      lv: "n5",
      title: "ともだちへの てがみ — A letter to a friend",
      jp: "たなかさん、おげんきですか。わたしは せんげつ にほんへ きました。まいにち にほんごを べんきょうしています。にほんごは むずかしいですが、おもしろいです。こんど いっしょに おちゃを のみませんか。",
      en: "Tanaka-san, how are you? I came to Japan last month. I study Japanese every day. Japanese is difficult, but interesting. Won't you have tea together with me sometime?",
      qs: [
        q("When did the writer come to Japan?", ["Last month", "Last year", "Last week", "Yesterday"], "Last month"),
        q("What does the writer think of Japanese?", ["Difficult but interesting", "Easy and fun", "Boring", "Too fast"], "Difficult but interesting"),
        q("What does the writer suggest?", ["Having tea together", "Studying together", "Traveling together", "Eating dinner"], "Having tea together"),
      ],
    },
    {
      lv: "n4",
      title: "しゅうまつの よてい — Weekend plans",
      jp: "土曜日に 友だちが 遊びに 来ることに なって、部屋を そうじして おきました。いっしょに 映画を 見たり、ゲームを したり する つもりです。友だちは 料理が 上手なので、晩ごはんを 作って くれると 言って いました。楽しみです。",
      en: "It's been arranged that a friend will come over on Saturday, so I cleaned my room in advance. We plan to do things like watch a movie and play games. My friend is good at cooking, so he said he would make dinner for me. I'm looking forward to it.",
      qs: [
        q("Why did the writer clean the room?", ["A friend is coming on Saturday", "Their mother told them to", "They lost something", "It was dirty for months"], "A friend is coming on Saturday"),
        q("Who will make dinner?", ["The friend", "The writer", "They will order food", "The writer's mother"], "The friend"),
      ],
    },
    {
      lv: "n4",
      title: "電車の 忘れ物 — Lost on the train",
      jp: "今朝、電車の 中に かばんを 忘れて しまいました。かばんには 財布と 会社の 書類が 入って いたので、とても 困りました。駅員さんに 聞いたら、となりの 駅に 届いて いると 教えて くれました。取りに 行かなければ なりません。",
      en: "This morning I (regrettably) left my bag on the train. My wallet and company documents were inside, so I was in real trouble. When I asked the station attendant, he told me it had been turned in at the next station. I have to go pick it up.",
      qs: [
        q("What was in the bag?", ["A wallet and documents", "A bento and a book", "A phone and keys", "Clothes"], "A wallet and documents"),
        q("Where is the bag now?", ["At the next station", "Still on the train", "At the police station", "Nobody knows"], "At the next station"),
        q("What must the writer do?", ["Go pick it up", "Buy a new bag", "Call the company", "Wait at home"], "Go pick it up"),
      ],
    },
    {
      lv: "n4",
      title: "アルバイトの けいけん — Part-time job experience",
      jp: "大学生の とき、レストランで アルバイトを した ことが あります。最初は お皿を 落としたり、注文を まちがえたり して、店長に しかられました。でも、だんだん 仕事に 慣れて、お客さんと 話すのが 楽しく なりました。この けいけんの おかげで、人と 話すのが 上手に なったと 思います。",
      en: "When I was a university student, I worked part-time at a restaurant. At first I dropped plates and got orders wrong, and the manager scolded me. But gradually I got used to the work, and talking with customers became fun. Thanks to this experience, I think I became good at talking with people.",
      qs: [
        q("What happened at first?", ["The writer made mistakes and was scolded", "The writer was praised", "The writer quit quickly", "The writer became manager"], "The writer made mistakes and was scolded"),
        q("What did the writer gain from the experience?", ["Becoming good at talking with people", "A lot of money", "Free meals", "A full-time job"], "Becoming good at talking with people"),
      ],
    },
    {
      lv: "n4",
      title: "健康の ために — For my health",
      jp: "最近、体の 調子が よくないので、生活を 変える ことに しました。夜 おそくまで スマホを 見すぎない ように します。それから、できるだけ 階段を 使ったり、一駅 歩いたり する つもりです。無理を しないで、少しずつ 続ける ことが 大切だと 思います。",
      en: "Lately I haven't been feeling well, so I decided to change my lifestyle. I will try not to look at my phone too much until late at night. Also, I plan to use the stairs as much as possible and walk one station. I think it's important to continue little by little without overdoing it.",
      qs: [
        q("Why did the writer decide to change their lifestyle?", ["They haven't been feeling well", "A doctor ordered it", "To save money", "To lose weight for summer"], "They haven't been feeling well"),
        q("What does the writer think is important?", ["Continuing little by little", "Exercising hard every day", "Buying a gym membership", "Sleeping 10 hours"], "Continuing little by little"),
      ],
    },
    {
      lv: "n4",
      title: "引っ越しの 知らせ — Moving notice",
      jp: "来月、会社の 近くに 引っ越す ことに なりました。今の 家は 駅から 遠くて、毎朝 １時間も かかって いました。新しい 家は 少し せまいですが、歩いて 会社に 行けるので、朝 ゆっくり できます。引っ越したら、友だちを よんで パーティーを する つもりです。",
      en: "It's been decided that I will move near my office next month. My current home is far from the station, and it took a whole hour every morning. The new home is a little small, but I can walk to the office, so I can take it easy in the morning. Once I've moved, I plan to invite friends and have a party.",
      qs: [
        q("What was the problem with the current home?", ["It is far — commuting took an hour", "It is too expensive", "It is too small", "It is noisy"], "It is far — commuting took an hour"),
        q("What is good about the new home?", ["The writer can walk to work", "It is big", "It is cheap", "It is next to the station"], "The writer can walk to work"),
        q("What will the writer do after moving?", ["Have a party with friends", "Buy new furniture", "Look for a new job", "Get a pet"], "Have a party with friends"),
      ],
    },
    {
      lv: "n4",
      title: "日本の コンビニ — Japanese convenience stores",
      jp: "日本の コンビニは とても 便利だと 思います。食べ物や 飲み物が 買えるだけでなく、電気代を 払ったり、荷物を 送ったり する ことも できます。２４時間 開いて いるので、夜 おそく 帰った ときにも 使えます。ただ、便利すぎて、お金を 使いすぎて しまう ことも あります。",
      en: "I think Japanese convenience stores are very convenient. Not only can you buy food and drinks, you can also do things like pay electricity bills and send packages. They are open 24 hours, so you can use them even when you come home late at night. However, they are so convenient that I sometimes end up spending too much money.",
      qs: [
        q("Which is NOT mentioned as something you can do at a konbini?", ["Cut your hair", "Pay electricity bills", "Send packages", "Buy food and drinks"], "Cut your hair"),
        q("What is the downside the writer mentions?", ["Spending too much money", "Long lines", "High prices", "Few stores"], "Spending too much money"),
      ],
    },
  ];

  // ---------------------------------------------------------------
  // Listening dialogues — two speakers (A/B get different TTS voices)
  // ---------------------------------------------------------------
  const dialogues = [
    {
      lv: "n5",
      title: "カフェで ちゅうもん — Ordering at a café",
      lines: [
        { sp: "A", ja: "いらっしゃいませ。ごちゅうもんは？", en: "Welcome. Your order?" },
        { sp: "B", ja: "コーヒーを ひとつ おねがいします。", en: "One coffee, please." },
        { sp: "A", ja: "ホットですか、アイスですか。", en: "Hot or iced?" },
        { sp: "B", ja: "ホットで おねがいします。", en: "Hot, please." },
        { sp: "A", ja: "はい、３００えんです。", en: "That's 300 yen." },
      ],
      qs: [
        q("What did the customer order?", ["Hot coffee", "Iced coffee", "Tea", "Juice"], "Hot coffee"),
        q("How much was it?", ["300 yen", "500 yen", "1000 yen", "30 yen"], "300 yen"),
      ],
    },
    {
      lv: "n5",
      title: "みちを きく — Asking the way",
      lines: [
        { sp: "B", ja: "すみません、えきは どこですか。", en: "Excuse me, where is the station?" },
        { sp: "A", ja: "えきですか。この みちを まっすぐ いって ください。", en: "The station? Go straight down this road." },
        { sp: "A", ja: "ぎんこうの かどを みぎに まがって ください。", en: "Turn right at the bank corner." },
        { sp: "B", ja: "ここから どのぐらい かかりますか。", en: "How long does it take from here?" },
        { sp: "A", ja: "あるいて ５ふんぐらいです。", en: "About 5 minutes on foot." },
        { sp: "B", ja: "わかりました。ありがとうございます。", en: "I see. Thank you." },
      ],
      qs: [
        q("Where does the person want to go?", ["The station", "The bank", "A school", "A hospital"], "The station"),
        q("Where should they turn right?", ["At the bank corner", "At the school", "At the traffic light", "At the park"], "At the bank corner"),
        q("How long does it take on foot?", ["About 5 minutes", "About 15 minutes", "About 30 minutes", "About 1 hour"], "About 5 minutes"),
      ],
    },
    {
      lv: "n5",
      title: "しゅうまつの はなし — Talking about the weekend",
      lines: [
        { sp: "A", ja: "しゅうまつ、なにを しましたか。", en: "What did you do on the weekend?" },
        { sp: "B", ja: "どようびに ともだちと えいがを みました。", en: "On Saturday I watched a movie with a friend." },
        { sp: "A", ja: "いいですね。どうでしたか。", en: "Nice. How was it?" },
        { sp: "B", ja: "とても おもしろかったです。にちようびは うちで やすみました。", en: "It was very interesting. On Sunday I rested at home." },
      ],
      qs: [
        q("What did B do on Saturday?", ["Watched a movie", "Rested at home", "Went shopping", "Played sports"], "Watched a movie"),
        q("How was the movie?", ["Very interesting", "Boring", "Too long", "Scary"], "Very interesting"),
      ],
    },
    {
      lv: "n5",
      title: "かいものの やくそく — Making shopping plans",
      lines: [
        { sp: "A", ja: "あした、いっしょに かいものに いきませんか。", en: "Won't you go shopping with me tomorrow?" },
        { sp: "B", ja: "いいですね。なんじに あいましょうか。", en: "Sounds good. What time shall we meet?" },
        { sp: "A", ja: "１０じに えきの まえで どうですか。", en: "How about 10 o'clock in front of the station?" },
        { sp: "B", ja: "すみません、ごぜんちゅうは ちょっと…。ごご １じは どうですか。", en: "Sorry, the morning is a bit... How about 1 p.m.?" },
        { sp: "A", ja: "だいじょうぶです。じゃ、１じに。", en: "That's fine. See you at 1." },
      ],
      qs: [
        q("What will they do tomorrow?", ["Go shopping", "See a movie", "Study", "Eat dinner"], "Go shopping"),
        q("What time will they meet?", ["1 p.m.", "10 a.m.", "12 p.m.", "3 p.m."], "1 p.m."),
        q("Where will they meet?", ["In front of the station", "At a café", "At B's house", "At the shop"], "In front of the station"),
      ],
    },
    {
      lv: "n5",
      title: "びょういんで — At the doctor's",
      lines: [
        { sp: "A", ja: "どう しましたか。", en: "What seems to be the problem?" },
        { sp: "B", ja: "きのうから あたまが いたいです。ねつも あります。", en: "My head has hurt since yesterday. I have a fever too." },
        { sp: "A", ja: "そうですか。くすりを だしますから、きょうは ゆっくり やすんで ください。", en: "I see. I'll prescribe medicine, so please rest well today." },
        { sp: "B", ja: "はい、わかりました。", en: "Yes, understood." },
      ],
      qs: [
        q("What are B's symptoms?", ["Headache and fever", "Stomachache", "A cough", "A broken leg"], "Headache and fever"),
        q("What does the doctor tell B to do?", ["Rest well today", "Exercise", "Go to work", "Come back tomorrow"], "Rest well today"),
      ],
    },
    {
      lv: "n4",
      title: "飲み会の さそい — Invitation to a work dinner",
      lines: [
        { sp: "A", ja: "田中さん、金曜日の 飲み会に 行けますか。", en: "Tanaka-san, can you come to Friday's work dinner?" },
        { sp: "B", ja: "すみません、金曜日は 早く 帰らなければ ならないんです。", en: "Sorry, on Friday I have to go home early." },
        { sp: "A", ja: "そうですか。何か 用事が あるんですか。", en: "I see. Do you have something to do?" },
        { sp: "B", ja: "ええ、母が 遊びに 来ることに なって いて、空港まで 迎えに 行くんです。", en: "Yes, my mother is coming to visit, and I'm going to the airport to pick her up." },
        { sp: "A", ja: "それは 楽しみですね。じゃ、また 今度。", en: "That's something to look forward to. Well, next time then." },
      ],
      qs: [
        q("Why can't B go to the dinner?", ["B has to pick up their mother at the airport", "B is sick", "B has to work late", "B doesn't like drinking"], "B has to pick up their mother at the airport"),
        q("When is the dinner?", ["Friday", "Saturday", "Monday", "Tonight"], "Friday"),
      ],
    },
    {
      lv: "n4",
      title: "しごとの そうだん — Asking a coworker for help",
      lines: [
        { sp: "B", ja: "すみません、この 資料の 作り方を 教えて いただけませんか。", en: "Excuse me, could you teach me how to make this document?" },
        { sp: "A", ja: "いいですよ。まず、先月の 資料を 見て みて ください。同じ 形で 作れば いいんです。", en: "Sure. First, try looking at last month's document. You just need to make it in the same format." },
        { sp: "B", ja: "なるほど。もし 分からない ことが あったら、また 聞いても いいですか。", en: "I see. If there's something I don't understand, may I ask again?" },
        { sp: "A", ja: "もちろん。いつでも どうぞ。", en: "Of course. Any time." },
      ],
      qs: [
        q("What does B want to know?", ["How to make a document", "Where the meeting is", "How to use the printer", "When the deadline is"], "How to make a document"),
        q("What does A suggest?", ["Looking at last month's document", "Asking the manager", "Searching online", "Taking a course"], "Looking at last month's document"),
      ],
    },
    {
      lv: "n4",
      title: "天気と やくそく — Rain changes the plan",
      lines: [
        { sp: "A", ja: "明日、海に 行く つもりだったんですが、天気予報に よると、雨が 降るそうですよ。", en: "I was planning to go to the beach tomorrow, but according to the forecast, it's going to rain." },
        { sp: "B", ja: "ええ、本当ですか。じゃ、どう しましょうか。", en: "Really? Then what shall we do?" },
        { sp: "A", ja: "雨だったら、映画に しませんか。", en: "If it rains, shall we make it a movie instead?" },
        { sp: "B", ja: "いいですね。もし 晴れたら、海に 行きましょう。", en: "Sounds good. If it clears up, let's go to the beach." },
      ],
      qs: [
        q("What was the original plan?", ["Going to the beach", "Watching a movie", "Hiking", "Shopping"], "Going to the beach"),
        q("What will they do if it rains?", ["Watch a movie", "Stay home", "Go to the beach anyway", "Cancel everything"], "Watch a movie"),
      ],
    },
    {
      lv: "n4",
      title: "アパートを さがす — Looking for an apartment",
      lines: [
        { sp: "B", ja: "駅の 近くで、家賃が ７万円までの 部屋を さがして いるんですが。", en: "I'm looking for a room near the station with rent up to 70,000 yen." },
        { sp: "A", ja: "それなら、この 部屋は いかがですか。駅から 歩いて ３分です。", en: "In that case, how about this room? It's 3 minutes on foot from the station." },
        { sp: "B", ja: "いいですね。でも、少し せまそうですね。", en: "Nice. But it looks a little small." },
        { sp: "A", ja: "では、こちらは？ 少し 古いですが、広くて 家賃も 安いです。", en: "Then how about this one? It's a bit old, but spacious and the rent is cheap." },
        { sp: "B", ja: "こっちの ほうが よさそうです。見に 行っても いいですか。", en: "This one seems better. May I go see it?" },
      ],
      qs: [
        q("What is B looking for?", ["A room near the station, up to 70,000 yen", "A house with a garden", "A room near a school", "A shop to rent"], "A room near the station, up to 70,000 yen"),
        q("What is the second room like?", ["A bit old but spacious and cheap", "New and expensive", "Small but new", "Far from the station"], "A bit old but spacious and cheap"),
      ],
    },
    {
      lv: "n4",
      title: "旅行の 思い出 — Talking about a trip",
      lines: [
        { sp: "A", ja: "京都に 行った ことが ありますか。", en: "Have you ever been to Kyoto?" },
        { sp: "B", ja: "ええ、去年 行きました。お寺を 見たり、おいしい 物を 食べたり しました。", en: "Yes, I went last year. I did things like see temples and eat delicious food." },
        { sp: "A", ja: "いいですね。私も 行って みたいです。いつが いちばん いいですか。", en: "Nice. I'd like to try going too. When is the best time?" },
        { sp: "B", ja: "秋が いちばん きれいだと 思います。でも、人が 多いので、ホテルは 早く 予約して おいた ほうが いいですよ。", en: "I think autumn is the most beautiful. But there are many people, so you'd better book a hotel early." },
      ],
      qs: [
        q("When did B go to Kyoto?", ["Last year", "Last month", "This year", "B has never been"], "Last year"),
        q("What advice does B give?", ["Book a hotel early", "Go in summer", "Take a lot of money", "Avoid the temples"], "Book a hotel early"),
      ],
    },
  ];

  window.JP_EXTRA = { readings, dialogues };
})();
