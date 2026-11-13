# Your Settings

Put your own settings for x1-validator-private-rpc here, in `private-rpc.json`. git ignores every file in this folder except this one.

The file holds only the settings you change. The tool merges it over the shipped defaults, setting by setting. The defaults, and what each setting does, are in `../app-defaults-for-user-configurable/private-rpc.json` and the schema beside it.

```bash
cp ../app-defaults-for-user-configurable/private-rpc.json private-rpc.json
```

Then delete every setting you don't change.
