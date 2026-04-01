---
name: google-health
description: >
  Read and write health data via the Google Health API (v4). Supports nutrition/food
  logging, sleep tracking, steps, heart rate, weight, exercise, hydration, and more.
  Uses gog OAuth token (shared with Google Workspace). Use when asked about health
  data, meals, sleep, workouts, weight, or fitness metrics.
---

# Google Health API

Read and write health and fitness data via the [Google Health API](https://developers.google.com/health) (v4). Works with Fitbit, Pixel Watch, and Health Connect.

**Auth:** Uses gog's OAuth token automatically (shared with Google Workspace — no separate auth needed).

**CLI wrapper:** `node /home/clawuser/openclaw/skills/google-health/health-api.js`

## Commands

### List data points

```bash
node /home/clawuser/openclaw/skills/google-health/health-api.js list <dataType> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
```

Examples:
```bash
# Recent sleep data
node /home/clawuser/openclaw/skills/google-health/health-api.js list sleep --since 2026-03-25

# Today's nutrition logs
node /home/clawuser/openclaw/skills/google-health/health-api.js list nutritionLog --since 2026-03-31

# Steps this week
node /home/clawuser/openclaw/skills/google-health/health-api.js list steps --since 2026-03-25

# Weight history this month
node /home/clawuser/openclaw/skills/google-health/health-api.js list weight --since 2026-03-01

# Exercise sessions
node /home/clawuser/openclaw/skills/google-health/health-api.js list exercise --since 2026-03-25

# Heart rate
node /home/clawuser/openclaw/skills/google-health/health-api.js list dailyRestingHeartRate --since 2026-03-25
```

### Daily roll-ups (aggregated by day)

```bash
node /home/clawuser/openclaw/skills/google-health/health-api.js daily <dataType> --since YYYY-MM-DD --until YYYY-MM-DD
```

Examples:
```bash
# Daily step totals for March
node /home/clawuser/openclaw/skills/google-health/health-api.js daily steps --since 2026-03-01 --until 2026-03-31

# Daily calories burned
node /home/clawuser/openclaw/skills/google-health/health-api.js daily totalCalories --since 2026-03-25 --until 2026-03-31
```

### Log data (create)

```bash
node /home/clawuser/openclaw/skills/google-health/health-api.js create <dataType> '<JSON>'
```

#### Log a meal
```bash
node /home/clawuser/openclaw/skills/google-health/health-api.js create nutritionLog '{
  "nutritionLogValue": {
    "foodName": "Grilled chicken salad",
    "mealType": "LUNCH",
    "nutritionalValues": {
      "calories": 450,
      "protein": 35,
      "fat": 18,
      "carbohydrates": 30,
      "fiber": 8
    }
  },
  "startTime": "2026-03-31T12:30:00Z",
  "endTime": "2026-03-31T13:00:00Z"
}'
```

Meal types: `BREAKFAST`, `LUNCH`, `DINNER`, `SNACK`

Nutrition fields: `calories`, `protein`, `fat`, `carbohydrates`, `fiber`, `sugar`, `sodium`, `cholesterol`, `saturatedFat`, `transFat`, `unsaturatedFat`, `potassium`, `vitaminA`, `vitaminC`, `calcium`, `iron`

#### Log water
```bash
node /home/clawuser/openclaw/skills/google-health/health-api.js create hydrationLog '{
  "hydrationLogValue": {"volumeMilliliters": 500}
}'
```

#### Log weight
```bash
node /home/clawuser/openclaw/skills/google-health/health-api.js create weight '{
  "weightValue": {"weightKg": 75.5}
}'
```

### Profile and settings
```bash
node /home/clawuser/openclaw/skills/google-health/health-api.js profile
node /home/clawuser/openclaw/skills/google-health/health-api.js settings
```

## Data Types

| Type | Description |
|------|-------------|
| `steps` | Step count |
| `distance` | Distance traveled |
| `exercise` | Workout sessions |
| `sleep` | Sleep sessions and stages |
| `weight` | Body weight |
| `bodyFat` | Body fat percentage |
| `dailyRestingHeartRate` | Resting heart rate |
| `dailyHeartRateVariability` | HRV |
| `hydrationLog` | Water intake |
| `nutritionLog` | Meals and food entries |
| `activeMinutes` | Active zone minutes |
| `totalCalories` | Total calories burned |

## Setup

Run once on your host machine to add health scopes to gog:
```bash
bash scripts/gog-health-auth.sh you@company.com
```
This re-authenticates gog with health scopes included. Both Google Workspace and Health API share the same token.
