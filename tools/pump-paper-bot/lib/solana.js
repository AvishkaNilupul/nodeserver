const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

async function rpc(url, method, params) {
  const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function parseTrade(tx, signature) {
  if (!tx || tx.meta?.err) return null;
  const logs = tx.meta.logMessages || [];
  const instruction = logs.find((line) => line.includes('Instruction: Buy') || line.includes('Instruction: Sell'));
  if (!instruction) return null;
  const action = instruction.includes('Sell') ? 'sell' : 'buy';
  const keys = tx.transaction?.message?.accountKeys || [];
  const signerKeys = keys.filter((key) => key.signer).map((key) => key.pubkey);
  const balances = [...(tx.meta.preTokenBalances || []), ...(tx.meta.postTokenBalances || [])];
  // The fee payer is often signer[0], but Pump.fun routes can put the actual
  // trader on another signer. Select the signer that owns the traded token ATA.
  const token = [...new Set(balances
    .filter((item) => signerKeys.includes(item.owner) && !QUOTE_MINTS.has(item.mint))
    .map((item) => `${item.owner}:${item.mint}`))]
    .map((key) => {
      const [owner, mint] = key.split(':');
      const preAmount = Number((tx.meta.preTokenBalances || []).find((item) => item.owner === owner && item.mint === mint)?.uiTokenAmount?.uiAmount || 0);
      const postAmount = Number((tx.meta.postTokenBalances || []).find((item) => item.owner === owner && item.mint === mint)?.uiTokenAmount?.uiAmount || 0);
      return { owner, mint, delta: Math.abs(postAmount - preAmount) };
    }).sort((a, b) => b.delta - a.delta)[0];
  if (!token) return null;
  const trader = token.owner;
  const pre = (tx.meta.preTokenBalances || []).find((item) => item.owner === trader && item.mint === token.mint)?.uiTokenAmount.uiAmount || 0;
  const post = (tx.meta.postTokenBalances || []).find((item) => item.owner === trader && item.mint === token.mint)?.uiTokenAmount.uiAmount || 0;
  const tokenDelta = Math.abs(post - pre);
  const traderIndex = keys.findIndex((key) => key.pubkey === trader);
  const balanceIndexes = traderIndex >= 0 ? [traderIndex, 0] : [0];
  const signerSolVolume = balanceIndexes.reduce((best, index) => {
    const delta = Math.abs(((tx.meta.postBalances?.[index] || 0) - (tx.meta.preBalances?.[index] || 0)) / 1e9);
    return delta > best ? delta : best;
  }, 0);
  // Routers can fund the swap through a non-signer vault while the signer only
  // pays rent and transaction fees. Pair the transaction's dominant incoming
  // and outgoing lamport flows to measure the swap rather than that tiny fee
  // payer delta. The smaller side represents the net amount after route fees.
  const lamportDeltas = keys.map((_, index) => ((tx.meta.postBalances?.[index] || 0) - (tx.meta.preBalances?.[index] || 0)) / 1e9);
  const dominantIncomingSol = lamportDeltas.reduce((best, delta) => delta > best ? delta : best, 0);
  const dominantOutgoingSol = lamportDeltas.reduce((best, delta) => -delta > best ? -delta : best, 0);
  const dominantSolVolume = dominantIncomingSol && dominantOutgoingSol
    ? Math.min(dominantIncomingSol, dominantOutgoingSol)
    : 0;
  const solDelta = dominantSolVolume || signerSolVolume;
  if (!tokenDelta || !solDelta) return null;
  return {
    type: 'market',
    time: tx.blockTime,
    slot: tx.slot,
    signature,
    mint: token.mint,
    action,
    trader,
    tokenVolume: tokenDelta,
    solVolume: solDelta,
    priceSol: solDelta / tokenDelta,
    priceSource: dominantSolVolume ? 'dominant-lamport-flow' : 'signer-balance',
    signerSolVolume,
    dominantSolVolume,
  };
}

module.exports = { PUMP_FUN_PROGRAM, rpc, parseTrade };
