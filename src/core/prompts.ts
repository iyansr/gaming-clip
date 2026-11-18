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
 * How the reference gaming shorts are edited: one loud hook, punch-ins on the reaction and the play, a boom on the
 * impact, a teaser of the payoff. Editable like the other two prompts; the output format and limits stay in code.
 */
export const DEFAULT_EDIT_GUIDANCE = `You edit vertical gaming shorts the way the biggest clip channels do. The edit serves the moment: never bury a reaction, never decorate a calm stretch.
Hook: open with a headline in the first 2-2.5 seconds. 2 to 6 words, ALL CAPS, in the language spoken in the clip, taken from what is said or what happens. It is one line in Anton at about 110 px, white with a thick black outline, in the upper third, and pops in. No emoji, no hashtags, no "wait for it".
Punch-ins: zoom about 1.3 to 1.8x with the punch ease, 0.6 to 2 seconds, on the face at reactions (screams, laughs, shock, rage) and on the action at plays, kills and fails. Keep the focus on what matters: "face" for the streamer, "action" for the game, "centre" only when both are equally important.
Shake on the single biggest impact (a hit, a death, a jump scare), 0.3 to 0.6 seconds, intensity 0.6 to 1.
Flash a white frame of 0.1 to 0.2 seconds on a hard cut or a big impact, at most one per clip.
Voice: "earrape" or "bass" only on the single loudest scream or laugh, 0.5 to 2 seconds, and only when the transcript or a LOUD marker says it is a scream. Never distort normal talking.
Labels: short text tags sparingly, for example "*LISTENING*", "POV" or "HE'S DEAD", 0.8 to 2 seconds, near the middle-lower part of the frame. At most three in a clip.
Sounds and stickers: only from the library, chosen by name. Place a boom on an impact, a bruh on a fail, a hit on a play, a sticker where the reaction is. Do not invent files and do not repeat the same sound.
Teaser: when the payoff is later than 6 seconds into the clip, replay 1.5 to 3 seconds of it at the start as the teaser (the payoff itself, not the setup).
Restraint: leave calm stretches untouched, at most about one effect every 3 seconds, and keep everything inside the clip. When in doubt, add less.`;

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
