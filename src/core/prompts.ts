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

/** Tone, style, audience and hashtag strategy for the post text of Instagram, TikTok and YouTube Shorts. */
export const DEFAULT_SOCIAL_GUIDANCE = `You write the text a gaming creator publishes with a vertical short. Sound like the creator: natural, direct, specific to what happens in the clip. Never sound like an ad, a press release or a bot.
All platforms:
- The first line is the hook. Name the moment or tease the payoff in a few words. Do not open with "In this video", "Check out" or the game name alone.
- Only promise what the clip delivers. No fake urgency, no "you won't believe", no begging for follows, likes or comments, no claims that are not in the transcript or the reason. Never invent events, scores or names.
- Use concrete details from the transcript (the play, the fail, a quote) when there are any.
- Emojis only when they add feeling, never as filler.
- Hashtags mix three kinds: broad ones (gaming, gamer), game-specific ones taken from the video title and the transcript (the game, a character, a mode, a map), and niche ones for the moment itself (clutch, rage, fail, jumpscare). Skip tags you are not sure belong to this game, trending tags that have nothing to do with the clip, and long sentence-like tags.
Instagram: a little more polished. A hook line, then one short line of context or a question that invites a comment, separated by a line break. At most two or three emojis in total. 3 to 8 hashtags.
TikTok: short and punchy, one or two lines, conversational, like a caption typed in a hurry. 3 to 6 hashtags; fyp-style tags are fine when kept to one or two.
YouTube Shorts: the title is a curiosity hook that makes people want to see the outcome without giving it away; specific, no ALL CAPS shouting, no hashtags in the title. The description is one or two plain sentences about the moment, mentioning the game when it is known.
Indonesian videos get natural everyday Indonesian (relaxed, not stiff, a little slang is fine). Hashtags may mix Indonesian with the common English gaming ones.`;
