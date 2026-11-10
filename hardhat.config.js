// Local test engines only. No funded keys and no transactions to real chains (the fork only reads).
export default {
  solidity: '0.8.38',
  paths: { artifacts: './artifacts/hardhat', cache: './.hardhat-cache' },
  // Forks need each chain's hardfork history to run calls at historical blocks (both chains are Cancun-level).
  chainDescriptors: {
    99901: { name: 'Elysium', chainType: 'generic', hardforkHistory: { cancun: { blockNumber: 0 } } },
    999: { name: 'HyperEVM', chainType: 'generic', hardforkHistory: { cancun: { blockNumber: 0 } } },
  },
  networks: {
    local: {
      type: 'edr-simulated',
      chainType: 'l1',
      chainId: 31337,
      hardfork: 'cancun',
      loggingEnabled: false,
    },
    // Local copy of Elysium mainnet for the pre-deploy dry run (scripts/fork-dryrun.mjs): real WHYPE and
    // Uniswap V4 state, simulated accounts, nothing sent to the real chain. FORK_URL may point at a provider.
    elysiumFork: {
      type: 'edr-simulated',
      chainType: 'generic',
      chainId: 99901,
      hardfork: 'cancun',
      loggingEnabled: false,
      forking: { url: process.env.FORK_URL ?? 'https://rpc.elysium.kinetiq.xyz' },
    },
    // Local copy of HyperEVM mainnet, for the bridge test against Elysium's real Inbox.
    hyperevmFork: {
      type: 'edr-simulated',
      chainType: 'generic',
      chainId: 999,
      hardfork: 'cancun',
      loggingEnabled: false,
      forking: { url: process.env.HYPEREVM_FORK_URL ?? 'https://rpc.hyperliquid.xyz/evm' },
    },
  },
};
