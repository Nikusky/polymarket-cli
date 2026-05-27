const assert = require('assert');
const { computeMaxPriceForFill, validateFunderAddress, sizeUsdToShareSize, normalizeTokenId, parseGetOrderFill } = require('./clob');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok ${name}`); }
  catch (e) { console.log(`  FAIL ${name}\n    ${e.message}`); failed++; }
}

console.log('== computeMaxPriceForFill ==');
test('returns paper fill + bps slippage allowance', () => {
  assert.strictEqual(computeMaxPriceForFill(0.85, 50), 0.85425); // 0.85 + 0.85*0.005
});
test('clamps to MAX_FILL_PRICE ceiling', () => {
  assert.strictEqual(computeMaxPriceForFill(0.91, 200, 0.92), 0.92);
});
test('never exceeds 1.0', () => {
  assert.strictEqual(computeMaxPriceForFill(0.99, 500, 1.0), 1.0);
});

console.log('\n== validateFunderAddress ==');
test('accepts 0x + 40 hex', () => {
  assert.strictEqual(validateFunderAddress('0x66c2dEAd4E96Cafe0011223344556677889900AA'), true);
});
test('rejects non-0x prefix', () => {
  assert.strictEqual(validateFunderAddress('66c2deadbeef'), false);
});
test('rejects wrong length', () => {
  assert.strictEqual(validateFunderAddress('0x66c2'), false);
});

console.log('\n== sizeUsdToShareSize ==');
test('returns shares at given price', () => {
  assert.strictEqual(sizeUsdToShareSize(100, 0.50), 200);
});
test('throws on price <= 0', () => {
  assert.throws(() => sizeUsdToShareSize(100, 0), /price must be > 0/);
});

console.log('\n== normalizeTokenId ==');
test('converts 0x-hex to decimal uint256', () => {
  // Real Polymarket Down-token id from btc-updown-15m-1779908400.
  assert.strictEqual(
    normalizeTokenId('0xcf07b08beb1d66e90efeee628ebc7ac5cf072adca55461414e6d6e7ed36c17f2'),
    '93642346065739696777515137155820884328801762002849328920416978130331111266290'
  );
});
test('passes decimal strings through unchanged', () => {
  assert.strictEqual(normalizeTokenId('12345'), '12345');
});
test('throws on non-string input', () => {
  assert.throws(() => normalizeTokenId(123), /tokenId must be a string/);
  assert.throws(() => normalizeTokenId(null), /tokenId must be a string/);
});

console.log('\n== parseGetOrderFill ==');
test('parses size_matched + price into fill summary', () => {
  // Real-shaped doc from /data/order/{id}: BUY filled 144.9sh @ $0.489 = $70.84
  const fill = parseGetOrderFill({
    id: '0xbef55d', status: 'CLOSED', side: 'BUY',
    original_size: '295.67', size_matched: '144.9', price: '0.489',
  });
  assert.strictEqual(fill.filledShares, 144.9);
  assert.strictEqual(fill.fillPrice, 0.489);
  assert.ok(Math.abs(fill.filledUsd - 70.8561) < 1e-6);
  assert.strictEqual(fill.status, 'CLOSED');
});
test('returns null when size_matched is zero (unfilled FAK)', () => {
  assert.strictEqual(parseGetOrderFill({
    id: 'x', status: 'CANCELED', size_matched: '0', price: '0.50',
  }), null);
});
test('returns null when price > 1.0 (impossible for [0,1] market)', () => {
  // V1 bug: response amounts swapped → fillPrice of 2.12 in production ledger.
  // parseGetOrderFill rejects such inputs so the bug surfaces as zero fill, not
  // a polluted ledger.
  assert.strictEqual(parseGetOrderFill({
    id: 'x', status: 'CLOSED', size_matched: '68.3', price: '2.12',
  }), null);
});
test('returns null when price is non-numeric', () => {
  assert.strictEqual(parseGetOrderFill({
    id: 'x', status: 'CLOSED', size_matched: '100', price: '',
  }), null);
});
test('returns null on null / undefined / non-object input', () => {
  assert.strictEqual(parseGetOrderFill(null), null);
  assert.strictEqual(parseGetOrderFill(undefined), null);
  assert.strictEqual(parseGetOrderFill('not-an-object'), null);
});
test('SELL side parses the same way (size_matched = shares sold)', () => {
  const fill = parseGetOrderFill({
    id: 'y', status: 'CLOSED', side: 'SELL',
    original_size: '144.9', size_matched: '144.9', price: '0.31',
  });
  assert.strictEqual(fill.filledShares, 144.9);
  assert.strictEqual(fill.fillPrice, 0.31);
  assert.ok(Math.abs(fill.filledUsd - 44.919) < 1e-6);
});

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} - ${failed} failure(s)`);
process.exit(failed === 0 ? 0 : 1);
