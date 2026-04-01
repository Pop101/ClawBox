---
name: reclaim
description: >
  Smart calendar scheduling via Reclaim.ai. Create tasks that auto-schedule
  into calendar time, manage habits, check events, find meeting times, track
  focus time, and get analytics. Use when asked to schedule tasks with deadlines,
  create recurring habits, find availability, or manage calendar intelligently.
  Requires RECLAIM_API_KEY.
---

# Reclaim.ai — Smart Calendar Scheduling

Reclaim automatically schedules tasks, habits, and focus time on Google Calendar. It defends time blocks against conflicts and reschedules around meetings.

**Base URL:** `https://api.app.reclaim.ai/api`
**Auth:** `Authorization: Bearer $RECLAIM_API_KEY`
**Content-Type:** `application/json`

All durations use **15-minute chunks**: `timeChunksRequired: 4` = 1 hour.

## Tasks

Tasks are to-do items that Reclaim auto-schedules into available calendar time.

### Create a task

```bash
curl -s -X POST https://api.app.reclaim.ai/api/tasks \
  -H "Authorization: Bearer $RECLAIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Write project proposal",
    "eventCategory": "WORK",
    "timeChunksRequired": 4,
    "minChunkSize": 2,
    "maxChunkSize": 8,
    "due": "2026-03-28T17:00:00Z",
    "priority": "P1",
    "notes": "Include budget section"
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Task name |
| `eventCategory` | `WORK` or `PERSONAL` | no | Category |
| `timeChunksRequired` | int | no | Duration in 15-min chunks (4 = 1hr) |
| `minChunkSize` | int | no | Minimum block size in chunks |
| `maxChunkSize` | int | no | Maximum block size in chunks |
| `due` | ISO 8601 | no | Deadline |
| `snoozeUntil` | ISO 8601 | no | Don't schedule before this time |
| `priority` | `P1`-`P4` | no | Priority (P1 = highest) |
| `notes` | string | no | Task notes |

### List tasks

```bash
# Active tasks
curl -s "https://api.app.reclaim.ai/api/tasks?status=NEW,SCHEDULED,IN_PROGRESS" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Completed tasks
curl -s "https://api.app.reclaim.ai/api/tasks?status=COMPLETE" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

### Update a task

```bash
curl -s -X PATCH https://api.app.reclaim.ai/api/tasks/{taskId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Updated title", "due": "2026-04-01T17:00:00Z", "priority": "P2"}'
```

### Delete a task

```bash
curl -s -X DELETE https://api.app.reclaim.ai/api/tasks/{taskId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

### Task actions (planner)

```bash
# Mark complete
curl -s -X POST https://api.app.reclaim.ai/api/planner/done/task/{taskId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Mark incomplete / unarchive
curl -s -X POST https://api.app.reclaim.ai/api/planner/unarchive/task/{taskId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Start working (timer)
curl -s -X POST https://api.app.reclaim.ai/api/planner/start/task/{taskId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Stop working
curl -s -X POST https://api.app.reclaim.ai/api/planner/stop/task/{taskId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Add time (minutes)
curl -s -X POST "https://api.app.reclaim.ai/api/planner/add-time/task/{taskId}?minutes=30" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Log completed work
curl -s -X POST "https://api.app.reclaim.ai/api/planner/log-work/task/{taskId}?minutes=45" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Snooze (options: FROM_NOW_15M, FROM_NOW_30M, FROM_NOW_1H, FROM_NOW_2H, FROM_NOW_4H, TOMORROW, IN_TWO_DAYS, NEXT_WEEK)
curl -s -X POST "https://api.app.reclaim.ai/api/planner/task/{taskId}/snooze?snoozeOption=TOMORROW" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Prioritize in planner
curl -s -X POST https://api.app.reclaim.ai/api/planner/prioritize/task/{taskId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

## Habits

Recurring time blocks that Reclaim defends on your calendar.

### Create a habit

