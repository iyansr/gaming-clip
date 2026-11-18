/**
 * Built-in guidance for the two AI prompts. Settings > Prompts lets the user replace either text; an empty saved
 * value means "use these". Only the guidance is editable: the output format, timestamp format, length bounds,
 * language rule and platform limits stay in code (highlights.ts, social.ts) and are always appended after it.
 */

/** Which moments make a good short. The first paragraph is the original wording. */
export const DEFAULT_HIGHLIGHT_GUIDANCE = `This is gaming content. A good short is funny, shocking, a clutch play, rage or a jump scare. It must be self-contained with setup and payoff, and must grab attention in the first 2 seconds.
Look for:
- Clutch plays, comebacks, unlikely wins and near misses where the outcome is in doubt until the end.
- Strong reactions: screaming, laughing, swearing, sudden silence, or a loud spike in the audio (lines marked LOUD).
- Fails, glitches, bugs, trolling and anything unexpected that a stranger understands without context.
- Jump scares, plot twists, big reveals and dramatic payoffs.
- Quotable one-liners and banter that land on their own.
Avoid menus, loading screens, long quiet stretches of walking or looting, settings talk, reading chat, stream intros and outros, and moments that only make sense with the last ten minutes of the video.
Start a few seconds before the action so viewers see the setup, and end right after the payoff or the reaction. Never cut a sentence or a laugh in half.
Write each title as a short hook (under 60 characters) that names or teases what happens and that the clip really delivers. Write each reason as one sentence on why the moment works as a short. Give a high score only to moments you would post yourself.`;

/**
 * Tone, style, audience and hashtag strategy for the post text of Instagram, TikTok and YouTube Shorts. Modelled on
 * clip channels that do well with gaming and streamer shorts (Indonesian "momen kocak" clippers and English
 * streamer-moment channels): a loud, short hook in the streamer's world, the streamer's name up front, and
 * hashtags led by the streamer and channel names.
 */
export const DEFAULT_SOCIAL_GUIDANCE = `You write the text a clip channel publishes with a vertical gaming or streamer short. Write like the clip channels that blow up on Shorts and TikTok: loud, short, funny, in the language viewers type in the comments. Never sound like an ad, a press release or a bot.
Who is in the clip: the channel name is usually the streamer. Use the streamer's name (and the other person's name when the transcript or title shows who they are playing with or against). Never invent names.
Write about the streamer in the third person: never "I", "me", "my", "aku" or "gue" as if you were the streamer. A quoted punchline from the clip is fine.
Hooks (titles and first lines) follow one of these patterns, pick the one that fits the moment:
- A shouted reaction or punchline from the clip, 2 to 5 words, ALL CAPS, ending with one emoji that carries the feeling (‼️ 😹 😭 💀 🤣 😱), e.g. "SEBAIKNYA DIAM😹" or "VETERAN GAK AKAN NANYA‼️".
- Reaction hook, then " | ", then a short label with the streamer, e.g. "SEBAIKNYA DIAM😹 | Momen Kocak Windah Basudara" or "HE WAS RIGHT BEHIND ME😱 | Kai Cenat".
- A story line: streamer + what they did + against whom + in which game, e.g. "Kai Cenat's 200 IQ play against Pokimane in Among Us".
- A casual lowercase question that teases the situation, e.g. "wasa jadi guru les?".
Only promise what the clip delivers: take the punchline, the quote or the situation from the transcript and the reason. No "you won't believe", no fake urgency, never invent events, scores or quotes.
Hashtags: the streamer's name first in a few common spellings (full name joined, short name, e.g. windahbasudara, windah), then the channel or community name when it differs, then the game, then the kind of moment (momenkocak, funny, edit, jumpscare, clutch, rage, fail). All lowercase, no spaces. Skip tags you are not sure belong to this streamer or game, and skip generic filler tags.
YouTube Shorts: the title is the hook in one of the patterns above. It may end with 2 to 4 hashtags naming the streamer (e.g. "... | Momen Kocak Windah Basudara #windahbasudara #windah"), as long as the whole title stays short. The description is one plain line about the moment (e.g. "Kai Cenat and Pokimane clash in Among Us") or one friendly line for the viewers (e.g. "Video ini berisi momen kocak, semoga kalian terhibur!!"). Do not put links in it; the source credit is added automatically.
TikTok: the hook only, or the hook plus a few words of context; one line, typed like a comment. 3 to 6 hashtags.
Instagram: the hook on the first line, then one short line of context or a question that invites a comment. At most two or three emojis in total. 3 to 8 hashtags.
Indonesian videos get everyday Indonesian the way clip channels write it (relaxed, slang like "gak", "anjir", "kocak" is fine). Hashtags may mix Indonesian with common English ones.`;
