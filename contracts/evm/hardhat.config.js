require("@nomicfoundation/hardhat-toolbox");

// Never commit keys. Export them in your shell instead:
//   export SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com
//   export PRIVATE_KEY=0x...   (a throwaway testnet key)
const { SEPOLIA_RPC_URL, PRIVATE_KEY } = process.env;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  paths: { sources: "./src", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    sepolia: {
      url: SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      chainId: 11155111,
    },
  },
};
