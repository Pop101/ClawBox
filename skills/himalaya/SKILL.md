---
name: himalaya
description: >
  CLI email client for managing emails via IMAP/SMTP. Use himalaya to list,
  read, write, reply, forward, search, move, copy, and delete emails from
  the terminal. Supports multiple accounts and message composition with MML
  (MIME Meta Language). Use when asked to check email, send email, search
  inbox, manage folders, or handle email-related tasks.
requires_binaries:
  - himalaya
---

# Himalaya Email

Manage emails from the command line using [himalaya](https://github.com/pimalaya/himalaya).

## Core Commands

```bash
# List recent emails (default: INBOX)
himalaya envelope list
himalaya envelope list --folder "Sent"
himalaya envelope list --page 2 --page-size 20

# Read an email
himalaya message read <id>
himalaya message read <id> --header "From" --header "Subject"

# Search emails
himalaya envelope list --query "from:user@example.com"
himalaya envelope list --query "subject:meeting"
himalaya envelope list --query "unseen"

# Send an email (MML format)
himalaya message write <<'MML'
From: me@example.com
To: recipient@example.com
Subject: Hello

Plain text body here.
MML

# Reply to an email
himalaya message reply <id>

# Forward an email
himalaya message forward <id>

# Move/copy/delete
himalaya message move <id> --to "Archive"
himalaya message copy <id> --to "Important"
himalaya message delete <id>

# List folders
himalaya folder list

# List accounts
himalaya account list
```

## MML (MIME Meta Language) Format

When composing emails, use MML format:

```
From: sender@example.com
To: recipient@example.com
Cc: cc@example.com
Subject: Email subject
Content-Type: text/plain

The email body goes here.
```

For HTML emails:
```
From: sender@example.com
To: recipient@example.com
Subject: HTML Email
Content-Type: text/html

<h1>Hello</h1>
<p>This is an HTML email.</p>
```

## Tips

- Always check `himalaya account list` first to see configured accounts.
- Use `--output json` for machine-readable output when processing results.
- Himalaya config is at `~/.config/himalaya/config.toml`.
- For bulk operations, use `himalaya envelope list --output json` and pipe through jq.
