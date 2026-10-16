// Reproduces the finding that motivated a two-source design:
// how many OFAC SDN-listed ETH addresses does the Chainalysis on-chain oracle NOT flag?
//   bun run scripts/compare-sources.ts            (from screening-workflow/)
// Optional: MAINNET_RPC_URL=... to use your own RPC.
import { createPublicClient, http, parseAbi } from 'viem'
import { mainnet } from 'viem/chains'
import { writeFileSync } from 'node:fs'
import { normaliseList, hashList } from '../screening'

const REPO = '0xB10C/ofac-sanctioned-digital-currency-addresses'
const ORACLE = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb'
const abi = parseAbi(['function isSanctioned(address) view returns (bool)'])

const ref = await (await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/lists`)).json()
const commit: string = ref.object.sha
const list = normaliseList(await (await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/sanctioned_addresses_ETH.json`)).json())

const client = createPublicClient({
  chain: mainnet,
  transport: http(process.env.MAINNET_RPC_URL ?? 'https://ethereum-rpc.publicnode.com'),
  batch: { multicall: true },
})
const block = await client.getBlockNumber()
const flags = await Promise.all(
  list.map((a) => client.readContract({ address: ORACLE, abi, functionName: 'isSanctioned', args: [a as `0x${string}`], blockNumber: block })),
)
const missed = list.filter((_, i) => !flags[i])
const result = {
  generatedAt: new Date().toISOString(),
  listCommit: commit,
  listHash: hashList(list),
  mainnetBlock: block.toString(),
  ofacListedEthAddresses: list.length,
  flaggedByOracle: list.length - missed.length,
  notFlaggedByOracle: missed.length,
  notFlaggedSample: missed.slice(0, 10),
}
console.log(JSON.stringify(result, null, 2))
writeFileSync(new URL('../../docs/source-comparison.json', import.meta.url), JSON.stringify({ ...result, notFlaggedByOracleAll: missed }, null, 2) + '\n')
