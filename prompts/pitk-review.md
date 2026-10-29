---
description: Review a PR or the current branch with the pr-review skill
argument-hint: "[PR id or branch] [focus]"
---
Use the pr-review skill to review ${1:-the current branch against its target branch}.

Extra focus from the user (may be empty): ${@:2}
