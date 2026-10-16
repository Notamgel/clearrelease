#!/bin/zsh
# Demo para el video: corre el flujo completo de ClearRelease en Sepolia con pausas legibles.
# Uso: abre Terminal, empieza a grabar la pantalla y ejecuta:  ~/Desktop/bounties/01-chainlink-cre-clearrelease/demo-video.sh
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.bun/bin:$HOME/.cre/bin:$PATH"
export PRIVATE_KEY=$(grep '^CRE_ETH_PRIVATE_KEY=' .env | cut -d= -f2)
SANCTIONED_MISSED=0x038989cbb1710c72b9920dc4fa529158f463e72c

say() { print -P "\n%F{cyan}%B▶ $1%b%f"; sleep 2; }
demo() { (cd contracts/evm && env "$@" npx hardhat run scripts/demo.js --network sepolia 2>&1) }
screen_event() { # corre el workflow de CRE contra el evento que imprimió demo.js
  local out="$1" tx idx
  tx=$(print -r -- "$out" | grep -oE "evm-tx-hash 0x[0-9a-f]+" | awk '{print $2}')
  idx=$(print -r -- "$out" | grep -oE "evm-event-index [0-9]+" | awk '{print $2}')
  cre workflow simulate screening-workflow --target staging-settings --non-interactive \
    --trigger-index 1 --evm-tx-hash "$tx" --evm-event-index "$idx" --broadcast 2>&1 | grep -E "USER LOG"
}

clear
print -P "%F{green}%B ClearRelease — sanctions-gated legal escrow on Chainlink CRE %b%f"
sleep 3

say "1) Ad-hoc screening: a clean address, an address both sources flag, and an OFAC-listed address the Chainalysis oracle misses"
cre workflow simulate screening-workflow --target staging-settings --non-interactive --trigger-index 0 \
  --http-payload '{"addresses":["0x1111111111111111111111111111111111111111","0x0330070FD38Ec3bB94F58FA55D40368271E9e54A","'$SANCTIONED_MISSED'"]}' 2>&1 | grep -E "USER LOG"
sleep 4

say "2) Open an escrow between two clean parties (Sepolia)"
OUT=$(demo ACTION=open); print -r -- "$OUT" | grep -E "opened"
ID=$(print -r -- "$OUT" | grep -oE "escrow id=[0-9]+" | cut -d= -f2)
say "   CRE screens both parties and writes a signed report on-chain"
screen_event "$OUT"
sleep 3

say "3) Payer approves the release → CRE re-screens at payment time"
OUT=$(demo ACTION=approve ESCROW_ID=$ID); print -r -- "$OUT" | grep -E "approved"
screen_event "$OUT"
demo ACTION=status ESCROW_ID=$ID | grep -E "status:"
sleep 4

say "4) Open an escrow whose payee is on the OFAC list but NOT flagged by the Chainalysis oracle"
OUT=$(demo ACTION=open PAYEE=$SANCTIONED_MISSED); print -r -- "$OUT" | grep -E "opened"
ID2=$(print -r -- "$OUT" | grep -oE "escrow id=[0-9]+" | cut -d= -f2)
screen_event "$OUT"
demo ACTION=status ESCROW_ID=$ID2 | grep -E "status:"

print -P "\n%F{green}%B✔ Clean escrow released, sanctioned payee frozen. Every decision leaves an auditable evidence hash on-chain.%b%f"
print -P "Contract: https://sepolia.etherscan.io/address/0x2FFE6Ec34D1470198ba64c1A88F5FBef0dc54f50"
