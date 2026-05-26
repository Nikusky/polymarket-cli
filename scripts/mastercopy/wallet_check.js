#!/usr/bin/env node
// Wallet snapshot. Prints EOA + proxy balances across both USDC contracts
// (native USDC + bridged USDC.e) and the authenticated CLOB cash balance.
// Reads POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER_OVERRIDE from env.
// No state changes, no orders.

const { createWalletClient, http, parseAbi, createPublicClient } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { polygon } = require('viem/chains');
const { ClobClient, Chain } = require('@polymarket/clob-client-v2');

const KEY    = process.env.POLYMARKET_PRIVATE_KEY;
const FUNDER = process.env.POLYMARKET_FUNDER_OVERRIDE;
const HOST   = process.env.CLOB_HOST || 'https://clob.polymarket.com';

const USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_NATIVE  = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

(async () => {
  if (!KEY || !FUNDER) { console.error('missing env'); process.exit(1); }

  const account = privateKeyToAccount(KEY);
  const eoa = account.address;
  console.log(`EOA signer:   ${eoa}`);
  console.log(`Proxy/funder: ${FUNDER}`);

  const publicClient = createPublicClient({ chain: polygon, transport: http() });

  async function bal(token, owner) {
    try {
      const b = await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
      return Number(b) / 1e6;
    } catch (e) { return `err: ${e.message}`; }
  }

  const [eoaBridged, eoaNative, proxyBridged, proxyNative] = await Promise.all([
    bal(USDC_BRIDGED, eoa),
    bal(USDC_NATIVE,  eoa),
    bal(USDC_BRIDGED, FUNDER),
    bal(USDC_NATIVE,  FUNDER),
  ]);
  console.log('');
  console.log('On-chain USDC (Polygon):');
  console.log(`  EOA   USDC.e (bridged 0x2791): $${eoaBridged}`);
  console.log(`  EOA   USDC   (native  0x3c49): $${eoaNative}`);
  console.log(`  Proxy USDC.e (bridged 0x2791): $${proxyBridged}`);
  console.log(`  Proxy USDC   (native  0x3c49): $${proxyNative}`);

  // Authenticated CLOB cash balance
  console.log('');
  try {
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
    const opts = { host: HOST, chain: Chain.POLYGON, signer: walletClient, signatureType: 2, funderAddress: FUNDER };
    const bootstrap = new ClobClient(opts);
    const creds = await bootstrap.createOrDeriveApiKey();
    const clob = new ClobClient({ ...opts, creds, throwOnError: true });
    const cashCollateral = await clob.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    console.log('CLOB COLLATERAL (USDC cash on Polymarket):', cashCollateral);
  } catch (e) {
    console.log('CLOB balance error:', e.message);
  }
})();
