---
description: Take a work item or issue from ticket to pull request with the ticket-to-pr skill (add --auto to run without stopping)
argument-hint: "<work item id or issue number> [--auto] [notes]"
---
Use the ticket-to-pr skill to complete ticket $1. Stop at both checkpoints for my approval, unless autonomous mode is on.

Extra notes from me (may be empty): ${@:2}
