// Deploys ClearReleaseEscrow and writes its address into the workflow config.
//   PRIVATE_KEY=0x... npx hardhat run scripts/deploy.js --network sepolia
// FORWARDER defaults to the Sepolia MockKeystoneForwarder used by `cre workflow simulate --broadcast`.
// For a real CRE deployment use the production KeystoneForwarder (see the CRE forwarder directory)
// or call setForwarderAddress() later.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const MOCK_FORWARDER_SEPOLIA = "0x15fC6ae953E024d975e77382eEeC56A9101f9F88";

async function main() {
  const forwarder = process.env.FORWARDER || MOCK_FORWARDER_SEPOLIA;
  const [deployer] = await ethers.getSigners();
  console.log(`network=${network.name} deployer=${deployer.address} forwarder=${forwarder}`);
  const F = await ethers.getContractFactory("ClearReleaseEscrow");
  const escrow = await F.deploy(forwarder);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log(`ClearReleaseEscrow deployed at ${address}`);
  console.log(`deploy tx: ${escrow.deploymentTransaction().hash}`);

  for (const file of ["config.staging.json", "config.production.json"]) {
    const p = path.join(__dirname, "..", "..", "..", "screening-workflow", file);
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.escrow.address = address;
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    console.log(`updated ${path.relative(process.cwd(), p)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
