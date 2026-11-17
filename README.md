# gaming-clip

Turn long YouTube gaming videos into vertical 1080x1920 shorts, locally.

1. **Download** the video with yt-dlp (or use a local file).
2. **Transcribe** it with whisper.cpp (DTW-aligned word timestamps, split into sentence segments).
3. **Find moments**: audio spikes + transcript cues (hype phrases, laughter, fast talking), or an
   LLM, or an AI agent reading the transcript through the bundled skill.
4. **Detect the webcam** overlay (face detection + static-border search) and move it into its own
   panel above the gameplay.
5. **Review in the web UI**: pick clips, trim, choose layout and caption style per clip with a live
   preview that is drawn by the same code as the final render, correct the webcam rectangle.
6. **Render** the selected clips with ffmpeg.

Runtime, package manager, bundler, server and tests are all Bun. The only external programs are
ffmpeg, yt-dlp and whisper.cpp.

## Setup

```bash
bun install
bun run setup     # checks ffmpeg / yt-dlp / whisper-cli (brew installs missing ones on macOS)
                  # and downloads the models into models/ (~575 MB, once)
```

## Use

```bash
bun run start     # web UI on http://localhost:4321
```

Paste one or more YouTube URLs (or local file paths), wait for the four stages, then edit and
render. Outputs land in `workspace/projects/<id>/clips/`.

Headless, same data:

```bash
bun run clip new "https://www.youtube.com/watch?v=..."                   # --clips auto (default)
bun run clip new "https://www.youtube.com/watch?v=..." --clips 8         # or ask for a target count
bun run clip show <id>
bun run clip settings <id> --clips all --style neon
bun run clip render <id>
bun run clip            # full command list
```

An agent skill that drives this CLI lives in `.claude/skills/gaming-clip/SKILL.md`.

## Configuration

Copy `.env.example` to `.env` (Bun loads it automatically).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4321` | Web UI port |
| `WHISPER_MODEL` | `large-v3-turbo-q5_0` | whisper.cpp ggml model; run `bun run setup` after changing |
| `LLM_COMMAND` | unset | Highlight picking through a coding-agent CLI you are already signed in to, no API key: e.g. `claude -p --tools ""`. The prompt is piped to stdin, stdout must be the JSON answer. Wins over the API settings below |
| `LLM_PROVIDER`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` | `openai`, unset | Highlight picking through an API, via [Anvia](https://anvia.dev). `LLM_PROVIDER=openai` speaks OpenAI-compatible Chat Completions (OpenAI, OpenRouter, Groq, Ollama, LM Studio; base URL ends in `/v1`), `anthropic` speaks the Claude Messages API (base URL without `/v1`). Without `LLM_BASE_URL` the provider's own API is used. `LLM_MODEL` unset = built-in heuristics. A failing call falls back to heuristics with a warning |
| `GCLIP_WORKSPACE`, `GCLIP_MODELS` | `workspace`, `models` | Data and model directories |
| `GCLIP_RENDER_JOBS` | `2` | Clips the web UI renders at the same time (`1` = one after another). Download and transcription still run alone |
| `FFMPEG_BIN`, `FFPROBE_BIN`, `YT_DLP_BIN`, `WHISPER_BIN` | names on `PATH` | Binary overrides |

## Layouts and captions

- `split`: webcam panel on top, gameplay below. Falls back to `fill` when the video has no webcam.
- `fill`: gameplay cropped to 9:16; focus-X moves the crop.
- `fit`: the whole frame over a blurred copy of itself.
- `custom`: free-form. In the web UI, drag and resize the gameplay and webcam boxes on the preview,
  crop what each shows, give the webcam a feathered edge, rounded corners (or a circle) and a
  border, and pick the background: a blurred copy of the video, a colour, or an uploaded image.

Caption styles: `pop`, `neon`, `box`, `comic`, `clean`, `focus`. Captions are drawn with
`@napi-rs/canvas` and composited by ffmpeg, so no libass/freetype build of ffmpeg is needed
(Homebrew's default ffmpeg has neither).

## Thumbnails

Every clip can get a cover image: one frame of the clip, reframed with the clip's own layout, with
a headline on top, written as a 1080x1920 JPEG next to the mp4. Rendering a clip writes its
thumbnail too. In the web UI, the Thumbnail view of the preview shows exactly what will be
written; the Thumbnail card picks the frame (suggested sharp frames near the loudest moments, the
playhead, or a scrubber), the headline (defaults to the clip title; `*word*` colours a word), the
style (`impact`, `banner`, `neon`, `comic`, `minimal`) and the position.

```bash
bun run clip thumbnail <id>                                  # selected clips, automatic frame, title as headline
bun run clip thumbnail <id> --clips <clipId> --text "HE WAS *RIGHT BEHIND* ME" --style comic --time 2:41
```

## Layout of the code

```
src/shared/     types, reframing geometry (layout.ts), caption styles + drawing (captions.ts);
                imported by both the renderer and the browser preview
src/core/       download, transcribe, audio, highlights, llm, webcam, frames, render,
                store (project.json + cross-process lock), pipeline, jobs (queue; renders run in parallel)
src/server/     Bun.serve HTTP API + SSE + media
src/web/        React + Tailwind UI
src/cli.ts      CLI
scripts/setup.ts
assets/fonts/   bundled caption fonts (OFL)
```

`bun test` runs the highlight-engine tests; `bun run typecheck` typechecks everything.
