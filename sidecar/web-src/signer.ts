export type EthereumProvider = {
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
};

export type WalletChain = {
  chainIdHex: string;
  rpcUrl: string;
  name: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
};

export type TypedDataEnvelope = {
  domain?: Record<string, unknown>;
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  message?: Record<string, unknown>;
};

export type WalletSigner = {
  readonly id: string;
  readonly label: string;
  connect(): Promise<string>;
  ensureChain(chain: WalletChain): Promise<void>;
  signTypedData(wallet: string, data: TypedDataEnvelope): Promise<string>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

export function injectedWalletSigner(provider = window.ethereum): WalletSigner {
  if (!provider) throw new Error("EVM wallet required");
  return {
    id: "injected-eip1193",
    label: "Browser Wallet",
    async connect() {
      const accounts = await provider.request({ method: "eth_requestAccounts" }) as string[];
      const wallet = accounts[0];
      if (!wallet) throw new Error("wallet account unavailable");
      return wallet;
    },
    async ensureChain(chain) {
      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: chain.chainIdHex }],
        });
      } catch (err) {
        const code = typeof err === "object" && err && "code" in err
          ? Number((err as { code: unknown }).code)
          : 0;
        if (code !== 4902) throw err;
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: chain.chainIdHex,
            chainName: chain.name,
            rpcUrls: [chain.rpcUrl],
            nativeCurrency: chain.nativeCurrency,
          }],
        });
      }
    },
    async signTypedData(wallet, data) {
      return provider.request({
        method: "eth_signTypedData_v4",
        params: [wallet, JSON.stringify(data)],
      }) as Promise<string>;
    },
  };
}
