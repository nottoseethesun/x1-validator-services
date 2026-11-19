# Your Settings

Put your own settings for x1-validator-private-rpc in this folder, in `private-rpc.json`. `git` ignores every file here but this README. The tool refuses to run while the folder holds another file whose name ends in `.json` and doesn't start with a dot, such as `private_rpc.json`. So settings saved under a wrong name can't be ignored without a word. Every other file passes. That covers a name that doesn't end in `.json`, such as `private-rpc.json.save`, which `nano` can leave behind. It also covers a name that starts with a dot, such as `.#private-rpc.json`, the lock file Emacs keeps while an edit is unsaved.

The file holds only the settings you change. The tool merges it over the shipped defaults, setting by setting. The defaults, and what each setting does, are in `../app-defaults-for-user-configurable/private-rpc.json` and the schema beside it. Every command checks the merged settings first, and stops with every problem named, so a typo can't be ignored.

`apply` needs one setting that has no default: `hostname`, the name your clients will use for the rpc. The feature's [Set the Hostname](../../README.md#set-the-hostname) step starts this file from the example.
