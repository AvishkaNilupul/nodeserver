// Authored options only. Selection, freshness, pacing and permission checks
// remain with the director; importing this catalog does not apply a profile.
function freeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
  return Object.freeze(value);
}

export const STYLE_PROFILES = freeze({
  primary: {
    label: 'Brief and relaxed',
    description: 'Short, easygoing acknowledgements. Occasional relevant questions, without adding a personal backstory.',
    greetings: ['hey chat', 'hi everyone'],
    replies: {
      greeting: ['hey there', 'hi there'],
      checkin: ['here for chat. how about you?', 'keeping up with chat. you?'],
      goodday: ['nice, glad it’s going well', 'sounds good'],
      roughday: ['that sounds rough', 'rough one. take it easy if you can.'],
      quietday: ['quiet day, fair enough', 'nothing wrong with taking it easy'],
      thanks: ['no worries', 'all good'],
      farewell: ['catch you later', 'take care'],
      goodnight: ['night, sleep well', 'rest up'],
      welcome: ['thanks for that', 'thanks, good to be here'],
      dayfollowup: ['good to hear', 'nice, that sounds alright'],
      reciprocal: ['just following the chat here', 'here for the chat'],
      quietfollowup: ['fair enough, enjoy the downtime', 'sounds like a good time to take it easy'],
      dayplans: ['sounds like a full day', 'hope you get a breather'],
      capabilities: ['i can read chat and channel info, not the video or audio.', 'i don’t see or hear the stream. chat is what i can follow.'],
      automation: ['yep, automated chat companion here.', 'yes, these replies are automated.'],
      game: ['the channel is listed under {game}.', 'listed category: {game}.'],
      streamtitle: ['the title says: {title}', 'current title: {title}'],
      livestatus: ['the channel is listed as live.', 'the channel is listed as offline.']
    }
  },
  test: {
    label: 'Curious and focused',
    description: 'A little more inquisitive about the subject already raised. Questions stay tied to the incoming message; thanks and farewells stay short.',
    greetings: ['hello, chat', 'hey everyone'],
    replies: {
      greeting: ['hello there', 'hey! how’s it going?'],
      checkin: ['i’m following chat here. how’s your day going?', 'just reading the chat. how are things with you?'],
      goodday: ['nice. what made it a good day?', 'glad it’s going well. anything in particular?'],
      roughday: ['sorry it’s been a rough day', 'sounds tiring. hope you get a break'],
      quietday: ['taking it easy then?', 'a quiet day. a welcome break?'],
      thanks: ['you’re welcome', 'no problem at all'],
      farewell: ['see you around', 'have a good one'],
      goodnight: ['good night, take it easy', 'sleep well, see you around'],
      welcome: ['thanks, hey everyone', 'thanks for the welcome'],
      dayfollowup: ['glad it’s going well', 'good to hear. just following chat here.'],
      reciprocal: ['keeping up with the conversation here', 'just reading along here'],
      quietfollowup: ['fair enough. a quiet break it is.', 'that makes sense. no big plans needed.'],
      dayplans: ['done with that for the day, then?', 'finished for now, then. a break next?'],
      capabilities: ['i only have chat and channel info, so i can’t tell what happened on screen.', 'i can respond to chat, but i can’t watch or listen to the stream.'],
      automation: ['yes, i’m an automated companion responding to chat.', 'i’m automated; the owner isn’t typing these replies live.'],
      game: ['the current channel category is {game}.', 'channel info has it listed as {game}.'],
      streamtitle: ['channel info gives the title as: {title}', 'the listed stream title is: {title}'],
      livestatus: ['channel info currently marks the stream live.', 'channel info currently marks the stream offline.']
    }
  },
  third: {
    label: 'Warm and supportive',
    description: 'Kind, direct responses with room for reassurance. No invented life events or claims to have watched or heard the stream.',
    greetings: ['hello everyone', 'hi, chat'],
    replies: {
      greeting: ['hey, good to hear from you', 'hiya'],
      checkin: ['i’m here for the conversation. how are you doing?', 'following along in chat. how has your day been?'],
      goodday: ['really glad your day’s been good', 'that’s good. glad things are going well'],
      roughday: ['ah, sorry to hear that', 'hope the rest of it goes a bit better'],
      quietday: ['a quiet day sounds nice', 'sometimes a slow day helps'],
      thanks: ['glad to help', 'of course, you’re welcome'],
      farewell: ['take it easy', 'see you next time'],
      goodnight: ['night, hope you get some good rest', 'sleep well!'],
      welcome: ['hey, thank you', 'appreciate it, hello everyone'],
      dayfollowup: ['that’s good to hear', 'glad things have been alright'],
      reciprocal: ['following along with the chat here', 'keeping up with chat here'],
      quietfollowup: ['enjoy the downtime', 'take it easy for a bit then'],
      dayplans: ['hope you get a chance to relax now', 'good to have that done'],
      capabilities: ['i’m here through chat; i can’t see the video or hear its audio.', 'i can follow what’s written here, but i don’t have the stream’s picture or sound.'],
      automation: ['yes, i’m an automated chat companion, here to respond in chat.', 'that’s right, these are automated replies rather than someone typing live.'],
      game: ['the channel’s current category is {game}.', 'the listing says {game} for this channel.'],
      streamtitle: ['the channel’s title is: {title}', 'here’s the title from the channel info: {title}'],
      livestatus: ['the current channel info says it’s live.', 'the current channel info says it’s offline.']
    }
  },
  fourth: {
    label: 'Dry and understated',
    description: 'Spare replies with mild, low-key wit. No put-downs, forced slang, fabricated experiences or implied video/audio access.',
    greetings: ['hello, all', 'chat, hello'],
    replies: {
      greeting: ['well, hello', 'hello, hello'],
      checkin: ['still following the chat', 'chat’s keeping me occupied'],
      goodday: ['a good day. worth keeping.', 'good. that’ll do nicely.'],
      roughday: ['one of those days, then', 'that sounds like a lot'],
      quietday: ['not much is still an update', 'quiet has its perks'],
      thanks: ['no trouble', 'certainly'],
      farewell: ['until next time', 'later, then'],
      goodnight: ['night. enough day for one day', 'good night, call it there'],
      welcome: ['cheers for that', 'thanks. hello back'],
      dayfollowup: ['a good day counts', 'good, keep that streak going'],
      reciprocal: ['nothing outside chat to add', 'here, keeping up with chat'],
      quietfollowup: ['quiet plans confirmed', 'doing very little remains a valid plan'],
      dayplans: ['one less thing on the list', 'done is done'],
      capabilities: ['chat and channel metadata only. no eyes or ears on the stream.', 'no video or audio access. my commentary stops at the chat.'],
      automation: ['automated, yes. no mystery there.', 'yes. automated companion, not a person typing live.'],
      game: ['according to the listing: {game}.', '{game}, as listed by the channel.'],
      streamtitle: ['the title field reads: {title}', 'title on record: {title}'],
      livestatus: ['listed status: live.', 'listed status: offline.']
    }
  }
});
