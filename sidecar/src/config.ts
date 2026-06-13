// Central config — all addresses verified live 2026-06-12 (see plan memory).
export const ARC = {
  chainId: 5042002,
  caip2: "eip155:5042002",
  rpc: "https://rpc.testnet.arc.network",
  usdc: "0x3600000000000000000000000000000000000000", // 6dp token; native gas 18dp!
  gatewayWallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  facilitatorUrl: "https://gateway-api-testnet.circle.com", // 🚨 default is MAINNET
  explorer: "https://testnet.arcscan.app",
} as const;

export const ERC8004 = {
  // Sepolia (cheap registration tonight); mainnet 0x8004A169…/0x8004BAa1…
  identity: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
  reputation: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
  topicNewFeedback:
    "0x6a4a61743519c9d648a14e6493f47dbe3ff1aa29e7785c96c8326a205e58febc",
  topicRegistered:
    "0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a",
} as const;

export const ROBOTS = {
  guard: {
    url: process.env.GUARD_URL ?? "http://192.168.8.71:8000",
    wallet: process.env.GUARD_WALLET ?? "",
    privyWalletId: process.env.GUARD_PRIVY_WALLET_ID ?? "",
    ens: "guard.rover.eth",
    agentId: process.env.GUARD_AGENT_ID,
  },
  courier: {
    url: process.env.COURIER_URL ?? "http://192.168.8.72:8000",
    wallet: process.env.COURIER_WALLET ?? "",
    privyWalletId: process.env.COURIER_PRIVY_WALLET_ID ?? "",
    ens: "courier.rover.eth",
    agentId: process.env.COURIER_AGENT_ID,
  },
} as const;

export type RobotName = keyof typeof ROBOTS;

export const NAMESTONE = {
  endpoint: "https://namestone.com/api/public_v1/set-name",
  resolver: "0xA87361C4E58B619c390f469B9E6F27d759715125",
  apiKey: process.env.NAMESTONE_API_KEY ?? "",
  domain: process.env.ENS_PARENT ?? "rover.eth",
} as const;

// ENSIP-25: agent-registration[<erc7930 registry>][<agentId>] = "1"
// ERC-7930 binary: 0001|0000|<len>|<chainid>|14|<20B addr>
// Sepolia chainid 11155111 = 0xaa36a7 (3 bytes). Sanity-check vs canonical
// mainnet example 0x000100000101148004a169… at build time (flagged in plan).
export const ensip25Key = (agentId: string | number) =>
  `agent-registration[0x0001000003aa36a7148004a818bfb912233c491871b3d84c89a494bd9e][${agentId}]`;
