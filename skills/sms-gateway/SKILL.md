---
name: sms-gateway
description: >
  Send and receive SMS messages via Android SMS Gateway. Use when asked to
  send a text message, check texts, read SMS, reply to a text, or monitor
  incoming messages. Supports multi-SIM and delivery tracking.
---

# SMS Gateway

Send and receive SMS via [Android SMS Gateway](https://github.com/capcom6/android-sms-gateway). The gateway runs on the user's Android phone and exposes a REST API.

**Base URL:** `$SMS_GATEWAY_URL` (e.g., `https://api.sms-gate.app:443`)
**Auth:** HTTP Basic Auth with `$SMS_GATEWAY_USERNAME` : `$SMS_GATEWAY_PASSWORD`

All requests use Basic Auth:
```bash
curl -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD" ...
```

## Send SMS

```bash
curl -X POST "$SMS_GATEWAY_URL/api/3rdparty/v1/message" \
  -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello from OpenClaw!",
    "phoneNumbers": ["+1234567890"]
  }'
```

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | yes | SMS text content |
| `phoneNumbers` | string[] | yes | Array of recipient phone numbers (E.164 format: +country code + number) |
| `simNumber` | int | no | SIM slot to send from (1 or 2). Omit for default SIM. |
| `withDeliveryReport` | bool | no | Request delivery confirmation (default: false) |
| `isEncrypted` | bool | no | Whether the message is encrypted (default: false) |
| `ttl` | string | no | Time-to-live duration (e.g., "1h", "30m"). Message expires if not sent within this window. |
| `validUntil` | string | no | ISO 8601 datetime after which the message should not be sent. |

**Response (201 Created):**
```json
{
  "id": "msg_abc123",
  "state": "Pending",
  "recipients": [
    {
      "phoneNumber": "+1234567890",
      "state": "Pending"
    }
  ],
  "isEncrypted": false,
  "createdAt": "2026-03-30T12:00:00Z"
}
```

**Send to multiple recipients:**
```bash
curl -X POST "$SMS_GATEWAY_URL/api/3rdparty/v1/message" \
  -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Meeting at 3pm",
    "phoneNumbers": ["+1234567890", "+0987654321"]
  }'
```

## Check Message Status

```bash
curl "$SMS_GATEWAY_URL/api/3rdparty/v1/message/{messageId}" \
  -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD"
```

**Response:**
```json
{
  "id": "msg_abc123",
  "state": "Delivered",
  "message": "Hello from OpenClaw!",
  "recipients": [
    {
      "phoneNumber": "+1234567890",
      "state": "Delivered",
      "error": null
    }
  ],
  "createdAt": "2026-03-30T12:00:00Z",
  "isEncrypted": false
}
```

**Message states:** `Pending` → `Processed` → `Sent` → `Delivered` (or `Failed`)

## Get Received Messages (Inbox)

```bash
# Get all received messages
curl "$SMS_GATEWAY_URL/api/3rdparty/v1/message?status=received" \
  -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD"
```

**Response:**
```json
[
  {
    "id": "msg_xyz789",
    "message": "Hey, are you free tonight?",
    "phoneNumber": "+1234567890",
    "receivedAt": "2026-03-30T11:30:00Z"
  }
]
```

## List Sent Messages

```bash
# Get all sent messages
curl "$SMS_GATEWAY_URL/api/3rdparty/v1/message" \
  -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD"
```

## Webhooks (Incoming SMS Notifications)

The gateway supports webhooks for real-time incoming SMS. Configure via the Android app settings:
- **Event type:** `sms:received` — fires when a new SMS arrives
- **Webhook URL:** point to your server endpoint
- **Payload:**
```json
{
  "event": "sms:received",
  "payload": {
    "message": "The SMS text content",
    "phoneNumber": "+1234567890",
    "receivedAt": "2026-03-30T11:30:00Z"
  }
}
```

Other webhook events: `sms:sent`, `sms:delivered`, `sms:failed`

## Device Info

```bash
# Get connected device status
curl "$SMS_GATEWAY_URL/api/3rdparty/v1/device" \
  -u "$SMS_GATEWAY_USERNAME:$SMS_GATEWAY_PASSWORD"
```

## Common Patterns

### Reply to the last text from a contact
1. `GET /api/3rdparty/v1/message?status=received` — find the message
2. `POST /api/3rdparty/v1/message` — send reply to the sender's number

### Send an SMS to a contact by name
Look up the phone number from:
1. Google Contacts via `gog contacts search <name>`
2. Credentials files: `grep -i "name" /home/clawuser/credentials/*.csv`
3. Memory: `memory_search("phone number <name>")`
Then send via the API.

### Check if a message was delivered
Poll `GET /api/3rdparty/v1/message/{id}` until state is `Delivered` or `Failed`.

## Environment Variables

- `SMS_GATEWAY_URL` — Base URL of the gateway (e.g., `https://api.sms-gate.app:443`)
- `SMS_GATEWAY_USERNAME` — Basic auth username
- `SMS_GATEWAY_PASSWORD` — Basic auth password

## Tips

- Phone numbers must be in E.164 format: `+` followed by country code and number (e.g., `+14155551234`)
- The Android app must be running on the phone with the SIM card active
- Battery optimization should be disabled for the SMS Gateway app on Samsung (Settings → Apps → SMS Gateway → Battery → Unrestricted)
- For bulk sends, batch into a single request with multiple phoneNumbers rather than multiple requests
