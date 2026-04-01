---
name: google-health
description: >
  Read and write health data via the Google Health API (v4). Supports nutrition/food
  logging, sleep tracking, steps, heart rate, weight, exercise, hydration, and more.
  Uses dedicated OAuth token (auto-refreshes). Use when asked about health data, meals, sleep,
  workouts, weight, or fitness metrics.
---

# Google Health API

Read and write health and fitness data via the [Google Health API](https://developers.google.com/health) (v4). This is the successor to the Fitbit Web API — it works with Fitbit, Pixel Watch, and connected Health Connect apps.

**Base URL:** `https://health.googleapis.com/v4`
**Auth:** Bearer token (auto-refreshes from `credentials/google-health-token.json`)

IMPORTANT: Always get the token FIRST in a separate command, then use it:
```bash
TOKEN=$(node /home/clawuser/openclaw/scripts/google-health-token.js)
```
Then use `$TOKEN` in all subsequent curl calls in the SAME command. Do NOT nest `$(node ...)` inside curl — it causes timeouts.

## Data Types

| Data type path | What it contains |
|---------------|-----------------|
| `steps` | Step count |
| `distance` | Distance traveled |
| `exercise` | Workout sessions (type, duration, calories, steps) |
| `sleep` | Sleep sessions (stages, duration, start/end) |
| `weight` | Body weight measurements |
| `bodyFat` | Body fat percentage |
| `dailyRestingHeartRate` | Resting heart rate |
| `dailyHeartRateVariability` | HRV measurements |
| `hydrationLog` | Water intake logs |
| `nutritionLog` | Food/meal entries (calories, macros, micronutrients) |
| `activeMinutes` | Active zone minutes |
| `totalCalories` | Total calories burned |

## Read Data

### List data points

```bash
curl -s "https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints" \
  -H "Authorization: Bearer $TOKEN"
```

### Filter by date range

Use RFC-3339 timestamps or ISO dates:
```bash
# Sleep data for last 7 days
curl -s "https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints?filter=startTime>=2026-03-24" \
  -H "Authorization: Bearer $TOKEN"

# Nutrition logs for today
curl -s "https://health.googleapis.com/v4/users/me/dataTypes/nutritionLog/dataPoints?filter=startTime>=2026-03-31T00:00:00Z" \
  -H "Authorization: Bearer $TOKEN"

# Steps for a specific date range
curl -s "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints?filter=startTime>=2026-03-01%20AND%20startTime<2026-03-31" \
  -H "Authorization: Bearer $TOKEN"
```

### Daily roll-ups (aggregated by day)

```bash
# Daily step totals
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/steps/dataPoints:dailyRollUp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": {"year": 2026, "month": 3, "day": 1},
    "endDate": {"year": 2026, "month": 3, "day": 31}
  }'

# Daily calorie totals
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/totalCalories/dataPoints:dailyRollUp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "startDate": {"year": 2026, "month": 3, "day": 24},
    "endDate": {"year": 2026, "month": 3, "day": 31}
  }'
```

### Time interval roll-ups

```bash
# Hourly heart rate averages
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/dailyRestingHeartRate/dataPoints:rollUp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "startTime": "2026-03-30T00:00:00Z",
    "endTime": "2026-03-31T00:00:00Z",
    "bucketDuration": "3600s"
  }'
```

## Write Data

### Log a meal / nutrition entry

```bash
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/nutritionLog/dataPoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "nutritionLogValue": {
        "foodName": "Grilled chicken salad",
        "mealType": "LUNCH",
        "nutritionalValues": {
          "calories": 450,
          "protein": 35,
          "fat": 18,
          "carbohydrates": 30,
          "fiber": 8,
          "sugar": 5,
          "sodium": 600
        }
      }
    },
    "startTime": "2026-03-31T12:30:00Z",
    "endTime": "2026-03-31T13:00:00Z"
  }'
```

**Meal types:** `BREAKFAST`, `LUNCH`, `DINNER`, `SNACK`

**Nutritional fields:** `calories`, `protein`, `fat`, `carbohydrates`, `fiber`, `sugar`, `sodium`, `cholesterol`, `saturatedFat`, `transFat`, `unsaturatedFat`, `potassium`, `vitaminA`, `vitaminC`, `calcium`, `iron`

### Log water intake

```bash
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/hydrationLog/dataPoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "hydrationLogValue": {
        "volumeMilliliters": 500
      }
    },
    "startTime": "2026-03-31T14:00:00Z",
    "endTime": "2026-03-31T14:00:00Z"
  }'
```

### Log weight

```bash
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "weightValue": {
        "weightKg": 75.5
      }
    },
    "startTime": "2026-03-31T08:00:00Z",
    "endTime": "2026-03-31T08:00:00Z"
  }'
```

### Log sleep

```bash
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "sleepValue": {
        "state": "ASLEEP"
      }
    },
    "startTime": "2026-03-30T23:00:00Z",
    "endTime": "2026-03-31T07:00:00Z"
  }'
```

**Sleep states:** `AWAKE`, `LIGHT_SLEEP`, `DEEP_SLEEP`, `REM`, `ASLEEP`

## Update / Delete

### Update a data point

```bash
curl -s -X PATCH "https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints/{dataPointId}" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "data": {
      "weightValue": {
        "weightKg": 75.0
      }
    }
  }'
```

### Delete data points

```bash
curl -s -X POST "https://health.googleapis.com/v4/users/me/dataTypes/weight/dataPoints:batchDelete" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "dataPointIds": ["datapoint-id-1", "datapoint-id-2"]
  }'
```

## User Profile

```bash
# Get profile (name, age, height, etc.)
curl -s "https://health.googleapis.com/v4/users/me/profile" \
  -H "Authorization: Bearer $TOKEN"

# Get settings (units, timezone, etc.)
curl -s "https://health.googleapis.com/v4/users/me/settings" \
  -H "Authorization: Bearer $TOKEN"
```

## OAuth Scopes

The gog token must include these scopes (added via `--extra-scopes` during auth):

| Scope | Access |
|-------|--------|
| `googlehealth.activity_and_fitness` | Steps, exercise, calories, distance, active minutes |
| `googlehealth.health_metrics_and_measurements` | Weight, body fat, heart rate, HRV |
| `googlehealth.nutrition` | Food logs, hydration |
| `googlehealth.sleep` | Sleep sessions and stages |

## Tips

- Always run `TOKEN=$(node /home/clawuser/openclaw/scripts/google-health-token.js)` FIRST, then use `$TOKEN` in curl. Never nest the node command inside curl.
- Data points are returned newest-first by default
- For nutrition logging, at minimum include `foodName`, `mealType`, and `calories`
- The `pageSize` default is 1440 (except exercise/sleep which default to 25)
- Use `dailyRollUp` for day-level aggregates, `rollUp` for custom time intervals
- Exercise data can be exported as TCX via `exportExerciseTcx`
