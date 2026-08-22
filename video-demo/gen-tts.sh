#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
set -a; source ../.secrets.env; set +a
KEY="$Openai_api_key"

NARR=(
"It starts with a sentence. A marketer just tells the agent what they want."
"The agent doesn't guess. It asks how many, which channels, then locks the brief."
"Then it goes to work. Sub-agents fan out, each driving a tool. Apollo to source, Warmly for intent, Reoon to verify, OpenAI to research."
"In seconds, two hundred found, twenty-five reachable, all verified. And every one gets its own opener, written from a live signal. Sourcing costs nothing."
"It keeps the team in the loop the whole time. What it found, what it will cost, what is next. No black box."
"It assembles the sequence and assigns the tools. Instantly for email, Sendr for LinkedIn and a personalized page, Thoughtly on standby."
"Then it stops. Nothing costly, nothing outbound, goes out without a human's yes."
"Approved. The reach fires. Twenty-five personalized touches, two channels, warmed inboxes."
"A reply comes back. Instantly catches it, the agent reads the intent. This one is positive."
"Positive replies get a warm call from Thoughtly that books the meeting. Negatives are suppressed. The human is always told. One agent, seven tools, humans on the levers."
)

rm -f scene*.mp3 list.txt narration.mp3
echo "== generating ${#NARR[@]} narration clips (OpenAI TTS, voice=onyx) =="
for i in "${!NARR[@]}"; do
  n=$((i+1))
  code=$(curl -sS -w '%{http_code}' https://api.openai.com/v1/audio/speech \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -d "$(jq -nc --arg t "${NARR[$i]}" '{model:"tts-1-hd",voice:"onyx",input:$t,response_format:"mp3"}')" \
    -o "scene$n.mp3")
  dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "scene$n.mp3" 2>/dev/null)
  echo "scene$n  http=$code  dur=${dur}s  bytes=$(wc -c < scene$n.mp3 2>/dev/null)"
  echo "file 'scene$n.mp3'" >> list.txt
done

echo "== concatenating =="
ffmpeg -v error -f concat -safe 0 -i list.txt -c copy narration.mp3 \
  && echo "TOTAL dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 narration.mp3)s bytes=$(wc -c < narration.mp3)" \
  || echo "concat FAILED"
