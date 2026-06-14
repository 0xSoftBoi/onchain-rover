/**
 * Ledger clear-sign treasury withdrawal — the governance climax.
 * Bundled to public/ledger.bundle.js by `npm run build:ledger` (esbuild).
 *
 * Flow: WebHID connect -> open Ethereum app -> sign the withdraw tx. With an
 * originToken + our ERC-7730 descriptor the device shows "Withdraw X USDC to Y";
 * without it, blind-sign fallback. Either way the funds move ONLY on a physical
 * button press — that's the demo's point.
 *
 * WebHID: Chromium-only, secure context, must be triggered by a user gesture.
 */
import { DeviceManagementKitBuilder, ConsoleLogger } from "@ledgerhq/device-management-kit";
import { webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import { webBleTransportFactory } from "@ledgerhq/device-transport-kit-web-ble";
import { SignerEthBuilder } from "@ledgerhq/device-signer-kit-ethereum";
import { firstValueFrom, filter } from "rxjs";

const DERIVATION = "44'/60'/0'/0/0";
const ORIGIN_TOKEN = (window as any).LEDGER_ORIGIN_TOKEN || "origin-token"; // from Ledger booth

let dmk: any, sessionId: string, signerEth: any, deviceAddress: string;

function log(m: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = m;
  console.log("[ledger]", m);
}

/**
 * Connect over Bluetooth (Nano X) or USB. transport="ble"|"hid"|"auto".
 * "auto" prefers BLE if Web Bluetooth is present, else falls back to WebHID.
 */
export async function connect(transport: "ble" | "hid" | "auto" = "auto") {
  const hasBle = "bluetooth" in navigator;
  const hasHid = "hid" in navigator;
  const useBle = transport === "ble" || (transport === "auto" && hasBle);
  if (useBle && !hasBle) throw new Error("Web Bluetooth unavailable — use Chrome/Edge over HTTPS, or pick USB");
  if (!useBle && !hasHid) throw new Error("WebHID unavailable — use Chrome/Edge over HTTPS or localhost, or pick Bluetooth");
  const factory = useBle ? webBleTransportFactory : webHidTransportFactory;
  dmk = new DeviceManagementKitBuilder().addLogger(new ConsoleLogger())
    .addTransport(factory).build();
  log(useBle ? "select your Ledger in the Bluetooth prompt…" : "select your Ledger in the browser prompt…");
  const device = await firstValueFrom(dmk.startDiscovering({}));
  sessionId = await dmk.connect({ device });
  log(`connected over ${useBle ? "Bluetooth" : "USB"} — open the Ethereum app on the device`);
  signerEth = new SignerEthBuilder({ dmk, sessionId, originToken: ORIGIN_TOKEN }).build();
  deviceAddress = await getAddress();
  log("ready · device address " + deviceAddress.slice(0, 10) + "…");
  return deviceAddress;
}

async function getAddress(): Promise<string> {
  const { observable } = signerEth.getAddress(DERIVATION, { checkOnDevice: false });
  const final = await firstValueFrom(
    observable.pipe(filter((s: any) => s.status === "completed" || s.status === "error")));
  if (final.status === "error") throw final.error;
  return final.output.address as string;
}

/** Sign a serialized unsigned EIP-1559 tx (hex) on the device. Returns {r,s,v}. */
export async function signTx(unsignedSerializedHex: string) {
  if (!signerEth) throw new Error("connect the Ledger first");
  log("review and APPROVE on your Ledger…");
  const bytes = hexToBytes(unsignedSerializedHex);
  const { observable } = signerEth.signTransaction(DERIVATION, bytes, {});
  const final = await firstValueFrom(
    observable.pipe(filter((s: any) => s.status === "completed" || s.status === "error")));
  if (final.status === "error") throw final.error;
  log("signed on device ✓");
  return final.output as { r: string; s: string; v: number | bigint };
}

/** Full climax: fetch unsigned withdraw tx -> Ledger sign -> broadcast on Arc. */
export async function withdraw(to: string, amountUsdc: string) {
  if (!deviceAddress) throw new Error("connect the Ledger first");
  const built = await (await fetch(
    `/treasury/withdraw-tx?from=${deviceAddress}&to=${to}&amount=${amountUsdc}`)).json();
  if (built.error) throw new Error(built.error);
  const sig = await signTx(built.unsignedSerialized);
  log("broadcasting on Arc…");
  const res = await (await fetch("/treasury/broadcast", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tx: built.tx, signature: sig }),
  })).json();
  if (res.error) throw new Error(res.error);
  log("✓ withdrawn — tx " + res.tx);
  return res;
}

/**
 * Opening ceremony: clear-sign the GASLESS EIP-712 session authorization on the
 * device, then post it to the sidecar to unlock the show. No gas, no tx — just a
 * human granting the autonomous fleet permission to operate. Returns the verified
 * session status.
 */
export async function authorize() {
  if (!deviceAddress) throw new Error("connect the Ledger first");
  const td = await (await fetch(
    `/session/auth-message?operator=${deviceAddress}`)).json();
  if (td.error) throw new Error(td.error);
  log("review and APPROVE the authorization on your Ledger…");
  const { observable } = signerEth.signTypedData(DERIVATION, td);
  const final = await firstValueFrom(
    observable.pipe(filter((s: any) => s.status === "completed" || s.status === "error")));
  if (final.status === "error") throw final.error;
  const signature = normalizeSig(final.output);
  log("authorizing…");
  const res = await (await fetch("/session/authorize", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signature }),
  })).json();
  if (res.error || !res.ok) throw new Error(res.error || "authorization rejected");
  log("✓ fleet authorized — the show may begin");
  return res;
}

/** DMK may return a hex string, {signature}, or {r,s,v}; viem needs one 65-byte hex. */
function normalizeSig(out: any): string {
  if (typeof out === "string") return out;
  if (out?.signature) return out.signature;
  if (out?.r && out?.s && out?.v !== undefined) {
    const r = String(out.r).replace(/^0x/, "").padStart(64, "0");
    const s = String(out.s).replace(/^0x/, "").padStart(64, "0");
    let v = typeof out.v === "bigint" ? Number(out.v) : Number(out.v);
    if (v < 27) v += 27;                       // EIP-712 expects v in {27,28}
    return "0x" + r + s + v.toString(16).padStart(2, "0");
  }
  throw new Error("unrecognized signature format from device");
}

function hexToBytes(hex: string) {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

(window as any).roverLedger = { connect, authorize, withdraw, signTx };
