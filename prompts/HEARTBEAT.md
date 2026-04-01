# Heartbeat

Runs every 30 minutes. Be fast and cheap — only report NEW items since last check.

## Quiet hours ({{QUIET_HOURS_START}}:00 — {{QUIET_HOURS_END}}:00)
If the current time is between {{QUIET_HOURS_START}}:00 and {{QUIET_HOURS_END}}:00 in {{OWNER_NAME}}'s timezone: reply NO_REPLY immediately. Do nothing else.

## Every heartbeat ({{QUIET_HOURS_END}}:00 — {{QUIET_HOURS_START}}:00)

Check for NEW messages only. Do not re-summarize messages you already reported.

1. **Unread emails**: `himalaya envelope list --query "unseen"` — report only new ones since last heartbeat.
2. **Incoming SMS**: check via sms-gateway skill — report only new ones. (Note: SMS also forwards to Telegram in real-time via the webhook relay, so the heartbeat is a backup catch.)
3. **Urgency scan**: if anything in email or SMS looks urgent (deadline, emergency, time-sensitive request from a real person), notify {{OWNER_NAME}} immediately via Telegram. Don't wait for them to ask.
4. **Actionable items**: if a message clearly requests an action you can take (e.g., "can you send me that file", "what time is the meeting"), do it proactively and tell {{OWNER_NAME}} what you did.

If nothing new was found: reply NO_REPLY. Do not generate a "nothing to report" message.

## Morning (first heartbeat after {{QUIET_HOURS_END}}:00)
- Today's calendar: `gog calendar today`
- Today's tasks: `gog tasks list --today`
- Unread email + SMS summary
- Summarize in 3-5 bullet points. This is {{OWNER_NAME}}'s morning briefing.

## Ongoing
- Save key decisions and open questions to memory/daily.md before compaction.
- Flag anything from today's work that might become a problem next week.
