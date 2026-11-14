#!/bin/bash

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
export PATH="$HOME/.nvm/versions/node/v20.0.0/bin:$PATH"

# A stand-in for x1console's start_validator.sh, for tests. It has the real
# script's shape at x1console commit c1ef91b: the validator's command runs
# tachyon-validator with its flags one per line, each line but the last
# ending in a backslash, and the rpc port on a line of its own, indented by
# four spaces. Its values are neutral; none is copied from x1console.

ACCOUNTS_DIR="/run/accounts"
DIRECT_IO_FLAG=""

# Start the validator
nohup $HOME/.local/share/solana/install/active_release/bin/tachyon-validator \
    --identity ~/.config/solana/identity.json \
    --vote-account "$VOTE_ACCOUNT" \
    --known-validator KNOWN_VALIDATOR_IDENTITY \
    --accounts "$ACCOUNTS_DIR" \
    $DIRECT_IO_FLAG \
    --log ~/x1/log.txt \
    --ledger ~/x1/ledger \
    --rpc-port 8899 \
    --full-rpc-api \
    --dynamic-port-range 8000-8030 \
    --entrypoint entrypoint.example.invalid:8001 \
    --enable-rpc-transaction-history \
    --rpc-pubsub-enable-block-subscription \
    --maximum-full-snapshots-to-retain 50 > ~/x1/log.txt 2>&1 &
