import test from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveSuiNetwork,
  isValidSuiAddress,
  isValidSuiDigest,
  isValidSuiCoinType,
  isValidWalrusBlobId,
  getSuiTxUrl,
  getSuiAccountUrl,
  getSuiObjectUrl,
  getSuiCoinUrl,
  getWalrusBlobUrl,
  shortenIdentifier,
  QUARANTINED_SYNTHETIC_BLOB_IDS,
} from '../src/services/explorerLinks.ts'

test('resolveSuiNetwork correctly maps testnet and mainnet', () => {
  assert.equal(resolveSuiNetwork('testnet'), 'testnet')
  assert.equal(resolveSuiNetwork('sui-testnet'), 'testnet')
  assert.equal(resolveSuiNetwork('mainnet'), 'mainnet')
  assert.equal(resolveSuiNetwork('sui-mainnet'), 'mainnet')
  assert.equal(resolveSuiNetwork('unconfigured'), null)
  assert.equal(resolveSuiNetwork(undefined), null)
  assert.equal(resolveSuiNetwork(''), null)
})

test('isValidSuiAddress validates 0x hex addresses up to 64 chars', () => {
  assert.equal(isValidSuiAddress('0xb45b010966bb108875fd0df9c85ef961dc92790b67ae7112e7146cd8e4549159'), true)
  assert.equal(isValidSuiAddress('0x2'), true)
  assert.equal(isValidSuiAddress('b45b010966bb108875fd0df9c85ef961dc92790b67ae7112e7146cd8e4549159'), false)
  assert.equal(isValidSuiAddress('0xZZZ'), false)
  assert.equal(isValidSuiAddress(''), false)
})

test('isValidSuiDigest validates Base58 32-byte digests and rejects 0x hex or short strings', () => {
  assert.equal(isValidSuiDigest('4uTafS7jwWgzha7ekccGZyihAv2Rwd8krLHvZWqXbc8Y'), true)
  assert.equal(isValidSuiDigest('0x4uTafS7jwWgzha7ekccGZyihAv2Rwd8krLHvZWqXbc8Y'), false)
  assert.equal(isValidSuiDigest('short'), false)
  assert.equal(isValidSuiDigest(''), false)
})

test('isValidSuiCoinType validates Move coin types', () => {
  assert.equal(isValidSuiCoinType('0x2::sui::SUI'), true)
  assert.equal(isValidSuiCoinType('0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC'), true)
  assert.equal(isValidSuiCoinType('0x0d7dfa...::circle::Circle<0x2::sui::SUI>'), false)
  assert.equal(isValidSuiCoinType('not_a_coin_type'), false)
})

test('isValidWalrusBlobId rejects quarantined, synthetic, and malformed blob IDs', () => {
  // Valid real blob ID from Walrus
  assert.equal(isValidWalrusBlobId('ukT4N-4Byl1We3_SsgWRaI7f6kKmhTKWx2wB1EgmCOQ'), true)
  assert.equal(isValidWalrusBlobId('AyEguMKt3AZtWaOi1ALYqnKzb8XGZGx7GZPqReNnmGA'), true)

  // Quarantined synthetic blob IDs must be rejected
  for (const qid of QUARANTINED_SYNTHETIC_BLOB_IDS) {
    assert.equal(isValidWalrusBlobId(qid), false, `Quarantined ID ${qid} must be invalid`)
  }

  // Malformed IDs
  assert.equal(isValidWalrusBlobId('mock-blob-123'), false)
  assert.equal(isValidWalrusBlobId('synthetic-seed'), false)
  assert.equal(isValidWalrusBlobId('short'), false)
  assert.equal(isValidWalrusBlobId(''), false)
})

test('Explorer URL builders generate valid Suiscan and Walruscan URLs on matching networks', () => {
  const txUrl = getSuiTxUrl('4uTafS7jwWgzha7ekccGZyihAv2Rwd8krLHvZWqXbc8Y', 'testnet')
  assert.equal(txUrl, 'https://suiscan.xyz/testnet/tx/4uTafS7jwWgzha7ekccGZyihAv2Rwd8krLHvZWqXbc8Y')

  const acctUrl = getSuiAccountUrl('0xb45b010966bb108875fd0df9c85ef961dc92790b67ae7112e7146cd8e4549159', 'testnet')
  assert.equal(acctUrl, 'https://suiscan.xyz/testnet/account/0xb45b010966bb108875fd0df9c85ef961dc92790b67ae7112e7146cd8e4549159')

  const objUrl = getSuiObjectUrl('0x20262a807e165c8e2ff489451cb5912c81b7819b56da0abdd32cfddb895231a9', 'testnet')
  assert.equal(objUrl, 'https://suiscan.xyz/testnet/object/0x20262a807e165c8e2ff489451cb5912c81b7819b56da0abdd32cfddb895231a9')

  const coinUrl = getSuiCoinUrl('0x2::sui::SUI', 'testnet')
  assert.equal(coinUrl, 'https://suiscan.xyz/testnet/coin/0x2%3A%3Asui%3A%3ASUI')

  const blobUrl = getWalrusBlobUrl('ukT4N-4Byl1We3_SsgWRaI7f6kKmhTKWx2wB1EgmCOQ', 'mainnet')
  assert.equal(blobUrl, 'https://walruscan.com/mainnet/blob/ukT4N-4Byl1We3_SsgWRaI7f6kKmhTKWx2wB1EgmCOQ')

  // Unknown network returns null
  assert.equal(getSuiTxUrl('4uTafS7jwWgzha7ekccGZyihAv2Rwd8krLHvZWqXbc8Y', 'unconfigured'), null)
})

test('shortenIdentifier handles edge cases and lengths', () => {
  assert.equal(shortenIdentifier('0x1234567890abcdef', 6, 4), '0x1234...cdef')
  assert.equal(shortenIdentifier('short'), 'short')
  assert.equal(shortenIdentifier(''), '')
})
