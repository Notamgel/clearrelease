// Drives the escrow on Sepolia so the CRE workflow has real events to react to.
//
//   ACTION=open    [PAYEE=0x...] [AMOUNT_ETH=0.0001]  -> opens an escrow, prints the tx hash + event index
//   ACTION=approve ESCROW_ID=1                         -> payer approves release (new ScreeningRequested)
//   ACTION=status  ESCROW_ID=1                         -> prints the escrow state
//
// ESCROW defaults to the address in screening-workflow/config.staging.json.
// Run with:  PRIVATE_KEY=0x... ACTION=open npx hardhat run scripts/demo.js --network sepolia
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const STATUS = ["None", "AwaitingClearance", "Active", "PendingRelease", "Disputed", "Released", "Frozen"];
const cfgPath = path.join(__dirname, "..", "..", "..", "screening-workflow", "config.staging.json");

function printSimulateHint(receipt, escrow) {
  const idx = receipt.logs.findIndex((l) => {
    try { return escrow.interface.parseLog(l)?.name === "ScreeningRequested"; } catch { return false; }
  });
  console.log(`\nNow run the workflow against this event (from the project root):`);
  console.log(`  cre workflow simulate screening-workflow --target staging-settings --non-interactive \\`);
  console.log(`    --trigger-index 1 --evm-tx-hash ${receipt.hash} --evm-event-index ${idx} --broadcast`);
}

async function main() {
  const action = process.env.ACTION || "status";
  const address = process.env.ESCROW || JSON.parse(fs.readFileSync(cfgPath, "utf8")).escrow.address;
  const escrow = await ethers.getContractAt("ClearReleaseEscrow", address);
  const [signer] = await ethers.getSigners();
  console.log(`escrow=${address} signer=${signer.address} action=${action}`);

  if (action === "open") {
    // Default payee: a fresh random address (clean). Set PAYEE to an OFAC-listed address to demo a freeze.
    const payee = process.env.PAYEE || ethers.Wallet.createRandom().address;
    const agreementPath = path.join(__dirname, "..", "..", "..", "docs", "sample-agreement.md");
    const agreementHash = ethers.sha256(fs.readFileSync(agreementPath));
    const releaseAfter = Math.floor(Date.now() / 1000) + Number(process.env.REVIEW_SECONDS || 3600);
    const value = ethers.parseEther(process.env.AMOUNT_ETH || "0.0001");
    const tx = await escrow.openEscrow(payee, agreementHash, releaseAfter, { value });
    const receipt = await tx.wait();
    const opened = receipt.logs.map((l) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((e) => e && e.name === "EscrowOpened");
    console.log(`opened escrow id=${opened.args.id} payee=${payee} agreementHash=${agreementHash}`);
    printSimulateHint(receipt, escrow);
  } else if (action === "approve") {
    const tx = await escrow.approveRelease(BigInt(process.env.ESCROW_ID));
    const receipt = await tx.wait();
    console.log(`release approved for escrow ${process.env.ESCROW_ID}`);
    printSimulateHint(receipt, escrow);
  } else {
    const id = BigInt(process.env.ESCROW_ID || 1);
    const e = await escrow.getEscrow(id);
    console.log({
      id: id.toString(), status: STATUS[Number(e.status)], payer: e.payer, payee: e.payee,
      amountWei: e.amount.toString(), payeeBps: Number(e.payeeBps),
      lastScreenedAt: Number(e.lastScreenedAt), lastEvidence: e.lastEvidence, agreementHash: e.agreementHash,
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