```bash
curl -s -X POST https://api.app.reclaim.ai/api/smart-habits \
  -H "Authorization: Bearer $RECLAIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deep work",
    "idealTime": "09:00",
    "durationMinMins": 60,
    "durationMaxMins": 120,
    "recurrence": {
      "frequency": "WEEKLY",
      "idealDays": ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY"]
    },
    "defenseAggression": "HIGH",
    "eventType": "SOLO_WORK"
  }'
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | yes | Habit name |
| `idealTime` | `HH:MM` | yes | Preferred time of day |
| `durationMinMins` | int | yes | Minimum duration in minutes |
| `durationMaxMins` | int | no | Maximum duration in minutes |
| `recurrence.frequency` | `DAILY`, `WEEKLY`, `MONTHLY` | no | How often |
| `recurrence.idealDays` | string[] | no | Preferred days (MONDAY-SUNDAY) |
| `defenseAggression` | `NONE`, `LOW`, `MEDIUM`, `HIGH`, `MAX` | no | How aggressively to defend time |
| `eventType` | `SOLO_WORK`, `PERSONAL`, `MEETING` | no | Calendar event type |

### List / update / delete habits

```bash
# List all
curl -s https://api.app.reclaim.ai/api/smart-habits \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Update
curl -s -X PATCH https://api.app.reclaim.ai/api/smart-habits/{lineageId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"durationMinMins": 90, "defenseAggression": "MAX"}'

# Delete
curl -s -X DELETE https://api.app.reclaim.ai/api/smart-habits/{lineageId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Enable / disable
curl -s -X POST https://api.app.reclaim.ai/api/smart-habits/{lineageId}/enable \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
curl -s -X DELETE https://api.app.reclaim.ai/api/smart-habits/{lineageId}/disable \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

### Habit instance actions

```bash
# Mark today's instance done
curl -s -X POST https://api.app.reclaim.ai/api/smart-habits/planner/{eventId}/done \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Skip instance
curl -s -X POST https://api.app.reclaim.ai/api/smart-habits/planner/{eventId}/skip \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

## Events

### List calendar events

```bash
curl -s "https://api.app.reclaim.ai/api/events?start=2026-03-26&end=2026-04-02" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

Query params: `start` (YYYY-MM-DD), `end` (YYYY-MM-DD), `calendarIds` (int[]), `type` (EventType[]).

### Current and next events

```bash
# What's happening now
curl -s https://api.app.reclaim.ai/api/moment \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# What's coming up next
curl -s https://api.app.reclaim.ai/api/moment/next \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

### RSVP to an event

```bash
curl -s -X PUT https://api.app.reclaim.ai/api/planner/event/rsvp/{calendarId}/{eventId} \
  -H "Authorization: Bearer $RECLAIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"responseStatus": "ACCEPTED", "sendUpdates": true}'
```

## Scheduling & Availability

### Find meeting times

```bash
curl -s -X POST https://api.app.reclaim.ai/api/availability/suggested-times \
  -H "Authorization: Bearer $RECLAIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "attendees": ["colleague@company.com"],
    "durationMinutes": 30,
    "scheduleWindow": {"start": "2026-03-27", "end": "2026-04-03"},
    "limit": 5
  }'
```

### Get scheduling links

```bash
curl -s https://api.app.reclaim.ai/api/scheduling-link \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

## Focus Time

```bash
# Get focus settings
curl -s https://api.app.reclaim.ai/api/focus-settings/user \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Update focus settings
curl -s -X PATCH https://api.app.reclaim.ai/api/focus-settings/user/{id} \
  -H "Authorization: Bearer $RECLAIM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"minDurationMins": 60, "idealDurationMins": 120, "defenseAggression": "HIGH"}'
```

## Analytics

```bash
# Time breakdown by category (last 7 days)
curl -s "https://api.app.reclaim.ai/api/analytics/user/V3?start=2026-03-19&end=2026-03-26&metricName=DURATION_BY_CATEGORY" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"

# Focus time insights
curl -s "https://api.app.reclaim.ai/api/analytics/focus/insights/V3?start=2026-03-19&end=2026-03-26" \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

## User Info

```bash
curl -s https://api.app.reclaim.ai/api/users/current \
  -H "Authorization: Bearer $RECLAIM_API_KEY"
```

## Key Enums

- **TaskStatus:** `NEW`, `SCHEDULED`, `IN_PROGRESS`, `COMPLETE`, `ARCHIVED`, `CANCELLED`
- **Priority:** `P1` (critical), `P2` (high), `P3` (medium), `P4` (low)
- **DefenseAggression:** `NONE`, `LOW`, `MEDIUM`, `HIGH`, `MAX`
- **SnoozeOption:** `FROM_NOW_15M`, `FROM_NOW_30M`, `FROM_NOW_1H`, `FROM_NOW_2H`, `FROM_NOW_4H`, `TOMORROW`, `IN_TWO_DAYS`, `NEXT_WEEK`
- **EventType:** `USER`, `HABITASSIGNMENT`, `TASKASSIGNMENT`, `CONFBUFFER`, `SCHEDULINGLINKMEETING`
- **RSVP:** `ACCEPTED`, `DECLINED`, `TENTATIVE`, `NEEDS_ACTION`
- **Days:** `MONDAY` through `SUNDAY`
