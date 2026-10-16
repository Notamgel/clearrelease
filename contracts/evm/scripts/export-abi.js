// Regenerates the ABI files consumed by the workflow binding after `npx hardhat compile`.
const fs = require("fs");
const path = require("path");
const a = require("../artifacts/src/ClearReleaseEscrow.sol/ClearReleaseEscrow.json");
fs.mkdirSync(path.join(__dirname, "..", "abi"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "..", "abi", "ClearReleaseEscrow.abi.json"), JSON.stringify(a.abi, null, 2));
const ts = "// Generated from contracts/evm/artifacts by `npm run abi` (contracts/evm). Do not edit by hand.\n" +
  "export const ClearReleaseEscrowABI = [\n" + a.abi.map((x) => "  " + JSON.stringify(x) + ",").join("\n") + "\n] as const\n";
fs.writeFileSync(path.join(__dirname, "..", "..", "..", "screening-workflow", "bindings", "ClearReleaseEscrowAbi.ts"), ts);
console.log(`wrote ${a.abi.length} ABI items`);
