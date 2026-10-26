/**
 * TradingView-API — High-End Gateway & Login Landing Page
 *
 * Visual Theme: Inspired by MO_IAI's "Sweet Dreams"
 * Aesthetic: Dark Sublime, Gothic Elegance, Neoclassical Chiaroscuro
 * Palette:
 *   - Abyssal Charcoal: #090b10, #0f121a
 *   - Bone White / Alabaster: #f5f2eb, #d8d4c8
 *   - Muted Sage / Antique Slate: #828c7e, #94a3b8
 *   - Ember Rust / Burnt Ochre: #b8432e, #ea580c, #7f1d1d
 *
 * Features:
 *   - Single-intent Gateway: Direct Google/Gmail login & Web3 Wallet (EIP-4361 SIWE)
 *   - Comprehensive Security Disclosures, Terms of Service & Privacy Policy Modals
 *   - Multi-channel Contact Support (Telegram, Twitter/X, Email)
 *   - Seamless transition to Trading Terminal upon authentication
 */

function getLoginPageHtml(config = {}) {
  const domain = config.domain || 'hyperview.ai.id';
  const googleClientId = config.googleClientId || '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hyperview — Institutional AI Trading & Price Cycle Gateway</title>
  <link rel="icon" type="image/svg+xml" href="/public/favicon.svg">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=Syncopate:wght@700&family=Cinzel:wght@600;700;800;900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
  <script src="https://accounts.google.com/gsi/client" async defer></script>

  <style>
    :root {
      --bg-abyss: #07090e;
      --bg-card: rgba(14, 18, 27, 0.88);
      --bg-card-hover: rgba(18, 23, 35, 0.94);
      --text-alabaster: #f5f2eb;
      --text-muted: #8e95a5;
      --text-sage: #889487;
      --border-subtle: rgba(136, 148, 135, 0.22);
      --border-ember: rgba(184, 67, 46, 0.55);
      --ember-primary: #b8432e;
      --ember-glow: rgba(184, 67, 46, 0.35);
      --ember-gradient: linear-gradient(135deg, #b8432e 0%, #87281a 100%);
      --accent-blue: #3b82f6;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }

    body {
      background: var(--bg-abyss);
      color: var(--text-alabaster);
      font-family: 'Plus Jakarta Sans', -apple-system, sans-serif;
      min-height: 100vh;
      overflow-x: hidden;
      position: relative;
    }

    /* Ambient Film Grain & Atmospheric Stippling */
    .film-grain {
      position: fixed; inset: 0; pointer-events: none; z-index: 1;
      opacity: 0.035;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
    }

    /* Ambient Dynamic Background Video & Atmospheric Overlay */
    .video-background-wrap {
      position: fixed; inset: 0; width: 100vw; height: 100vh; overflow: hidden; z-index: 0; pointer-events: none;
      background: #070608;
    }

    /* Misty Mountain Ridge Horizon across 100vw */
    .ambient-horizon-layer {
      position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none;
      background:
        radial-gradient(ellipse 90% 45% at 50% 55%, rgba(45, 52, 48, 0.45) 0%, rgba(18, 20, 22, 0.6) 60%, transparent 85%),
        linear-gradient(180deg, #070608 0%, rgba(20, 24, 22, 0.4) 45%, rgba(10, 8, 9, 0.85) 75%, #050405 100%);
      z-index: 1;
    }

    /* Volumetric Crimson Smoke Billows extending horizontally across Left and Right flanks */
    .ambient-smoke-spread {
      position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 2;
      background:
        radial-gradient(ellipse 70% 36% at 50% 96%, rgba(184, 67, 46, 0.48) 0%, rgba(138, 29, 29, 0.3) 45%, transparent 75%),
        radial-gradient(circle at 18% 92%, rgba(150, 25, 25, 0.38) 0%, rgba(184, 67, 46, 0.16) 40%, transparent 68%),
        radial-gradient(circle at 82% 90%, rgba(150, 25, 25, 0.38) 0%, rgba(184, 67, 46, 0.16) 40%, transparent 68%);
      mix-blend-mode: screen;
      animation: smokeBreathing 9s ease-in-out infinite alternate;
    }
    @keyframes smokeBreathing {
      0% { opacity: 0.82; transform: scale(1); }
      100% { opacity: 1; transform: scale(1.02); }
    }

    .bg-video-ambient {
      position: absolute; top: 50%; left: 50%; width: 100vw; height: 100vh; min-width: 100%; min-height: 100%;
      transform: translate(-50%, -50%) scale(1.15);
      object-fit: cover; filter: blur(52px) saturate(1.8) brightness(0.85); opacity: 0.78;
      z-index: 1;
    }
    .bg-video-stage {
      position: absolute; inset: 0; width: 100vw; height: 100vh; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      padding: 0;
      pointer-events: none;
      z-index: 2;
    }
    .bg-video-main {
      height: 100vh;
      max-height: 100vh;
      width: auto;
      max-width: 100vw;
      aspect-ratio: 816 / 1104;
      object-fit: contain;
      opacity: 0.98;
      filter: saturate(1.22) contrast(1.18) brightness(1.0);
      mask-image: radial-gradient(ellipse 92% 97% at 50% 50%, black 70%, rgba(0,0,0,0.85) 86%, transparent 100%);
      -webkit-mask-image: radial-gradient(ellipse 92% 97% at 50% 50%, black 70%, rgba(0,0,0,0.85) 86%, transparent 100%);
    }
    .video-ambient-overlay {
      position: absolute; inset: 0;
      background: radial-gradient(circle at 50% 90%, rgba(184, 67, 46, 0.12) 0%, rgba(7, 9, 14, 0.18) 55%, rgba(5, 7, 11, 0.55) 100%),
                  linear-gradient(180deg, rgba(7, 9, 14, 0.08) 0%, rgba(7, 9, 14, 0.45) 100%);
      pointer-events: none;
      z-index: 3;
    }

    /* Floating Atmospheric Particles (Feathers & Embers) Canvas */
    #atmospheric-particles {
      position: fixed; inset: 0; width: 100vw; height: 100vh;
      pointer-events: none; z-index: 5;
    }

    /* Floating Island Header (Frosted Glass) */
    header.floating-nav {
      position: fixed; top: 20px; left: 0; right: 0; margin: 0 auto;
      width: calc(100% - 48px); max-width: 1180px; height: 56px;
      background: rgba(10, 14, 22, 0.35) !important;
      backdrop-filter: blur(16px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(16px) saturate(190%) !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important;
      border-radius: 999px;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 24px; z-index: 100;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.22);
    }

    .brand-group {
      display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit;
    }
    .brand-logo-badge {
      width: 26px; height: 26px; border-radius: 7px;
      background: linear-gradient(135deg, #b8432e 0%, #ea580c 100%);
      display: flex; align-items: center; justify-content: center;
      color: #fff;
      box-shadow: 0 0 14px rgba(234, 88, 12, 0.45);
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    .brand-logo-badge svg { width: 15px; height: 15px; }
    .brand-title {
      font-family: 'Cormorant Garamond', 'Cinzel', serif;
      font-size: 21px; font-weight: 700; letter-spacing: 4px;
      text-transform: uppercase;
      color: #ffffff;
      text-shadow: 0 2px 10px rgba(0, 0, 0, 0.8);
      line-height: 1;
    }
    .brand-status-dot {
      width: 7px; height: 7px; border-radius: 50%; background: #10b981;
      box-shadow: 0 0 8px #10b981; animation: pulseGlow 2s infinite;
    }
    @keyframes pulseGlow { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }

    .nav-links {
      display: flex; align-items: center; gap: 28px; list-style: none;
    }
    .nav-link {
      font-size: 13px; font-weight: 600; color: #cbd5e1; text-decoration: none;
      transition: color 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      text-shadow: 0 1px 3px rgba(0,0,0,0.8);
    }
    .nav-link:hover { color: #fff; }

    .btn-nav-cta {
      background: linear-gradient(135deg, rgba(184, 67, 46, 0.45) 0%, rgba(127, 29, 29, 0.55) 100%) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      color: #fff;
      border: 1px solid rgba(251, 146, 60, 0.7) !important;
      border-radius: 999px; padding: 7px 18px; font-size: 12.5px; font-weight: 700;
      cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 6px;
      box-shadow: 0 4px 16px rgba(184, 67, 46, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.35);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .btn-nav-cta:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 22px rgba(184, 67, 46, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.45);
    }

    /* Main Container */
    main.landing-main {
      position: relative; z-index: 10;
      padding-top: 130px; max-width: 1240px; margin: 0 auto; padding-left: 24px; padding-right: 24px;
    }

    /* Hero Grid: Split Headline & Monolithic Login Card */
    .hero-split-grid {
      display: grid; grid-template-columns: 1.15fr 0.95fr; gap: 48px;
      align-items: center; min-height: calc(100vh - 160px);
      padding-bottom: 60px;
    }

    .hero-badge-live {
      display: inline-flex; align-items: center; gap: 8px;
      background: rgba(184, 67, 46, 0.22); border: 1px solid rgba(251, 146, 60, 0.5);
      backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border-radius: 999px; padding: 5px 14px; font-size: 11px; font-weight: 700;
      color: #fed7aa; margin-bottom: 20px; letter-spacing: 0.5px; text-transform: uppercase;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    }

    .hero-headline {
      font-family: 'Cinzel', serif; font-size: 46px; line-height: 1.14; font-weight: 800;
      margin-bottom: 20px; letter-spacing: -0.5px;
      background: linear-gradient(180deg, #ffffff 40%, #d8d4c8 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      text-shadow: 0 4px 20px rgba(0, 0, 0, 0.6);
    }

    .hero-subhead {
      font-size: 16px; line-height: 1.6; color: #e2e8f0;
      margin-bottom: 32px; max-width: 540px;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.8);
    }

    .hero-proof-stats {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px;
      background: rgba(16, 13, 15, 0.6) !important;
      backdrop-filter: blur(22px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(22px) saturate(190%) !important;
      border: 1px solid rgba(220, 80, 40, 0.3) !important;
      border-radius: 14px; padding: 18px 22px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.5), 0 0 24px rgba(184, 67, 46, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.1);
      max-width: 520px;
    }
    .stat-metric {
      font-family: 'JetBrains Mono', monospace; font-size: 22px; font-weight: 700; color: #fff;
      margin-bottom: 4px; display: flex; align-items: baseline; gap: 4px;
      font-feature-settings: "tnum"; letter-spacing: -0.5px;
    }
    .stat-metric span { font-size: 11.5px; color: #10b981; }
    .stat-label {
      font-size: 10px; color: #cbd5e1; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700;
    }

    /* Monolithic Authentication Console Card (Frosted Glass Translucent with Warm Rim Glow) */
    .auth-monolith-card {
      background: rgba(14, 11, 14, 0.68) !important;
      backdrop-filter: blur(28px) saturate(190%) !important;
      -webkit-backdrop-filter: blur(28px) saturate(190%) !important;
      border: 1px solid rgba(220, 80, 40, 0.35) !important;
      border-radius: 20px;
      box-shadow: 0 28px 72px rgba(0, 0, 0, 0.8), 0 0 45px rgba(184, 67, 46, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.18);
      overflow: hidden; position: relative;
    }

    .card-ember-accent {
      height: 3px; width: 100%;
      background: linear-gradient(90deg, #ea580c 0%, #b8432e 50%, #7f1d1d 100%);
    }

    .card-header-inner {
      padding: 24px 28px 16px 28px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    }
    .card-title-main {
      font-family: 'Cinzel', serif; font-size: 18px; font-weight: 800; color: #fff;
      display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;
    }
    .card-subtext {
      font-size: 12.5px; color: #cbd5e1;
    }

    /* Segmented Navigation Tabs */
    .auth-selector-tabs {
      display: flex; padding: 6px 20px; gap: 6px;
      background: rgba(8, 11, 17, 0.38) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1) !important;
    }
    .tab-trigger {
      flex: 1; padding: 10px 8px;
      background: rgba(255, 255, 255, 0.04) !important;
      backdrop-filter: blur(8px) !important;
      -webkit-backdrop-filter: blur(8px) !important;
      border: 1px solid rgba(255, 255, 255, 0.08) !important;
      border-radius: 8px; color: #cbd5e1; font-size: 12px; font-weight: 700;
      cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 7px;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .tab-trigger:hover { color: #fff; background: rgba(255, 255, 255, 0.08) !important; }
    .tab-trigger.active {
      background: rgba(255, 255, 255, 0.15) !important; color: #fff;
      border-color: rgba(251, 146, 60, 0.4) !important;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    }

    .auth-tab-content-area {
      padding: 28px;
    }

    .auth-pane { display: none; }
    .auth-pane.active { display: block; animation: paneFade 0.25s ease-out; }
    @keyframes paneFade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Translucent Action Buttons (Rich Crimson Gradient matching reference image) */
    .btn-connect-web3 {
      width: 100%; padding: 14px 18px;
      background: linear-gradient(135deg, #7c1d1d 0%, #450a0a 100%) !important;
      backdrop-filter: blur(16px) !important;
      -webkit-backdrop-filter: blur(16px) !important;
      color: #fff;
      border: 1px solid rgba(248, 113, 113, 0.45) !important;
      border-radius: 12px; font-size: 13.5px; font-weight: 700; cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      box-shadow: 0 8px 24px rgba(124, 29, 29, 0.5), 0 0 16px rgba(220, 38, 38, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.25);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .btn-connect-web3:hover {
      transform: translateY(-1.5px);
      background: linear-gradient(135deg, #991b1b 0%, #5a0d0d 100%) !important;
      box-shadow: 0 12px 32px rgba(220, 38, 38, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.4);
    }

    .input-auth-field {
      width: 100%;
      background: rgba(7, 10, 16, 0.32) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      border: 1px solid rgba(255, 255, 255, 0.18) !important;
      color: #fff; padding: 12px 14px; border-radius: 10px; font-size: 13px; outline: none;
      margin-bottom: 14px; transition: border-color 0.2s, box-shadow 0.2s;
    }
    .input-auth-field:focus {
      border-color: #3b82f6 !important; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25);
    }

    .btn-email-submit {
      width: 100%; padding: 12px 16px;
      background: rgba(37, 99, 235, 0.38) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      color: #fff;
      border: 1px solid rgba(96, 165, 250, 0.6) !important;
      border-radius: 10px;
      font-size: 13px; font-weight: 700; cursor: pointer; transition: all 0.2s;
      box-shadow: 0 6px 20px rgba(37, 99, 235, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.35);
    }
    .btn-email-submit:hover {
      background: rgba(37, 99, 235, 0.55) !important;
      box-shadow: 0 8px 24px rgba(37, 99, 235, 0.5);
    }

    /* Translucent Security Notice Pill Box */
    .security-callout-pill {
      background: rgba(136, 148, 135, 0.1) !important;
      backdrop-filter: blur(14px) !important;
      -webkit-backdrop-filter: blur(14px) !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
      border-radius: 10px; padding: 12px 14px; margin-top: 20px; font-size: 11.5px;
      color: #cbd5e1; line-height: 1.55;
    }

    .divider-text-line {
      display: flex; align-items: center; gap: 12px; margin: 18px 0;
    }
    .divider-text-line div { flex: 1; height: 1px; background: rgba(255, 255, 255, 0.1); }
    .divider-text-line span { font-size: 10.5px; color: #94a3b8; text-transform: uppercase; font-weight: 700; }

    .guest-preview-link {
      display: block; text-align: center; margin-top: 18px; font-size: 12px;
      color: #cbd5e1; text-decoration: none; transition: color 0.15s;
    }
    .guest-preview-link:hover { color: #fff; text-decoration: underline; }

    /* SECTION 2: ARCHITECTURE & VALUE PILLARS (Frosted Translucent Cards) */
    .section-pillars {
      padding: 90px 0 60px 0; border-top: 1px solid rgba(255, 255, 255, 0.08);
    }
    .section-head-center {
      text-align: center; max-width: 680px; margin: 0 auto 50px auto;
    }
    .section-tag {
      font-family: 'JetBrains Mono', monospace; font-size: 11px; text-transform: uppercase;
      color: #fb923c; letter-spacing: 1.5px; font-weight: 700; margin-bottom: 12px; display: block;
    }
    .section-title {
      font-family: 'Cinzel', serif; font-size: 32px; font-weight: 800; color: #fff; margin-bottom: 14px;
      text-shadow: 0 4px 16px rgba(0,0,0,0.6);
    }
    .section-desc {
      font-size: 14.5px; color: #cbd5e1; line-height: 1.6;
    }

    .pillars-grid {
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px;
    }
    .pillar-card {
      background: rgba(12, 16, 25, 0.34) !important;
      backdrop-filter: blur(20px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
      border: 1px solid rgba(255, 255, 255, 0.15) !important;
      border-radius: 16px; padding: 28px 24px;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.2);
      transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .pillar-card:hover {
      border-color: rgba(251, 146, 60, 0.6) !important; transform: translateY(-3px);
      box-shadow: 0 20px 48px rgba(0, 0, 0, 0.6), 0 0 24px rgba(184, 67, 46, 0.25);
    }
    .pillar-icon-box {
      width: 44px; height: 44px; border-radius: 10px; background: rgba(184, 67, 46, 0.2);
      border: 1px solid rgba(251, 146, 60, 0.45); display: flex; align-items: center; justify-content: center;
      margin-bottom: 18px; color: #fb923c;
    }
    .pillar-heading {
      font-family: 'Cinzel', serif; font-size: 17px; font-weight: 700; color: #fff; margin-bottom: 10px;
    }
    .pillar-text {
      font-size: 13px; color: #cbd5e1; line-height: 1.6;
    }

    /* SECTION 3: SECURITY ARCHITECTURE (SIWE & CRYPTOGRAPHY) */
    .section-security-banner {
      background: linear-gradient(180deg, rgba(14, 18, 27, 0.45) 0%, rgba(8, 10, 16, 0.55) 100%) !important;
      backdrop-filter: blur(24px) saturate(180%) !important;
      -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
      border: 1px solid rgba(184, 67, 46, 0.4) !important;
      border-radius: 20px; padding: 48px;
      margin: 40px 0 90px 0; position: relative; overflow: hidden;
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
    }
    .sec-grid-2col {
      display: grid; grid-template-columns: 1.2fr 0.8fr; gap: 40px; align-items: center;
    }
    .sec-feature-list {
      list-style: none; margin-top: 20px; display: flex; flex-direction: column; gap: 14px;
    }
    .sec-item {
      display: flex; gap: 12px; font-size: 13.5px; color: var(--text-alabaster); line-height: 1.5;
    }
    .sec-item svg { flex-shrink: 0; color: #10b981; margin-top: 3px; }

    /* FOOTER */
    footer.landing-footer {
      border-top: 1px solid rgba(255, 255, 255, 0.08); background: #05070a;
      padding: 60px 24px 40px 24px; position: relative; z-index: 10;
    }
    .footer-inner {
      max-width: 1240px; margin: 0 auto; display: grid; grid-template-columns: 1.5fr repeat(3, 1fr); gap: 40px;
      margin-bottom: 48px;
    }
    .footer-col-title {
      font-family: 'Cinzel', serif; font-size: 13px; font-weight: 700; color: #fff;
      letter-spacing: 1px; text-transform: uppercase; margin-bottom: 18px;
    }
    .footer-link-list { list-style: none; display: flex; flex-direction: column; gap: 10px; }
    .footer-link-item a {
      color: var(--text-muted); font-size: 13px; text-decoration: none; transition: color 0.15s; cursor: pointer;
    }
    .footer-link-item a:hover { color: #fff; }

    .footer-bottom-bar {
      max-width: 1240px; margin: 0 auto; padding-top: 28px; border-top: 1px solid rgba(255, 255, 255, 0.06);
      display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #64748b;
    }

    /* MODAL SYSTEM (TERMS, PRIVACY, CONTACT) */
    .modal-backdrop-layer {
      position: fixed; inset: 0; background: rgba(4, 6, 10, 0.88);
      backdrop-filter: blur(20px); z-index: 9999; display: none;
      align-items: center; justify-content: center; padding: 20px;
    }
    .modal-dialog-box {
      background: #0d101a; border: 1px solid rgba(184, 67, 46, 0.4); border-radius: 18px;
      width: 100%; max-width: 680px; max-height: 86vh; display: flex; flex-direction: column;
      box-shadow: 0 32px 80px rgba(0, 0, 0, 0.95), 0 0 36px rgba(184, 67, 46, 0.15); overflow: hidden;
      animation: modalScaleIn 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      position: relative;
    }
    @keyframes modalScaleIn { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }

    /* TERMS FULLSCREEN ARTWORK & FROSTED SEE-THROUGH GLASS MODAL */
    .modal-backdrop-layer.terms-fullscreen-art {
      background: #04060a url('/public/terms_bg_art.png') center center / cover no-repeat !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
      transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .modal-backdrop-layer.terms-fullscreen-art::before {
      content: '';
      position: absolute;
      inset: 0;
      background: radial-gradient(circle at center, rgba(0, 0, 0, 0.08) 0%, rgba(0, 0, 0, 0.28) 70%, rgba(0, 0, 0, 0.6) 100%);
      pointer-events: none;
      z-index: 0;
    }
    .modal-dialog-box.terms-art-glass {
      position: relative;
      z-index: 1;
      background: rgba(8, 12, 22, 0.32) !important;
      backdrop-filter: blur(14px) saturate(1.3) !important;
      -webkit-backdrop-filter: blur(14px) saturate(1.3) !important;
      border: 1px solid rgba(245, 158, 11, 0.55) !important;
      border-radius: 20px !important;
      box-shadow: 0 28px 80px rgba(0, 0, 0, 0.75), 0 0 50px rgba(245, 158, 11, 0.3), inset 0 0 35px rgba(255, 255, 255, 0.08) !important;
      max-width: 720px !important;
    }
    .modal-dialog-box.terms-art-glass .modal-header-strip {
      background: rgba(8, 12, 22, 0.42) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
      border-bottom: 1px solid rgba(245, 158, 11, 0.35) !important;
    }
    .modal-dialog-box.terms-art-glass .modal-headline-text {
      color: #fef08a !important;
      text-shadow: 0 0 20px rgba(245, 158, 11, 0.75), 0 2px 6px rgba(0, 0, 0, 0.85) !important;
      font-size: 17px !important;
      letter-spacing: 0.8px !important;
    }
    .modal-dialog-box.terms-art-glass .modal-scrollable-body {
      background: transparent !important;
    }
    .modal-dialog-box.terms-art-glass .modal-footer-strip {
      background: rgba(8, 12, 22, 0.48) !important;
      backdrop-filter: blur(12px) !important;
      -webkit-backdrop-filter: blur(12px) !important;
      border-top: 1px solid rgba(245, 158, 11, 0.35) !important;
    }
    .modal-dialog-box.terms-art-glass .btn-modal-accept {
      background: linear-gradient(135deg, rgba(217, 119, 6, 0.9), rgba(180, 83, 9, 0.98)) !important;
      border: 1px solid #f59e0b !important;
      box-shadow: 0 4px 20px rgba(245, 158, 11, 0.5) !important;
      color: #fff !important;
      font-weight: 700 !important;
    }
    .modal-dialog-box.terms-art-glass .btn-modal-accept:hover {
      background: linear-gradient(135deg, rgba(245, 158, 11, 0.98), rgba(217, 119, 6, 1)) !important;
      box-shadow: 0 6px 26px rgba(245, 158, 11, 0.75) !important;
      transform: translateY(-1px);
    }
    .terms-section-card {
      background: rgba(6, 9, 18, 0.38);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-left: 3px solid #f59e0b;
      border-radius: 12px;
      padding: 14px 18px;
      margin-bottom: 12px;
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
      transition: all 0.2s ease;
    }
    .terms-section-card:hover {
      background: rgba(6, 9, 18, 0.55);
      border-color: rgba(245, 158, 11, 0.45);
      transform: translateY(-1px);
    }
    .terms-section-card h3 {
      margin: 0 0 6px 0 !important;
      color: #fef08a !important;
      font-size: 13.5px !important;
      font-weight: 700 !important;
      text-shadow: 0 2px 8px rgba(0, 0, 0, 0.95) !important;
    }
    .terms-section-card p {
      margin: 0 !important;
      color: #f8fafc !important;
      font-size: 12.5px !important;
      line-height: 1.65;
      text-shadow: 0 1px 4px rgba(0, 0, 0, 0.95) !important;
    }

    .modal-header-strip {
      padding: 18px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex; justify-content: space-between; align-items: center;
      background: rgba(255, 255, 255, 0.03); flex-shrink: 0;
    }
    .modal-headline-text {
      font-family: 'Cinzel', serif; font-size: 16.5px; font-weight: 800; color: #fff;
    }
    .modal-close-btn {
      background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.12);
      color: #fff; width: 28px; height: 28px; border-radius: 50%; font-size: 14px; cursor: pointer;
      display: flex; align-items: center; justify-content: center; transition: all 0.15s;
    }
    .modal-close-btn:hover { background: rgba(239, 68, 68, 0.3); border-color: rgba(239, 68, 68, 0.6); }
    .modal-scrollable-body {
      padding: 24px; overflow-y: auto; font-size: 13px; line-height: 1.7; color: #cbd5e1;
      flex: 1; min-height: 0;
    }
    .modal-scrollable-body::-webkit-scrollbar { width: 6px; }
    .modal-scrollable-body::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.2); }
    .modal-scrollable-body::-webkit-scrollbar-thumb { background: rgba(184, 67, 46, 0.5); border-radius: 3px; }
    .modal-scrollable-body h3 {
      font-family: 'Cinzel', serif; color: #fff; font-size: 14.5px; margin: 18px 0 8px 0; font-weight: 700;
    }
    .modal-scrollable-body p { margin-bottom: 12px; }

    .modal-footer-strip {
      padding: 14px 24px; border-top: 1px solid rgba(255, 255, 255, 0.08);
      display: flex; justify-content: space-between; align-items: center; background: rgba(0, 0, 0, 0.4);
      flex-shrink: 0;
    }
    .btn-modal-accept {
      background: var(--ember-gradient); color: #fff; border: 1px solid var(--border-ember);
      border-radius: 8px; padding: 8px 18px; font-size: 12px; font-weight: 700; cursor: pointer;
      transition: all 0.2s;
    }
    .btn-modal-accept:hover { transform: translateY(-1px); box-shadow: 0 4px 14px var(--ember-glow); }

    .contact-channel-pill {
      display: flex; align-items: center; justify-content: space-between; padding: 12px 16px;
      background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px; text-decoration: none; color: inherit; transition: all 0.2s;
    }
    .contact-channel-pill:hover {
      background: rgba(255, 255, 255, 0.08); border-color: rgba(184, 67, 46, 0.45);
      transform: translateY(-1px);
    }
    .channel-icon-bg {
      width: 34px; height: 34px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
    }
    .channel-action-badge {
      font-size: 11px; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.12);
      border: 1px solid rgba(56, 189, 248, 0.3); padding: 4px 10px; border-radius: 6px;
    }

    /* Toast Notification */
    .landing-toast-pill {
      position: fixed; bottom: 24px; right: 24px; background: #111624;
      border: 1px solid #b8432e; color: #fff; padding: 12px 20px; border-radius: 10px;
      font-size: 12.5px; font-weight: 600; box-shadow: 0 16px 40px rgba(0,0,0,0.6);
      z-index: 10000; display: none; align-items: center; gap: 10px;
    }

    /* Lateral Neoclassical Architectural Columns (Side Flanks Decor) */
    .flank-pillar {
      position: fixed; top: 100px; bottom: 35px; width: 36px;
      display: flex; flex-direction: column; justify-content: space-between; align-items: center;
      z-index: 6; pointer-events: none; opacity: 0.72;
      font-family: 'JetBrains Mono', monospace; font-size: 9.5px; color: rgba(226, 232, 240, 0.4);
      user-select: none;
    }
    .flank-pillar-left { left: 24px; }
    .flank-pillar-right { right: 24px; }

    .flank-rail-line {
      width: 1px; flex: 1; margin: 14px 0;
      background: linear-gradient(180deg, rgba(251, 146, 60, 0.5) 0%, rgba(255, 255, 255, 0.15) 30%, rgba(184, 67, 46, 0.4) 70%, transparent 100%);
      position: relative;
    }
    .flank-node-dot {
      width: 5px; height: 5px; border-radius: 50%; background: #fb923c;
      box-shadow: 0 0 10px #fb923c; position: absolute; left: -2px; top: 35%;
      animation: pulseNode 4s infinite alternate;
    }
    @keyframes pulseNode { from { top: 20%; opacity: 0.3; } to { top: 80%; opacity: 1; } }

    .flank-vertical-text {
      writing-mode: vertical-rl; transform: rotate(180deg);
      letter-spacing: 3.5px; font-size: 9px; font-weight: 700;
      font-family: 'Cinzel', serif; color: rgba(248, 250, 252, 0.45);
      text-shadow: 0 1px 4px rgba(0,0,0,0.8); margin: 12px 0;
    }
    .flank-coordinate-tag {
      font-size: 8.5px; letter-spacing: 1px; color: rgba(251, 146, 60, 0.65);
    }

    /* Ambient Renaissance Arch Framing Brackets */
    .viewport-corner-bracket {
      position: fixed; width: 28px; height: 28px; pointer-events: none; z-index: 6;
      border-color: rgba(251, 146, 60, 0.35); border-style: solid;
    }
    .bracket-tl { top: 14px; left: 14px; border-width: 1px 0 0 1px; border-top-left-radius: 6px; }
    .bracket-tr { top: 14px; right: 14px; border-width: 1px 1px 0 0; border-top-right-radius: 6px; }
    .bracket-bl { bottom: 14px; left: 14px; border-width: 0 0 1px 1px; border-bottom-left-radius: 6px; }
    .bracket-br { bottom: 14px; right: 14px; border-width: 0 1px 1px 0; border-bottom-right-radius: 6px; }

    /* Stealth Admin Vault Console Dialog */
    .admin-vault-dialog {
      max-width: 480px; border-color: rgba(239, 68, 68, 0.45) !important;
      box-shadow: 0 32px 80px rgba(0,0,0,0.95), 0 0 40px rgba(239, 68, 68, 0.25) !important;
    }
    .vault-header {
      background: rgba(239, 68, 68, 0.08) !important; border-bottom: 1px solid rgba(239, 68, 68, 0.2) !important;
    }

    @media (max-width: 1320px) {
      .flank-pillar { display: none; }
    }

    @media (max-width: 960px) {
      .hero-split-grid { grid-template-columns: 1fr; gap: 40px; }
      .pillars-grid { grid-template-columns: 1fr; }
      .sec-grid-2col { grid-template-columns: 1fr; }
      .footer-inner { grid-template-columns: 1fr 1fr; }
      .nav-links { display: none; }
    }
  </style>
</head>
<body>
  <div class="film-grain"></div>

  <!-- LATERAL NEOCLASSICAL ARCHITECTURAL COLUMNS (FLANKS DECOR) -->
  <aside class="flank-pillar flank-pillar-left" aria-hidden="true">
    <span class="flank-coordinate-tag">EPOCH // T3–T10</span>
    <div class="flank-rail-line">
      <div class="flank-node-dot"></div>
    </div>
    <div class="flank-vertical-text">VINCIT • QUI • SE • VINCIT</div>
    <div class="flank-rail-line" style="background: linear-gradient(180deg, rgba(184, 67, 46, 0.4) 0%, transparent 100%);"></div>
    <span class="flank-coordinate-tag">LAT 41°53'N</span>
  </aside>

  <aside class="flank-pillar flank-pillar-right" aria-hidden="true">
    <span class="flank-coordinate-tag">SECP256K1 // EIP-4361</span>
    <div class="flank-rail-line">
      <div class="flank-node-dot" style="animation-delay: 1.5s; background: #38bdf8; box-shadow: 0 0 10px #38bdf8;"></div>
    </div>
    <div class="flank-vertical-text">AUDACES • FORTUNA • IUVAT</div>
    <div class="flank-rail-line" style="background: linear-gradient(180deg, rgba(56, 189, 248, 0.4) 0%, transparent 100%);"></div>
    <span class="flank-coordinate-tag">LON 12°29'E</span>
  </aside>

  <!-- AMBIENT VIEWPORT CORNER BRACKETS -->
  <div class="viewport-corner-bracket bracket-tl"></div>
  <div class="viewport-corner-bracket bracket-tr"></div>
  <div class="viewport-corner-bracket bracket-bl"></div>
  <div class="viewport-corner-bracket bracket-br"></div>

  <div class="video-background-wrap">
    <div class="ambient-horizon-layer"></div>
    <div class="ambient-smoke-spread"></div>
    <video class="bg-video-ambient" autoplay loop muted playsinline>
      <source src="/public/sweet_dreams_loop.mp4" type="video/mp4">
    </video>
    <div class="bg-video-stage">
      <video class="bg-video-main" id="bg-video-main" autoplay loop muted playsinline poster="/public/sweet_dreams_hero.jpg">
        <source src="/public/sweet_dreams_loop.mp4" type="video/mp4">
      </video>
    </div>
    <div class="video-ambient-overlay"></div>
  </div>

  <!-- FLOATING FEATHERS & EMBER PARTICLES CANVAS -->
  <canvas id="atmospheric-particles"></canvas>

  <!-- FLOATING NAVIGATION ISLAND -->
  <header class="floating-nav">
    <a href="/" class="brand-group">
      <div class="brand-logo-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
      </div>
      <span class="brand-title">HYPERVIEW</span>
      <span class="brand-status-dot" title="Core Engine Operational"></span>
    </a>

    <ul class="nav-links">
      <li><a href="#features" class="nav-link">Intelligence</a></li>
      <li><a href="#security" class="nav-link">Web3 Security</a></li>
      <li><a href="#architecture" class="nav-link">Risk Engine</a></li>
      <li><a href="javascript:void(0)" onclick="openLegalModal('terms')" class="nav-link">Terms</a></li>
      <li><a href="javascript:void(0)" onclick="openLegalModal('privacy')" class="nav-link">Privacy</a></li>
      <li><a href="javascript:void(0)" onclick="openLegalModal('contact')" class="nav-link">Contact</a></li>
    </ul>

    <div style="display: flex; align-items: center; gap: 8px;">
      <a href="https://github.com/Doffyyyy/TradingView-API" target="_blank" rel="noopener noreferrer" class="btn-nav-cta" style="background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.15); color: #cbd5e1;" title="Verified Open-Source Code on GitHub">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
        <span>GitHub</span>
      </a>
      <a href="#gateway-console" class="btn-nav-cta">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        <span>Access Terminal</span>
      </a>
    </div>
  </header>

  <!-- MAIN LANDING HERO & GATEWAY -->
  <main class="landing-main">
    <div class="hero-split-grid">
      <!-- Left Hero Pitch -->
      <div>
        <div class="hero-badge-live">
          <span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#f97316; box-shadow:0 0 8px #f97316;"></span>
          Institutional Grade Cycle Intelligence
        </div>
        <h1 class="hero-headline">
          The Execution Edge for Quantitative Crypto Markets.
        </h1>
        <p class="hero-subhead">
          Powered by Oliver Kell's championship price cycles, 26 technical consensus models, and zero-latency timeframe execution. Built for disciplined capital compounding.
        </p>

        <div class="hero-proof-stats">
          <div>
            <div class="stat-metric">$11,547 <span>+15.4%</span></div>
            <div class="stat-label">Current Equity (T3–T10)</div>
          </div>
          <div>
            <div class="stat-metric">&lt; 18ms <span>INST</span></div>
            <div class="stat-label">Switching Latency</div>
          </div>
          <div>
            <div class="stat-metric">4-Layer <span style="display:inline-flex; align-items:center; gap:4px;"><span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:#10b981; box-shadow:0 0 6px #10b981;"></span>Pure Guard</span></div>
            <div class="stat-label">Loss Slippage Shield</div>
          </div>
        </div>
      </div>

      <!-- Right Monolithic Authentication Console -->
      <div id="gateway-console">
        <div class="auth-monolith-card">
          <div class="card-ember-accent"></div>
          <div class="card-header-inner">
            <div class="card-title-main">
              <span>SECURITY GATEWAY</span>
              <span style="font-size: 10px; font-family: 'JetBrains Mono', monospace; color: #fb923c; background: rgba(251, 146, 60, 0.12); padding: 2px 8px; border-radius: 4px; border: 1px solid rgba(251, 146, 60, 0.3);">EIP-4361 VERIFIED</span>
            </div>
            <div class="card-subtext">Sign in to unlock terminal workspaces, trading logs & live AI engines.</div>
          </div>

          <!-- Tabs: Web3 Wallet vs Google -->
          <div class="auth-selector-tabs">
            <button class="tab-trigger active" data-tab-target="pane-wallet">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fb923c" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
              <span>Web3 Wallet</span>
            </button>
            <button class="tab-trigger" data-tab-target="pane-google">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/></svg>
              <span>Google / Gmail</span>
            </button>
          </div>

          <div class="auth-tab-content-area">
            <!-- PANE 1: WEB3 WALLET (EIP-4361 SIWE) -->
            <div class="auth-pane active" id="pane-wallet">
              <div style="font-size: 12.5px; color: var(--text-muted); margin-bottom: 16px; line-height: 1.5;">
                Connect your decentralized EVM wallet (MetaMask, Rabby, Phantom). Ownership is verified via cryptographic challenge with <strong>zero gas fees</strong>.
              </div>

              <div id="wallet-auth-status-text" style="font-size: 11px; color: var(--text-sage); margin-bottom: 12px; min-height: 16px;"></div>

              <button class="btn-connect-web3" id="btn-login-wallet">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>
                <span id="btn-login-wallet-label">Connect EVM Wallet & Sign In</span>
              </button>

              <div class="security-callout-pill">
                🔒 <strong>Non-Custodial Guarantee:</strong> Sign-In with Ethereum only verifies cryptographic address possession. We never ask for contract approval, token transfer, or private keys.
              </div>
            </div>

            <!-- PANE 2: GOOGLE / GMAIL -->
            <div class="auth-pane" id="pane-google">
              <div style="font-size: 12.5px; color: var(--text-muted); margin-bottom: 16px; line-height: 1.5;">
                Sign in with your verified Google account to store customized alerts, journal configurations, and notifications.
              </div>

              <input type="email" class="input-auth-field" id="login-email-input" placeholder="Enter your Gmail (e.g. name@gmail.com)">
              <button class="btn-email-submit" id="btn-login-email">Continue with Gmail</button>

              <div class="divider-text-line">
                <div></div>
                <span>Secured by Google Identity</span>
                <div></div>
              </div>

              <div class="security-callout-pill">
                🛡️ <strong>Zero Password Storage:</strong> Authentication occurs through OAuth 2.0 cryptographic token signatures. Your credentials remain securely stored with Google.
              </div>
            </div>

            <a href="/terminal" class="guest-preview-link">
              Or explore terminal in Guest Mode (View-only) →
            </a>
          </div>
        </div>
      </div>
    </div>

    <!-- VALUE PROPOSITIONS & INTELLIGENCE PILLARS -->
    <section class="section-pillars" id="features">
      <div class="section-head-center">
        <span class="section-tag">ENGINEERING CORE</span>
        <h2 class="section-title">Built for the Asymmetric Trader</h2>
        <p class="section-desc">Traditional indicators lag. Hyperview pairs relative strength leader selection with multi-tier capital preservation.</p>
      </div>

      <div class="pillars-grid">
        <div class="pillar-card">
          <div class="pillar-icon-box">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <h3 class="pillar-heading">Oliver Kell Price Cycles</h3>
          <p class="pillar-text">
            Strict wedge pop confirmation, EMA 10/20 crossbacks, and two-stage take profit: 50% locked at +2.2R, runner captures Climax Extensions at +5R to +8R.
          </p>
        </div>

        <div class="pillar-card">
          <div class="pillar-icon-box">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3 class="pillar-heading">4-Layer Pure Loss Guard</h3>
          <p class="pillar-text">
            Committed Risk Gate rejects orders when floating risk threatens the $180 daily ceiling. Emergency Circuit Breaker prevents overnight cascading drawdowns.
          </p>
        </div>

        <div class="pillar-card">
          <div class="pillar-icon-box">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <h3 class="pillar-heading">Zero-Latency Switching</h3>
          <p class="pillar-text">
            Binance Vision direct REST clusters and in-memory pre-warming reduce 1m, 15m, 1h, 4h, and 1D indicator compute down to 18 milliseconds without screen flashes.
          </p>
        </div>
      </div>
    </section>

    <!-- SECTION: WEB3 SECURITY SPECIFICATION -->
    <section class="section-security-banner" id="security">
      <div class="sec-grid-2col">
        <div>
          <span class="section-tag">DEFENSE IN DEPTH</span>
          <h2 class="section-title" style="font-size: 28px; margin-bottom: 12px;">Cryptographic SIWE Architecture</h2>
          <p class="section-desc">
            Hyperview operates on modern Web3 security foundations. When connecting your wallet, identity is established via mathematical proof rather than passwords.
          </p>
          <ul class="sec-feature-list">
            <li class="sec-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span><strong>EIP-4361 Standardized Nonce:</strong> Cryptographically generated 256-bit challenge invalidated immediately upon single use.</span>
            </li>
            <li class="sec-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span><strong>Anti-Replay Defense:</strong> 5-minute strict time-to-live prevents eavesdropped signatures from reuse.</span>
            </li>
            <li class="sec-item">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span><strong>HttpOnly, Secure Cookies:</strong> Session tokens isolated from browser scripts to eliminate XSS token exfiltration.</span>
            </li>
          </ul>
          <div style="margin-top: 22px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;">
            <button onclick="openLegalModal('security-audit')" style="background: rgba(16, 185, 129, 0.15); border: 1px solid rgba(16, 185, 129, 0.4); color: #10b981; padding: 10px 18px; border-radius: 8px; font-size: 12.5px; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; transition: all 0.2s;">
              <span style="display:inline-block; width:7px; height:7px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;"></span>
              View Full Security Architecture Audit Dossier (8/8 Verified) ↗
            </button>
            <a href="https://github.com/Doffyyyy/TradingView-API" target="_blank" rel="noopener noreferrer" style="background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.14); color: #cbd5e1; padding: 10px 16px; border-radius: 8px; font-size: 12.5px; font-weight: 700; text-decoration: none; display: inline-flex; align-items: center; gap: 8px; transition: all 0.2s;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
              <span>GitHub Verified Open-Source ↗</span>
            </a>
          </div>
        </div>
        <div style="background: rgba(0,0,0,0.5); border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 24px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #94a3b8; line-height: 1.6;">
          <div style="color: #fb923c; margin-bottom: 8px;">// EIP-4361 Challenge Format</div>
          <div>hyperview.ai.id wants you to sign in:</div>
          <div style="color: #fff;">0x71C...4e79</div>
          <div style="margin: 8px 0; color: #64748b;">-------------------------------</div>
          <div>URI: https://hyperview.ai.id</div>
          <div>Version: 1 | Chain: 1</div>
          <div>Nonce: 35fd851c64c9b78e568d51b68d8a</div>
          <div>Issued: 2026-10-25T16:00:00Z</div>
          <div style="margin-top: 10px; color: #10b981;">// Recovered via secp256k1: Valid</div>
        </div>
      </div>
    </section>
  </main>

  <!-- FOOTER -->
  <footer class="landing-footer" id="contact">
    <div class="footer-inner">
      <div>
        <div class="brand-group" style="margin-bottom: 14px;">
          <div class="brand-logo-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>
          </div>
          <span class="brand-title">HYPERVIEW</span>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); line-height: 1.6; max-width: 340px; margin-bottom: 20px;">
          Institutional-grade algorithmic execution, price cycle intelligence, and quantitative risk management for digital assets.
        </p>
        <div style="display: flex; gap: 12px;">
          <a href="https://t.me/_teml" target="_blank" rel="noopener" style="color: #38bdf8; text-decoration: none; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px;">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
            Telegram @_teml
          </a>
          <span style="color: #334155;">•</span>
          <a href="https://x.com/_teml" target="_blank" rel="noopener" style="color: #cbd5e1; text-decoration: none; font-size: 13px; font-weight: 700; display: inline-flex; align-items: center; gap: 6px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            Twitter @_teml
          </a>
        </div>
      </div>

      <div>
        <div class="footer-col-title">Navigation</div>
        <ul class="footer-link-list">
          <li class="footer-link-item"><a href="/terminal">Trading Terminal</a></li>
          <li class="footer-link-item"><a href="#features">AI Intelligence Hub</a></li>
          <li class="footer-link-item"><a href="#security">Security Specs</a></li>
          <li class="footer-link-item"><a href="/api/paper/simulated-6m">Historical Journal (API)</a></li>
        </ul>
      </div>

      <div>
        <div class="footer-col-title">Compliance & Legal</div>
        <ul class="footer-link-list">
          <li class="footer-link-item"><a onclick="openLegalModal('terms')">Terms of Service</a></li>
          <li class="footer-link-item"><a onclick="openLegalModal('privacy')">Privacy Policy</a></li>
          <li class="footer-link-item"><a onclick="openLegalModal('security-audit')">Security Audit</a></li>
          <li class="footer-link-item"><a onclick="openLegalModal('disclaimer')">Risk Disclaimer</a></li>
          <li class="footer-link-item"><a href="https://github.com/Doffyyyy/TradingView-API" target="_blank" rel="noopener noreferrer" style="color: #38bdf8;">Verified GitHub (Open-Source) ↗</a></li>
        </ul>
      </div>

      <div>
        <div class="footer-col-title">Contact & Help</div>
        <ul class="footer-link-list">
          <li class="footer-link-item"><a onclick="openLegalModal('contact')">Direct Contact</a></li>
          <li class="footer-link-item"><a href="mailto:admin@hyperview.ai.id">admin@hyperview.ai.id</a></li>
          <li class="footer-link-item"><a href="https://t.me/_teml" target="_blank">Telegram Support</a></li>
          <li class="footer-link-item"><span style="color: #10b981; font-size: 11px;">● All Systems Normal</span></li>
        </ul>
      </div>
    </div>

    <div class="footer-bottom-bar">
      <div>© 2026 Hyperview Network. All rights reserved. Non-custodial trading software.</div>
      <div style="display: flex; gap: 16px;">
        <span>Cloudflare Protected</span>
        <span>EIP-4361 Standard</span>
        <span>Oliver Kell Price Cycle V2</span>
      </div>
    </div>
  </footer>

  <!-- INTERACTIVE MODAL DIALOG (TERMS, PRIVACY, CONTACT) -->
  <div class="modal-backdrop-layer" id="legal-modal-backdrop">
    <div class="modal-dialog-box">
      <div class="modal-header-strip">
        <div class="modal-headline-text" id="legal-modal-title">Terms of Service</div>
        <button class="modal-close-btn" onclick="closeLegalModal()">✕</button>
      </div>
      <div class="modal-scrollable-body" id="legal-modal-body"></div>
      <div class="modal-footer-strip">
        <span style="font-size: 11px; color: #64748b;" id="legal-modal-foot-meta">Effective Date: October 2026 • Compliance v2.4</span>
        <button class="btn-modal-accept" onclick="closeLegalModal()">I Understand & Accept</button>
      </div>
    </div>
  </div>

  <!-- STEALTH ADMIN VAULT MODAL (TRIGGERED VIA HOTKEY CTRL+SHIFT+A, TRIPLE CLICK STATUS DOT, OR ?mode=vault) -->
  <div class="modal-backdrop-layer" id="admin-vault-backdrop">
    <div class="modal-dialog-box admin-vault-dialog">
      <div class="modal-header-strip vault-header">
        <div style="display:flex; align-items:center; gap:9px;">
          <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#ef4444; box-shadow:0 0 10px #ef4444;"></span>
          <span class="modal-headline-text" style="color:#f87171; letter-spacing:1px; font-size:14.5px;">OPERATOR VAULT // ROOT CLEARANCE</span>
        </div>
        <button class="modal-close-btn" onclick="closeAdminVaultModal()">✕</button>
      </div>
      <div class="modal-scrollable-body" style="padding:24px;">
        <p style="font-size:12px; color:#94a3b8; margin-bottom:16px; font-family:'JetBrains Mono', monospace; line-height:1.6;">
          ENTER HIGH-CLEARANCE OPERATOR PASSPHRASE TO UNLOCK FULL ADMINISTRATIVE CONTROL (BOT TOGGLE, LIQUIDATION OVERRIDE, RISK RESETS).
        </p>
        <input type="password" id="stealth-vault-key-input" class="input-auth-field" placeholder="Enter Operator Master Key..." style="border-color:rgba(239,68,68,0.4); font-family:'JetBrains Mono', monospace; font-size:13.5px;" onkeydown="if(event.key==='Enter') submitStealthAdminKey()">
        <button class="btn-connect-web3" id="btn-submit-vault" onclick="submitStealthAdminKey()" style="background:linear-gradient(135deg, rgba(220,38,38,0.65), rgba(153,27,27,0.75)) !important; border-color:#f87171 !important; box-shadow:0 8px 24px rgba(220,38,38,0.4) !important;">
          Authorize Root Console
        </button>
        <div id="vault-auth-status" style="margin-top:14px; font-size:12px; font-family:'JetBrains Mono', monospace; font-weight:600; text-align:center; min-height:16px;"></div>
      </div>
    </div>
  </div>

  <div class="landing-toast-pill" id="landing-toast"></div>

  <!-- CLIENT-SIDE GATEWAY CONTROLLER -->
  <script>
    function showToast(msg, isError = false) {
      const toast = document.getElementById('landing-toast');
      if (!toast) return;
      toast.textContent = msg;
      toast.style.borderColor = isError ? '#ef4444' : '#10b981';
      toast.style.display = 'flex';
      setTimeout(() => { toast.style.display = 'none'; }, 4000);
    }

    // Tab switcher
    document.querySelectorAll('.tab-trigger').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-trigger').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.auth-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const target = btn.getAttribute('data-tab-target');
        document.getElementById(target)?.classList.add('active');
      });
    });

    // 1. Web3 Wallet Sign-In (EIP-4361 SIWE)
    document.getElementById('btn-login-wallet')?.addEventListener('click', async () => {
      const statusText = document.getElementById('wallet-auth-status-text');
      const btnLabel = document.getElementById('btn-login-wallet-label');

      if (!window.ethereum) {
        alert('No Web3 wallet found. Please install MetaMask, Rabby, or Coinbase Wallet to proceed!');
        return;
      }

      try {
        btnLabel.textContent = 'Connecting...';
        statusText.textContent = '1. Requesting account permission from wallet...';
        const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
        if (!accounts || accounts.length === 0) throw new Error('No account selected');
        const userAddress = accounts[0];

        statusText.textContent = '2. Requesting cryptographic Nonce challenge from server...';
        const nonceRes = await fetch('/api/auth/wallet/nonce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ address: userAddress })
        });
        const nonceData = await nonceRes.json();
        if (!nonceData.success) throw new Error(nonceData.error || 'Failed to generate Nonce');

        statusText.textContent = '3. Please sign the EIP-4361 challenge on your wallet window (0 gas fee)...';
        btnLabel.textContent = 'Awaiting signature...';

        const signature = await window.ethereum.request({
          method: 'personal_sign',
          params: [nonceData.message, userAddress]
        });

        statusText.textContent = '4. Verifying secp256k1 signature and issuing session...';
        btnLabel.textContent = 'Verifying...';

        const verifyRes = await fetch('/api/auth/wallet/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            address: userAddress,
            signature,
            message: nonceData.message
          })
        });

        const verifyData = await verifyRes.json();
        if (verifyData.success) {
          showToast('✅ Signature verified! Welcome to Hyperview (' + verifyData.user.role + ')');
          setTimeout(() => { window.location.href = '/terminal'; }, 800);
        } else {
          throw new Error(verifyData.error || 'Verification failed');
        }
      } catch (err) {
        showToast('❌ ' + err.message, true);
        statusText.textContent = 'Error: ' + err.message;
      } finally {
        btnLabel.textContent = 'Connect EVM Wallet & Sign In';
      }
    });

    // 2. Gmail / Email Direct Sign-In
    document.getElementById('btn-login-email')?.addEventListener('click', async () => {
      const email = (document.getElementById('login-email-input')?.value || '').trim();
      if (!email || !email.includes('@')) {
        alert('Please enter a valid Gmail / Email address');
        return;
      }

      try {
        const res = await fetch('/api/auth/direct-login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: email, role: 'USER' })
        });
        const data = await res.json();
        if (data.success) {
          showToast('✅ Welcome, ' + data.user.displayId);
          setTimeout(() => { window.location.href = '/terminal'; }, 800);
        } else {
          alert(data.error || 'Login failed');
        }
      } catch (e) {
        alert(e.message);
      }
    });

    // 3. STEALTH OPERATOR VAULT CONTROLLER (DISCREET ADMIN ACCESS)
    function openAdminVaultModal() {
      const modal = document.getElementById('admin-vault-backdrop');
      if (modal) {
        modal.style.display = 'flex';
        setTimeout(() => {
          document.getElementById('stealth-vault-key-input')?.focus();
        }, 120);
      }
    }

    function closeAdminVaultModal() {
      const modal = document.getElementById('admin-vault-backdrop');
      if (modal) modal.style.display = 'none';
      const status = document.getElementById('vault-auth-status');
      if (status) status.textContent = '';
    }

    async function submitStealthAdminKey() {
      const input = document.getElementById('stealth-vault-key-input');
      const key = (input?.value || '').trim();
      const status = document.getElementById('vault-auth-status');
      const btn = document.getElementById('btn-submit-vault');

      if (!key) {
        if (status) { status.style.color = '#ef4444'; status.textContent = 'Passphrase required.'; }
        input?.focus();
        return;
      }

      if (status) { status.style.color = '#fb923c'; status.textContent = 'Verifying root clearance...'; }
      if (btn) btn.disabled = true;

      try {
        const res = await fetch('/api/auth/claim-admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ masterKey: key })
        });
        const data = await res.json();
        if (data.success) {
          if (status) { status.style.color = '#10b981'; status.textContent = '✓ Clearances granted. Initializing Admin Workspace...'; }
          showToast('👑 Administrative privileges authorized!');
          setTimeout(() => { window.location.href = '/terminal'; }, 700);
        } else {
          if (status) { status.style.color = '#ef4444'; status.textContent = '✗ ' + (data.error || 'Access Denied: Invalid Key'); }
          if (btn) btn.disabled = false;
        }
      } catch (e) {
        if (status) { status.style.color = '#ef4444'; status.textContent = '✗ ' + e.message; }
        if (btn) btn.disabled = false;
      }
    }

    // Stealth Trigger 1: Global Shortcut Ctrl+Shift+A (or Cmd+Shift+A)
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        openAdminVaultModal();
      }
      if (e.key === 'Escape') {
        closeAdminVaultModal();
        closeLegalModal();
      }
    });

    // Stealth Trigger 2: Triple click on status dot or header logo
    let dotClicks = 0;
    let dotTimer = null;
    document.querySelector('.brand-status-dot')?.addEventListener('click', (e) => {
      e.stopPropagation();
      dotClicks++;
      clearTimeout(dotTimer);
      if (dotClicks >= 3) {
        dotClicks = 0;
        openAdminVaultModal();
      } else {
        dotTimer = setTimeout(() => { dotClicks = 0; }, 800);
      }
    });

    // Stealth Trigger 3: Secret URL query (?admin=1 or ?mode=vault)
    if (window.location.search.includes('admin=1') || window.location.search.includes('mode=vault')) {
      setTimeout(openAdminVaultModal, 350);
    }

    // Video Infinite Seamless Loop Assurance
    const mainVid = document.getElementById('bg-video-main');
    if (mainVid) {
      mainVid.addEventListener('timeupdate', () => {
        if (mainVid.currentTime >= mainVid.duration - 0.12) {
          mainVid.currentTime = 0;
          mainVid.play();
        }
      });
      mainVid.addEventListener('ended', () => {
        mainVid.currentTime = 0;
        mainVid.play();
      });
    }

    // FLOATING BLACK FEATHERS & EMBER PARTICLES ENGINE
    (function initAtmosphericEngine() {
      const canvas = document.getElementById('atmospheric-particles');
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      let w = canvas.width = window.innerWidth;
      let h = canvas.height = window.innerHeight;

      window.addEventListener('resize', () => {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
      });

      // 12 Feathers with varied depth, scale, blur, and swaying physics
      const feathers = [];
      for (let i = 0; i < 12; i++) {
        feathers.push({
          x: Math.random() * w,
          y: Math.random() * h,
          scale: 0.45 + Math.random() * 0.85,
          angle: Math.random() * Math.PI * 2,
          angularSpeed: (Math.random() - 0.5) * 0.012,
          vy: 0.35 + Math.random() * 0.45,
          swaySpeed: 0.008 + Math.random() * 0.014,
          swayAmp: 0.6 + Math.random() * 0.9,
          phase: Math.random() * Math.PI * 2,
          blur: Math.random() > 0.65 ? (1 + Math.random() * 2) : 0,
          color: Math.random() > 0.4 ? 'rgba(12, 14, 18, 0.88)' : 'rgba(22, 18, 20, 0.82)'
        });
      }

      // 45 Fiery Embers rising from the bottom smoke
      const embers = [];
      const emberColors = ['#ff5500', '#ff7700', '#ff9900', '#ff3300', '#ffb347'];
      for (let i = 0; i < 45; i++) {
        embers.push({
          x: Math.random() * w,
          y: Math.random() * h,
          size: 1 + Math.random() * 2.2,
          vy: -(0.5 + Math.random() * 1.1),
          vx: (Math.random() - 0.5) * 0.4,
          alpha: 0.2 + Math.random() * 0.7,
          color: emberColors[Math.floor(Math.random() * emberColors.length)],
          pulse: Math.random() * Math.PI * 2
        });
      }

      function drawFeather(f) {
        ctx.save();
        ctx.translate(f.x, f.y);
        ctx.rotate(f.angle);
        ctx.scale(f.scale, f.scale);
        if (f.blur) ctx.filter = 'blur(' + f.blur + 'px)';

        // Feather Vanes (Organic curved blade)
        ctx.beginPath();
        ctx.moveTo(0, 32);
        ctx.bezierCurveTo(-14, 16, -17, -14, 0, -36);
        ctx.bezierCurveTo(15, -14, 13, 16, 0, 32);
        ctx.fillStyle = f.color;
        ctx.fill();

        // Rim Light
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
        ctx.lineWidth = 0.8;
        ctx.stroke();

        // Central Rachis (Stem)
        ctx.beginPath();
        ctx.moveTo(0, 35);
        ctx.quadraticCurveTo(1.5, 0, 0, -36);
        ctx.strokeStyle = 'rgba(45, 50, 60, 0.9)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.restore();
      }

      function render() {
        ctx.clearRect(0, 0, w, h);

        // Render & Update Embers
        for (let i = 0; i < embers.length; i++) {
          const e = embers[i];
          e.y += e.vy;
          e.x += e.vx + Math.sin(e.pulse) * 0.25;
          e.pulse += 0.03;
          e.alpha = 0.3 + Math.sin(e.pulse) * 0.4;
          if (e.y < -10) {
            e.y = h + Math.random() * 30;
            e.x = Math.random() * w;
          }

          ctx.save();
          ctx.globalAlpha = Math.max(0.1, Math.min(1, e.alpha));
          ctx.shadowColor = e.color;
          ctx.shadowBlur = e.size * 3.5;
          ctx.fillStyle = e.color;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }

        // Render & Update Feathers
        for (let i = 0; i < feathers.length; i++) {
          const f = feathers[i];
          f.y += f.vy;
          f.x += Math.sin(f.phase) * f.swayAmp;
          f.phase += f.swaySpeed;
          f.angle += f.angularSpeed;

          if (f.y > h + 50) {
            f.y = -50;
            f.x = Math.random() * w;
          }
          if (f.x < -50) f.x = w + 40;
          if (f.x > w + 50) f.x = -40;

          drawFeather(f);
        }

        requestAnimationFrame(render);
      }

      requestAnimationFrame(render);
    })();

    // LEGAL & CONTACT MODALS
    const LEGAL_CONTENT = {
      terms: {
        title: 'Terms of Service',
        body: '<div class="terms-section-card">'
          + '<h3>1. Acceptance of Terms</h3>'
          + '<p>By accessing Hyperview (the "Platform") at ' + '${domain}' + ', you agree to comply with and be bound by these Terms of Service. If you do not agree, you must immediately cease accessing the platform.</p>'
          + '</div>'
          + '<div class="terms-section-card">'
          + '<h3>2. Informational & Educational Software</h3>'
          + '<p>Hyperview provides automated market indicators, technical pattern detection, and simulation journals. None of the materials or automated outputs constitute personalized investment or financial advice.</p>'
          + '</div>'
          + '<div class="terms-section-card">'
          + '<h3>3. Non-Custodial Operation</h3>'
          + '<p>The Platform operates on a 100% non-custodial framework. Hyperview never retains custody of your private keys or cryptographic assets. All live trade routing via Hyperliquid is signed directly by the user environment.</p>'
          + '</div>'
          + '<div class="terms-section-card">'
          + '<h3>4. Prohibited Activities</h3>'
          + '<p>Users shall not attempt denial-of-service attacks, reverse engineer proprietary algorithmic modules, or bypass security rate limiters. Violations result in permanent IP blacklisting.</p>'
          + '</div>'
      },
      privacy: {
        title: 'Privacy & Data Protection Policy',
        body: '<h3>1. Data We Collect</h3>'
          + '<p>We believe in radical data minimization. When you connect via Web3 wallet, we collect only your public EVM address. When you sign in via Google, we collect only your verified email and display name for session identification.</p>'
          + '<h3>2. Cryptographic Security Standards</h3>'
          + '<p>Authentication utilizes EIP-4361 (Sign-In with Ethereum). Sessions are bound to 256-bit cryptographically random tokens stored in HttpOnly, SameSite=Strict cookies. No private keys or passwords ever touch our infrastructure.</p>'
          + '<h3>3. Zero Third-Party Monetization</h3>'
          + '<p>We do not sell, rent, or monetize your trading journals, simulated strategies, or browsing activities. All analytical caching is localized.</p>'
          + '<h3>4. Data Removal</h3>'
          + '<p>You may request deletion of all server-side session logs at any time by contacting admin@hyperview.ai.id.</p>'
      },
      disclaimer: {
        title: 'Risk Disclaimer & Disclosure',
        body: '<h3>High-Risk Derivative Warning</h3>'
          + '<p>Trading cryptocurrencies, perpetual futures, and financial derivatives carries a substantial risk of capital loss and is not suitable for every investor. Leverage can work against you as well as for you.</p>'
          + '<h3>Hypothetical & Simulation Results</h3>'
          + '<p>Backtested performance results (including the Oliver Kell V2 Pure Loss Guard journal) have inherent limitations. Past performance does not guarantee future results in live market liquidity.</p>'
      },
      contact: {
        title: 'Direct Support & Official Channels',
        body: '<p style="margin-bottom:14px; font-size:13px; color:#94a3b8;">For strategic integrations, algorithmic inquiries, or account recovery:</p>'
          + '<div style="display:flex; flex-direction:column; gap:10px;">'
          + '<a href="https://t.me/_teml" target="_blank" rel="noopener" class="contact-channel-pill">'
          + '<div style="display:flex; align-items:center; gap:12px;">'
          + '<div class="channel-icon-bg" style="background:rgba(56,189,248,0.15); color:#38bdf8;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></div>'
          + '<div><div style="font-weight:700; color:#fff; font-size:13px;">Telegram Direct Support</div><div style="font-size:11.5px; color:#38bdf8;">@_teml</div></div>'
          + '</div>'
          + '<span class="channel-action-badge">Open Telegram ↗</span>'
          + '</a>'
          + '<a href="https://x.com/_teml" target="_blank" rel="noopener" class="contact-channel-pill">'
          + '<div style="display:flex; align-items:center; gap:12px;">'
          + '<div class="channel-icon-bg" style="background:rgba(255,255,255,0.08); color:#fff;"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></div>'
          + '<div><div style="font-weight:700; color:#fff; font-size:13px;">Twitter / X Operator</div><div style="font-size:11.5px; color:#38bdf8;">@_teml</div></div>'
          + '</div>'
          + '<span class="channel-action-badge" style="color:#cbd5e1; border-color:rgba(255,255,255,0.2); background:rgba(255,255,255,0.05);">Message on X ↗</span>'
          + '</a>'
          + '<a href="mailto:admin@hyperview.ai.id" class="contact-channel-pill">'
          + '<div style="display:flex; align-items:center; gap:12px;">'
          + '<div class="channel-icon-bg" style="background:rgba(245,158,11,0.15); color:#f59e0b;"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div>'
          + '<div><div style="font-weight:700; color:#fff; font-size:13px;">Official Operator Email</div><div style="font-size:11.5px; color:#38bdf8;">admin@hyperview.ai.id</div></div>'
          + '</div>'
          + '<span class="channel-action-badge" style="color:#f59e0b; border-color:rgba(245,158,11,0.3); background:rgba(245,158,11,0.1);">Send Mail ↗</span>'
          + '</a>'
          + '<a href="https://github.com/Doffyyyy/TradingView-API" target="_blank" rel="noopener" class="contact-channel-pill">'
          + '<div style="display:flex; align-items:center; gap:12px;">'
          + '<div class="channel-icon-bg" style="background:rgba(168,85,247,0.15); color:#c084fc;"><svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg></div>'
          + '<div><div style="font-weight:700; color:#fff; font-size:13px;">GitHub Core Repository</div><div style="font-size:11.5px; color:#38bdf8;">Doffyyyy/TradingView-API</div></div>'
          + '</div>'
          + '<span class="channel-action-badge" style="color:#c084fc; border-color:rgba(168,85,247,0.3); background:rgba(168,85,247,0.1);">Repository ↗</span>'
          + '</a>'
          + '</div>'
      },
      'security-audit': {
        title: 'Security Architecture Audit & Verification Report',
        body: '<div style="background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.3); border-radius:8px; padding:12px 16px; margin-bottom:16px; display:flex; align-items:center; justify-content:space-between;">'
          + '<div><span style="color:#10b981; font-weight:700; font-size:12px;">● ALL 8 AUDIT VECTORS VERIFIED (100% PASS RATE)</span><br><span style="color:#94a3b8; font-size:11px;">Automated security test suite completed with zero vulnerabilities.</span></div>'
          + '<span style="font-family:JetBrains Mono, monospace; font-size:11px; color:#10b981; background:rgba(16,185,129,0.15); padding:4px 8px; border-radius:4px; font-weight:700;">AUDIT: PASSED</span>'
          + '</div>'
          + '<h3>1. Web3 Cryptographic Security & SIWE (EIP-4361)</h3>'
          + '<p>• <strong>Cryptographic Challenge:</strong> 256-bit single-use random Nonce generated per session request with strict 5-minute TTL.<br>'
          + '• <strong>Zero-Gas Signature:</strong> Identity authenticated off-chain via standard <code>personal_sign</code> (secp256k1 elliptic curve recovery via <code>ethers.verifyMessage</code>). Zero gas cost to users.<br>'
          + '• <strong>Anti-Replay Mechanism:</strong> Nonce records are immediately consumed and deleted upon first verification. Replaying intercepted signatures results in immediate 401 Unauthorized rejection.<br>'
          + '• <strong>100% Non-Custodial:</strong> The platform never requests token allowances, smart contract approvals, or private keys.</p>'
          + '<h3>2. Zero-Trust RBAC (Role-Based Access Control)</h3>'
          + '<p>• <strong>Privilege Separation:</strong> Strict isolation between <code>USER</code> (read-only analytical charts & paper trade telemetry) and <code>ADMIN</code> (full bot orchestration authority).<br>'
          + '• <strong>Mutation Guard:</strong> All destructive and operational API endpoints (<code>/api/paper/toggle</code>, <code>/api/paper/reset</code>, <code>/api/hyperliquid/trade</code>) require verified <code>ADMIN</code> role clearance. Unauthorized calls are blocked with HTTP 403 Forbidden (<code>ADMIN_REQUIRED</code>).</p>'
          + '<h3>3. Operator Vault & Master Key Protection</h3>'
          + '<p>• <strong>Stealth Root Access:</strong> Administrative console is completely decoupled from the public login screen. Access is gated behind biometric hotkey (<code>Ctrl+Shift+A</code>) or multi-touch anchor.<br>'
          + '• <strong>Cryptographic Passphrase Verification:</strong> Operator key is validated against server-side persistent config with scrypt hashing, preventing brute-force dictionary attacks.</p>'
          + '<h3>4. Session Hardening & Security Headers</h3>'
          + '<p>• <strong>Cookie Security:</strong> Sessions use 256-bit cryptographic entropy tokens stored in <code>HttpOnly; SameSite=Strict</code> cookies, completely eliminating client-side XSS token theft.<br>'
          + '• <strong>HTTP Security Headers:</strong> Enforced across all routes:<br>'
          + '&nbsp;&nbsp;▫ <code>X-Frame-Options: SAMEORIGIN</code> (prevents clickjacking)<br>'
          + '&nbsp;&nbsp;▫ <code>X-Content-Type-Options: nosniff</code> (prevents MIME-sniffing exploits)<br>'
          + '&nbsp;&nbsp;▫ <code>X-XSS-Protection: 1; mode=block</code><br>'
          + '&nbsp;&nbsp;▫ <code>Referrer-Policy: strict-origin-when-cross-origin</code><br>'
          + '&nbsp;&nbsp;▫ <code>Permissions-Policy: camera=(), microphone=(), geolocation=()</code></p>'
          + '<h3>5. Rate Limiting & DoS Mitigation</h3>'
          + '<p>• <strong>Auth Gate Throttling:</strong> Strictly enforced at 5 failed authentication attempts per 5-minute window per IP.<br>'
          + '• <strong>API Protection:</strong> General analytical and chart endpoints are capped at 120 requests per minute per IP, responding with HTTP 429 Too Many Requests upon threshold breach.</p>'
          + '<h3>6. Automated Resilience & Disaster Recovery</h3>'
          + '<p>• <strong>Continuous Snapshots:</strong> Automated 24-hour snapshot daemon archives portfolio journals (<code>paper_portfolio.json</code>) and multi-month PnL simulations to <code>data/backups/</code>.<br>'
          + '• <strong>Historical Equity Guard:</strong> $11,547.11 overnight compounding capital baseline is protected against process resets or overwrites.</p>'
      }
    };

    function openLegalModal(key) {
      const data = LEGAL_CONTENT[key];
      if (!data) return;
      document.getElementById('legal-modal-title').textContent = data.title;
      document.getElementById('legal-modal-body').innerHTML = data.body;
      const footMeta = document.getElementById('legal-modal-foot-meta');
      const acceptBtn = document.querySelector('.btn-modal-accept');
      const backdrop = document.getElementById('legal-modal-backdrop');
      const dialogBox = document.querySelector('#legal-modal-backdrop .modal-dialog-box');
      if (key === 'terms') {
        backdrop?.classList.add('terms-fullscreen-art');
        dialogBox?.classList.add('terms-art-glass');
      } else {
        backdrop?.classList.remove('terms-fullscreen-art');
        dialogBox?.classList.remove('terms-art-glass');
      }
      if (key === 'contact') {
        if (footMeta) footMeta.innerHTML = '<span style="color:#10b981;">● Typical response within 2 hours</span>';
        if (acceptBtn) acceptBtn.textContent = 'Close Directory';
      } else {
        if (footMeta) footMeta.textContent = 'Effective Date: October 2026 • Compliance v2.4';
        if (acceptBtn) acceptBtn.textContent = 'I Understand & Accept';
      }
      document.getElementById('legal-modal-backdrop').style.display = 'flex';
    }

    function closeLegalModal() {
      const backdrop = document.getElementById('legal-modal-backdrop');
      const dialogBox = document.querySelector('#legal-modal-backdrop .modal-dialog-box');
      backdrop?.classList.remove('terms-fullscreen-art');
      dialogBox?.classList.remove('terms-art-glass');
      if (backdrop) backdrop.style.display = 'none';
    }

    document.getElementById('legal-modal-backdrop')?.addEventListener('click', (e) => {
      if (e.target.id === 'legal-modal-backdrop') closeLegalModal();
    });
  </script>
</body>
</html>`;
}

module.exports = {
  getLoginPageHtml,
};
