const { ethers } = require('ethers');

async function runTests() {
  console.log('=== STARTING SECURITY & AUTHENTICATION AUDIT TESTS ===\n');

  // Test 1: Check security headers & /api/auth/me for guest
  console.log('Test 1: Guest check on /api/auth/me & Security Headers');
  const meRes = await fetch('http://localhost:8095/api/auth/me');
  console.log('  Status:', meRes.status);
  console.log('  X-Frame-Options:', meRes.headers.get('x-frame-options'));
  console.log('  X-Content-Type-Options:', meRes.headers.get('x-content-type-options'));
  const meData = await meRes.json();
  console.log('  Response:', meData);
  if (meData.authenticated === false && meRes.headers.get('x-frame-options') === 'SAMEORIGIN') {
    console.log('  ✅ PASSED: Guest is unauthenticated, security headers present.\n');
  } else {
    throw new Error('Test 1 failed');
  }

  // Test 2: Unauthenticated attack on protected admin endpoint (/api/paper/reset)
  console.log('Test 2: Unauthorized attack on /api/paper/reset (Privilege Escalation Prevention)');
  const attackRes = await fetch('http://localhost:8095/api/paper/reset', { method: 'POST' });
  const attackData = await attackRes.json();
  console.log('  Status:', attackRes.status);
  console.log('  Response:', attackData);
  if (attackRes.status === 403 && attackData.code === 'ADMIN_REQUIRED') {
    console.log('  ✅ PASSED: Unauthorized bot tampering blocked with 403 Forbidden.\n');
  } else {
    throw new Error('Test 2 failed');
  }

  // Test 3: Web3 Wallet Nonce Challenge (EIP-4361 SIWE)
  console.log('Test 3: Web3 Wallet EIP-4361 Nonce Challenge');
  const testWallet = ethers.Wallet.createRandom();
  console.log('  Generated Test Wallet:', testWallet.address);
  const nonceRes = await fetch('http://localhost:8095/api/auth/wallet/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: testWallet.address }),
  });
  const nonceData = await nonceRes.json();
  console.log('  Nonce Response:', { success: nonceData.success, nonce: nonceData.nonce });
  if (nonceData.success && nonceData.nonce && nonceData.message.includes(testWallet.address)) {
    console.log('  ✅ PASSED: EIP-4361 SIWE challenge created with single-use nonce.\n');
  } else {
    throw new Error('Test 3 failed');
  }

  // Test 4: Web3 Cryptographic Signature Verification
  console.log('Test 4: Web3 Signature Verification (Zero Gas Fee personal_sign)');
  const sig = await testWallet.signMessage(nonceData.message);
  const verifyRes = await fetch('http://localhost:8095/api/auth/wallet/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: testWallet.address,
      signature: sig,
      message: nonceData.message,
    }),
  });
  const cookie = verifyRes.headers.get('set-cookie');
  const verifyData = await verifyRes.json();
  console.log('  Verification Status:', verifyRes.status);
  console.log('  Verified User:', verifyData.user);
  console.log('  Session Cookie issued:', cookie ? cookie.split(';')[0] : 'none');
  if (verifyData.success && verifyData.user.role === 'USER' && cookie && cookie.includes('HttpOnly')) {
    console.log('  ✅ PASSED: Valid secp256k1 signature verified & HttpOnly session issued.\n');
  } else {
    throw new Error('Test 4 failed');
  }

  // Test 5: Replay Attack Defense (Same signature re-submitted)
  console.log('Test 5: Replay Attack Defense (Submitting used signature/nonce again)');
  const replayRes = await fetch('http://localhost:8095/api/auth/wallet/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address: testWallet.address,
      signature: sig,
      message: nonceData.message,
    }),
  });
  const replayData = await replayRes.json();
  console.log('  Replay Status:', replayRes.status);
  console.log('  Replay Response:', replayData);
  if (replayRes.status === 401 && replayData.success === false) {
    console.log('  ✅ PASSED: Replay attack intercepted and rejected.\n');
  } else {
    throw new Error('Test 5 failed');
  }

  // Test 6: Member attempting to call /api/paper/reset (RBAC enforcement)
  console.log('Test 6: Member attempting admin action with Member cookie');
  const memberActionRes = await fetch('http://localhost:8095/api/paper/reset', {
    method: 'POST',
    headers: { 'Cookie': cookie },
  });
  const memberActionData = await memberActionRes.json();
  console.log('  Status:', memberActionRes.status);
  console.log('  Response:', memberActionData);
  if (memberActionRes.status === 403) {
    console.log('  ✅ PASSED: Member role cannot tamper with bot.\n');
  } else {
    throw new Error('Test 6 failed');
  }

  // Test 7: Master Key Admin Claim
  console.log('Test 7: Admin Master Key Claim');
  const adminRes = await fetch('http://localhost:8095/api/auth/claim-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ masterKey: '0711' }),
  });
  const adminData = await adminRes.json();
  const adminCookie = adminRes.headers.get('set-cookie');
  console.log('  Admin Status:', adminRes.status);
  console.log('  Admin User:', adminData.user);
  if (adminData.success && adminData.user.role === 'ADMIN' && adminCookie) {
    console.log('  ✅ PASSED: Admin session created successfully.\n');
  } else {
    throw new Error('Test 7 failed');
  }

  // Test 8: Admin calling /api/paper/toggle
  console.log('Test 8: Admin toggling bot state with Admin cookie');
  const toggleRes = await fetch('http://localhost:8095/api/paper/toggle', {
    method: 'POST',
    headers: { 'Cookie': adminCookie },
  });
  const toggleData = await toggleRes.json();
  console.log('  Toggle Status:', toggleRes.status);
  console.log('  Toggle Response:', toggleData);
  // Ensure auto-trade is left enabled
  if (!toggleData.autoTradeEnabled) {
    await fetch('http://localhost:8095/api/paper/toggle', {
      method: 'POST',
      headers: { 'Cookie': adminCookie },
    });
  }
  if (toggleData.success) {
    console.log('  ✅ PASSED: Admin successfully authorized to operate bot.\n');
  } else {
    throw new Error('Test 8 failed');
  }

  console.log('🎉 ALL 8 SECURITY AUDIT TESTS PASSED WITH 100% SUCCESS!');
}

runTests().catch(err => {
  console.error('❌ Test failed with error:', err.message);
  process.exit(1);
});
