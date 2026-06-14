import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";

import { createWalletSigner, type EthereumProvider } from "../web-src/signer.js";

const wallet = "0x1000000000000000000000000000000000000001";
const treasury = "0x2000000000000000000000000000000000000002";
const gatewayWallet = "0x3000000000000000000000000000000000000003";
const usdc = "0x4000000000000000000000000000000000000004";
const signature = `0x${"11".repeat(65)}`;

async function main() {
  const typedDataRequests: unknown[] = [];
  const provider: EthereumProvider = {
    async request(args) {
      if (args.method === "eth_requestAccounts") return [wallet];
      if (args.method === "eth_chainId") return "0x4cef12";
      if (args.method === "eth_signTypedData_v4") {
        const params = args.params as unknown[];
        typedDataRequests.push(JSON.parse(String(params[1])));
        return signature;
      }
      throw new Error(`unexpected provider method ${args.method}`);
    },
  };

  const calls: Array<{ url: string; body: unknown; payment?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const payment = headerValue(init?.headers, "PAYMENT-SIGNATURE");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(input), body, payment });
    if (!payment) {
      return Response.json({ error: "payment required" }, {
        status: 402,
        headers: {
          "PAYMENT-REQUIRED": encodePaymentRequiredHeader({
            x402Version: 2,
            resource: {
              url: "/race/round/round1/join",
              description: "race fee",
              mimeType: "application/json",
            },
            accepts: [{
              scheme: "exact",
              network: "eip155:5042002",
              asset: usdc,
              amount: "250000",
              payTo: treasury,
              maxTimeoutSeconds: 60,
              extra: {
                name: "GatewayWalletBatched",
                version: "1",
                verifyingContract: gatewayWallet,
              },
            }],
          } as any),
        },
      });
    }

    const payload = decodePaymentSignatureHeader(payment);
    const authorization = (payload.payload as any).authorization;
    assert(authorization.from.toLowerCase() === wallet.toLowerCase(), "payment signer mismatch");
    assert(authorization.to.toLowerCase() === treasury.toLowerCase(), "payment recipient mismatch");
    assert(authorization.value === "250000", "payment amount mismatch");
    assert((payload as any).accepted?.network === "eip155:5042002", "accepted network missing");

    return Response.json({
      ok: true,
      slot: "challenger",
      feePayment: { source: "x402", status: "paid" },
    });
  }) as typeof fetch;

  try {
    const signer = createWalletSigner({ provider });
    const session = await signer.connect();
    const result = await signer.payRaceFee(session, {
      roundId: "round1",
      slot: "challenger",
      displayName: "challenger",
    }) as { feePayment?: { source?: string } };

    assert(result.feePayment?.source === "x402", "fee payment result missing");
    assert(calls.length === 2, `expected unpaid and paid requests, got ${calls.length}`);
    assert(calls[0].url === "/race/round/round1/join", "wrong first URL");
    assert(calls[1].payment, "paid retry missing PAYMENT-SIGNATURE");
    assert(typedDataRequests.length === 1, "expected one typed-data signature");
    const typed = typedDataRequests[0] as any;
    assert(typed.domain.name === "GatewayWalletBatched", "wrong typed-data domain");
    assert(typed.domain.verifyingContract.toLowerCase() === gatewayWallet.toLowerCase(), "wrong verifying contract");
    assert(typed.message.value === "250000", "wrong typed-data value");

    console.log("Signer x402 e2e passed");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function headerValue(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

await main();
