# Your Settings

Put your own settings for x1-validator-private-rpc here, in `private-rpc.json`. git ignores every file in this folder except this one. The tool refuses to run while this folder holds any other file, so settings saved under a wrong name can't be ignored without a word.

The file holds only the settings you change. The tool merges it over the shipped defaults, setting by setting. The defaults, and what each setting does, are in `../app-defaults-for-user-configurable/private-rpc.json` and the schema beside it. Every command checks the merged settings first, and stops with every problem named, so a typo can't be ignored.

`apply` needs one setting that has no default: `hostname`, the name your clients will use for the rpc. The feature's [Set the Hostname](../../README.md#set-the-hostname) step starts this file from the example.
