// Local test engine only. No funded keys and no remote transaction endpoints.
export default {
  solidity: '0.8.38',
  paths: { artifacts: './artifacts/hardhat', cache: './.hardhat-cache' },
  networks: {
    local: {
      type: 'edr-simulated',
      chainType: 'l1',
      chainId: 31337,
      hardfork: 'cancun',
      loggingEnabled: false,
    },
  },
};
